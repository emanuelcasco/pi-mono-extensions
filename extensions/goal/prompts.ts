import { formatBudgetSummary } from "./format";
import type { GoalState } from "./state";

function formatPlan(state: GoalState): string {
	if (!state.plan || state.plan.length === 0) return "(no structured plan yet)";
	return state.plan.map((step) => `- ${step.id}: ${step.text} [${step.status}]`).join("\n");
}

export function buildGoalSteeringPrompt(state: GoalState): string {
	return `[GOAL ACTIVE]\nGoal: ${state.text}\nMode: ${state.mode}\nStatus: ${state.status}\nProgress: ${state.summary ?? "(no progress summary yet)"}\nPlan:\n${formatPlan(state)}\nNext action: ${state.nextAction ?? "infer the next useful action"}\nBudgets: ${formatBudgetSummary(state)}\n\nInstructions:\n- Keep working toward this goal unless the user explicitly changes direction.\n- Call get_goal if you need the current structured state.\n- Call update_goal after meaningful progress, on blockers, and on completion.\n- If the goal is complete, call update_goal with status=\"completed\" and a concise summary.\n- If blocked by missing information, approval, budget, or unsafe action, call update_goal with status=\"blocked\" and explain the blocker.\n- Do not continue autonomously when user input or approval is required.`;
}

export function buildGoalContinuationPrompt(state: GoalState): string {
	return `[GOAL CONTINUATION]\nContinue working toward the active goal.\n\nGoal: ${state.text}\nProgress: ${state.summary ?? "(no progress summary yet)"}\nNext action: ${state.nextAction ?? "infer the next useful action"}\nBudgets: ${formatBudgetSummary(state)}\n\nInspect get_goal if needed, perform the next useful action, and update_goal when progress, blockers, or completion change. Stop and mark the goal blocked if user input, approval, credentials, or a budget increase is needed.`;
}
