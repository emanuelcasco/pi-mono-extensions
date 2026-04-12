/**
 * Pi Teams — SignalManager Unit Tests
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore } from "../core/store.ts";
import { SignalManager } from "../managers/signal-manager.ts";
import type { Signal, TeamRecord } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setup(): Promise<{
	store: TeamStore;
	signalManager: SignalManager;
	teamId: string;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "pi-teams-signal-"));
	const store = new TeamStore(dir);
	const signalManager = new SignalManager(store);
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
		teammates: [],
	};
	await store.saveTeam(team);

	return { store, signalManager, teamId, dir };
}

type EmitInput = Omit<Signal, "id" | "teamId" | "timestamp">;

function baseSignal(overrides: Partial<EmitInput> = {}): EmitInput {
	return {
		source: "backend",
		type: "task_started",
		severity: "info",
		message: "Task started",
		links: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

describe("SignalManager.emit", () => {
	test("assigns sequential sig-NNN IDs", async () => {
		const { signalManager, teamId, dir } = await setup();
		const s1 = await signalManager.emit(teamId, baseSignal({ message: "first" }));
		const s2 = await signalManager.emit(teamId, baseSignal({ message: "second" }));
		assert.equal(s1.id, "sig-001");
		assert.equal(s2.id, "sig-002");
		await rm(dir, { recursive: true, force: true });
	});

	test("sets teamId and timestamp on emitted signal", async () => {
		const { signalManager, teamId, dir } = await setup();
		const before = new Date().toISOString();
		const signal = await signalManager.emit(teamId, baseSignal());
		const after = new Date().toISOString();
		assert.equal(signal.teamId, teamId);
		assert.ok(signal.timestamp >= before);
		assert.ok(signal.timestamp <= after);
		await rm(dir, { recursive: true, force: true });
	});

	test("persists signal to store", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ message: "persisted" }));
		const all = await signalManager.getSignals(teamId);
		assert.ok(all.some((s) => s.message === "persisted"));
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getSignals
// ---------------------------------------------------------------------------

describe("SignalManager.getSignals", () => {
	test("returns all signals when no filter is provided", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ type: "task_started" }));
		await signalManager.emit(teamId, baseSignal({ type: "task_completed" }));
		const signals = await signalManager.getSignals(teamId);
		assert.equal(signals.length, 2);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by single type", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ type: "task_started" }));
		await signalManager.emit(teamId, baseSignal({ type: "task_completed" }));
		const signals = await signalManager.getSignals(teamId, { type: "task_completed" });
		assert.equal(signals.length, 1);
		assert.equal(signals[0].type, "task_completed");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by multiple types", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ type: "task_started" }));
		await signalManager.emit(teamId, baseSignal({ type: "task_completed" }));
		await signalManager.emit(teamId, baseSignal({ type: "blocked" }));
		const signals = await signalManager.getSignals(teamId, {
			type: ["task_started", "blocked"],
		});
		assert.equal(signals.length, 2);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by severity", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ severity: "error", message: "err" }));
		await signalManager.emit(teamId, baseSignal({ severity: "info", message: "info" }));
		const signals = await signalManager.getSignals(teamId, { severity: "error" });
		assert.equal(signals.length, 1);
		assert.equal(signals[0].message, "err");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by source", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ source: "backend" }));
		await signalManager.emit(teamId, baseSignal({ source: "frontend" }));
		const signals = await signalManager.getSignals(teamId, { source: "backend" });
		assert.equal(signals.length, 1);
		assert.equal(signals[0].source, "backend");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by taskId", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ taskId: "task-001" }));
		await signalManager.emit(teamId, baseSignal({ taskId: "task-002" }));
		const signals = await signalManager.getSignals(teamId, { taskId: "task-001" });
		assert.equal(signals.length, 1);
		assert.equal(signals[0].taskId, "task-001");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by since timestamp", async () => {
		const { signalManager, teamId, store, dir } = await setup();
		// Emit two signals with controlled timestamps via store directly
		await store.appendSignal(teamId, {
			id: "sig-001",
			teamId,
			source: "backend",
			type: "task_started",
			severity: "info",
			message: "old",
			links: [],
			timestamp: "2026-01-01T00:00:00Z",
		});
		await store.appendSignal(teamId, {
			id: "sig-002",
			teamId,
			source: "backend",
			type: "task_started",
			severity: "info",
			message: "new",
			links: [],
			timestamp: "2026-12-01T00:00:00Z",
		});

		const signals = await signalManager.getSignals(teamId, {
			since: "2026-06-01T00:00:00Z",
		});
		assert.equal(signals.length, 1);
		assert.equal(signals[0].message, "new");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by until timestamp", async () => {
		const { signalManager, teamId, store, dir } = await setup();
		await store.appendSignal(teamId, {
			id: "sig-001",
			teamId,
			source: "backend",
			type: "task_started",
			severity: "info",
			message: "old",
			links: [],
			timestamp: "2026-01-01T00:00:00Z",
		});
		await store.appendSignal(teamId, {
			id: "sig-002",
			teamId,
			source: "backend",
			type: "task_started",
			severity: "info",
			message: "new",
			links: [],
			timestamp: "2026-12-01T00:00:00Z",
		});

		const signals = await signalManager.getSignals(teamId, {
			until: "2026-06-01T00:00:00Z",
		});
		assert.equal(signals.length, 1);
		assert.equal(signals[0].message, "old");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getSignalsSince
// ---------------------------------------------------------------------------

describe("SignalManager.getSignalsSince", () => {
	test("returns signals at or after the given timestamp", async () => {
		const { signalManager, teamId, store, dir } = await setup();
		await store.appendSignal(teamId, {
			id: "sig-001",
			teamId,
			source: "backend",
			type: "task_started",
			severity: "info",
			message: "before",
			links: [],
			timestamp: "2026-01-01T00:00:00Z",
		});
		await store.appendSignal(teamId, {
			id: "sig-002",
			teamId,
			source: "backend",
			type: "task_completed",
			severity: "info",
			message: "after",
			links: [],
			timestamp: "2026-12-01T00:00:00Z",
		});

		const result = await signalManager.getSignalsSince(teamId, "2026-06-01T00:00:00Z");
		assert.equal(result.length, 1);
		assert.equal(result[0].message, "after");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getSignalsSinceLastCheck
// ---------------------------------------------------------------------------

describe("SignalManager.getSignalsSinceLastCheck", () => {
	test("returns all signals when team has never been checked", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ message: "first" }));
		await signalManager.emit(teamId, baseSignal({ message: "second" }));

		const result = await signalManager.getSignalsSinceLastCheck(teamId);
		assert.equal(result.length, 2);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns only signals since lastCheckedAt", async () => {
		const { signalManager, teamId, store, dir } = await setup();
		const checkTime = "2026-06-01T00:00:00Z";

		await store.appendSignal(teamId, {
			id: "sig-001",
			teamId,
			source: "backend",
			type: "task_started",
			severity: "info",
			message: "old",
			links: [],
			timestamp: "2026-01-01T00:00:00Z",
		});
		await store.appendSignal(teamId, {
			id: "sig-002",
			teamId,
			source: "backend",
			type: "task_completed",
			severity: "info",
			message: "new",
			links: [],
			timestamp: "2026-12-01T00:00:00Z",
		});

		// Stamp the lastCheckedAt on the team
		await store.setLastChecked(teamId, checkTime);

		const result = await signalManager.getSignalsSinceLastCheck(teamId);
		assert.equal(result.length, 1);
		assert.equal(result[0].message, "new");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getBubbleSignals
// ---------------------------------------------------------------------------

describe("SignalManager.getBubbleSignals", () => {
	test("returns bubble-worthy signal types (approval_requested, blocked warning, team_completed)", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ type: "approval_requested", severity: "warning" }));
		await signalManager.emit(teamId, baseSignal({ type: "team_completed", severity: "info" }));
		await signalManager.emit(teamId, baseSignal({ type: "task_started", severity: "info" })); // NOT bubble-worthy

		const result = await signalManager.getBubbleSignals(teamId);
		assert.equal(result.length, 2);
		await rm(dir, { recursive: true, force: true });
	});

	test("suppresses blocked signals with info severity", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ type: "blocked", severity: "info" }));
		await signalManager.emit(teamId, baseSignal({ type: "blocked", severity: "warning" }));

		const result = await signalManager.getBubbleSignals(teamId);
		assert.equal(result.length, 1);
		assert.equal(result[0].severity, "warning");
		await rm(dir, { recursive: true, force: true });
	});

	test("respects since parameter", async () => {
		const { signalManager, teamId, store, dir } = await setup();
		// Both signals are set at controlled timestamps to avoid dependence on wall clock
		await store.appendSignal(teamId, {
			id: "sig-001",
			teamId,
			source: "leader",
			type: "team_completed",
			severity: "info",
			message: "old completion",
			links: [],
			timestamp: "2025-01-01T00:00:00Z",
		});
		await store.appendSignal(teamId, {
			id: "sig-002",
			teamId,
			source: "leader",
			type: "team_completed",
			severity: "info",
			message: "new completion",
			links: [],
			timestamp: "2025-12-01T00:00:00Z",
		});

		const result = await signalManager.getBubbleSignals(teamId, "2025-06-01T00:00:00Z");
		assert.equal(result.length, 1);
		assert.equal(result[0].message, "new completion");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getSignalsForSource
// ---------------------------------------------------------------------------

describe("SignalManager.getSignalsForSource", () => {
	test("returns signals from the specified source", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ source: "backend", message: "be" }));
		await signalManager.emit(teamId, baseSignal({ source: "frontend", message: "fe" }));

		const result = await signalManager.getSignalsForSource(teamId, "backend");
		assert.equal(result.length, 1);
		assert.equal(result[0].message, "be");
		await rm(dir, { recursive: true, force: true });
	});

	test("respects limit parameter and returns most recent", async () => {
		const { signalManager, teamId, dir } = await setup();
		for (let i = 1; i <= 5; i++) {
			await signalManager.emit(teamId, baseSignal({ source: "backend", message: `msg-${i}` }));
		}

		const result = await signalManager.getSignalsForSource(teamId, "backend", 2);
		assert.equal(result.length, 2);
		assert.equal(result[0].message, "msg-4");
		assert.equal(result[1].message, "msg-5");
		await rm(dir, { recursive: true, force: true });
	});

	test("returns all signals when limit is not provided", async () => {
		const { signalManager, teamId, dir } = await setup();
		for (let i = 0; i < 4; i++) {
			await signalManager.emit(teamId, baseSignal({ source: "backend" }));
		}
		const result = await signalManager.getSignalsForSource(teamId, "backend");
		assert.equal(result.length, 4);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// compacted signal view
// ---------------------------------------------------------------------------

describe("SignalManager compacted signal view", () => {
	test("rebuildCompactedSignals collapses progress chatter into summary signals", async () => {
		const { signalManager, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ source: "backend", type: "progress_update", message: "tool 1" }));
		await signalManager.emit(teamId, baseSignal({ source: "backend", type: "progress_update", message: "tool 2" }));
		await signalManager.emit(teamId, baseSignal({ source: "leader", type: "team_summary", message: "Phase transition: research → synthesis" }));

		const compacted = await signalManager.rebuildCompactedSignals(teamId);
		assert.equal(compacted.some((signal) => signal.message.includes("Compacted activity")), true);
		assert.equal(compacted.some((signal) => signal.message === "tool 1"), false);
		assert.equal(compacted.some((signal) => signal.message === "tool 2"), false);
		await rm(dir, { recursive: true, force: true });
	});

	test("completed compaction drops task assignment/start noise from context view", async () => {
		const { signalManager, store, teamId, dir } = await setup();
		await signalManager.emit(teamId, baseSignal({ source: "leader", type: "task_assigned", message: "Assigned task-001" }));
		await signalManager.emit(teamId, baseSignal({ source: "backend", type: "task_started", message: "Started task-001" }));
		await signalManager.emit(teamId, baseSignal({ source: "backend", type: "progress_update", message: "working" }));
		await signalManager.emit(teamId, baseSignal({ source: "backend", type: "task_completed", message: "Finished task-001" }));
		await signalManager.emit(teamId, baseSignal({ source: "leader", type: "team_completed", message: "Team completed" }));

		await signalManager.rebuildCompactedSignals(teamId, { completed: true });
		const contextSignals = await signalManager.getContextSignals(teamId);
		assert.equal(contextSignals.some((signal) => signal.type === "task_assigned"), false);
		assert.equal(contextSignals.some((signal) => signal.type === "task_started"), false);
		assert.equal(contextSignals.some((signal) => signal.type === "progress_update"), false);
		assert.equal(contextSignals.some((signal) => signal.type === "task_completed"), true);
		assert.equal((await store.loadCompactedSignals(teamId))?.length ? true : false, true);
		await rm(dir, { recursive: true, force: true });
	});
});
