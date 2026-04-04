/**
 * Pi Teams — TaskManager Unit Tests
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore } from "../core/store.ts";
import { TaskManager } from "../managers/task-manager.ts";
import type { TaskRecord, TeamRecord } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setup(): Promise<{
	store: TeamStore;
	taskManager: TaskManager;
	teamId: string;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "pi-teams-task-"));
	const store = new TeamStore(dir);
	const taskManager = new TaskManager(store);
	const teamId = "team-20260403-001";
	const now = new Date().toISOString();

	const team: TeamRecord = {
		id: teamId,
		name: "test-team",
		status: "running",
		createdAt: now,
		updatedAt: now,
		objective: "Test",
		repoRoots: [],
		teammates: ["backend", "frontend"],
	};
	await store.saveTeam(team);

	return { store, taskManager, teamId, dir };
}

function baseTask(
	overrides: Partial<Omit<TaskRecord, "id" | "teamId" | "createdAt" | "updatedAt">> = {},
): Omit<TaskRecord, "id" | "teamId" | "createdAt" | "updatedAt"> {
	return {
		title: "Implement feature",
		status: "todo",
		priority: "medium",
		riskLevel: "low",
		approvalRequired: false,
		dependsOn: [],
		artifacts: [],
		blockers: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

describe("TaskManager.createTask", () => {
	test("assigns task-001 as first ID", async () => {
		const { taskManager, teamId, dir } = await setup();
		const task = await taskManager.createTask(teamId, baseTask({ title: "First" }));
		assert.equal(task.id, "task-001");
		await rm(dir, { recursive: true, force: true });
	});

	test("assigns sequential IDs for multiple tasks", async () => {
		const { taskManager, teamId, dir } = await setup();
		const t1 = await taskManager.createTask(teamId, baseTask({ title: "First" }));
		const t2 = await taskManager.createTask(teamId, baseTask({ title: "Second" }));
		const t3 = await taskManager.createTask(teamId, baseTask({ title: "Third" }));
		assert.equal(t1.id, "task-001");
		assert.equal(t2.id, "task-002");
		assert.equal(t3.id, "task-003");
		await rm(dir, { recursive: true, force: true });
	});

	test("applies sensible defaults for omitted fields", async () => {
		const { taskManager, teamId, dir } = await setup();
		const task = await taskManager.createTask(teamId, { title: "Minimal" } as any);
		assert.equal(task.status, "todo");
		assert.equal(task.priority, "medium");
		assert.equal(task.riskLevel, "low");
		assert.equal(task.approvalRequired, false);
		assert.deepEqual(task.dependsOn, []);
		assert.deepEqual(task.artifacts, []);
		assert.deepEqual(task.blockers, []);
		await rm(dir, { recursive: true, force: true });
	});

	test("sets teamId, createdAt, and updatedAt", async () => {
		const { taskManager, teamId, dir } = await setup();
		const before = new Date().toISOString();
		const task = await taskManager.createTask(teamId, baseTask());
		const after = new Date().toISOString();
		assert.equal(task.teamId, teamId);
		assert.ok(task.createdAt >= before);
		assert.ok(task.createdAt <= after);
		assert.ok(task.updatedAt >= before);
		assert.ok(task.updatedAt <= after);
		await rm(dir, { recursive: true, force: true });
	});

	test("persists task so it can be loaded by getTasks", async () => {
		const { taskManager, teamId, dir } = await setup();
		const task = await taskManager.createTask(teamId, baseTask({ title: "Persist me" }));
		const tasks = await taskManager.getTasks(teamId);
		assert.ok(tasks.some((t) => t.id === task.id && t.title === "Persist me"));
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// updateTask
// ---------------------------------------------------------------------------

describe("TaskManager.updateTask", () => {
	test("patches only the specified fields", async () => {
		const { taskManager, teamId, dir } = await setup();
		const task = await taskManager.createTask(teamId, baseTask({ title: "Original" }));
		const updated = await taskManager.updateTask(teamId, task.id, {
			status: "in_progress",
			owner: "backend",
		});
		assert.equal(updated.status, "in_progress");
		assert.equal(updated.owner, "backend");
		assert.equal(updated.title, "Original"); // unchanged
		await rm(dir, { recursive: true, force: true });
	});

	test("protects immutable fields (id, teamId, createdAt)", async () => {
		const { taskManager, teamId, dir } = await setup();
		const task = await taskManager.createTask(teamId, baseTask());
		const updated = await taskManager.updateTask(teamId, task.id, {
			id: "hacked-id" as any,
			teamId: "hacked-team" as any,
			createdAt: "0000-01-01T00:00:00Z" as any,
		});
		assert.equal(updated.id, task.id);
		assert.equal(updated.teamId, teamId);
		assert.equal(updated.createdAt, task.createdAt);
		await rm(dir, { recursive: true, force: true });
	});

	test("refreshes updatedAt", async () => {
		const { taskManager, teamId, dir } = await setup();
		const task = await taskManager.createTask(teamId, baseTask());
		await new Promise((r) => setTimeout(r, 5));
		const updated = await taskManager.updateTask(teamId, task.id, { status: "done" });
		assert.ok(updated.updatedAt > task.updatedAt);
		await rm(dir, { recursive: true, force: true });
	});

	test("throws when taskId does not exist", async () => {
		const { taskManager, teamId, dir } = await setup();
		await assert.rejects(
			() => taskManager.updateTask(teamId, "task-999", { status: "done" }),
			/Task not found/,
		);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getTasks
// ---------------------------------------------------------------------------

describe("TaskManager.getTasks", () => {
	test("returns all tasks when no filter is provided", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ title: "A" }));
		await taskManager.createTask(teamId, baseTask({ title: "B" }));
		const tasks = await taskManager.getTasks(teamId);
		assert.equal(tasks.length, 2);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by single status", async () => {
		const { taskManager, teamId, dir } = await setup();
		const t = await taskManager.createTask(teamId, baseTask({ status: "in_progress" }));
		await taskManager.createTask(teamId, baseTask({ status: "done" }));
		const tasks = await taskManager.getTasks(teamId, { status: "in_progress" });
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0].id, t.id);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by multiple statuses", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ status: "in_progress" }));
		await taskManager.createTask(teamId, baseTask({ status: "done" }));
		await taskManager.createTask(teamId, baseTask({ status: "blocked" }));
		const tasks = await taskManager.getTasks(teamId, { status: ["in_progress", "done"] });
		assert.equal(tasks.length, 2);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by owner", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ owner: "backend" }));
		await taskManager.createTask(teamId, baseTask({ owner: "frontend" }));
		const tasks = await taskManager.getTasks(teamId, { owner: "backend" });
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0].owner, "backend");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by priority", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ priority: "high" }));
		await taskManager.createTask(teamId, baseTask({ priority: "low" }));
		const tasks = await taskManager.getTasks(teamId, { priority: "high" });
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0].priority, "high");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by riskLevel", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ riskLevel: "high" }));
		await taskManager.createTask(teamId, baseTask({ riskLevel: "low" }));
		const tasks = await taskManager.getTasks(teamId, { riskLevel: "high" });
		assert.equal(tasks.length, 1);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by approvalRequired", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ approvalRequired: true }));
		await taskManager.createTask(teamId, baseTask({ approvalRequired: false }));
		const tasks = await taskManager.getTasks(teamId, { approvalRequired: true });
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0].approvalRequired, true);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

describe("TaskManager.getTask", () => {
	test("returns task by ID", async () => {
		const { taskManager, teamId, dir } = await setup();
		const task = await taskManager.createTask(teamId, baseTask({ title: "Find me" }));
		const found = await taskManager.getTask(teamId, task.id);
		assert.equal(found?.id, task.id);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns null when task does not exist", async () => {
		const { taskManager, teamId, dir } = await setup();
		const result = await taskManager.getTask(teamId, "task-999");
		assert.equal(result, null);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getTaskBoard
// ---------------------------------------------------------------------------

describe("TaskManager.getTaskBoard", () => {
	test("returns correct summary counts", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ status: "done" }));
		await taskManager.createTask(teamId, baseTask({ status: "done" }));
		await taskManager.createTask(teamId, baseTask({ status: "in_progress" }));
		await taskManager.createTask(teamId, baseTask({ status: "blocked" }));
		await taskManager.createTask(teamId, baseTask({ status: "awaiting_approval" }));

		const board = await taskManager.getTaskBoard(teamId);
		assert.equal(board.teamId, teamId);
		assert.equal(board.summary.done, 2);
		assert.equal(board.summary.inProgress, 1);
		assert.equal(board.summary.blocked, 1);
		assert.equal(board.summary.awaitingApproval, 1);
		assert.equal(board.summary.total, 5);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns all tasks in the board", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ title: "A" }));
		await taskManager.createTask(teamId, baseTask({ title: "B" }));
		const board = await taskManager.getTaskBoard(teamId);
		assert.equal(board.tasks.length, 2);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getReadyTasks
// ---------------------------------------------------------------------------

describe("TaskManager.getReadyTasks", () => {
	test("returns only tasks with status ready", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ status: "ready" }));
		await taskManager.createTask(teamId, baseTask({ status: "todo" }));
		await taskManager.createTask(teamId, baseTask({ status: "in_progress" }));
		const tasks = await taskManager.getReadyTasks(teamId);
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0].status, "ready");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getBlockedTasks
// ---------------------------------------------------------------------------

describe("TaskManager.getBlockedTasks", () => {
	test("returns blocked tasks that have blocker reasons", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(
			teamId,
			baseTask({ status: "blocked", blockers: ["waiting on task-01"] }),
		);
		// Blocked but no reason — should NOT appear
		await taskManager.createTask(teamId, baseTask({ status: "blocked", blockers: [] }));
		await taskManager.createTask(teamId, baseTask({ status: "in_progress" }));

		const tasks = await taskManager.getBlockedTasks(teamId);
		assert.equal(tasks.length, 1);
		assert.ok(tasks[0].blockers.length > 0);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getTasksForOwner
// ---------------------------------------------------------------------------

describe("TaskManager.getTasksForOwner", () => {
	test("returns non-cancelled tasks for the given owner", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ owner: "backend", status: "in_progress" }));
		await taskManager.createTask(teamId, baseTask({ owner: "backend", status: "done" }));
		await taskManager.createTask(
			teamId,
			baseTask({ owner: "backend", status: "cancelled" }),
		);
		await taskManager.createTask(teamId, baseTask({ owner: "frontend" }));

		const tasks = await taskManager.getTasksForOwner(teamId, "backend");
		assert.equal(tasks.length, 2);
		assert.ok(tasks.every((t) => t.owner === "backend"));
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// assignTask
// ---------------------------------------------------------------------------

describe("TaskManager.assignTask", () => {
	test("sets owner on the task", async () => {
		const { taskManager, teamId, dir } = await setup();
		const task = await taskManager.createTask(teamId, baseTask());
		const updated = await taskManager.assignTask(teamId, task.id, "backend");
		assert.equal(updated.owner, "backend");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// resolveDependencies
// ---------------------------------------------------------------------------

describe("TaskManager.resolveDependencies", () => {
	test("promotes todo tasks whose dependencies are all done", async () => {
		const { taskManager, teamId, dir } = await setup();
		const dep = await taskManager.createTask(teamId, baseTask({ title: "Dep", status: "done" }));
		const t = await taskManager.createTask(
			teamId,
			baseTask({ title: "Dependent", status: "todo", dependsOn: [dep.id] }),
		);

		const promoted = await taskManager.resolveDependencies(teamId);
		assert.equal(promoted.length, 1);
		assert.equal(promoted[0].id, t.id);
		assert.equal(promoted[0].status, "ready");
		await rm(dir, { recursive: true, force: true });
	});

	test("promotes blocked tasks whose dependencies are all done", async () => {
		const { taskManager, teamId, dir } = await setup();
		const dep = await taskManager.createTask(teamId, baseTask({ status: "done" }));
		const t = await taskManager.createTask(
			teamId,
			baseTask({ status: "blocked", dependsOn: [dep.id], blockers: ["waiting on dep"] }),
		);

		const promoted = await taskManager.resolveDependencies(teamId);
		assert.equal(promoted.length, 1);
		assert.equal(promoted[0].id, t.id);
		assert.equal(promoted[0].status, "ready");
		await rm(dir, { recursive: true, force: true });
	});

	test("does not promote tasks with unresolved dependencies", async () => {
		const { taskManager, teamId, dir } = await setup();
		const dep = await taskManager.createTask(teamId, baseTask({ status: "in_progress" }));
		await taskManager.createTask(
			teamId,
			baseTask({ status: "todo", dependsOn: [dep.id] }),
		);

		const promoted = await taskManager.resolveDependencies(teamId);
		assert.equal(promoted.length, 0);
		await rm(dir, { recursive: true, force: true });
	});

	test("does not touch tasks with no dependencies", async () => {
		const { taskManager, teamId, dir } = await setup();
		await taskManager.createTask(teamId, baseTask({ status: "todo", dependsOn: [] }));
		const promoted = await taskManager.resolveDependencies(teamId);
		assert.equal(promoted.length, 0);
		await rm(dir, { recursive: true, force: true });
	});

	test("only promotes todo and blocked tasks, not in_progress", async () => {
		const { taskManager, teamId, dir } = await setup();
		const dep = await taskManager.createTask(teamId, baseTask({ status: "done" }));
		await taskManager.createTask(
			teamId,
			baseTask({ status: "in_progress", dependsOn: [dep.id] }),
		);
		const promoted = await taskManager.resolveDependencies(teamId);
		assert.equal(promoted.length, 0);
		await rm(dir, { recursive: true, force: true });
	});

	test("persists the promoted tasks so they remain ready on reload", async () => {
		const { taskManager, teamId, dir } = await setup();
		const dep = await taskManager.createTask(teamId, baseTask({ status: "done" }));
		const t = await taskManager.createTask(
			teamId,
			baseTask({ status: "todo", dependsOn: [dep.id] }),
		);

		await taskManager.resolveDependencies(teamId);
		const reloaded = await taskManager.getTask(teamId, t.id);
		assert.equal(reloaded?.status, "ready");
		await rm(dir, { recursive: true, force: true });
	});
});
