// Cycle Runner Extension
//
// Adds a /loop command that keeps the agent running turn after turn until
// a configured exit condition is reached. The agent exits the cycle by
// calling the complete_loop tool once it determines the condition is met.

import { Type } from "@sinclair/typebox";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionSwitchEvent } from "@mariozechner/pi-coding-agent";
import { compact } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";

// The three available strategies for deciding when a cycle ends
type RepeatStrategy = "tests" | "custom" | "self";

// Shape of cycle state written to the session
type CycleState = {
	active: boolean;
	mode?: RepeatStrategy;
	condition?: string;
	prompt?: string;
	summary?: string;
	loopCount?: number;
};

// Entries shown in the interactive strategy picker
const MODE_CHOICES = [
	{ value: "tests", label: "Run until tests pass", description: "" },
	{ value: "custom", label: "Run until custom condition", description: "" },
	{ value: "self", label: "Agent-driven (agent decides when done)", description: "" },
] as const;

// Key used when writing cycle state to the session entry log
const PERSIST_ENTRY_TYPE = "loop-state";

// Haiku is fast and cheap — preferred for generating short summary labels
const FAST_MODEL = "claude-haiku-4-5";

// Instructions for the summariser that produces the short widget label
const CONDENSING_PROMPT = `Your job is to produce a short status label for a looping agent task.
The user will provide a description of the loop exit condition.
Respond with a brief phrase of at most 6 words describing when the loop stops.
No punctuation, no quotes, no explanation — only the phrase itself.

Use natural phrasing like "stops when tests pass", "loops until done", "exits on success", etc.
Choose whatever form fits the condition best.
`;

// Compose the follow-up message injected at the start of each iteration
function composeIterationMessage(mode: RepeatStrategy, condition?: string): string {
	if (mode === "tests") {
		return (
			"Run the full test suite. If all tests are passing, call the complete_loop tool. " +
			"If not, keep working until every test passes."
		);
	}
	if (mode === "custom") {
		const exitCondition = condition?.trim() || "the condition is met";
		return (
			`Keep working until this condition is satisfied: ${exitCondition}. ` +
			"Once satisfied, call the complete_loop tool."
		);
	}
	// mode === "self"
	return "Continue making progress. When you believe the task is fully complete, call the complete_loop tool.";
}

// Static fallback label used when the LLM summary isn't available yet
function shortConditionLabel(mode: RepeatStrategy, condition?: string): string {
	if (mode === "tests") return "tests pass";
	if (mode === "self") return "done";
	const text = condition?.trim() || "custom condition";
	return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

// Full description of the exit condition — fed to the summariser LLM
function describeBreakCondition(mode: RepeatStrategy, condition?: string): string {
	if (mode === "tests") return "tests pass";
	if (mode === "self") return "you are done";
	return condition?.trim() || "custom condition";
}

// Resolve the best available model for generating a condition summary
async function pickSummarizerModel(
	ctx: ExtensionContext,
): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string> } | null> {
	if (!ctx.model) return null;

	// Prefer the fast Haiku model on Anthropic providers
	if (ctx.model.provider === "anthropic") {
		const fastModel = ctx.modelRegistry.find("anthropic", FAST_MODEL);
		if (fastModel) {
			const credentials = await ctx.modelRegistry.getApiKeyAndHeaders(fastModel);
			if (credentials.ok) {
				return { model: fastModel, apiKey: credentials.apiKey, headers: credentials.headers };
			}
		}
	}

	// Fall back to the currently selected model
	const credentials = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!credentials.ok) return null;
	return { model: ctx.model, apiKey: credentials.apiKey, headers: credentials.headers };
}

// Ask a small LLM for a concise label describing when the cycle ends
async function generateConditionSummary(
	ctx: ExtensionContext,
	mode: RepeatStrategy,
	condition?: string,
): Promise<string> {
	const fallback = shortConditionLabel(mode, condition);
	const modelInfo = await pickSummarizerModel(ctx);
	if (!modelInfo) return fallback;

	const conditionDescription = describeBreakCondition(mode, condition);
	const msg: UserMessage = {
		role: "user",
		content: [{ type: "text", text: conditionDescription }],
		timestamp: Date.now(),
	};

	const result = await complete(
		modelInfo.model,
		{ systemPrompt: CONDENSING_PROMPT, messages: [msg] },
		{ apiKey: modelInfo.apiKey, headers: modelInfo.headers },
	);

	if (result.stopReason === "aborted" || result.stopReason === "error") {
		return fallback;
	}

	const phrase = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	if (!phrase) return fallback;
	return phrase.length > 60 ? `${phrase.slice(0, 57)}...` : phrase;
}

