/**
 * Pi Team-Mode — Compact Text Formatters
 *
 * Pure helpers for rendering status summaries to markdown / ansi lines.
 * No theme or tui imports here so they're trivial to unit test.
 */

import type { LiveTeammateSnapshot, TeamRecord, TeammateRecord } from "../core/types.js";
import type { TaskRecord } from "../core/tasks.js";

export const STATUS_ICONS: Record<string, string> = {
	pending: "·",
	running: "▸",
	completed: "✓",
	failed: "✗",
	stopped: "■",
};

export function formatTeammateLine(t: TeammateRecord): string {
	const icon = STATUS_ICONS[t.status] ?? "?";
	const bits = [
		`${icon} ${t.name}`,
		t.subagentType ? `[${t.subagentType}]` : "",
		t.teamId ? `team=${t.teamId}` : "",
		t.isolation === "worktree" ? "wt" : "",
	].filter(Boolean);
	return bits.join(" ");
}

export function formatTeammateList(teammates: TeammateRecord[]): string {
	if (teammates.length === 0) return "No teammates.";
	return teammates.map(formatTeammateLine).join("\n");
}

export function formatTeamLine(team: TeamRecord, memberCount: number): string {
	return `• ${team.name} (${team.id}) — ${memberCount} teammate${memberCount === 1 ? "" : "s"}, default=${team.defaultIsolation}`;
}

export function formatTeamDashboard(teams: TeamRecord[], teammates: TeammateRecord[]): string {
	if (teams.length === 0 && teammates.length === 0) {
		return "No teams and no teammates.";
	}
	const out: string[] = [];
	if (teams.length > 0) {
		out.push("Teams:");
		for (const team of teams) {
			const members = teammates.filter((t) => t.teamId === team.id);
			out.push(`  ${formatTeamLine(team, members.length)}`);
			for (const m of members) out.push(`    ${formatTeammateLine(m)}`);
		}
	}
	const loners = teammates.filter((t) => !t.teamId);
	if (loners.length > 0) {
		out.push("Unassigned teammates:");
		for (const m of loners) out.push(`  ${formatTeammateLine(m)}`);
	}
	return out.join("\n");
}

export function formatTaskLine(t: TaskRecord): string {
	const icon = STATUS_ICONS[t.status] ?? "?";
	const owner = t.owner ? `@${t.owner}` : "unassigned";
	const blocks = t.blockedBy.length > 0 ? ` ⤴${t.blockedBy.length}` : "";
	return `${icon} [${t.id}] ${t.subject} (${owner}${blocks})`;
}

export function formatTaskList(tasks: TaskRecord[]): string {
	if (tasks.length === 0) return "No tasks.";
	const byStatus: Record<string, TaskRecord[]> = {};
	for (const t of tasks) (byStatus[t.status] ??= []).push(t);
	const order: TaskRecord["status"][] = ["in_progress", "pending", "completed", "failed", "deleted"];
	const out: string[] = [];
	for (const status of order) {
		const group = byStatus[status];
		if (!group || group.length === 0) continue;
		out.push(`${status} (${group.length}):`);
		for (const t of group) out.push(`  ${formatTaskLine(t)}`);
	}
	return out.join("\n");
}

export function formatTaskDetails(t: TaskRecord): string {
	const out = [
		`Task: ${t.subject} (${t.id})`,
		`Status: ${t.status}`,
		t.activeForm ? `In-progress form: ${t.activeForm}` : "",
		t.owner ? `Owner: ${t.owner}` : "Owner: unassigned",
		t.teamId ? `Team: ${t.teamId}` : "",
		t.blockedBy.length > 0 ? `Blocked by: ${t.blockedBy.join(", ")}` : "",
		t.blocks.length > 0 ? `Blocks: ${t.blocks.join(", ")}` : "",
		`Version: ${t.version}`,
		`Created: ${t.createdAt}`,
		`Updated: ${t.updatedAt}`,
		t.description ? `\n${t.description}` : "",
		t.result ? `\nResult:\n${t.result}` : "",
		t.hookOutput ? `\nHook output:\n${t.hookOutput}` : "",
	].filter(Boolean);
	return out.join("\n");
}

export function formatTeammateStatus(t: TeammateRecord): string {
	const modelStr =
		t.provider && t.model ? `${t.provider}/${t.model}` : t.model ?? "(pi default)";
	const out = [
		`Teammate: ${t.name} (${t.id})`,
		`Status: ${t.status}`,
		`Model: ${modelStr}`,
		t.subagentType ? `Role: ${t.subagentType}` : "",
		t.teamId ? `Team: ${t.teamId}` : "",
		`Isolation: ${t.isolation}${t.worktreeBranch ? ` (branch=${t.worktreeBranch})` : ""}`,
		`CWD: ${t.cwd}`,
		`Created: ${t.createdAt}`,
		`Updated: ${t.updatedAt}`,
		t.lastExitCode !== undefined ? `Last exit: ${t.lastExitCode}` : "",
		t.lastResult ? `Last result:\n${t.lastResult}` : "",
	].filter(Boolean);
	return out.join("\n");
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0.0s";
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokenCount(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens < 1000) return `${Math.round(tokens)}`;
	return `${(tokens / 1000).toFixed(1)}k`;
}

export function summarizeResult(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max)}…`;
}

export function formatMetricChip(snapshot: LiveTeammateSnapshot): string {
	const elapsed = (snapshot.metrics.finishedAt ?? Date.now()) - snapshot.metrics.startedAt;
	const turns = snapshot.metrics.maxTurns
		? `⟳ ${snapshot.metrics.turns}≤${snapshot.metrics.maxTurns}`
		: `⟳ ${snapshot.metrics.turns}`;
	return [
		turns,
		`${snapshot.metrics.toolUses} tool uses`,
		`${formatTokenCount(snapshot.metrics.tokens)} tok`,
		formatDuration(elapsed),
	].join(" · ");
}
