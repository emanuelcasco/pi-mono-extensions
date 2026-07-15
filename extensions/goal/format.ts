import type { GoalBudgets, GoalEvent, GoalState } from "./state";
import { totalTokens } from "./state";

const MAX_GOAL_CHARS = 96;
const MAX_NEXT_CHARS = 80;

export function truncate(text: string | undefined, max = 80): string {
	if (!text) return "—";
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatMoney(value: number): string {
	return value === 0 ? "$0" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function formatBudgetSummary(state: GoalState): string {
	const parts: string[] = [];
	if (state.budgets.maxTurns !== undefined) parts.push(`turns ${state.accounting.assistantTurns}/${state.budgets.maxTurns}`);
	else parts.push(`turns ${state.accounting.assistantTurns}`);
	if (state.budgets.maxToolCalls !== undefined) parts.push(`tools ${state.accounting.toolCalls}/${state.budgets.maxToolCalls}`);
	if (state.budgets.maxTokens !== undefined) parts.push(`tokens ${totalTokens(state.accounting)}/${state.budgets.maxTokens}`);
	else if (totalTokens(state.accounting) > 0) parts.push(`tokens ${totalTokens(state.accounting)}`);
	if (state.budgets.maxCostUsd !== undefined) parts.push(`cost ${formatMoney(state.accounting.costUsd)}/${formatMoney(state.budgets.maxCostUsd)}`);
	else if (state.accounting.costUsd > 0) parts.push(`cost ${formatMoney(state.accounting.costUsd)}`);
	return parts.join(" · ");
}

export function formatGoalLines(state: GoalState | undefined, historyLength = 0): string[] {
	if (!state) return ["No goal set. Use /goal <text> to create one."];
	const lines = [
		`🎯 Goal: ${truncate(state.text, MAX_GOAL_CHARS)}`,
		`status: ${state.status} · mode: ${state.mode} · ${formatBudgetSummary(state)}`,
	];
	if (state.summary) lines.push(`progress: ${truncate(state.summary, MAX_GOAL_CHARS)}`);
	if (state.nextAction) lines.push(`next: ${truncate(state.nextAction, MAX_NEXT_CHARS)}`);
	if (state.blockers.length > 0) lines.push(`blockers: ${truncate(state.blockers.join("; "), MAX_GOAL_CHARS)}`);
	lines.push(`updated: ${state.updatedAt}${historyLength > 0 ? ` · events: ${historyLength}` : ""}`);
	return lines;
}

export function formatGoalMarkdown(state: GoalState | undefined, history?: GoalEvent[]): string {
	if (!state) return "No goal set. Use `/goal <text>` or `create_goal` to create one.";
	const lines = [
		`# Goal`,
		``,
		`- **Goal:** ${state.text}`,
		`- **Status:** ${state.status}`,
		`- **Mode:** ${state.mode}`,
		`- **Created:** ${state.createdAt}`,
		`- **Updated:** ${state.updatedAt}`,
		`- **Budgets/accounting:** ${formatBudgetSummary(state)}`,
	];
	if (state.summary) lines.push(`- **Progress:** ${state.summary}`);
	if (state.nextAction) lines.push(`- **Next action:** ${state.nextAction}`);
	if (state.blockers.length > 0) lines.push(`- **Blockers:** ${state.blockers.join("; ")}`);
	if (state.plan && state.plan.length > 0) {
		lines.push("", "## Plan");
		for (const step of state.plan) lines.push(`- [${step.status === "done" ? "x" : " "}] ${step.id}: ${step.text} (${step.status})`);
	}
	if (history && history.length > 0) {
		lines.push("", "## Recent events");
		for (const event of history.slice(-12)) lines.push(`- ${event.at}: ${event.kind}`);
	}
	return lines.join("\n");
}

export function parseBudgetPatch(kind: string, value: string): Partial<GoalBudgets> | undefined {
	const amount = Number(value);
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	if (kind === "turns") return { maxTurns: Math.floor(amount) };
	if (kind === "tools") return { maxToolCalls: Math.floor(amount) };
	if (kind === "tokens") return { maxTokens: Math.floor(amount) };
	if (kind === "cost") return { maxCostUsd: amount };
	if (kind === "time" || kind === "wall") return { maxWallMs: Math.floor(amount * 60_000) };
	return undefined;
}