// Build the extra instruction injected into compaction prompts
function buildCompactHint(mode: RepeatStrategy, condition?: string): string {
	const description = describeBreakCondition(mode, condition);
	return `Cycle active. Exit condition: ${description}. Retain this cycle state and exit condition in the compacted summary.`;
}

// Keep the TUI status widget in sync with the current cycle state
function refreshWidget(ctx: ExtensionContext, state: CycleState): void {
	if (!ctx.hasUI) return;

	if (!state.active || !state.mode) {
		ctx.ui.setWidget("loop", undefined);
		return;
	}

	const iteration = state.loopCount ?? 0;
	const label = state.summary?.trim();
	const display = label
		? `Cycle running: ${label} (iteration ${iteration})`
		: `Cycle running (iteration ${iteration})`;

	ctx.ui.setWidget("loop", [ctx.ui.theme.fg("accent", display)]);
}

// Read the most recent cycle state written to the session
async function restoreFromSession(ctx: ExtensionContext): Promise<CycleState> {
	const allEntries = ctx.sessionManager.getEntries();
	for (let idx = allEntries.length - 1; idx >= 0; idx--) {
		const entry = allEntries[idx] as { type: string; customType?: string; data?: CycleState };
		if (entry.type === "custom" && entry.customType === PERSIST_ENTRY_TYPE && entry.data) {
			return entry.data;
		}
	}
	return { active: false };
}

// Parse strategy and condition from inline command arguments
function parseCommandInput(args: string | undefined): CycleState | null {
	if (!args?.trim()) return null;

	const tokens = args.trim().split(/\s+/);
	const strategyToken = tokens[0]?.toLowerCase();

	if (strategyToken === "tests") {
		return { active: true, mode: "tests", prompt: composeIterationMessage("tests") };
	}

	if (strategyToken === "self") {
		return { active: true, mode: "self", prompt: composeIterationMessage("self") };
	}

	if (strategyToken === "custom") {
		const cond = tokens.slice(1).join(" ").trim();
		if (!cond) return null;
		return {
			active: true,
			mode: "custom",
			condition: cond,
			prompt: composeIterationMessage("custom", cond),
		};
	}

	return null;
}

// Check whether the most recent assistant message was aborted mid-turn
function didAgentAbort(messages: Array<{ role?: string; stopReason?: string }>): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			return msg.stopReason === "aborted";
		}
	}
	return false;
}

