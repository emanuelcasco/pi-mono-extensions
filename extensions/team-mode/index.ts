/**
 * Pi Teams — Extension Entry Point
 *
 * Multi-agent team coordination for Pi sessions. Allows the LLM to spawn and
 * manage background teams of sub-agents that work concurrently on complex tasks.
 *
 * Registers:
 *  - 12+ LLM-callable tools  (team_create, team_status, team_list, team_watch, ...)
 *  - 1   slash command       (/team)
 *  - 4   lifecycle handlers  (session_start, session_switch, agent_end, session_shutdown)
 */

import type { ExtensionAPI, ExtensionContext, SessionSwitchEvent } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

import { TeamStore } from "./core/store.js";
import { TeamManager } from "./managers/team-manager.js";
import { TaskManager } from "./managers/task-manager.js";
import { SignalManager } from "./managers/signal-manager.js";
import { MailboxManager } from "./managers/mailbox-manager.js";
import { ApprovalManager } from "./managers/approval-manager.js";
import {
	formatCompactSignals,
	formatCompactTaskBoard,
	formatCompactTeamSummary,
	formatCompactTeammateSummary,
	formatDashboard,
	formatSignals,
	formatTaskBoard,
	formatTeamSummary,
	formatTeammateSummary,
} from "./ui/formatters.js";
import { updateTeamWidget } from "./ui/widget.js";
import { LeaderRuntime } from "./runtime/leader-runtime.js";
import { WatchManager } from "./runtime/watch-mode.js";
import {
	DEFAULT_MODEL_CONFIG,
	detectProvider,
	isModelTier,
	loadModelConfig,
	saveModelConfig,
	type ModelConfig,
} from "./core/model-config.js";

// ---------------------------------------------------------------------------
// /team subcommand definitions — single source of truth for autocomplete + handler
// ---------------------------------------------------------------------------

const TEAM_SUBCOMMANDS = [
	{ value: "list", label: "list", description: "Show team dashboard", needsTeamId: false },
	{ value: "status", label: "status", description: "Show team summary", needsTeamId: true },
	{ value: "tasks", label: "tasks", description: "Show task board", needsTeamId: true },
	{ value: "signals", label: "signals", description: "Show recent signals", needsTeamId: true },
	{ value: "ask", label: "ask", description: "Ask leader or teammate a question", needsTeamId: true },
	{ value: "stop", label: "stop", description: "Stop a running team", needsTeamId: true },
	{ value: "resume", label: "resume", description: "Resume a stopped team", needsTeamId: true },
	{ value: "watch", label: "watch", description: "Start live monitoring", needsTeamId: true },
	{ value: "unwatch", label: "unwatch", description: "Stop live monitoring", needsTeamId: false },
	{ value: "models", label: "models", description: "Show or configure teammate model tiers", needsTeamId: false },
] as const;

const TEAM_ID_SUBCOMMANDS: ReadonlySet<string> = new Set(
	TEAM_SUBCOMMANDS.filter((s) => s.needsTeamId).map((s) => s.value),
);

// ---------------------------------------------------------------------------
// Manager bundle — initialized on session_start / session_switch
// ---------------------------------------------------------------------------

/** All manager instances bundled together for easy access. */
type ManagerBundle = {
	store: TeamStore;
	teamManager: TeamManager;
	taskManager: TaskManager;
	signalManager: SignalManager;
	mailboxManager: MailboxManager;
	approvalManager: ApprovalManager;
	leaderRuntime: LeaderRuntime;
	watchManager: WatchManager;
};

let managers: ManagerBundle | undefined;

/** (Re-)create all manager instances for the given project root. */
function initManagers(cwd: string): void {
	const store = new TeamStore(cwd);
	const teamManager = new TeamManager(store);
	const taskManager = new TaskManager(store);
	const signalManager = new SignalManager(store);
	const mailboxManager = new MailboxManager(store);
	const approvalManager = new ApprovalManager(store);
	managers = {
		store,
		teamManager,
		taskManager,
		signalManager,
		mailboxManager,
		approvalManager,
		leaderRuntime: new LeaderRuntime(store, teamManager, taskManager, signalManager, mailboxManager),
		watchManager: new WatchManager(store, signalManager),
	};
}

/** Return the active manager bundle, throwing a clear error if not initialized. */
function getManagers(): ManagerBundle {
	if (!managers) {
		throw new Error("Team managers not initialized — is a session active?");
	}
	return managers;
}

// ---------------------------------------------------------------------------
// Widget helpers
// ---------------------------------------------------------------------------

