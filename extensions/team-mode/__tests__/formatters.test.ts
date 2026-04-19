/**
 * Pi Teams — Formatters Unit Tests
 *
 * Pure-function tests for all text formatters. No filesystem I/O required.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
// Note: no filesystem I/O needed — formatters are pure functions

import {
	formatApprovals,
	formatCompactSignals,
	formatCompactTaskBoard,
	formatCompactTeamSummary,
	formatCompactTeammateSummary,
	formatDashboard,
	formatDelta,
	formatSignals,
	formatTaskBoard,
	formatTeamSummary,
	formatTeammateSummary,
} from "../ui/formatters.ts";
import type {
	ApprovalRequest,
	DeltaResponse,
	MultiTeamDashboard,
	Signal,
	TaskBoard,
	TaskRecord,
	TeamSummary,
	TeammateSummary,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
	const now = new Date().toISOString();
	return {
		id: "task-001",
		teamId: "team-001",
		title: "Do something",
		status: "todo",
		priority: "medium",
		riskLevel: "low",
		approvalRequired: false,
		dependsOn: [],
		artifacts: [],
		blockers: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
	return {
		id: "sig-001",
		teamId: "team-001",
		source: "backend",
		type: "task_started",
		severity: "info",
		timestamp: new Date().toISOString(),
		message: "Task started",
		links: [],
		...overrides,
	};
}

function makeSummary(overrides: Partial<TeamSummary> = {}): TeamSummary {
	return {
		teamId: "team-001",
		name: "alpha",
		status: "running",
		objective: "Build feature X",
		progress: { done: 2, total: 5 },
		teammates: [],
		blockers: [],
		approvalsPending: [],
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeBoard(overrides: Partial<TaskBoard> = {}): TaskBoard {
	return {
		teamId: "team-001",
		tasks: [],
		summary: { done: 0, inProgress: 0, blocked: 0, awaitingApproval: 0, total: 0 },
		...overrides,
	};
}

function makeTeammateSummary(overrides: Partial<TeammateSummary> = {}): TeammateSummary {
	return {
		teamId: "team-001",
		name: "backend",
		role: "backend",
		status: "idle",
		artifacts: [],
		debugArtifacts: [],
		signalsSinceLastCheck: 0,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// formatTeamSummary
// ---------------------------------------------------------------------------

describe("formatTeamSummary", () => {
	test("includes team name, id, and status in header", () => {
		const summary = makeSummary();
		const output = formatTeamSummary(summary);
		assert.ok(output.includes("alpha"), "should include team name");
		assert.ok(output.includes("team-001"), "should include team id");
		assert.ok(output.includes("running"), "should include status");
	});

	test("shows progress as done/total tasks", () => {
		const summary = makeSummary({ progress: { done: 3, total: 7 } });
		const output = formatTeamSummary(summary);
		assert.ok(output.includes("3/7"), "should show progress fraction");
	});

	test("includes active teammates section", () => {
		const summary = makeSummary({
			teammates: [
				{ name: "backend", status: "in_progress", currentTask: "task-01", summary: "implementing API" },
			],
		});
		const output = formatTeamSummary(summary);
		assert.ok(output.includes("backend"), "should include teammate name");
		assert.ok(output.includes("⚙"), "should include in-progress icon");
	});

	test("includes blocked section when there are blockers", () => {
		const summary = makeSummary({
			blockers: [{ taskId: "task-03", owner: "frontend", reason: "waiting on API" }],
			teammates: [{ name: "frontend", status: "blocked", summary: "blocked" }],
		});
		const output = formatTeamSummary(summary);
		assert.ok(output.includes("Blocked"), "should have Blocked section");
		assert.ok(output.includes("⏸"), "should have blocked icon");
		assert.ok(output.includes("waiting on API"), "should include blocker reason");
	});

	test("includes pending approval section", () => {
		const summary = makeSummary({
			approvalsPending: [
				{ taskId: "task-06", owner: "backend", artifact: "specs/plan.md" },
			],
		});
		const output = formatTeamSummary(summary);
		assert.ok(output.includes("Pending Approval"), "should have Pending Approval section");
		assert.ok(output.includes("⏳"), "should have awaiting icon");
		assert.ok(output.includes("task-06"), "should include task id");
	});

	test("includes next milestone when set", () => {
		const summary = makeSummary({ nextMilestone: "Complete API contract" });
		const output = formatTeamSummary(summary);
		assert.ok(output.includes("Next milestone"), "should include milestone label");
		assert.ok(output.includes("Complete API contract"), "should include milestone text");
	});

	test("omits sections that are empty", () => {
		const summary = makeSummary({
			blockers: [],
			approvalsPending: [],
			teammates: [],
		});
		const output = formatTeamSummary(summary);
		assert.ok(!output.includes("Blocked"), "should not have Blocked section");
		assert.ok(!output.includes("Pending Approval"), "should not have Pending Approval section");
	});
});

describe("formatCompactTeamSummary", () => {
	test("renders a single compact status line", () => {
		const output = formatCompactTeamSummary(
			makeSummary({
				blockers: [{ taskId: "task-009", owner: "backend", reason: "tests failing" }],
				teammates: [{ name: "backend", status: "in_progress", summary: "Working", currentTask: "Task", lastProgressAge: "10s ago" }],
			}),
		);

		assert.match(output, /^alpha: 2\/5 done \| blockers: 1/);
		assert.match(output, /active: backend/);
		assert.equal(output.includes("\n"), false);
	});
});

// ---------------------------------------------------------------------------
// formatDelta
// ---------------------------------------------------------------------------

describe("formatDelta", () => {
	test("shows no new events when signals list is empty", () => {
		const delta: DeltaResponse = {
			teamId: "team-001",
			since: new Date().toISOString(),
			signals: [],
			count: 0,
		};
		const output = formatDelta(delta);
		assert.ok(output.includes("no new events"), "should indicate no new events");
	});

	test("includes source and message for each signal", () => {
		const delta: DeltaResponse = {
			teamId: "team-001",
			since: new Date().toISOString(),
			signals: [
				makeSignal({ source: "backend", message: "finished validation" }),
				makeSignal({ source: "reviewer", message: "flagged issue", severity: "warning" }),
			],
			count: 2,
		};
		const output = formatDelta(delta);
		assert.ok(output.includes("backend"), "should include first source");
		assert.ok(output.includes("finished validation"), "should include first message");
		assert.ok(output.includes("reviewer"), "should include second source");
		assert.ok(output.includes("flagged issue"), "should include second message");
	});

	test("includes a since header", () => {
		const since = new Date(Date.now() - 12 * 60 * 1000).toISOString();
		const delta: DeltaResponse = {
			teamId: "team-001",
			since,
			signals: [],
			count: 0,
		};
		const output = formatDelta(delta);
		assert.ok(output.includes("Since your last check"), "should have since header");
	});
});

// ---------------------------------------------------------------------------
// formatTaskBoard
// ---------------------------------------------------------------------------

describe("formatTaskBoard", () => {
	test("shows team id in header", () => {
		const board: TaskBoard = {
			teamId: "team-001",
			tasks: [],
			summary: { done: 0, inProgress: 0, blocked: 0, awaitingApproval: 0, total: 0 },
		};
		const output = formatTaskBoard(board);
		assert.ok(output.includes("team-001"));
	});

	test("groups done tasks under Done section", () => {
		const board: TaskBoard = {
			teamId: "team-001",
			tasks: [makeTask({ id: "task-001", title: "Finished task", status: "done" })],
			summary: { done: 1, inProgress: 0, blocked: 0, awaitingApproval: 0, total: 1 },
		};
		const output = formatTaskBoard(board);
		assert.ok(output.includes("Done"), "should have Done section");
		assert.ok(output.includes("✓"), "should have done icon");
		assert.ok(output.includes("Finished task"));
	});

	test("groups in_progress tasks under In Progress section", () => {
		const board: TaskBoard = {
			teamId: "team-001",
			tasks: [
				makeTask({ id: "task-002", title: "Active task", status: "in_progress", owner: "backend" }),
			],
			summary: { done: 0, inProgress: 1, blocked: 0, awaitingApproval: 0, total: 1 },
		};
		const output = formatTaskBoard(board);
		assert.ok(output.includes("In Progress"));
		assert.ok(output.includes("⚙"));
		assert.ok(output.includes("Active task"));
		assert.ok(output.includes("backend"));
	});

	test("groups blocked tasks under Blocked section with reason", () => {
		const board: TaskBoard = {
			teamId: "team-001",
			tasks: [
				makeTask({
					id: "task-003",
					title: "Stuck task",
					status: "blocked",
					blockers: ["waiting on API"],
				}),
			],
			summary: { done: 0, inProgress: 0, blocked: 1, awaitingApproval: 0, total: 1 },
		};
		const output = formatTaskBoard(board);
		assert.ok(output.includes("Blocked"));
		assert.ok(output.includes("⏸"));
		assert.ok(output.includes("Stuck task"));
		assert.ok(output.includes("waiting on API"));
	});

	test("groups awaiting_approval tasks under Awaiting Approval section", () => {
		const board: TaskBoard = {
			teamId: "team-001",
			tasks: [
				makeTask({ id: "task-004", title: "Needs review", status: "awaiting_approval" }),
			],
			summary: { done: 0, inProgress: 0, blocked: 0, awaitingApproval: 1, total: 1 },
		};
		const output = formatTaskBoard(board);
		assert.ok(output.includes("Awaiting Approval"));
		assert.ok(output.includes("⏳"));
	});

	test("shows high priority label", () => {
		const board: TaskBoard = {
			teamId: "team-001",
			tasks: [makeTask({ id: "task-005", title: "Urgent", priority: "high" })],
			summary: { done: 0, inProgress: 0, blocked: 0, awaitingApproval: 0, total: 1 },
		};
		const output = formatTaskBoard(board);
		assert.ok(output.includes("high priority"));
	});
});

describe("formatCompactTaskBoard", () => {
	test("summarises progress counts and focus tasks in one line", () => {
		const board = makeBoard({
			tasks: [
				makeTask({ id: "task-001", status: "done", owner: "backend" }),
				makeTask({ id: "task-002", status: "in_progress", owner: "frontend" }),
				makeTask({ id: "task-003", status: "blocked", owner: "reviewer" }),
			],
			summary: { done: 1, inProgress: 1, blocked: 1, awaitingApproval: 0, total: 3 },
		});

		const output = formatCompactTaskBoard(board);
		assert.match(output, /team-001: 1\/3 done/);
		assert.match(output, /active: 1/);
		assert.match(output, /blocked: 1/);
		assert.match(output, /focus:/);
	});
});

// ---------------------------------------------------------------------------
// formatTeammateSummary
// ---------------------------------------------------------------------------

describe("formatTeammateSummary", () => {
	const baseSummary: TeammateSummary = {
		teamId: "team-001",
		name: "backend",
		role: "backend",
		status: "in_progress",
		artifacts: [],
		debugArtifacts: [],
		signalsSinceLastCheck: 0,
		updatedAt: new Date().toISOString(),
	};

	test("includes teammate name and team id", () => {
		const output = formatTeammateSummary(baseSummary);
		assert.ok(output.includes("backend"));
		assert.ok(output.includes("team-001"));
	});

	test("includes status", () => {
		const output = formatTeammateSummary(baseSummary);
		assert.ok(output.includes("in_progress"));
	});

	test("includes current task when provided", () => {
		const summary: TeammateSummary = {
			...baseSummary,
			currentTask: {
				id: "task-005",
				title: "Implement validation",
				status: "in_progress",
			},
		};
		const output = formatTeammateSummary(summary);
		assert.ok(output.includes("task-005"));
		assert.ok(output.includes("Implement validation"));
	});

	test("includes blocker when task is blocked", () => {
		const summary: TeammateSummary = {
			...baseSummary,
			currentTask: {
				id: "task-005",
				title: "Frontend integration",
				status: "blocked",
				blocker: "waiting on API contract",
			},
		};
		const output = formatTeammateSummary(summary);
		assert.ok(output.includes("waiting on API contract"));
	});

	test("includes worktree path when provided", () => {
		const summary: TeammateSummary = {
			...baseSummary,
			worktree: "/tmp/pi/team-001/backend",
		};
		const output = formatTeammateSummary(summary);
		assert.ok(output.includes("/tmp/pi/team-001/backend"));
	});

	test("includes artifacts list when provided", () => {
		const summary: TeammateSummary = {
			...baseSummary,
			artifacts: ["specs/api.md", "src/api.ts"],
		};
		const output = formatTeammateSummary(summary);
		assert.ok(output.includes("specs/api.md"));
		assert.ok(output.includes("src/api.ts"));
	});

	test("includes signals count when > 0", () => {
		const summary: TeammateSummary = {
			...baseSummary,
			signalsSinceLastCheck: 7,
		};
		const output = formatTeammateSummary(summary);
		assert.ok(output.includes("7"));
	});

	test("includes debug metadata when present", () => {
		const summary: TeammateSummary = {
			...baseSummary,
			pid: 4242,
			model: "openai-codex/gpt-5.4-mini",
			modelTier: "cheap",
			modelProvider: "openai-codex",
			terminationReason: "failed",
			exitCode: 1,
			stderrTail: "Authentication failed",
			toolExecutions: 2,
			debugArtifacts: ["teammates/backend/debug/stderr.log"],
		};
		const output = formatTeammateSummary(summary);
		assert.ok(output.includes("PID: 4242"));
		assert.ok(output.includes("openai-codex/gpt-5.4-mini"));
		assert.ok(output.includes("Termination: failed | exit=1"));
		assert.ok(output.includes("Authentication failed"));
		assert.ok(output.includes("Debug artifacts:"));
	});
});

describe("formatCompactTeammateSummary", () => {
	test("renders a compact teammate line", () => {
		const output = formatCompactTeammateSummary(
			makeTeammateSummary({
				status: "in_progress",
				currentTask: { id: "task-002", title: "Implement API contract", status: "in_progress" },
				artifacts: ["spec.md"],
				lastProgressAge: "15s ago",
			}),
		);

		assert.match(output, /^backend: in_progress \| task: task-002/);
		assert.match(output, /artifacts: 1/);
		assert.match(output, /last progress: 15s ago/);
	});

	test("includes termination reason when available", () => {
		const output = formatCompactTeammateSummary(
			makeTeammateSummary({
				status: "failed",
				terminationReason: "failed",
			}),
		);

		assert.match(output, /term: failed/);
	});
});

// ---------------------------------------------------------------------------
// formatDashboard
// ---------------------------------------------------------------------------

describe("formatDashboard", () => {
	test("shows active team count", () => {
		const dashboard: MultiTeamDashboard = {
			activeTeams: 3,
			needsAttention: [],
			recentUpdates: [],
			noAttentionNeeded: [],
		};
		const output = formatDashboard(dashboard);
		assert.ok(output.includes("3"), "should include team count");
		assert.ok(output.includes("Active teams") || output.includes("active"), "should label active teams");
	});

	test("shows needs-attention section when teams need attention", () => {
		const dashboard: MultiTeamDashboard = {
			activeTeams: 2,
			needsAttention: [
				{ teamId: "team-001", reason: "approval required for task-09", severity: "warning" },
			],
			recentUpdates: [],
			noAttentionNeeded: [],
		};
		const output = formatDashboard(dashboard);
		assert.ok(output.includes("Needs Attention") || output.includes("attention"));
		assert.ok(output.includes("team-001"));
		assert.ok(output.includes("approval required for task-09"));
		assert.ok(output.includes("⚠"));
	});

	test("shows recent updates section", () => {
		const dashboard: MultiTeamDashboard = {
			activeTeams: 1,
			needsAttention: [],
			recentUpdates: [
				{ teamId: "team-002", type: "task_completed", message: "auth service done" },
			],
			noAttentionNeeded: [],
		};
		const output = formatDashboard(dashboard);
		assert.ok(output.includes("Recent Updates") || output.includes("updates"));
		assert.ok(output.includes("team-002"));
		assert.ok(output.includes("auth service done"));
	});

	test("shows running smoothly section", () => {
		const dashboard: MultiTeamDashboard = {
			activeTeams: 1,
			needsAttention: [],
			recentUpdates: [],
			noAttentionNeeded: [
				{ teamId: "team-003", progress: "3/5 tasks done", status: "running" },
			],
		};
		const output = formatDashboard(dashboard);
		assert.ok(output.includes("Running Smoothly") || output.includes("smoothly"));
		assert.ok(output.includes("team-003"));
		assert.ok(output.includes("3/5 tasks done"));
	});
});

// ---------------------------------------------------------------------------
// formatSignals
// ---------------------------------------------------------------------------

describe("formatSignals", () => {
	test("returns no-signals placeholder for empty list", () => {
		const output = formatSignals([]);
		assert.ok(output.includes("no signals") || output.includes("(no"), "should indicate empty");
	});

	test("formats each signal with icon, time, source, and message", () => {
		const output = formatSignals([
			makeSignal({ source: "leader", message: "team starting", type: "team_started" }),
		]);
		assert.ok(output.includes("leader"), "should include source");
		assert.ok(output.includes("team starting"), "should include message");
	});

	test("uses ✓ icon for task_completed signals", () => {
		const output = formatSignals([
			makeSignal({ type: "task_completed", severity: "info" }),
		]);
		assert.ok(output.includes("✓"), "should use ✓ for completed");
	});

	test("uses ⏸ icon for blocked signals", () => {
		const output = formatSignals([
			makeSignal({ type: "blocked", severity: "warning" }),
		]);
		assert.ok(output.includes("⏸"), "should use ⏸ for blocked");
	});

	test("uses ⚠ icon for error signals", () => {
		const output = formatSignals([
			makeSignal({ type: "error", severity: "error" }),
		]);
		assert.ok(output.includes("⚠"), "should use ⚠ for error");
	});

	test("includes artifact links when present", () => {
		const output = formatSignals([
			makeSignal({ links: ["docs/api-contract.md"] }),
		]);
		assert.ok(output.includes("docs/api-contract.md"), "should include artifact links");
	});
});

describe("formatCompactSignals", () => {
	test("renders each signal as a short one-liner", () => {
		const output = formatCompactSignals([
			makeSignal({ type: "task_completed", message: "Completed billing endpoint implementation" }),
		]);

		assert.match(output, /^✓ \[[0-9]{2}:[0-9]{2}\] backend: Completed billing endpoint implementation$/);
	});

	test("returns placeholder for empty lists", () => {
		assert.equal(formatCompactSignals([]), "(no signals)");
	});
});

// ---------------------------------------------------------------------------
// formatApprovals
// ---------------------------------------------------------------------------

describe("formatApprovals", () => {
	test("returns no-approvals placeholder for empty list", () => {
		const output = formatApprovals([]);
		assert.ok(
			output.includes("no pending") || output.includes("(no"),
			"should indicate empty",
		);
	});

	test("shows pending approvals with task id and submitter", () => {
		const now = new Date().toISOString();
		const pending: ApprovalRequest[] = [
			{
				id: "apr-001",
				teamId: "team-001",
				taskId: "task-06",
				submittedBy: "backend",
				artifact: "specs/auth-plan.md",
				status: "pending",
				createdAt: now,
			},
		];
		const output = formatApprovals(pending);
		assert.ok(output.includes("task-06"), "should include task id");
		assert.ok(output.includes("backend"), "should include submitter");
		assert.ok(output.includes("specs/auth-plan.md"), "should include artifact path");
		assert.ok(output.includes("⏳"), "should include pending icon");
	});

	test("shows rejected approvals with feedback", () => {
		const now = new Date().toISOString();
		const approvals: ApprovalRequest[] = [
			{
				id: "apr-002",
				teamId: "team-001",
				taskId: "task-07",
				submittedBy: "backend",
				artifact: "specs/plan.md",
				status: "rejected",
				reviewedBy: "leader",
				feedback: "Missing error handling",
				createdAt: now,
				resolvedAt: now,
			},
		];
		const output = formatApprovals(approvals);
		assert.ok(output.includes("task-07"), "should include task id");
		assert.ok(output.includes("Missing error handling"), "should include feedback");
		assert.ok(output.includes("⚠"), "should include warning icon for rejected");
	});

	test("separates pending and rejected sections", () => {
		const now = new Date().toISOString();
		const mixed: ApprovalRequest[] = [
			{
				id: "apr-001",
				teamId: "team-001",
				taskId: "task-01",
				submittedBy: "backend",
				artifact: "plan.md",
				status: "pending",
				createdAt: now,
			},
			{
				id: "apr-002",
				teamId: "team-001",
				taskId: "task-02",
				submittedBy: "planner",
				artifact: "plan2.md",
				status: "rejected",
				reviewedBy: "leader",
				feedback: "Needs work",
				createdAt: now,
				resolvedAt: now,
			},
		];
		const output = formatApprovals(mixed);
		assert.ok(output.includes("Pending"), "should have Pending section");
		assert.ok(output.includes("Rejected"), "should have Rejected section");
	});
});