export default function (pi: ExtensionAPI): void {
	// In-memory snapshot of the current cycle — kept in sync with session entries
	let cycleState: CycleState = { active: false };

	// Persist state to the session log
	function saveToSession(state: CycleState): void {
		pi.appendEntry(PERSIST_ENTRY_TYPE, state);
	}

	// Apply a new state object, persist it, and refresh the widget
	function activateCycle(state: CycleState, ctx: ExtensionContext): void {
		cycleState = state;
		saveToSession(state);
		refreshWidget(ctx, state);
	}

	// Reset to inactive state and clear the widget
	function deactivateCycle(ctx: ExtensionContext): void {
		const blank: CycleState = { active: false };
		cycleState = blank;
		saveToSession(blank);
		refreshWidget(ctx, blank);
	}

	// Stop the cycle and surface a notification
	function stopCycle(ctx: ExtensionContext): void {
		deactivateCycle(ctx);
		ctx.ui.notify("Cycle stopped", "info");
	}

	// Queue the next iteration's follow-up message
	function scheduleNextIteration(ctx: ExtensionContext): void {
		if (!cycleState.active || !cycleState.mode || !cycleState.prompt) return;
		if (ctx.hasPendingMessages()) return;

		const nextCount = (cycleState.loopCount ?? 0) + 1;
		cycleState = { ...cycleState, loopCount: nextCount };
		saveToSession(cycleState);
		refreshWidget(ctx, cycleState);

		pi.sendMessage(
			{ customType: "loop", content: cycleState.prompt, display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	// Show the TUI strategy selector and return the chosen cycle state
	async function presentModeChooser(ctx: ExtensionContext): Promise<CycleState | null> {
		const listItems: SelectItem[] = MODE_CHOICES.map((choice) => ({
			value: choice.value,
			label: choice.label,
			description: choice.description,
		}));

		const chosen = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const wrapper = new Container();
			wrapper.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			wrapper.addChild(new Text(theme.fg("accent", theme.bold("Choose a cycle strategy"))));

			const list = new SelectList(listItems, Math.min(listItems.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);

			wrapper.addChild(list);
			wrapper.addChild(new Text(theme.fg("dim", "Enter to select · Esc to cancel")));
			wrapper.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

			return {
				render(width: number) {
					return wrapper.render(width);
				},
				invalidate() {
					wrapper.invalidate();
				},
				handleInput(data: string) {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!chosen) return null;

		if (chosen === "tests") {
			return { active: true, mode: "tests", prompt: composeIterationMessage("tests") };
		}

		if (chosen === "self") {
			return { active: true, mode: "self", prompt: composeIterationMessage("self") };
		}

		if (chosen === "custom") {
			const userInput = await ctx.ui.editor("Describe the exit condition:", "");
			if (!userInput?.trim()) return null;
			return {
				active: true,
				mode: "custom",
				condition: userInput.trim(),
				prompt: composeIterationMessage("custom", userInput.trim()),
			};
		}

		return null;
	}

	// Load cycle state from the session and restore all UI state
	async function hydrateCycleState(ctx: ExtensionContext): Promise<void> {
		cycleState = await restoreFromSession(ctx);
		refreshWidget(ctx, cycleState);

		// Re-generate a missing summary label without blocking the UI
		if (cycleState.active && cycleState.mode && !cycleState.summary) {
			const savedMode = cycleState.mode;
			const savedCondition = cycleState.condition;
			void (async () => {
				const label = await generateConditionSummary(ctx, savedMode, savedCondition);
				if (!cycleState.active || cycleState.mode !== savedMode || cycleState.condition !== savedCondition) return;
				cycleState = { ...cycleState, summary: label };
				saveToSession(cycleState);
				refreshWidget(ctx, cycleState);
			})();
		}
	}

	// The agent calls this tool to signal that the exit condition is satisfied
	pi.registerTool({
		name: "complete_loop",
		label: "Complete Loop",
		description:
			"End the active cycle when the exit condition has been fully satisfied. Only call this tool when explicitly instructed to do so by the user, tool or system prompt.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!cycleState.active) {
				return {
					content: [{ type: "text", text: "No cycle is currently active." }],
					details: { active: false },
				};
			}

			deactivateCycle(ctx);

			return {
				content: [{ type: "text", text: "Cycle complete." }],
				details: { active: false },
			};
		},
	});

	pi.registerCommand("loop", {
		description: "Start a repeating cycle until an exit condition is met",
		handler: async (args, ctx) => {
			let nextState = parseCommandInput(args);

			if (!nextState) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /loop tests | /loop custom <condition> | /loop self", "warning");
					return;
				}
				nextState = await presentModeChooser(ctx);
			}

			if (!nextState) {
				ctx.ui.notify("Cycle start cancelled", "info");
				return;
			}

			if (cycleState.active) {
				const shouldReplace = ctx.hasUI
					? await ctx.ui.confirm(
							"Overwrite active cycle?",
							"A cycle is already running. Replace it with the new one?",
						)
					: true;
				if (!shouldReplace) {
					ctx.ui.notify("Existing cycle kept", "info");
					return;
				}
			}

			const initialState: CycleState = { ...nextState, summary: undefined, loopCount: 0 };
			activateCycle(initialState, ctx);
			ctx.ui.notify("Cycle started", "info");
			scheduleNextIteration(ctx);

			// Kick off asynchronous summary generation without blocking the turn
			const mode = nextState.mode!;
			const condition = nextState.condition;
			void (async () => {
				const label = await generateConditionSummary(ctx, mode, condition);
				if (!cycleState.active || cycleState.mode !== mode || cycleState.condition !== condition) return;
				cycleState = { ...cycleState, summary: label };
				saveToSession(cycleState);
				refreshWidget(ctx, cycleState);
			})();
		},
	});

	// After every agent turn: continue or offer to stop
	pi.on("agent_end", async (event, ctx) => {
		if (!cycleState.active) return;

		if (ctx.hasUI && didAgentAbort(event.messages)) {
			const shouldStop = await ctx.ui.confirm(
				"Stop active cycle?",
				"Turn was aborted. Do you want to stop the cycle?",
			);
			if (shouldStop) {
				stopCycle(ctx);
				return;
			}
		}

		scheduleNextIteration(ctx);
	});

	// Inject cycle context so compaction doesn't lose awareness of the running cycle
	pi.on("session_before_compact", async (event, ctx) => {
		if (!cycleState.active || !cycleState.mode || !ctx.model) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) return;

		const hint = buildCompactHint(cycleState.mode, cycleState.condition);
		const combinedInstructions = [event.customInstructions, hint].filter(Boolean).join("\n\n");

		try {
			const compacted = await compact(
				event.preparation,
				ctx.model,
				auth.apiKey ?? "",
				auth.headers,
				combinedInstructions,
				event.signal,
			);
			return { compaction: compacted };
		} catch (err) {
			if (ctx.hasUI) {
				const errMsg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Compaction failed during active cycle: ${errMsg}`, "warning");
			}
			return;
		}
	});

	// Reload cycle state on startup and session switches
	pi.on("session_start", async (_event, ctx) => {
		await hydrateCycleState(ctx);
	});

	pi.on("session_switch", async (_event: SessionSwitchEvent, ctx) => {
		await hydrateCycleState(ctx);
	});
}
