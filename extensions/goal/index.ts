import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatGoalLines, formatGoalMarkdown, parseBudgetPatch } from "./format";
import { buildGoalContinuationPrompt, buildGoalSteeringPrompt } from "./prompts";
import {
	applyGoalEvent,
	budgetExceeded,
	createGoalEvent,
	defaultBudgets,
	GOAL_CONTINUATION_CONTEXT,
	GOAL_EVENT,
	GOAL_STEERING_CONTEXT,
	isTerminalStatus,
	nowIso,
	reconstructGoal,
	type GoalBudgets,
	type GoalEvent,
	type GoalMode,
	type GoalState,
	type GoalStatus,
	type SessionEntryLike,
	type UsageLike,
} from "./state";
import { refreshGoalUi } from "./ui";

const MODE_SCHEMA = Type.Union([Type.Literal("manual"), Type.Literal("assist"), Type.Literal("auto")]);
const STATUS_SCHEMA = Type.Union([
	Type.Literal("active"),
	Type.Literal("paused"),
	Type.Literal("blocked"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);
const STEP_STATUS_SCHEMA = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("done"),
	Type.Literal("blocked"),
]);

const MAX_HISTORY_EVENTS = 40;
const MAX_NO_PROGRESS_CONTINUATIONS = 2;
const QUESTION_RE = /\?\s*$|\b(please confirm|need your approval|waiting for you|which option|what would you like|provide|please share)\b/i;

let cachedState: GoalState | undefined;
let continuationQueuedForGoalId: string | undefined;
let lastAgentHadToolCalls = false;

function getBranch(ctx: ExtensionContext): SessionEntryLike[] {
	return ctx.sessionManager.getBranch() as SessionEntryLike[];
}

function readGoal(ctx: ExtensionContext): ReturnType<typeof reconstructGoal> {
	const result = reconstructGoal(getBranch(ctx));
	cachedState = result.state;
	return result;
}

function appendGoalEvent(pi: ExtensionAPI, ctx: ExtensionContext, event: GoalEvent): GoalState | undefined {
	const base = cachedState ?? readGoal(ctx).state;
	pi.appendEntry(GOAL_EVENT, event);
	const current = applyGoalEvent(base, event);
	cachedState = current;
	refreshGoalUi(ctx, current);
	return current;
}

function statusEvent(goalId: string, status: GoalStatus, reason?: string): GoalEvent {
	return { kind: "status", goalId, status, reason, at: nowIso() };
}

function updateEvent(goalId: string, patch: GoalEvent & { kind: "updated" }): GoalEvent {
	return patch;
}

function assertMode(value: string | undefined): GoalMode | undefined {
	if (value === "manual" || value === "assist" || value === "auto") return value;
	return undefined;
}

function getErrorResult(message: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: message }], details: { ok: false, ...details } };
}

