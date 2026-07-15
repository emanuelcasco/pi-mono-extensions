export const GOAL_EVENT = "goal-event";
export const GOAL_STEERING_CONTEXT = "goal-steering-context";
export const GOAL_CONTINUATION_CONTEXT = "goal-continuation";

export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "cancelled";
export type GoalMode = "manual" | "assist" | "auto";
export type GoalStepStatus = "pending" | "in_progress" | "done" | "blocked";

export interface GoalStep {
	id: string;
	text: string;
	status: GoalStepStatus;
}

export interface GoalBudgets {
	maxTurns?: number;
	maxToolCalls?: number;
	maxTokens?: number;
	maxCostUsd?: number;
	maxWallMs?: number;
}

export interface GoalAccounting {
	assistantTurns: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	startedAt: string;
	lastTurnAt?: string;
}

export interface GoalAccountingDelta {
	assistantTurns?: number;
	toolCalls?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	lastTurnAt?: string;
}

export interface GoalState {
	goalId: string;
	text: string;
	status: GoalStatus;
	mode: GoalMode;
	createdAt: string;
	updatedAt: string;
	summary?: string;
	plan?: GoalStep[];
	nextAction?: string;
	blockers: string[];
	budgets: GoalBudgets;
	accounting: GoalAccounting;
	lastContinuationAt?: string;
	lastContinuationReason?: string;
	noProgressTurns: number;
	lastProgressAt?: string;
}

export type GoalEvent =
	| {
			kind: "created";
			goalId: string;
			text: string;
			mode: GoalMode;
			budgets: GoalBudgets;
			at: string;
	  }
	| {
			kind: "updated";
			goalId: string;
			patch: Partial<Pick<GoalState, "text" | "summary" | "plan" | "nextAction" | "blockers" | "mode" | "budgets">>;
			note?: string;
			at: string;
	  }
	| { kind: "status"; goalId: string; status: GoalStatus; reason?: string; at: string }
	| { kind: "accounting"; goalId: string; delta: GoalAccountingDelta; at: string }
	| { kind: "continuation"; goalId: string; action: "queued" | "skipped" | "stopped"; reason: string; at: string };

export interface HistoryEntry {
	event: GoalEvent;
}

export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		usage?: UsageLike;
	};
}

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function newGoalId(): string {
	return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultBudgets(mode: GoalMode, budgets: GoalBudgets = {}): GoalBudgets {
	return {
		...(mode === "auto" ? { maxTurns: 10, maxWallMs: 30 * 60_000 } : {}),
		...budgets,
	};
}

export function initialAccounting(at: string): GoalAccounting {
	return {
		assistantTurns: 0,
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		startedAt: at,
	};
}

export function createGoalEvent(text: string, mode: GoalMode = "assist", budgets: GoalBudgets = {}): GoalEvent {
	const at = nowIso();
	return {
		kind: "created",
		goalId: newGoalId(),
		text: text.trim(),
		mode,
		budgets: defaultBudgets(mode, budgets),
		at,
	};
}

export function applyGoalEvent(state: GoalState | undefined, event: GoalEvent): GoalState | undefined {
	if (event.kind === "created") {
		return {
			goalId: event.goalId,
			text: event.text,
			status: "active",
			mode: event.mode,
			createdAt: event.at,
			updatedAt: event.at,
			blockers: [],
			budgets: event.budgets,
			accounting: initialAccounting(event.at),
			noProgressTurns: 0,
		};
	}

	if (!state || state.goalId !== event.goalId) return state;

	switch (event.kind) {
		case "updated": {
			const progressChanged = Boolean(event.note || event.patch.summary || event.patch.nextAction || event.patch.plan);
			return {
				...state,
				...event.patch,
				budgets: event.patch.budgets ? { ...state.budgets, ...event.patch.budgets } : state.budgets,
				updatedAt: event.at,
				noProgressTurns: progressChanged ? 0 : state.noProgressTurns,
				lastProgressAt: progressChanged ? event.at : state.lastProgressAt,
			};
		}
		case "status":
			return {
				...state,
				status: event.status,
				updatedAt: event.at,
				blockers: event.status === "blocked" && event.reason ? [...state.blockers, event.reason] : state.blockers,
				summary: event.status === "completed" && event.reason ? event.reason : state.summary,
			};
		case "accounting":
			return {
				...state,
				updatedAt: event.at,
				accounting: {
					...state.accounting,
					assistantTurns: state.accounting.assistantTurns + (event.delta.assistantTurns ?? 0),
					toolCalls: state.accounting.toolCalls + (event.delta.toolCalls ?? 0),
					inputTokens: state.accounting.inputTokens + (event.delta.inputTokens ?? 0),
					outputTokens: state.accounting.outputTokens + (event.delta.outputTokens ?? 0),
					cacheReadTokens: state.accounting.cacheReadTokens + (event.delta.cacheReadTokens ?? 0),
					cacheWriteTokens: state.accounting.cacheWriteTokens + (event.delta.cacheWriteTokens ?? 0),
					costUsd: state.accounting.costUsd + (event.delta.costUsd ?? 0),
					lastTurnAt: event.delta.lastTurnAt ?? state.accounting.lastTurnAt,
				},
			};
		case "continuation":
			return {
				...state,
				updatedAt: event.at,
				lastContinuationAt: event.action === "queued" ? event.at : state.lastContinuationAt,
				lastContinuationReason: event.reason,
				noProgressTurns: event.action === "queued" ? state.noProgressTurns + 1 : state.noProgressTurns,
			};
	}
}

export function isGoalEvent(value: unknown): value is GoalEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as { kind?: unknown; goalId?: unknown };
	return typeof event.kind === "string" && typeof event.goalId === "string";
}

export function extractGoalEvents(entries: SessionEntryLike[]): HistoryEntry[] {
	const history: HistoryEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GOAL_EVENT) continue;
		if (isGoalEvent(entry.data)) history.push({ event: entry.data });
	}
	return history;
}

export function reconstructGoal(entries: SessionEntryLike[]): { state?: GoalState; history: HistoryEntry[] } {
	const history = extractGoalEvents(entries);
	let state: GoalState | undefined;
	for (const { event } of history) {
		state = applyGoalEvent(state, event);
	}
	return { state, history };
}

export function isTerminalStatus(status: GoalStatus): boolean {
	return status === "completed" || status === "cancelled" || status === "blocked";
}

export function isSteeringActive(state: GoalState | undefined): state is GoalState {
	return Boolean(state && state.status === "active" && (state.mode === "assist" || state.mode === "auto"));
}

export function totalTokens(accounting: GoalAccounting): number {
	return accounting.inputTokens + accounting.outputTokens + accounting.cacheReadTokens + accounting.cacheWriteTokens;
}

export function budgetExceeded(state: GoalState, now: number = Date.now()): string | undefined {
	const { budgets, accounting } = state;
	if (budgets.maxTurns !== undefined && accounting.assistantTurns >= budgets.maxTurns) return "turn budget exceeded";
	if (budgets.maxToolCalls !== undefined && accounting.toolCalls >= budgets.maxToolCalls) return "tool-call budget exceeded";
	if (budgets.maxTokens !== undefined && totalTokens(accounting) >= budgets.maxTokens) return "token budget exceeded";
	if (budgets.maxCostUsd !== undefined && accounting.costUsd >= budgets.maxCostUsd) return "cost budget exceeded";
	if (budgets.maxWallMs !== undefined && now - Date.parse(accounting.startedAt) >= budgets.maxWallMs) {
		return "wall-clock budget exceeded";
	}
	return undefined;
}
