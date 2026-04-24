// Pi Team-Mode — Task Board Tests

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { TaskStore, isUnblocked, type TaskRecord } from "../core/tasks.ts";
import { TaskManager, VersionConflictError } from "../managers/task-manager.ts";

function setup(): Promise<{ store: TaskStore; manager: TaskManager; dir: string; sessionId: string }> {
	return mkdtemp(join(tmpdir(), "team-mode-tasks-")).then((dir) => {
		const store = new TaskStore(dir);
		const sessionId = "session-test";
		const manager = new TaskManager({ store, getParentSessionId: () => sessionId });
		return { store, manager, dir, sessionId };
	});
}

async function cleanup(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

describe("TaskStore round-trip", () => {
	test("save + load + list + delete", async () => {
		const { store, dir, sessionId } = await setup();
		try {
			const now = new Date().toISOString();
			const record: TaskRecord = {
				id: "task-first-abcd1234",
				subject: "first",
				status: "pending",
				owner: null,
				blockedBy: [],
				blocks: [],
				parentSessionId: sessionId,
				createdAt: now,
				updatedAt: now,
				version: 1,
			};
			await store.save(record);
			assert.deepEqual(await store.load(sessionId, "task-first-abcd1234"), record);
			assert.equal((await store.list(sessionId)).length, 1);
			await store.delete(sessionId, "task-first-abcd1234");
			assert.equal((await store.list(sessionId)).length, 0);
		} finally {
			await cleanup(dir);
		}
	});

	test("list returns [] on missing dir", async () => {
		const { store, dir } = await setup();
		try {
			assert.deepEqual(await store.list("never-created"), []);
		} finally {
			await cleanup(dir);
		}
	});
});

describe("isUnblocked", () => {
	const makeTask = (o: Partial<TaskRecord>): TaskRecord => ({
		id: o.id ?? "t",
		subject: o.subject ?? "t",
		status: o.status ?? "pending",
		owner: o.owner ?? null,
		blockedBy: o.blockedBy ?? [],
		blocks: o.blocks ?? [],
		parentSessionId: "s",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		version: 1,
	});

	test("unblocked when all deps completed", () => {
		const task = makeTask({ id: "t", blockedBy: ["a"] });
		const byId = new Map([
			[task.id, task],
			["a", makeTask({ id: "a", status: "completed" })],
		]);
		assert.equal(isUnblocked(task, byId), true);
	});

	test("blocked when any dep pending", () => {
		const task = makeTask({ id: "t", blockedBy: ["a"] });
		const byId = new Map([
			[task.id, task],
			["a", makeTask({ id: "a", status: "pending" })],
		]);
		assert.equal(isUnblocked(task, byId), false);
	});

	test("deleted deps treated as resolved", () => {
		const task = makeTask({ id: "t", blockedBy: ["a"] });
		const byId = new Map([
			[task.id, task],
			["a", makeTask({ id: "a", status: "deleted" })],
		]);
		assert.equal(isUnblocked(task, byId), true);
	});
});

describe("TaskManager.create", () => {
	test("creates pending + unassigned per Claude Code shape", async () => {
		const { manager, dir } = await setup();
		try {
			const t = await manager.create({ subject: "a", description: "do a" });
			assert.equal(t.status, "pending");
			assert.equal(t.owner, null);
			assert.deepEqual(t.blockedBy, []);
			assert.deepEqual(t.blocks, []);
			assert.equal(t.version, 1);
			assert.match(t.id, /^task-a-[0-9a-f]{8}$/);
		} finally {
			await cleanup(dir);
		}
	});

	test("captures activeForm and metadata", async () => {
		const { manager, dir } = await setup();
		try {
			const t = await manager.create({
				subject: "run tests",
				description: "run the suite",
				activeForm: "Running tests",
				metadata: { priority: "high" },
			});
			assert.equal(t.activeForm, "Running tests");
			assert.deepEqual(t.metadata, { priority: "high" });
		} finally {
			await cleanup(dir);
		}
	});
});

describe("TaskManager.update — assignment + deps + CAS", () => {
	test("coordinator assigns owner via task_update", async () => {
		const { manager, dir } = await setup();
		try {
			const t = await manager.create({ subject: "a" });
			const assigned = await manager.update(t.id, { owner: "alice", status: "in_progress" });
			assert.equal(assigned.owner, "alice");
			assert.equal(assigned.status, "in_progress");
		} finally {
			await cleanup(dir);
		}
	});

	test("addBlockedBy / addBlocks merges with existing arrays", async () => {
		const { manager, dir } = await setup();
		try {
			const a = await manager.create({ subject: "a" });
			const b = await manager.create({ subject: "b" });
			const c = await manager.create({ subject: "c" });
			const updated = await manager.update(c.id, { addBlockedBy: [a.id, b.id] });
			assert.deepEqual(updated.blockedBy.sort(), [a.id, b.id].sort());
		} finally {
			await cleanup(dir);
		}
	});

	test("CAS guard rejects stale version", async () => {
		const { manager, dir } = await setup();
		try {
			const t = await manager.create({ subject: "a" });
			await manager.update(t.id, { status: "in_progress" });
			await assert.rejects(
				() => manager.update(t.id, { expectedVersion: t.version, owner: "alice" }),
				VersionConflictError,
			);
		} finally {
			await cleanup(dir);
		}
	});

	test("CAS guard accepts fresh version", async () => {
		const { manager, dir } = await setup();
		try {
			const t = await manager.create({ subject: "a" });
			const updated = await manager.update(t.id, {
				expectedVersion: t.version,
				owner: "alice",
			});
			assert.equal(updated.version, t.version + 1);
		} finally {
			await cleanup(dir);
		}
	});
});

describe("TaskManager — TaskCompleted hook", () => {
	test("hook success keeps task completed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-tasks-"));
		try {
			const store = new TaskStore(dir);
			const manager = new TaskManager({
				store,
				getParentSessionId: () => "s",
				getTaskCompletedHook: () => "exit 0",
			});
			const t = await manager.create({ subject: "a" });
			const done = await manager.update(t.id, { status: "completed" });
			assert.equal(done.status, "completed");
		} finally {
			await cleanup(dir);
		}
	});

	test("hook failure reverts to failed with output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-tasks-"));
		try {
			const store = new TaskStore(dir);
			const manager = new TaskManager({
				store,
				getParentSessionId: () => "s",
				getTaskCompletedHook: () => "echo 'test broke' >&2; exit 7",
			});
			const t = await manager.create({ subject: "a" });
			const done = await manager.update(t.id, { status: "completed" });
			assert.equal(done.status, "failed");
			assert.match(done.result ?? "", /hook failed, exit 7/);
			assert.match(done.hookOutput ?? "", /test broke/);
		} finally {
			await cleanup(dir);
		}
	});

	test("hook only runs on transition INTO completed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-tasks-"));
		try {
			const store = new TaskStore(dir);
			let hookCalls = 0;
			const manager = new TaskManager({
				store,
				getParentSessionId: () => "s",
				getTaskCompletedHook: () => {
					hookCalls++;
					return "exit 0";
				},
			});
			const t = await manager.create({ subject: "a" });
			await manager.update(t.id, { status: "in_progress" });
			await manager.update(t.id, { status: "failed" });
			assert.equal(hookCalls, 0);
		} finally {
			await cleanup(dir);
		}
	});
});

describe("TaskManager.list filters", () => {
	test("status + owner + teamId", async () => {
		const { manager, dir } = await setup();
		try {
			const a = await manager.create({ subject: "a", teamId: "billing" });
			await manager.create({ subject: "b", teamId: "billing" });
			await manager.create({ subject: "c" });
			await manager.update(a.id, { owner: "alice", status: "in_progress" });
			assert.equal((await manager.list({ owner: "alice" })).length, 1);
			assert.equal((await manager.list({ status: "in_progress" })).length, 1);
			assert.equal((await manager.list({ teamId: "billing" })).length, 2);
		} finally {
			await cleanup(dir);
		}
	});
});
