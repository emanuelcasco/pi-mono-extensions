/**
 * Pi Teams — TUI Widget
 *
 * Manages the compact single-line team status widget shown in the editor area.
 * Delegates to `ctx.ui.setWidget("team-mode", ...)` using the string-array form
 * (same pattern used by the loop extension).
 *
 * Display rules:
 *   - No teams → widget hidden (undefined)
 *   - 1 team   → "Team: {name} — {status} ({done}/{total} tasks) ⚠ {n} blocker(s)"
 *   - N teams  → "Teams: {n} active · {n} needs attention · {n} running smoothly"
 *
 * Theme color conventions:
 *   - Team name / label prefix → accent
 *   - Status (normal)          → muted
 *   - Needs attention / blocker→ warning
 *   - Done count               → success
 *   - Separators / counts      → dim
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TeamRecord, TeamSummary } from "./types.js";

const WIDGET_ID = "team-mode";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** True when the team has blockers, pending approvals, or has failed. */
function needsAttention(team: TeamRecord, summary?: TeamSummary): boolean {
	if (team.status === "failed") return true;
	if (summary) {
		return summary.blockers.length > 0 || summary.approvalsPending.length > 0;
	}
	// Without a summary, fall back to the team record status
	return team.status === "failed" || team.status === "paused";
}

/**
 * Build a single-line string for one team.
 *
 * Example:  Team: billing-settings — running (4/7 tasks) ⚠ 1 blocker
 */
function buildSingleTeamLine(
	team: TeamRecord,
	summary: TeamSummary | undefined,
	theme: ExtensionContext["ui"]["theme"],
): string {
	// Prefix
	const prefix = theme.fg("accent", "Team:");

	// Name
	const name = theme.fg("accent", team.name);

	// Status + phase
	const phase = summary?.currentPhase ? ` (${summary.currentPhase})` : "";
	const attention = needsAttention(team, summary);
	const statusColor = attention ? "warning" : "muted";
	const status = theme.fg(statusColor, `${team.status}${phase}`);

	// Progress
	let progressPart = "";
	if (summary) {
		const { done, total } = summary.progress;
		progressPart =
			" (" +
			theme.fg("success", String(done)) +
			theme.fg("dim", `/${total} tasks`) +
			")";
	}

	// Blocker / attention flag
	let attentionPart = "";
	if (summary) {
		const blockerCount = summary.blockers.length;
		const approvalCount = summary.approvalsPending.length;
		if (blockerCount > 0) {
			attentionPart =
				" " +
				theme.fg("warning", `⚠ ${blockerCount} blocker${blockerCount !== 1 ? "s" : ""}`);
		} else if (approvalCount > 0) {
			attentionPart =
				" " +
				theme.fg("warning", `⏳ ${approvalCount} approval${approvalCount !== 1 ? "s" : ""} pending`);
		}
	} else if (team.status === "failed") {
		attentionPart = " " + theme.fg("warning", "⚠ failed");
	}

	return `${prefix} ${name} — ${status}${progressPart}${attentionPart}`;
}

/**
 * Build a single-line string for multiple teams.
 *
 * Example:  Teams: 3 active · 1 needs attention · 2 running smoothly
 */
function buildMultiTeamLine(
	teams: TeamRecord[],
	summaries: Map<string, TeamSummary> | undefined,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const activeTeams = teams.filter(
		(t) => t.status === "running" || t.status === "initializing",
	);
	const attentionTeams = activeTeams.filter((t) =>
		needsAttention(t, summaries?.get(t.id)),
	);
	const smoothTeams = activeTeams.filter(
		(t) => !needsAttention(t, summaries?.get(t.id)),
	);

	// Prefix
	const prefix = theme.fg("accent", "Teams:");
	const sep = theme.fg("dim", " · ");

	const parts: string[] = [];

	parts.push(theme.fg("dim", `${activeTeams.length} active`));

	if (attentionTeams.length > 0) {
		parts.push(
			theme.fg("warning", `${attentionTeams.length} needs attention`),
		);
	}

	if (smoothTeams.length > 0) {
		parts.push(
			theme.fg("muted", `${smoothTeams.length} running smoothly`),
		);
	}

	return `${prefix} ${parts.join(sep)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Update the team-mode widget with the current team state.
 *
 * - When `teams` is empty the widget is removed.
 * - When there is exactly one team a detailed single-team line is shown.
 * - When there are multiple teams a summary count line is shown.
 *
 * `summaries` is optional; richer information (progress, blockers) is only
 * shown when a `TeamSummary` is available for the team.
 */
export function updateTeamWidget(
	ctx: ExtensionContext,
	teams: TeamRecord[],
	summaries?: Map<string, TeamSummary>,
): void {
	if (!ctx.hasUI) return;

	// No active teams → hide the widget
	if (teams.length === 0) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	let line: string;

	if (teams.length === 1) {
		const team = teams[0]!;
		line = buildSingleTeamLine(team, summaries?.get(team.id), theme);
	} else {
		line = buildMultiTeamLine(teams, summaries, theme);
	}

	ctx.ui.setWidget(WIDGET_ID, [line]);
}

/**
 * Remove the team-mode widget from the UI.
 *
 * Call this when all teams have been stopped or completed and no further
 * status needs to be shown.
 */
export function clearTeamWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_ID, undefined);
}