/** Statuses that should remain visible in the widget. */
const WIDGET_ACTIVE_STATUSES: import("./core/types.js").TeamStatus[] = [
	"initializing",
	"running",
	"paused",
	"failed",
];

/** Refresh the team status widget with the current list of active teams. */
async function refreshWidget(ctx: ExtensionContext): Promise<void> {
	if (!managers) return;
	try {
		// Only show teams that are still active — hide completed/cancelled ones.
		const teams = await managers.teamManager.listTeams({ status: WIDGET_ACTIVE_STATUSES });
		updateTeamWidget(ctx, teams);
	} catch {
		// Widget updates are best-effort — never surface errors from here.
	}
}

type TeamQueryParams = {
	action: "status" | "tasks" | "signals" | "teammate" | "ask";
	teamId: string;
	taskStatus?: import("./core/types.js").TaskStatus;
	sinceLastCheck?: boolean;
	signalType?: string;
	name?: string;
	target?: string;
	question?: string;
	verbose?: boolean;
};

function buildCompactAskResponse(
	target: string,
	content: string[],
	forwarded = true,
): string {
	const lines = [
		`${target}: ${content[0] ?? "No current signal."}`,
		...(content[1] ? [content[1]] : []),
	];
	if (forwarded) {
		lines.push(`Forwarded to ${target}'s mailbox.`);
	}
	return lines.join("\n");
}

async function answerTeamQuestion(params: TeamQueryParams): Promise<string> {
	const { teamManager, mailboxManager } = getManagers();
	const team = await teamManager.getTeam(params.teamId);
	if (!team) {
		throw new Error(`Team not found: ${params.teamId}`);
	}

	const target = params.target;
	const question = params.question;
	if (!target || !question) {
		throw new Error("team_query action=ask requires target and question");
	}

	if (target === "leader") {
		const summary = await teamManager.getTeamSummary(params.teamId);
		const compact = [
			`${summary.progress.done}/${summary.progress.total} done in ${summary.currentPhase ?? "unknown"} phase`,
			summary.blockers.length > 0
				? `Blockers: ${summary.blockers.map((blocker) => blocker.reason).join("; ")}`
				: `Next: ${summary.nextMilestone ?? "continue execution"}`,
		];

		try {
			await mailboxManager.send(params.teamId, {
				from: "user",
				to: target,
				type: "question",
				message: question,
				attachments: [],
			});
		} catch {
			// best effort only
		}

		if (!params.verbose) {
			return buildCompactAskResponse(target, compact);
		}

		const lines = [
			`Question for leader in team ${team.name} (${params.teamId}):`,
			`"${question}"`,
			"",
			"**Answer from current team state:**",
			`Phase: ${summary.currentPhase ?? "unknown"}`,
			`Progress: ${summary.progress.done}/${summary.progress.total} tasks done`,
		];
		if (summary.blockers.length > 0) {
			lines.push("Blockers:");
			for (const blocker of summary.blockers) {
				lines.push(`  - ${blocker.taskId} (${blocker.owner}): ${blocker.reason}`);
			}
		} else {
			lines.push("Blockers: none");
		}
		if (summary.approvalsPending.length > 0) {
			lines.push("Approvals pending:");
			for (const approval of summary.approvalsPending) {
				lines.push(`  - ${approval.taskId} (${approval.owner}): ${approval.artifact}`);
			}
		}
		const activeTeammates = summary.teammates.filter((teammate) => teammate.status === "in_progress");
		if (activeTeammates.length > 0) {
			lines.push("Active teammates:");
			for (const teammate of activeTeammates) {
				lines.push(`  - ${teammate.name}: ${teammate.summary ?? teammate.currentTask ?? "running"}`);
			}
		}
		if (summary.nextMilestone) {
			lines.push(`Next milestone: ${summary.nextMilestone}`);
		}
		lines.push("", `Note: question forwarded to ${target}'s mailbox for explicit follow-up.`);
		return lines.join("\n");
	}

	const teammate = await teamManager.getTeammateSummary(params.teamId, target);
	if (!teammate) {
		throw new Error(
			`Teammate "${target}" not found in team "${params.teamId}". Available roles: ${team.teammates.join(", ")}`,
		);
	}

	try {
		await mailboxManager.send(params.teamId, {
			from: "user",
			to: target,
			type: "question",
			message: question,
			attachments: [],
		});
	} catch {
		// best effort only
	}

	const compact = [
		teammate.currentTask
			? `${teammate.status} on ${teammate.currentTask.id} — ${teammate.currentTask.title}`
			: `${teammate.status} with no active task`,
		teammate.currentTask?.blocker
			? `Blocker: ${teammate.currentTask.blocker}`
			: teammate.lastOutput
				? `Last output: ${teammate.lastOutput.trim().slice(0, 120)}`
				: "No fresh output yet.",
	];

	if (!params.verbose) {
		return buildCompactAskResponse(target, compact);
	}

	const lines = [
		`Question for ${target} in team ${team.name} (${params.teamId}):`,
		`"${question}"`,
		"",
		`**Answer from ${target}'s current state:**`,
		`Status: ${teammate.status}`,
	];
	if (teammate.currentTask) {
		lines.push(`Current task: ${teammate.currentTask.id} — ${teammate.currentTask.title} (${teammate.currentTask.status})`);
		if (teammate.currentTask.blocker) {
			lines.push(`Blocker: ${teammate.currentTask.blocker}`);
		}
	} else {
		lines.push("Current task: none assigned");
	}
	if (teammate.worktree) {
		lines.push(`Worktree: ${teammate.worktree}`);
	}
	if (teammate.artifacts.length > 0) {
		lines.push(`Artifacts: ${teammate.artifacts.join(", ")}`);
	}
	if (teammate.lastOutput) {
		const preview = teammate.lastOutput.trim().slice(0, 300);
		lines.push("Last output preview:");
		lines.push(preview.replace(/^/gm, "  "));
		if (teammate.lastOutput.length > 300) lines.push("  ...");
	}
	lines.push("", `Note: question forwarded to ${target}'s mailbox for explicit follow-up.`);
	return lines.join("\n");
}

