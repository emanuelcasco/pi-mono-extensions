/**
 * Pi Teams — Text Formatters
 *
 * Pure functions that convert team data structures into concise, human-readable
 * text responses for the main Pi session. All functions follow the response
 * style rules from the implementation plan:
 *
 *   1. Default to concise — 5–10 lines max.
 *   2. Status icons: ✓ done · ⚙ in progress · ⏸ blocked · ⏳ awaiting approval
 *                    ⚠ needs attention · ○ todo/ready
 *   3. Include artifact links when relevant, but don't inline file contents.
 *   4. Never dump raw logs — always summarise.
 */

import type {
	ApprovalRequest,
	DeltaResponse,
	MultiTeamDashboard,
	Signal,
	SignalSeverity,
	SignalType,
	TaskBoard,
	TaskRecord,
	TaskStatus,
	TeamSummary,
	TeammateSummary,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return a human-readable description of the elapsed time since `isoTimestamp`. */
function humanizeDiff(isoTimestamp: string): string {
	const diffMs = Date.now() - new Date(isoTimestamp).getTime();
	if (diffMs < 0) return "just now";
	const totalSecs = Math.floor(diffMs / 1_000);
	if (totalSecs < 60) return "just now";
	const mins = Math.floor(totalSecs / 60);
	if (mins < 60) return `${mins} min ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs} hour${hrs !== 1 ? "s" : ""} ago`;
	const days = Math.floor(hrs / 24);
	return `${days} day${days !== 1 ? "s" : ""} ago`;
}

/** Map a signal type + severity to a compact status icon. */
function signalIcon(type: SignalType, severity: SignalSeverity): string {
	switch (type) {
		case "task_completed":
		case "team_completed":
		case "approval_granted":
			return "✓";
		case "blocked":
			return "⏸";
		case "approval_requested":
		case "plan_submitted":
			return "⏳";
		case "error":
		case "approval_rejected":
			return "⚠";
		default:
			break;
	}
	// Fallback to severity
	if (severity === "error" || severity === "warning") return "⚠";
	return "⚙";
}

/** Map a task status to a compact status icon. */
function taskIcon(status: TaskStatus): string {
	switch (status) {
		case "done":
			return "✓";
		case "cancelled":
			return "✗";
		case "blocked":
			return "⏸";
		case "awaiting_approval":
			return "⏳";
		case "in_progress":
		case "in_review":
		case "planning":
			return "⚙";
		case "todo":
		case "ready":
			return "○";
	}
}

/** Format a task line for a task board section. */
function formatTaskLine(task: TaskRecord): string {
	const icon = taskIcon(task.status);
	const ownerPart = task.owner ? ` (${task.owner})` : "";
	const priorityPart = task.priority === "high" ? " — high priority" : "";

	let extra = "";
	if (task.status === "blocked" && task.blockers.length > 0) {
		extra = ` — ${task.blockers[0]}`;
	} else if (task.status === "awaiting_approval") {
		extra = " — plan submitted";
	} else if (task.dependsOn.length > 0 && task.status === "blocked") {
		extra = ` — waiting on ${task.dependsOn.join(", ")}`;
	}

	return `${icon} ${task.id}: ${task.title}${ownerPart}${priorityPart}${extra}`;
}

/** Group tasks by broad status category. */
function groupTasks(tasks: TaskRecord[]): {
	done: TaskRecord[];
	inProgress: TaskRecord[];
	inReview: TaskRecord[];
	blocked: TaskRecord[];
	awaitingApproval: TaskRecord[];
	todo: TaskRecord[];
} {
	return {
		done: tasks.filter((t) => t.status === "done"),
		inProgress: tasks.filter((t) => t.status === "in_progress" || t.status === "planning"),
		inReview: tasks.filter((t) => t.status === "in_review"),
		blocked: tasks.filter((t) => t.status === "blocked"),
		awaitingApproval: tasks.filter((t) => t.status === "awaiting_approval"),
		todo: tasks.filter((t) => t.status === "todo" || t.status === "ready"),
	};
}

// ---------------------------------------------------------------------------
// Public formatters
// ---------------------------------------------------------------------------

/**
 * Format a `TeamSummary` into a concise multi-line status snapshot.
 *
 * Example output:
 * ```
 * Team Alpha — running (implementation phase)
 * Progress: 4/7 tasks done
 *
 * Active
 * ⚙ backend: implementing API validation
 * ⚙ reviewer: reviewing auth changes
 *
 * Blocked
 * ⏸ frontend: waiting on API contract (task-03)
 *
 * Pending Approval
 * ⏳ task-06: refactor auth middleware
 *
 * Next milestone: API contract handoff to frontend
 * ```
 */
export function formatTeamSummary(summary: TeamSummary): string {
	const lines: string[] = [];

	// Header
	const phase = summary.currentPhase ? ` (${summary.currentPhase} phase)` : "";
	lines.push(`Team ${summary.name} [${summary.teamId}] — ${summary.status}${phase}`);
	lines.push(`Progress: ${summary.progress.done}/${summary.progress.total} tasks done`);

	// Determine which teammates are blocked
	const blockedOwners = new Set(summary.blockers.map((b) => b.owner));
	const activeTeammates = summary.teammates.filter(
		(t) => !blockedOwners.has(t.name) && t.status !== "done" && t.status !== "idle",
	);

	// Active teammates
	if (activeTeammates.length > 0) {
		lines.push("");
		lines.push("Active");
		for (const t of activeTeammates) {
			const desc = t.summary ?? t.currentTask ?? t.status;
			const progressHint = t.lastProgressAge ? ` (last update: ${t.lastProgressAge})` : "";
			lines.push(`⚙ ${t.name}: ${desc}${progressHint}`);
		}
	}

	// Blockers
	if (summary.blockers.length > 0) {
		lines.push("");
		lines.push("Blocked");
		for (const b of summary.blockers) {
			lines.push(`⏸ ${b.owner}: ${b.reason} (${b.taskId})`);
		}
	}

	// Pending approvals
	if (summary.approvalsPending.length > 0) {
		lines.push("");
		lines.push("Pending Approval");
		for (const a of summary.approvalsPending) {
			lines.push(`⏳ ${a.taskId}: submitted by ${a.owner}`);
		}
	}

	// Next milestone
	if (summary.nextMilestone) {
		lines.push("");
		lines.push(`Next milestone: ${summary.nextMilestone}`);
	}

	return lines.join("\n");
}

/**
 * Format a `DeltaResponse` (changes since last check) into a brief signal digest.
 *
 * Example output:
 * ```
 * Since your last check (12 min ago):
 * ⚙ backend: completed validation rules
 * ⚠ reviewer: flagged missing permission check
 * ⏸ frontend: still blocked on task-12
 * ```
 */
export function formatDelta(delta: DeltaResponse): string {
	const lines: string[] = [];
	const timeAgo = humanizeDiff(delta.since);

	lines.push(`Since your last check (${timeAgo}):`);

	if (delta.signals.length === 0) {
		lines.push("(no new events)");
		return lines.join("\n");
	}

	for (const signal of delta.signals) {
		const icon = signalIcon(signal.type, signal.severity);
		lines.push(`${icon} ${signal.source}: ${signal.message}`);
	}

	return lines.join("\n");
}

/**
 * Format a `TaskBoard` into a structured task list grouped by status.
 *
 * Example output:
 * ```
 * Team Alpha Tasks (2 done, 2 active, 1 blocked, 1 pending)
 *
 * Done
 * ✓ task-01: API research (researcher)
 * ✓ task-02: auth pattern review (reviewer)
 *
 * In Progress
 * ⚙ task-03: backend API contract (backend) — high priority
 * ⚙ task-04: settings UI scaffold (frontend)
 *
 * Blocked
 * ⏸ task-05: frontend integration — waiting on task-03
 *
 * Awaiting Approval
 * ⏳ task-06: refactor auth middleware — plan submitted
 * ```
 */
export function formatTaskBoard(board: TaskBoard): string {
	const lines: string[] = [];
	const s = board.summary;

	const parts: string[] = [];
	if (s.done > 0) parts.push(`${s.done} done`);
	if (s.inProgress > 0) parts.push(`${s.inProgress} active`);
	if (s.blocked > 0) parts.push(`${s.blocked} blocked`);
	if (s.awaitingApproval > 0) parts.push(`${s.awaitingApproval} pending`);

	lines.push(`Team ${board.teamId} Tasks (${parts.join(", ")})`);

	const groups = groupTasks(board.tasks);

	if (groups.done.length > 0) {
		lines.push("");
		lines.push("Done");
		for (const t of groups.done) lines.push(formatTaskLine(t));
	}

	if (groups.inProgress.length > 0) {
		lines.push("");
		lines.push("In Progress");
		for (const t of groups.inProgress) lines.push(formatTaskLine(t));
	}

	if (groups.inReview.length > 0) {
		lines.push("");
		lines.push("In Review");
		for (const t of groups.inReview) lines.push(formatTaskLine(t));
	}

	if (groups.blocked.length > 0) {
		lines.push("");
		lines.push("Blocked");
		for (const t of groups.blocked) lines.push(formatTaskLine(t));
	}

	if (groups.awaitingApproval.length > 0) {
		lines.push("");
		lines.push("Awaiting Approval");
		for (const t of groups.awaitingApproval) lines.push(formatTaskLine(t));
	}

	if (groups.todo.length > 0) {
		lines.push("");
		lines.push("Todo");
		for (const t of groups.todo) lines.push(formatTaskLine(t));
	}

	return lines.join("\n");
}

/**
 * Format a `TeammateSummary` into a brief teammate status card.
 *
 * Example output:
 * ```
 * frontend — in Team Alpha
 * Status: blocked
 * Current task: task-05 (frontend integration)
 * Blocker: waiting on task-03 (backend API contract)
 * Last output: UI scaffold committed to worktree
 * Worktree: /tmp/pi/team-alpha/frontend
 * ```
 */
export function formatTeammateSummary(summary: TeammateSummary): string {
	const lines: string[] = [];

	lines.push(`${summary.name} — in Team ${summary.teamId}`);
	lines.push(`Status: ${summary.status}`);

	if (summary.currentTask) {
		const t = summary.currentTask;
		lines.push(`Current task: ${t.id} (${t.title})`);
		if (t.blocker) {
			lines.push(`Blocker: ${t.blocker}`);
		}
	}

	if (summary.lastProgressAge) {
		lines.push(`Last progress: ${summary.lastProgressAge}`);
	}

	if (summary.lastOutput) {
		lines.push(`Last output: ${summary.lastOutput}`);
	}

	if (summary.worktree) {
		lines.push(`Worktree: ${summary.worktree}`);
	}

	if (summary.artifacts.length > 0) {
		lines.push(`Artifacts: ${summary.artifacts.join(", ")}`);
	}

	if (summary.signalsSinceLastCheck > 0) {
		lines.push(`Signals since last check: ${summary.signalsSinceLastCheck}`);
	}

	return lines.join("\n");
}

/**
 * Format a `MultiTeamDashboard` into a cross-team overview.
 *
 * Example output:
 * ```
 * Active teams: 3
 *
 * Needs Attention
 * ⚠ Team Billing-1: approval required for task-09
 * ⚠ Team Migration-2: blocked on missing schema
 *
 * Recent Updates
 * ✓ Team Search-3: indexing pipeline completed
 *
 * Running Smoothly
 * ⚙ Team Settings-4: 3/5 tasks done
 * ```
 */
export function formatDashboard(dashboard: MultiTeamDashboard): string {
	const lines: string[] = [];

	lines.push(`Active teams: ${dashboard.activeTeams}`);

	if (dashboard.needsAttention.length > 0) {
		lines.push("");
		lines.push("Needs Attention");
		for (const item of dashboard.needsAttention) {
			lines.push(`⚠ ${item.teamId}: ${item.reason}`);
		}
	}

	if (dashboard.recentUpdates.length > 0) {
		lines.push("");
		lines.push("Recent Updates");
		for (const update of dashboard.recentUpdates) {
			const icon = update.type === "team_completed" || update.type === "task_completed" ? "✓" : "⚙";
			lines.push(`${icon} ${update.teamId}: ${update.message}`);
		}
	}

	if (dashboard.noAttentionNeeded.length > 0) {
		lines.push("");
		lines.push("Running Smoothly");
		for (const item of dashboard.noAttentionNeeded) {
			lines.push(`⚙ ${item.teamId} (${item.status}): ${item.progress}`);
		}
	}

	return lines.join("\n");
}

/**
 * Format a list of `Signal` events into a concise log.
 *
 * Each signal is rendered as a single line:
 *   `{icon} [{time}] {source}: {message}`
 */
export function formatSignals(signals: Signal[]): string {
	if (signals.length === 0) {
		return "(no signals)";
	}

	const lines: string[] = [];
	for (const signal of signals) {
		const icon = signalIcon(signal.type, signal.severity);
		const time = humanizeDiff(signal.timestamp);
		lines.push(`${icon} [${time}] ${signal.source}: ${signal.message}`);
		if (signal.links.length > 0) {
			lines.push(`   → ${signal.links.join(", ")}`);
		}
	}

	return lines.join("\n");
}

/**
 * Format a list of `ApprovalRequest` objects into a pending review summary.
 *
 * Example output:
 * ```
 * Pending Approvals (2)
 * ⏳ task-06: submitted by backend — specs/auth-refactor-plan.md
 * ⏳ task-09: submitted by planner — specs/billing-schema.md
 * ```
 */
export function formatApprovals(approvals: ApprovalRequest[]): string {
	if (approvals.length === 0) {
		return "(no pending approvals)";
	}

	const pending = approvals.filter((a) => a.status === "pending");
	const rejected = approvals.filter((a) => a.status === "rejected");

	const lines: string[] = [];

	if (pending.length > 0) {
		lines.push(`Pending Approvals (${pending.length})`);
		for (const a of pending) {
			lines.push(`⏳ ${a.taskId}: submitted by ${a.submittedBy} — ${a.artifact}`);
		}
	}

	if (rejected.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(`Rejected (${rejected.length})`);
		for (const a of rejected) {
			const feedback = a.feedback ? ` — ${a.feedback}` : "";
			lines.push(`⚠ ${a.taskId}: rejected by ${a.reviewedBy ?? "reviewer"}${feedback}`);
		}
	}

	return lines.join("\n");
}