function getGoalResult(state: GoalState | undefined, history: GoalEvent[] = []) {
	return {
		content: [{ type: "text" as const, text: formatGoalMarkdown(state, history) }],
		details: { ok: true, goal: state, history: history.slice(-MAX_HISTORY_EVENTS) },
	};
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function usageDelta(usage: UsageLike | undefined) {
	return {
		assistantTurns: 1,
		inputTokens: usage?.input ?? 0,
		outputTokens: usage?.output ?? 0,
		cacheReadTokens: usage?.cacheRead ?? 0,
		cacheWriteTokens: usage?.cacheWrite ?? 0,
		costUsd: usage?.cost?.total ?? 0,
		lastTurnAt: nowIso(),
	};
}

function hasPendingMessages(ctx: ExtensionContext): boolean {
	const maybe = ctx as ExtensionContext & { hasPendingMessages?: () => boolean };
	return typeof maybe.hasPendingMessages === "function" ? maybe.hasPendingMessages() : false;
}

function commandUsage(): string {
	return `Usage: /goal [show|create|edit|update|done|block|pause|resume|clear|auto|mode|budget]\n\nExamples:\n  /goal migrate TargetTracking to features\n  /goal show\n  /goal pause\n  /goal resume\n  /goal edit new goal text\n  /goal auto on\n  /goal budget turns 10\n  /goal done implemented and tested`;
}

async function handleGoalCommand(args: string, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const trimmed = args.trim();
	const { state, history } = readGoal(ctx);

	if (!trimmed || ["show", "status", "view"].includes(trimmed)) {
		ctx.ui.notify(formatGoalLines(state, history.length).join("\n"), "info");
		refreshGoalUi(ctx, state);
		return;
	}

	if (trimmed === "help") {
		ctx.ui.notify(commandUsage(), "info");
		return;
	}

	const [subcommandRaw = "", ...rest] = trimmed.split(/\s+/);
	const subcommand = subcommandRaw.toLowerCase();
	const restText = rest.join(" ").trim();

	if (["create", "set"].includes(subcommand) || !isKnownSubcommand(subcommand)) {
		const text = ["create", "set"].includes(subcommand) ? restText : trimmed;
		if (!text) {
			ctx.ui.notify("Goal text is required.", "warning");
			return;
		}
		if (state && !isTerminalStatus(state.status)) {
			ctx.ui.notify("A non-terminal goal already exists. Use /goal edit <text>, /goal done, /goal pause/resume, or /goal clear first.", "warning");
			return;
		}
		const created = appendGoalEvent(pi, ctx, createGoalEvent(text, "assist"));
		ctx.ui.notify(`Goal created:\n${formatGoalLines(created).join("\n")}`, "info");
		return;
	}

	if (!state) {
		ctx.ui.notify("No goal set. Use /goal <text> to create one.", "warning");
		return;
	}

	switch (subcommand) {
		case "edit": {
			if (!restText) {
				ctx.ui.notify("Usage: /goal edit <new goal text>", "warning");
				return;
			}
			const updated = appendGoalEvent(pi, ctx, {
				kind: "updated",
				goalId: state.goalId,
				patch: { text: restText },
				note: "Goal text edited by user",
				at: nowIso(),
			});
			ctx.ui.notify(`Goal updated:\n${formatGoalLines(updated).join("\n")}`, "info");
			return;
		}
		case "update": {
			if (!restText) {
				ctx.ui.notify("Usage: /goal update <progress note>", "warning");
				return;
			}
			const updated = appendGoalEvent(pi, ctx, {
				kind: "updated",
				goalId: state.goalId,
				patch: { summary: restText },
				note: restText,
				at: nowIso(),
			});
			ctx.ui.notify(`Progress recorded:\n${formatGoalLines(updated).join("\n")}`, "info");
			return;
		}
		case "pause":
			ctx.ui.notify(`Goal paused. Resume with /goal resume.`, "info");
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "paused", restText || "paused by user"));
			return;
		case "resume": {
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "active", restText || "resumed by user"));
			ctx.ui.notify(`Goal resumed in ${state.mode} mode.`, "info");
			return;
		}
		case "done":
		case "complete":
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "completed", restText || "completed by user"));
			continuationQueuedForGoalId = undefined;
			ctx.ui.notify("Goal completed.", "info");
			return;
		case "block":
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "blocked", restText || "blocked by user"));
			continuationQueuedForGoalId = undefined;
			ctx.ui.notify("Goal blocked.", "warning");
			return;
		case "cancel":
		case "clear":
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "cancelled", restText || (subcommand === "clear" ? "cleared by user" : "cancelled by user")));
			continuationQueuedForGoalId = undefined;
			refreshGoalUi(ctx, undefined);
			ctx.ui.notify(subcommand === "clear" ? "Goal cleared." : "Goal cancelled.", "info");
			return;
		case "auto": {
			if (restText !== "on" && restText !== "off") {
				ctx.ui.notify("Usage: /goal auto on|off", "warning");
				return;
			}
			const mode: GoalMode = restText === "on" ? "auto" : "assist";
			const updated = appendGoalEvent(pi, ctx, {
				kind: "updated",
				goalId: state.goalId,
				patch: { mode, budgets: defaultBudgets(mode, state.budgets) },
				note: `auto ${restText}`,
				at: nowIso(),
			});
			ctx.ui.notify(`Goal mode set to ${updated?.mode ?? mode}.`, "info");
			return;
		}
		case "mode": {
			const mode = assertMode(restText);
			if (!mode) {
				ctx.ui.notify("Usage: /goal mode manual|assist|auto", "warning");
				return;
			}
			appendGoalEvent(pi, ctx, {
				kind: "updated",
				goalId: state.goalId,
				patch: { mode, budgets: defaultBudgets(mode, state.budgets) },
				note: `mode ${mode}`,
				at: nowIso(),
			});
			ctx.ui.notify(`Goal mode set to ${mode}.`, "info");
			return;
		}
		case "budget": {
			const [kind = "", value = ""] = restText.split(/\s+/);
			const patch = parseBudgetPatch(kind, value);
			if (!patch) {
				ctx.ui.notify("Usage: /goal budget turns|tools|tokens|cost|time <number>", "warning");
				return;
			}
			const updated = appendGoalEvent(pi, ctx, {
				kind: "updated",
				goalId: state.goalId,
				patch: { budgets: patch },
				note: `budget ${kind} ${value}`,
				at: nowIso(),
			});
			ctx.ui.notify(`Budget updated: ${formatGoalLines(updated).join("\n")}`, "info");
			return;
		}
		default:
			ctx.ui.notify(commandUsage(), "warning");
	}
}