async function executeTeamQuery(params: TeamQueryParams, ctx?: ExtensionContext): Promise<{ text: string; details: unknown }> {
	const { teamManager, taskManager, signalManager } = getManagers();

	switch (params.action) {
		case "status": {
			const summary = await teamManager.getTeamSummary(params.teamId);
			await teamManager.markChecked(params.teamId);
			if (ctx) await refreshWidget(ctx);
			return {
				text: params.verbose ? formatTeamSummary(summary) : formatCompactTeamSummary(summary),
				details: summary,
			};
		}

		case "tasks": {
			const board = await taskManager.getTaskBoard(params.teamId);
			const filtered = params.taskStatus
				? { ...board, tasks: board.tasks.filter((task) => task.status === params.taskStatus) }
				: board;
			return {
				text: params.verbose ? formatTaskBoard(filtered) : formatCompactTaskBoard(filtered),
				details: filtered,
			};
		}

		case "signals": {
			const useSinceLastCheck = params.sinceLastCheck !== false;
			let signals = useSinceLastCheck
				? await signalManager.getSignalsSinceLastCheck(params.teamId)
				: await signalManager.getSignals(params.teamId);
			if (params.signalType) {
				signals = signals.filter((signal) => signal.type === params.signalType);
			}
			const renderedSignals = params.verbose ? signals : signals.slice(-10);
			return {
				text: params.verbose ? formatSignals(renderedSignals) : formatCompactSignals(renderedSignals),
				details: { signals, count: signals.length },
			};
		}

		case "teammate": {
			if (!params.name) {
				throw new Error("team_query action=teammate requires name");
			}
			const summary = await teamManager.getTeammateSummary(params.teamId, params.name);
			if (!summary) {
				throw new Error(
					`Teammate "${params.name}" not found in team "${params.teamId}". Check that the role name and team ID are correct.`,
				);
			}
			return {
				text: params.verbose ? formatTeammateSummary(summary) : formatCompactTeammateSummary(summary),
				details: summary,
			};
		}

		case "ask": {
			const text = await answerTeamQuestion(params);
			return {
				text,
				details: { teamId: params.teamId, target: params.target, question: params.question },
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Extension default export
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// /team models — handler for the model-tier configuration subcommand
// ---------------------------------------------------------------------------

function formatModelsConfig(config: ModelConfig): string {
	const activeProvider = detectProvider(config.provider);
	const catalog = config.providers[activeProvider];
	const lines: string[] = [];

	lines.push("## Team model configuration");
	lines.push("");
	lines.push(`Provider: **${config.provider}** (resolves to \`${activeProvider}\`)`);
	lines.push(`Default tier: **${config.defaultTier}**`);
	lines.push("");

	lines.push("### Active catalog");
	if (catalog) {
		for (const tier of ["cheap", "mid", "deep"] as const) {
			lines.push(`- ${tier}: \`${catalog[tier]}\``);
		}
	} else {
		lines.push(`_No catalog defined for \`${activeProvider}\`._`);
	}

	lines.push("");
	lines.push("### Role → tier");
	const roles = Object.keys(config.roleTiers).sort();
	for (const role of roles) {
		const tier = config.roleTiers[role];
		const model = catalog?.[tier] ?? "—";
		lines.push(`- ${role} → ${tier} (\`${model}\`)`);
	}

	lines.push("");
	lines.push("### All known providers");
	for (const [name, c] of Object.entries(config.providers)) {
		lines.push(`- ${name}: cheap=\`${c.cheap}\`, mid=\`${c.mid}\`, deep=\`${c.deep}\``);
	}

	lines.push("");
	lines.push("Commands:");
	lines.push("  /team models show");
	lines.push("  /team models provider <name|auto>");
	lines.push("  /team models role <role> <cheap|mid|deep>");
	lines.push("  /team models set <provider> <cheap|mid|deep> <modelId>");
	lines.push("  /team models default-tier <cheap|mid|deep>");
	lines.push("  /team models reset");

	return lines.join("\n");
}

async function handleModelsSubcommand(
	args: string[],
	teamsDir: string,
	onChange: () => void,
): Promise<string> {
	const action = (args[0] ?? "show").toLowerCase();
	const config = await loadModelConfig(teamsDir);

	switch (action) {
		case "show":
		case "": {
			return formatModelsConfig(config);
		}

		case "provider": {
			const provider = args[1];
			if (!provider) throw new Error("Usage: /team models provider <name|auto>");
			if (provider !== "auto" && !config.providers[provider]) {
				throw new Error(
					`Unknown provider "${provider}". Known: ${Object.keys(config.providers).join(", ")}, auto`,
				);
			}
			const next: ModelConfig = { ...config, provider };
			await saveModelConfig(teamsDir, next);
			onChange();
			return `Provider set to **${provider}**\n\n` + formatModelsConfig(next);
		}

		case "role": {
			const role = args[1];
			const tier = args[2];
			if (!role || !tier) throw new Error("Usage: /team models role <role> <cheap|mid|deep>");
			if (!isModelTier(tier)) throw new Error(`Invalid tier "${tier}". Use cheap, mid, or deep.`);
			const next: ModelConfig = {
				...config,
				roleTiers: { ...config.roleTiers, [role]: tier },
			};
			await saveModelConfig(teamsDir, next);
			onChange();
			return `Role **${role}** set to tier **${tier}**`;
		}

		case "set": {
			const provider = args[1];
			const tier = args[2];
			const model = args.slice(3).join(" ").trim();
			if (!provider || !tier || !model) {
				throw new Error("Usage: /team models set <provider> <cheap|mid|deep> <modelId>");
			}
			if (!isModelTier(tier)) throw new Error(`Invalid tier "${tier}". Use cheap, mid, or deep.`);
			const existing = config.providers[provider] ?? { cheap: "", mid: "", deep: "" };
			const next: ModelConfig = {
				...config,
				providers: {
					...config.providers,
					[provider]: { ...existing, [tier]: model },
				},
			};
			await saveModelConfig(teamsDir, next);
			onChange();
			return `Set ${provider}.${tier} = \`${model}\``;
		}

		case "default-tier": {
			const tier = args[1];
			if (!tier || !isModelTier(tier)) throw new Error("Usage: /team models default-tier <cheap|mid|deep>");
			const next: ModelConfig = { ...config, defaultTier: tier };
			await saveModelConfig(teamsDir, next);
			onChange();
			return `Default tier set to **${tier}**`;
		}

		case "reset": {
			await saveModelConfig(teamsDir, DEFAULT_MODEL_CONFIG);
			onChange();
			return "Model configuration reset to defaults\n\n" + formatModelsConfig(DEFAULT_MODEL_CONFIG);
		}

		default:
			throw new Error(`Unknown models action "${action}". Try: show, provider, role, set, default-tier, reset`);
	}
}

export default function (pi: ExtensionAPI): void {
	// -------------------------------------------------------------------------
	// Message renderer for /team command output
	// -------------------------------------------------------------------------

	pi.registerMessageRenderer("team-output", (message, _options, theme) => {
		return new Text(theme.fg("accent", "teams ") + message.content, 0, 0);
	});

	// -------------------------------------------------------------------------
	// Tool: team_create
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_create",
		label: "Create Team",
		description:
			"Create a new background team with a defined objective, optional template, and custom roster. " +
			"Returns a confirmation with the team ID, roster, and initial status.",
		promptSnippet: "Create and launch a new background team for multi-agent work",
		promptGuidelines: [
			"Use team_create when the user wants to start a background team for complex multi-step work",
			"Prefer providing only the objective unless the user explicitly asked for a custom name, template, or teammate roster",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "What the team should accomplish" }),
			name: Type.Optional(Type.String({ description: "Human-readable team name (generated from objective if omitted)" })),
			template: Type.Optional(
				StringEnum(["fullstack", "research", "refactor"] as const, {
					description: "Named preset that bootstraps the team with a predefined roster",
				}),
			),
			teammates: Type.Optional(
				Type.Array(Type.String(), {
					description: "Teammate role names to include (merged with template roles when both are provided)",
				}),
			),
			repoRoots: Type.Optional(
				Type.Array(Type.String(), {
					description: "Repository root paths accessible to this team",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teamManager, leaderRuntime } = getManagers();

			try {
				const team = await teamManager.createTeam(params.objective, {
					name: params.name,
					template: params.template,
					teammates: params.teammates,
					repoRoots: params.repoRoots,
				});

				await refreshWidget(ctx);

				let leaderLaunchNote = "";
				let effectiveStatus = team.status;
				try {
					await leaderRuntime.launchLeader(team.id);
					effectiveStatus = "running";
				} catch (leaderErr) {
					leaderLaunchNote = `\n\nNote: Leader launch failed: ${leaderErr instanceof Error ? leaderErr.message : String(leaderErr)}. Use team_control to retry.`;
				}

				const rosterLine =
					team.teammates.length > 0
						? `Roster: ${team.teammates.join(", ")}`
						: "Roster: (empty — assign teammates later)";

				const text = [
					`Team created: ${team.name} (${team.id})`,
					`Status: ${effectiveStatus}`,
					rosterLine,
					`Objective: ${team.objective}`,
				].join("\n") + leaderLaunchNote;

				return {
					content: [{ type: "text", text }],
					details: team,
				};
			} catch (err) {
				throw new Error(
					`Failed to create team: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_list
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_list",
		label: "List Teams",
		description:
			"List all active teams and their current status. Optionally filter to teams that need attention " +
			"(blocked tasks, pending approvals, or error signals).",
		promptSnippet: "List all active teams and their current status",
		parameters: Type.Object({
			needsAttention: Type.Optional(
				Type.Boolean({
					description: "When true, only return teams that need user intervention",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { teamManager } = getManagers();

			try {
				const dashboard = await teamManager.getDashboard();

				if (params.needsAttention) {
					const attentionItems = dashboard.needsAttention;
					if (attentionItems.length === 0) {
						return {
							content: [{ type: "text", text: "No teams currently need attention." }],
							details: dashboard,
						};
					}

					const lines = ["Teams needing attention:", ""];
					for (const item of attentionItems) {
						lines.push(`⚠ ${item.teamId}: ${item.reason}`);
					}

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: dashboard,
					};
				}

				return {
					content: [{ type: "text", text: formatDashboard(dashboard) }],
					details: dashboard,
				};
			} catch (err) {
				throw new Error(
					`Failed to list teams: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_query
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_query",
		label: "Query Team",
		description:
			"Query team state through a single compact read tool. Supports status, tasks, signals, teammate snapshots, and targeted questions.",
		promptSnippet: "Query team status, tasks, signals, teammate snapshots, or ask a focused question",
		promptGuidelines: [
			"Prefer team_query over multiple separate read calls when inspecting a team",
			"Default responses are compact; set verbose=true only when the user explicitly wants a full formatted view",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "tasks", "signals", "teammate", "ask"] as const, {
				description: "Which read operation to perform",
			}),
			teamId: Type.String({ description: "The team ID" }),
			taskStatus: Type.Optional(
				StringEnum(
					[
						"todo",
						"ready",
						"planning",
						"awaiting_approval",
						"in_progress",
						"blocked",
						"in_review",
						"done",
						"cancelled",
					] as const,
					{ description: "Optional task filter when action=tasks" },
				),
			),
			sinceLastCheck: Type.Optional(
				Type.Boolean({
					description: "When action=signals, default true returns only updates since the last check",
				}),
			),
			signalType: Type.Optional(
				Type.String({ description: "Optional signal type filter when action=signals" }),
			),
			name: Type.Optional(
				Type.String({ description: "Teammate role name when action=teammate" }),
			),
			target: Type.Optional(
				Type.String({ description: "Target role or 'leader' when action=ask" }),
			),
			question: Type.Optional(
				Type.String({ description: "Question text when action=ask" }),
			),
			verbose: Type.Optional(
				Type.Boolean({ description: "Return the full formatted view instead of the compact default" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await executeTeamQuery(params, ctx);
				return {
					content: [{ type: "text", text: result.text }],
					details: result.details,
				};
			} catch (err) {
				throw new Error(
					`Failed to query team: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_message
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_message",
		label: "Send Team Message",
		description:
			"Send guidance or a directive to the team leader or a specific teammate via the team mailbox.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			target: Type.String({
				description: "Recipient role name, 'leader' for the team leader, or 'all' to broadcast",
			}),
			message: Type.String({ description: "The message content to send" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { mailboxManager } = getManagers();

			try {
				const msg = await mailboxManager.send(params.teamId, {
					from: "user",
					to: params.target,
					type: "guidance",
					message: params.message,
					attachments: [],
				});

				const text = `Message sent to ${params.target} in team ${params.teamId} (${msg.id}).`;
				return {
					content: [{ type: "text", text }],
					details: msg,
				};
			} catch (err) {
				throw new Error(
					`Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_review
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_review",
		label: "Review Plan",
		description:
			"Approve or reject a submitted plan for a task that requires sign-off before execution.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			taskId: Type.String({ description: "The task ID whose plan should be reviewed" }),
			action: StringEnum(["approve", "reject"] as const, {
				description: "Whether to approve or reject the submitted plan",
			}),
			feedback: Type.Optional(Type.String({ description: "Required when rejecting the plan" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { approvalManager, taskManager } = getManagers();

			try {
				const pending = await approvalManager.getApprovalForTask(params.teamId, params.taskId);
				if (!pending) {
					throw new Error(
						`No approval request found for task "${params.taskId}" in team "${params.teamId}".`,
					);
				}

				if (params.action === "approve") {
					const updated = await approvalManager.approve(params.teamId, pending.id, "user");
					await taskManager.updateTask(params.teamId, params.taskId, {
						status: "ready",
						blockers: [],
					});
					await refreshWidget(ctx);
					return {
						content: [{ type: "text", text: `Plan approved for task ${params.taskId} in team ${params.teamId}.` }],
						details: updated,
					};
				}

				if (!params.feedback?.trim()) {
					throw new Error("feedback is required when action=reject");
				}

				const updated = await approvalManager.reject(
					params.teamId,
					pending.id,
					"user",
					params.feedback,
				);
				await taskManager.updateTask(params.teamId, params.taskId, {
					status: "blocked",
					blockers: [params.feedback],
				});
				await refreshWidget(ctx);

				return {
					content: [{ type: "text", text: `Plan rejected for task ${params.taskId} in team ${params.teamId}.` }],
					details: updated,
				};
			} catch (err) {
				throw new Error(
					`Failed to review plan: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_control
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_control",
		label: "Control Team",
		description: "Stop or resume a team. Use stop to pause execution and resume to continue.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to control" }),
			action: StringEnum(["stop", "resume"] as const, {
				description: "The control action: stop to cancel the team, resume to restart it",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teamManager, leaderRuntime } = getManagers();

			try {
				let updated;
				if (params.action === "stop") {
					await leaderRuntime.stopTeam(params.teamId);
					updated = await teamManager.stopTeam(params.teamId);
				} else {
					updated = await teamManager.resumeTeam(params.teamId);
					try {
						await leaderRuntime.launchLeader(params.teamId);
					} catch {
						// Non-fatal: the team is resumed even if the leader fails to relaunch.
					}
				}

				await refreshWidget(ctx);

				const text = `Team ${params.teamId} ${params.action === "stop" ? "stopped" : "resumed"}. Status: ${updated.status}`;
				return {
					content: [{ type: "text", text }],
					details: updated,
				};
			} catch (err) {
				throw new Error(
					`Failed to ${params.action} team: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_spawn_teammate
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_spawn_teammate",
		label: "Spawn Teammate",
		description:
			"Spawn a teammate subprocess to work on a specific task. The teammate runs as an isolated pi process with its own context.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			role: Type.String({ description: "Teammate role (backend, frontend, researcher, reviewer, etc.)" }),
			taskId: Type.String({ description: "The task ID to assign to the teammate" }),
			taskDescription: Type.String({ description: "Full, self-contained description of what the teammate should do" }),
			context: Type.Optional(Type.String({ description: "Additional context (research findings, contracts, etc.)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the teammate process" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const m = getManagers();
			try {
				const process = await m.leaderRuntime.spawnTeammate(
					params.teamId,
					params.role,
					params.taskId,
					params.taskDescription,
					params.context,
					params.cwd,
				);
				await refreshWidget(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Teammate ${params.role} spawned for task ${params.taskId} in team ${params.teamId}. PID: ${process.pid ?? "N/A"}`,
						},
					],
					details: process,
				};
			} catch (err) {
				throw new Error(`Failed to spawn teammate: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_memory
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_memory",
		label: "Write Team Memory",
		description:
			"Write durable team knowledge to long-lived memory that persists after the team completes. " +
			"Use 'discoveries' for codebase findings, 'decisions' for choices made and why, " +
			"and 'contracts' for agreed API schemas or interface specifications. " +
			"Content is appended to the named memory document and injected into future teammate contexts.",
		promptSnippet: "Record important team knowledge that persists across team runs",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			type: StringEnum(
				["discoveries", "decisions", "contracts"] as const,
				{
					description:
						"Which memory document to write to: 'discoveries' (codebase findings), " +
						"'decisions' (choices + rationale), or 'contracts' (API/interface specs)",
				},
			),
			content: Type.String({
				description: "Content to append to the memory document (Markdown supported)",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { store } = getManagers();

			try {
				const existing =
					await store.loadMemory(
						params.teamId,
						params.type as "discoveries" | "decisions" | "contracts",
					) ?? "";
				const separator = existing.trim() ? "\n\n---\n\n" : "";
				const updated = `${existing}${separator}${params.content}`;
				await store.saveMemory(
					params.teamId,
					params.type as "discoveries" | "decisions" | "contracts",
					updated,
				);

				const text = [
					`Team memory updated: ${params.type} for team ${params.teamId}.`,
					`Document length: ${updated.length} characters.`,
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: { teamId: params.teamId, type: params.type, length: updated.length },
				};
			} catch (err) {
				throw new Error(
					`Failed to write team memory: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_watch
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_watch",
		label: "Watch Team",
		description: "Start live monitoring of a team. Shows compact signal updates in a widget below the editor.",
		promptSnippet: "Start streaming live updates for a team",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to watch" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const m = getManagers();
			try {
				await m.watchManager.startWatch(params.teamId, ctx);
				return {
					content: [
						{
							type: "text",
							text: `Now watching team ${params.teamId}. Updates will appear below the editor. Use /team unwatch to stop.`,
						},
					],
					details: { teamId: params.teamId, watching: true },
				};
			} catch (err) {
				throw new Error(`Failed to start watch: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Slash command: /team
	// -------------------------------------------------------------------------

	/**
	 * /team <objective>          — create a new team (default action)
	 * /team list                 — show dashboard
	 * /team status <id>          — show team summary
	 * /team tasks <id>           — show task board
	 * /team signals <id>         — show recent signals
	 * /team stop <id>            — stop a team
	 * /team resume <id>          — resume a team
	 */
	pi.registerCommand("team", {
		description: "Create a team: /team <objective>. Or manage: /team list|status|tasks|signals|stop|resume <id>",
		getArgumentCompletions: async (prefix: string) => {
			const parts = prefix.trimStart().split(/\s+/);

			if (parts.length <= 1) {
				const partial = (parts[0] ?? "").toLowerCase();
				const matches = TEAM_SUBCOMMANDS.filter((s) => s.value.startsWith(partial));
				return matches.length > 0 ? matches.map((s) => ({ value: s.value, label: s.label, description: s.description })) : null;
			}

			const sub = parts[0].toLowerCase();
			if (TEAM_ID_SUBCOMMANDS.has(sub) && parts.length === 2) {
				if (!managers) return null;
				try {
					const teams = await managers.teamManager.listTeams();
					const partial = parts[1].toLowerCase();
					const items = teams
						.filter(
							(t) =>
								t.id.toLowerCase().startsWith(partial) ||
								t.name.toLowerCase().startsWith(partial),
						)
						.map((t) => ({
							value: `${sub} ${t.id}`,
							label: t.id,
							description: `${t.name} (${t.status})`,
						}));
					return items.length > 0 ? items : null;
				} catch {
					return null;
				}
			}

			return null;
		},
		handler: async (args, ctx) => {
			if (!managers) {
				ctx.ui.notify("Team managers not initialized", "error");
				return;
			}
			const { teamManager, leaderRuntime, watchManager } = managers;

			const parts = (args?.trim() ?? "").split(/\s+/).filter(Boolean);
			const subcommand = parts[0]?.toLowerCase() ?? "";

			switch (subcommand) {
				case "list": {
					try {
						const dashboard = await teamManager.getDashboard();
						pi.sendMessage(
							{ customType: "team-output", content: formatDashboard(dashboard), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get dashboard: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "status": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team status <id>", "warning");
						return;
					}
					try {
						const result = await executeTeamQuery({ action: "status", teamId, verbose: true }, ctx);
						pi.sendMessage(
							{ customType: "team-output", content: result.text, display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get status: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "tasks": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team tasks <id>", "warning");
						return;
					}
					try {
						const result = await executeTeamQuery({ action: "tasks", teamId, verbose: true }, ctx);
						pi.sendMessage(
							{ customType: "team-output", content: result.text, display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get tasks: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "signals": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team signals <id>", "warning");
						return;
					}
					try {
						const result = await executeTeamQuery({ action: "signals", teamId, verbose: true }, ctx);
						pi.sendMessage(
							{ customType: "team-output", content: result.text, display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get signals: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "ask": {
					// /team ask <teamId> <target> <question...>
					const teamId = parts[1];
					const target = parts[2];
					const question = parts.slice(3).join(" ").trim();
					if (!teamId || !target || !question) {
						ctx.ui.notify("Usage: /team ask <teamId> <target> <question>", "warning");
						return;
					}
					try {
						const result = await executeTeamQuery({ action: "ask", teamId, target, question, verbose: true }, ctx);
						pi.sendMessage(
							{ customType: "team-output", content: result.text, display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to ask: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "stop": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team stop <id>", "warning");
						return;
					}
					try {
						await leaderRuntime.stopTeam(teamId);
						await teamManager.stopTeam(teamId);
						await refreshWidget(ctx);
						ctx.ui.notify(`Team ${teamId} stopped`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to stop team: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "resume": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team resume <id>", "warning");
						return;
					}
					try {
						await teamManager.resumeTeam(teamId);
						try {
							await leaderRuntime.launchLeader(teamId);
						} catch {
							// non-fatal
						}
						await refreshWidget(ctx);
						ctx.ui.notify(`Team ${teamId} resumed`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to resume team: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "watch": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team watch <id>", "warning");
						return;
					}
					try {
						await watchManager.startWatch(teamId, ctx);
						ctx.ui.notify(`Now watching team ${teamId}`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to start watch: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "unwatch": {
					watchManager.stopWatch(ctx);
					ctx.ui.notify("Watch stopped", "info");
					break;
				}

				case "models": {
					try {
						const output = await handleModelsSubcommand(parts.slice(1), managers.store.getTeamsDir(), () => {
							managers?.leaderRuntime.reloadModelConfig();
						});
						pi.sendMessage(
							{ customType: "team-output", content: output, display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`models: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				default: {
					// Default action: treat entire args as an objective and create a team.
					const objective = (args?.trim() ?? "");
					if (!objective) {
						ctx.ui.notify("Usage: /team <objective> — creates a new team", "warning");
						return;
					}
					try {
						const team = await teamManager.createTeam(objective);
						try {
							await leaderRuntime.launchLeader(team.id);
						} catch {
							// non-fatal
						}
						await refreshWidget(ctx);
						ctx.ui.notify(`Team "${team.name}" created (${team.id})`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to create team: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}
			}
		},
	});

	// -------------------------------------------------------------------------
	// Lifecycle event handlers
	// -------------------------------------------------------------------------

	/** Initialize managers when a session starts. */
	pi.on("session_start", async (_event, ctx) => {
		if (managers) {
			await managers.leaderRuntime.cleanup();
			managers.watchManager.cleanup();
		}
		initManagers(ctx.cwd);
		// Wire up the status-change callback so the widget refreshes when a
		// team completes, fails, or stops in the background (outside an agent turn).
		if (managers) {
			managers.leaderRuntime.onStatusChange = () => {
				void refreshWidget(ctx);
			};
		}
		// Fix #1: teammate subprocesses must never spawn their own leader instances.
		// They set PI_TEAM_SUBPROCESS=1 in their env (see spawnPiJsonMode).
		if (!process.env.PI_TEAM_SUBPROCESS && managers) {
			const runningTeams = await managers.teamManager.listTeams({ status: ["running"] });
			for (const team of runningTeams) {
				try {
					await managers.leaderRuntime.launchLeader(team.id);
				} catch {
					// best effort only
				}
			}
		}
		await refreshWidget(ctx);
	});

	/** Re-initialize managers when switching sessions (cwd may differ). */
	pi.on("session_switch", async (_event: SessionSwitchEvent, ctx) => {
		if (managers) {
			await managers.leaderRuntime.cleanup();
			managers.watchManager.cleanup();
		}
		initManagers(ctx.cwd);
		// Wire up the status-change callback for the new session context.
		if (managers) {
			managers.leaderRuntime.onStatusChange = () => {
				void refreshWidget(ctx);
			};
		}
		await refreshWidget(ctx);
	});

	/** Refresh the widget after every agent turn to reflect any team state changes. */
	pi.on("agent_end", async (_event, ctx) => {
		await refreshWidget(ctx);
	});

	/** Clean up all team processes and watches on shutdown. */
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (managers) {
			await managers.leaderRuntime.cleanup();
			managers.watchManager.cleanup();
		}
	});
}