function isKnownSubcommand(value: string): boolean {
	return [
		"show",
		"status",
		"view",
		"help",
		"create",
		"set",
		"edit",
		"update",
		"pause",
		"resume",
		"done",
		"complete",
		"block",
		"cancel",
		"clear",
		"auto",
		"mode",
		"budget",
	].includes(value);
}

function shouldStopForAssistantQuestion(event: { messages?: unknown }): boolean {
	const messages = Array.isArray(event.messages) ? event.messages : [];
	const lastAssistant = [...messages]
		.reverse()
		.find((message): message is { role?: string; content?: unknown } => Boolean(message && typeof message === "object" && (message as { role?: string }).role === "assistant"));
	return QUESTION_RE.test(extractTextContent(lastAssistant?.content).trim());
}

export default function goalExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const { state } = readGoal(ctx);
		continuationQueuedForGoalId = undefined;
		refreshGoalUi(ctx, state);
	});

	pi.registerCommand("goal", {
		description: "Codex-style persistent session goal: /goal <text>, /goal show, /goal pause/resume/clear/edit, /goal auto on",
		getArgumentCompletions(prefix: string) {
			const options = ["show", "create ", "edit ", "update ", "pause", "resume", "done ", "block ", "clear", "auto on", "auto off", "mode manual", "mode assist", "mode auto", "budget turns "];
			return options.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => handleGoalCommand(args, pi, ctx),
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Inspect the active session goal, progress, budgets, and accounting.",
		promptSnippet: "Inspect the active session goal and progress",
		promptGuidelines: ["Use get_goal before substantial work when a session goal is active and you need current structured progress."],
		parameters: Type.Object({ includeHistory: Type.Optional(Type.Boolean({ description: "Include recent goal event history." })) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { state, history } = readGoal(ctx);
			refreshGoalUi(ctx, state);
			return getGoalResult(state, params.includeHistory ? history.map((h) => h.event) : []);
		},
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Create a persistent session goal with optional mode and budgets.",
		promptSnippet: "Create or formalize the active session goal",
		promptGuidelines: [
			"Use create_goal only when the user asks to set a goal or no active goal exists and the request clearly defines one.",
			"Do not overwrite an active goal with create_goal unless replace is true or the current goal is terminal.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "Goal text." }),
			mode: Type.Optional(MODE_SCHEMA),
			replace: Type.Optional(Type.Boolean({ description: "Replace an existing active goal." })),
			maxTurns: Type.Optional(Type.Number()),
			maxToolCalls: Type.Optional(Type.Number()),
			maxCostUsd: Type.Optional(Type.Number()),
			maxTokens: Type.Optional(Type.Number()),
			maxWallMs: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { state } = readGoal(ctx);
			if (!params.goal.trim()) return getErrorResult("Goal text is required.");
			if (state && !isTerminalStatus(state.status) && !params.replace) {
				return getErrorResult("A non-terminal goal already exists. Pass replace=true to replace it.", { goal: state });
			}
			if (state && params.replace && !isTerminalStatus(state.status)) {
				appendGoalEvent(pi, ctx, statusEvent(state.goalId, "cancelled", "replaced by create_goal"));
			}
			const budgets: GoalBudgets = {
				maxTurns: params.maxTurns,
				maxToolCalls: params.maxToolCalls,
				maxCostUsd: params.maxCostUsd,
				maxTokens: params.maxTokens,
				maxWallMs: params.maxWallMs,
			};
			const created = appendGoalEvent(pi, ctx, createGoalEvent(params.goal, params.mode ?? "assist", budgets));
			return getGoalResult(created);
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Update goal progress, next action, plan, blockers, mode, budgets, or terminal status.",
		promptSnippet: "Update active session goal progress or status",
		promptGuidelines: [
			"Use update_goal after meaningful progress, when blocked, and when the session goal is complete.",
			"Use update_goal with status=blocked when user input, approval, credentials, or budget changes are required.",
		],
		parameters: Type.Object({
			status: Type.Optional(STATUS_SCHEMA),
			summary: Type.Optional(Type.String()),
			progressNote: Type.Optional(Type.String()),
			nextAction: Type.Optional(Type.String()),
			blockers: Type.Optional(Type.Array(Type.String())),
			mode: Type.Optional(MODE_SCHEMA),
			maxTurns: Type.Optional(Type.Number()),
			maxToolCalls: Type.Optional(Type.Number()),
			maxCostUsd: Type.Optional(Type.Number()),
			maxTokens: Type.Optional(Type.Number()),
			maxWallMs: Type.Optional(Type.Number()),
			plan: Type.Optional(
				Type.Array(
					Type.Object({ id: Type.String(), text: Type.String(), status: STEP_STATUS_SCHEMA }),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { state } = readGoal(ctx);
			if (!state) return getErrorResult("No active goal. Use create_goal first.");

			const budgetPatch: GoalBudgets = {
				maxTurns: params.maxTurns,
				maxToolCalls: params.maxToolCalls,
				maxCostUsd: params.maxCostUsd,
				maxTokens: params.maxTokens,
				maxWallMs: params.maxWallMs,
			};
			const cleanBudgetPatch = Object.fromEntries(Object.entries(budgetPatch).filter(([, value]) => value !== undefined)) as GoalBudgets;
			const patch = {
				summary: params.summary ?? params.progressNote,
				nextAction: params.nextAction,
				blockers: params.blockers,
				plan: params.plan,
				mode: params.mode,
				budgets: Object.keys(cleanBudgetPatch).length > 0 ? cleanBudgetPatch : undefined,
			};
			const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));

			let updated = state;
			if (Object.keys(cleanPatch).length > 0 || params.progressNote) {
				updated = appendGoalEvent(pi, ctx, updateEvent(state.goalId, {
					kind: "updated",
					goalId: state.goalId,
					patch: cleanPatch,
					note: params.progressNote,
					at: nowIso(),
				} as GoalEvent & { kind: "updated" })) ?? updated;
			}
			if (params.status) {
				updated = appendGoalEvent(pi, ctx, statusEvent(state.goalId, params.status, params.summary ?? params.progressNote)) ?? updated;
				if (params.status !== "active") continuationQueuedForGoalId = undefined;
			}
			return { ...getGoalResult(updated), terminate: params.status === "completed" || params.status === "cancelled" || params.status === "blocked" };
		},
	});

	pi.on("context", async (event) => {
		const state = cachedState;
		const keepGoalContext = state?.status === "active" && (state.mode === "assist" || state.mode === "auto");
		if (keepGoalContext) return;
		return {
			messages: event.messages.filter((message) => {
				const msg = message as { customType?: string; role?: string; content?: unknown };
				if (msg.customType === GOAL_STEERING_CONTEXT || msg.customType === GOAL_CONTINUATION_CONTEXT) return false;
				const text = extractTextContent(msg.content);
				return !text.includes("[GOAL ACTIVE]") && !text.includes("[GOAL CONTINUATION]");
			}),
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const { state } = readGoal(ctx);
		refreshGoalUi(ctx, state);
		if (!state || state.status !== "active" || state.mode === "manual") return;
		return {
			message: {
				customType: GOAL_STEERING_CONTEXT,
				content: buildGoalSteeringPrompt(state),
				display: false,
				details: { goalId: state.goalId, mode: state.mode },
			},
		};
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		const { state } = readGoal(ctx);
		if (!state || state.status !== "active") return;
		lastAgentHadToolCalls = true;
		appendGoalEvent(pi, ctx, { kind: "accounting", goalId: state.goalId, delta: { toolCalls: 1 }, at: nowIso() });
	});

	pi.on("message_end", async (event, ctx) => {
		const message = (event as { message?: { role?: string; usage?: UsageLike } }).message;
		if (message?.role !== "assistant") return;
		const { state } = readGoal(ctx);
		if (!state || state.status !== "active") return;
		appendGoalEvent(pi, ctx, { kind: "accounting", goalId: state.goalId, delta: usageDelta(message.usage), at: nowIso() });
	});

	pi.on("agent_start", async () => {
		lastAgentHadToolCalls = false;
		continuationQueuedForGoalId = undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		const { state } = readGoal(ctx);
		refreshGoalUi(ctx, state);
		if (!state || state.status !== "active" || state.mode !== "auto") return;
		if (continuationQueuedForGoalId === state.goalId) return;

		const exceeded = budgetExceeded(state);
		if (exceeded) {
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "paused", `budget_exceeded: ${exceeded}`));
			ctx.ui.notify(`Goal auto-continuation paused: ${exceeded}.`, "warning");
			return;
		}
		if (hasPendingMessages(ctx)) {
			appendGoalEvent(pi, ctx, { kind: "continuation", goalId: state.goalId, action: "skipped", reason: "pending messages", at: nowIso() });
			return;
		}
		if (shouldStopForAssistantQuestion(event)) {
			appendGoalEvent(pi, ctx, { kind: "continuation", goalId: state.goalId, action: "stopped", reason: "assistant requested user input", at: nowIso() });
			return;
		}
		if (!lastAgentHadToolCalls && state.noProgressTurns >= MAX_NO_PROGRESS_CONTINUATIONS) {
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "paused", "auto-continuation stopped after repeated no-progress turns"));
			ctx.ui.notify("Goal auto-continuation paused after repeated no-progress turns.", "warning");
			return;
		}

		continuationQueuedForGoalId = state.goalId;
		appendGoalEvent(pi, ctx, { kind: "continuation", goalId: state.goalId, action: "queued", reason: "auto-continuation", at: nowIso() });
		pi.sendMessage(
			{
				customType: GOAL_CONTINUATION_CONTEXT,
				content: buildGoalContinuationPrompt(state),
				display: false,
				details: { goalId: state.goalId, reason: "auto-continuation" },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		refreshGoalUi(ctx, undefined);
		continuationQueuedForGoalId = undefined;
	});
}
