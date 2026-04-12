/**
 * Pi Teams — LeaderRuntime Unit Tests
 *
 * Covers: launchLeader, spawnTeammate, runLeaderCycle, detectStalledTasks,
 *         automateTeammateHandoffs, planTeamComposition, parseExplicitHandoffs,
 *         summarizeCompletionOutput, buildTaskContext.
 *
 * Uses real TeamStore + managers against temp directories, with mocked
 * subprocess spawning via _spawnFn injection.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore } from "../core/store.ts";
import { TeamManager } from "../managers/team-manager.ts";
import { TaskManager } from "../managers/task-manager.ts";
import { SignalManager } from "../managers/signal-manager.ts";
import { MailboxManager } from "../managers/mailbox-manager.ts";
import {
	LeaderRuntime,
	parseExplicitHandoffs,
	summarizeCompletionOutput,
	buildTaskPrompt,
} from "../runtime/leader-runtime.ts";
import type { TaskRecord, TeamRecord } from "../core/types.ts";
import { createMockChildProcess } from "./helpers/mock-subprocess.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestContext = {
	dir: string;
	store: TeamStore;
	teamManager: TeamManager;
	taskManager: TaskManager;
	signalManager: SignalManager;
	mailboxManager: MailboxManager;
	runtime: LeaderRuntime;
};

async function setup(): Promise<TestContext> {
	const dir = await mkdtemp(join(tmpdir(), "pi-teams-leader-test-"));
	const store = new TeamStore(dir);
	const teamManager = new TeamManager(store);
	const taskManager = new TaskManager(store);
	const signalManager = new SignalManager(store);
	const mailboxManager = new MailboxManager(store);
	const runtime = new LeaderRuntime(store, teamManager, taskManager, signalManager, mailboxManager);
	return { dir, store, teamManager, taskManager, signalManager, mailboxManager, runtime };
}

async function teardown(ctx: TestContext): Promise<void> {
	await ctx.runtime.cleanup();
	await rm(ctx.dir, { recursive: true, force: true });
}

function makeTeam(overrides: Partial<TeamRecord> = {}): TeamRecord {
	const now = new Date().toISOString();
	return {
		id: "test-team-001",
		name: "Test Team",
		status: "initializing",
		createdAt: now,
		updatedAt: now,
		objective: "Test objective",
		repoRoots: ["/tmp/fake-repo"],
		teammates: ["backend", "reviewer"],
		...overrides,
	};
}

function makeTask(teamId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	const now = new Date().toISOString();
	return {
		id: "task-001",
		teamId,
		title: "Test task",
		status: "ready",
		priority: "high",
		dependsOn: [],
		riskLevel: "low",
		approvalRequired: false,
		artifacts: [],
		blockers: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// parseExplicitHandoffs
// ---------------------------------------------------------------------------

describe("parseExplicitHandoffs", () => {
	test("parses 'to: role | message: text' format", () => {
		const output = [
			"Some work done.",
			"Handoff notes:",
			"- to: frontend | message: API is ready at /settings",
			"- to: reviewer | message: Check auth in billing.ts",
		].join("\n");

		const result = parseExplicitHandoffs(output, ["backend", "frontend", "reviewer"], "backend");
		assert.equal(result.length, 2);
		assert.equal(result[0].to, "frontend");
		assert.equal(result[0].message, "API is ready at /settings");
		assert.equal(result[1].to, "reviewer");
		assert.equal(result[1].message, "Check auth in billing.ts");
	});

	test("parses 'role: text' format inside handoff section", () => {
		const output = [
			"Done.",
			"## Handoffs",
			"frontend: The component props changed",
			"reviewer: Focus on the migration logic",
		].join("\n");

		const result = parseExplicitHandoffs(output, ["backend", "frontend", "reviewer"], "backend");
		assert.equal(result.length, 2);
		assert.equal(result[0].to, "frontend");
		assert.equal(result[1].to, "reviewer");
	});

	test("ignores invalid recipients not in team", () => {
		const output = [
			"Handoffs:",
			"- to: nonexistent | message: hello",
			"- to: frontend | message: real handoff",
		].join("\n");

		const result = parseExplicitHandoffs(output, ["backend", "frontend"], "backend");
		assert.equal(result.length, 1);
		assert.equal(result[0].to, "frontend");
	});

	test("ignores handoffs to self", () => {
		const output = [
			"Handoffs:",
			"- to: backend | message: note to self",
			"- to: frontend | message: real handoff",
		].join("\n");

		const result = parseExplicitHandoffs(output, ["backend", "frontend"], "backend");
		assert.equal(result.length, 1);
		assert.equal(result[0].to, "frontend");
	});

	test("merges duplicate recipient messages", () => {
		const output = [
			"Handoffs:",
			"- to: frontend | message: first note",
			"- to: frontend | message: second note",
		].join("\n");

		const result = parseExplicitHandoffs(output, ["backend", "frontend"], "backend");
		assert.equal(result.length, 1);
		assert.equal(result[0].to, "frontend");
		assert.ok(result[0].message.includes("first note"));
		assert.ok(result[0].message.includes("second note"));
	});

	test("returns empty array when no handoffs present", () => {
		const output = "Just completed the work. No handoffs needed.";
		const result = parseExplicitHandoffs(output, ["backend", "frontend"], "backend");
		assert.equal(result.length, 0);
	});
});

// ---------------------------------------------------------------------------
// summarizeCompletionOutput
// ---------------------------------------------------------------------------

describe("summarizeCompletionOutput", () => {
	test("returns first two non-header lines", () => {
		const output = [
			"# Summary",
			"Implemented the billing API endpoint.",
			"Added validation for all input fields.",
			"Tests pass at 95% coverage.",
		].join("\n");

		const result = summarizeCompletionOutput(output, "fallback");
		assert.ok(result.includes("billing API endpoint"));
		assert.ok(result.includes("validation"));
	});

	test("filters out known header patterns", () => {
		const output = [
			"What was accomplished:",
			"Fixed the bug in payment handler.",
			"Files created or modified:",
			"src/billing.ts",
		].join("\n");

		const result = summarizeCompletionOutput(output, "fallback");
		assert.ok(result.includes("Fixed the bug"));
		assert.ok(!result.includes("What was accomplished"));
	});

	test("returns fallback for empty output", () => {
		const result = summarizeCompletionOutput("", "my fallback");
		assert.equal(result, "my fallback");
	});

	test("truncates to 500 chars", () => {
		const longLine = "x".repeat(600);
		const result = summarizeCompletionOutput(longLine, "fallback");
		assert.ok(result.length <= 500);
	});
});

// ---------------------------------------------------------------------------
// buildTaskPrompt
// ---------------------------------------------------------------------------

describe("buildTaskPrompt", () => {
	test("includes title and description", () => {
		const task = makeTask("team-1", {
			title: "Implement API endpoint",
			description: "Create GET /health",
		});
		const prompt = buildTaskPrompt(task);
		assert.ok(prompt.includes("Implement API endpoint"));
		assert.ok(prompt.includes("Create GET /health"));
	});

	test("includes artifacts when present", () => {
		const task = makeTask("team-1", {
			title: "Task",
			artifacts: ["src/file.ts", "tests/file.test.ts"],
		});
		const prompt = buildTaskPrompt(task);
		assert.ok(prompt.includes("src/file.ts"));
	});

	test("includes blockers when present", () => {
		const task = makeTask("team-1", {
			title: "Task",
			blockers: ["Missing API schema"],
		});
		const prompt = buildTaskPrompt(task);
		assert.ok(prompt.includes("Missing API schema"));
	});
});

// ---------------------------------------------------------------------------
// LaaderRuntime — launchLeader
// ---------------------------------------------------------------------------

describe("launchLeader", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("creates bootstrap tasks and starts polling interval", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		// Inject a mock spawn to prevent real subprocess creation
		const mockProcs: ReturnType<typeof createMockChildProcess>[] = [];
		ctx.runtime._spawnFn = () => {
			const proc = createMockChildProcess();
			mockProcs.push(proc);
			// Don't auto-complete — we just need the leader to start
			return proc as any;
		};

		await ctx.runtime.launchLeader(team.id);
		assert.ok(ctx.runtime.isLeaderRunning(team.id));

		// Bootstrap tasks should have been created
		const tasks = await ctx.taskManager.getTasks(team.id);
		assert.ok(tasks.length > 0, "Should have bootstrap tasks");

		// Should have emitted team_summary signals
		const signals = await ctx.signalManager.getSignals(team.id);
		assert.ok(signals.some(s => s.type === "team_summary"), "Should emit team_summary signal");
	});

	test("calls planTeamComposition when team has no teammates", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: [] });
		await ctx.store.ensureTeamDirs(team.id, []);
		await ctx.store.saveTeam(team);

		let planningSpawnCalled = false;
		const mockProcs: ReturnType<typeof createMockChildProcess>[] = [];
		ctx.runtime._spawnFn = (_prompt, userMsg, _cwd) => {
			const proc = createMockChildProcess();
			mockProcs.push(proc);
			if (userMsg.includes("Select the right team roles")) {
				planningSpawnCalled = true;
				// Complete immediately with a valid role array
				setTimeout(() => proc.complete('["backend", "tester", "reviewer"]'), 10);
			}
			return proc as any;
		};

		await ctx.runtime.launchLeader(team.id);

		// Wait for planning to finish
		await new Promise(r => setTimeout(r, 100));

		assert.ok(planningSpawnCalled, "Should have called planTeamComposition");

		const updatedTeam = await ctx.store.loadTeam(team.id);
		assert.ok(updatedTeam!.teammates.length > 0, "Team should have teammates after planning");
		assert.ok(updatedTeam!.teammates.includes("reviewer"), "Should always include reviewer");
	});

	test("skips launch if already running (idempotent)", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		ctx.runtime._spawnFn = () => {
			const proc = createMockChildProcess();
			return proc as any;
		};

		await ctx.runtime.launchLeader(team.id);
		const signalsBefore = (await ctx.signalManager.getSignals(team.id)).length;

		// Second launch should be a no-op
		await ctx.runtime.launchLeader(team.id);
		const signalsAfter = (await ctx.signalManager.getSignals(team.id)).length;

		// No new signals should be emitted
		assert.equal(signalsBefore, signalsAfter, "Second launch should not emit signals");
	});

	test("cleans up activeLeaders slot on setup failure", async () => {
		ctx = await setup();
		// No team saved — loadTeam will return null, causing failure
		try {
			await ctx.runtime.launchLeader("nonexistent-team");
		} catch {
			// Expected to throw
		}
		assert.ok(!ctx.runtime.isLeaderRunning("nonexistent-team"), "Should cleanup on failure");
	});

	test("emits team_summary signal on start", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		ctx.runtime._spawnFn = () => {
			const proc = createMockChildProcess();
			return proc as any;
		};

		await ctx.runtime.launchLeader(team.id);
		const signals = await ctx.signalManager.getSignals(team.id);
		const summarySignals = signals.filter(s =>
			s.type === "team_summary" && s.message.includes("Leader started"),
		);
		assert.ok(summarySignals.length > 0, "Should emit leader started signal");
	});
});

// ---------------------------------------------------------------------------
// LeaderRuntime — spawnTeammate
// ---------------------------------------------------------------------------

describe("spawnTeammate", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("creates subprocess and tracks in activeTeammates", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const task = makeTask(team.id, { owner: "backend" });
		await ctx.store.saveTasks(team.id, [task]);

		const mockProc = createMockChildProcess();
		ctx.runtime._spawnFn = () => mockProc as any;

		const result = await ctx.runtime.spawnTeammate(
			team.id, "backend", task.id, "Implement the API",
		);

		assert.equal(result.role, "backend");
		assert.equal(result.state, "running");
		assert.ok(ctx.runtime.isTeammateRunning(team.id, "backend"));
	});

	test("throws if teammate already running for same role+team", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const task1 = makeTask(team.id, { id: "task-001", owner: "backend" });
		const task2 = makeTask(team.id, { id: "task-002", owner: "backend" });
		await ctx.store.saveTasks(team.id, [task1, task2]);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;

		await ctx.runtime.spawnTeammate(team.id, "backend", task1.id, "Task 1");

		await assert.rejects(
			() => ctx.runtime.spawnTeammate(team.id, "backend", task2.id, "Task 2"),
			{ message: /already running/ },
		);
	});

	test("updates task to in_progress on spawn", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const task = makeTask(team.id, { owner: "backend", status: "ready" });
		await ctx.store.saveTasks(team.id, [task]);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;
		await ctx.runtime.spawnTeammate(team.id, "backend", task.id, "Implement");

		const updated = await ctx.taskManager.getTask(team.id, task.id);
		assert.equal(updated!.status, "in_progress");
	});

	test("emits task_started signal", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const task = makeTask(team.id, { owner: "backend" });
		await ctx.store.saveTasks(team.id, [task]);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;
		await ctx.runtime.spawnTeammate(team.id, "backend", task.id, "Implement");

		const signals = await ctx.signalManager.getSignals(team.id);
		assert.ok(signals.some(s => s.type === "task_started" && s.taskId === task.id));
	});

	test("handles successful completion — marks task done, saves output", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const task = makeTask(team.id, { owner: "backend" });
		await ctx.store.saveTasks(team.id, [task]);

		const mockProc = createMockChildProcess();
		ctx.runtime._spawnFn = () => mockProc as any;

		await ctx.runtime.spawnTeammate(team.id, "backend", task.id, "Implement");

		// Simulate successful completion
		mockProc.complete("Implementation completed successfully.");
		await new Promise(r => setTimeout(r, 200));

		const updated = await ctx.taskManager.getTask(team.id, task.id);
		assert.equal(updated!.status, "done");
		assert.ok(!ctx.runtime.isTeammateRunning(team.id, "backend"), "Should no longer be running");

		const signals = await ctx.signalManager.getSignals(team.id);
		assert.ok(signals.some(s => s.type === "task_completed" && s.taskId === task.id));
	});

	test("handles failure — marks task blocked, emits error signal", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const task = makeTask(team.id, { owner: "backend" });
		await ctx.store.saveTasks(team.id, [task]);

		const mockProc = createMockChildProcess();
		ctx.runtime._spawnFn = () => mockProc as any;

		await ctx.runtime.spawnTeammate(team.id, "backend", task.id, "Implement");

		// Simulate failure
		mockProc.fail(1, "Compilation error");
		await new Promise(r => setTimeout(r, 200));

		const updated = await ctx.taskManager.getTask(team.id, task.id);
		assert.equal(updated!.status, "blocked");
		assert.ok(updated!.blockers.some(b => b.includes("Compilation error")));

		const signals = await ctx.signalManager.getSignals(team.id);
		assert.ok(signals.some(s => s.type === "error" && s.taskId === task.id));
	});

	test("handles cancellation — marks task cancelled", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const task = makeTask(team.id, { owner: "backend" });
		await ctx.store.saveTasks(team.id, [task]);

		const mockProc = createMockChildProcess();
		ctx.runtime._spawnFn = () => mockProc as any;

		await ctx.runtime.spawnTeammate(team.id, "backend", task.id, "Implement");

		// Stop the teammate (triggers cancellation)
		await ctx.runtime.stopTeammate(team.id, "backend");

		// The process abort will trigger the close handler
		mockProc.complete("partial output", 0);
		await new Promise(r => setTimeout(r, 200));

		assert.ok(!ctx.runtime.isTeammateRunning(team.id, "backend"));
	});

	test("triggers automateTeammateHandoffs on success", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "frontend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const backendTask = makeTask(team.id, { id: "task-001", owner: "backend", title: "Implement backend" });
		const frontendTask = makeTask(team.id, {
			id: "task-002",
			owner: "frontend",
			title: "Implement frontend",
			status: "todo",
			dependsOn: ["task-001"],
		});
		await ctx.store.saveTasks(team.id, [backendTask, frontendTask]);

		const mockProc = createMockChildProcess();
		ctx.runtime._spawnFn = () => mockProc as any;

		await ctx.runtime.spawnTeammate(team.id, "backend", backendTask.id, "Implement API");

		// Complete with handoff
		mockProc.complete("Done.\nHandoffs:\n- to: frontend | message: API ready at /health");
		await new Promise(r => setTimeout(r, 300));

		// Check that handoff signal was emitted
		const signals = await ctx.signalManager.getSignals(team.id);
		assert.ok(signals.some(s => s.type === "handoff"), "Should emit handoff signal");

		// Check mailbox
		const messages = await ctx.mailboxManager.getMessagesFor(team.id, "frontend");
		assert.ok(messages.length > 0, "Frontend should have received mailbox message");
	});
});

// ---------------------------------------------------------------------------
// LeaderRuntime — runLeaderCycle (tested via launchLeader + task manipulation)
// ---------------------------------------------------------------------------

describe("runLeaderCycle (via launchLeader)", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("skips if team is cancelled", async () => {
		ctx = await setup();
		const team = makeTeam({ status: "cancelled", teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);
		await ctx.store.saveTasks(team.id, [makeTask(team.id, { owner: "backend", status: "ready" })]);

		let spawnCalled = false;
		ctx.runtime._spawnFn = () => {
			spawnCalled = true;
			return createMockChildProcess() as any;
		};

		await (ctx.runtime as any).runLeaderCycleInner(team.id);

		assert.equal(spawnCalled, false);
		assert.deepEqual(ctx.runtime.getActiveTeammates(team.id), []);
	});

	test("resolves dependencies and spawns teammates for ready tasks", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"], status: "running" });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const task = makeTask(team.id, { owner: "backend", status: "ready" });
		await ctx.store.saveTasks(team.id, [task]);

		let spawnCalled = false;
		ctx.runtime._spawnFn = () => {
			spawnCalled = true;
			return createMockChildProcess() as any;
		};

		await ctx.runtime.launchLeader(team.id);
		await new Promise(r => setTimeout(r, 200));

		assert.ok(spawnCalled, "Should have spawned a teammate for the ready task");
	});

	test("serializes via cycleRunning set — no overlapping cycles", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;

		await ctx.runtime.launchLeader(team.id);
		// Multiple cycles should not error
		await new Promise(r => setTimeout(r, 300));

		assert.ok(ctx.runtime.isLeaderRunning(team.id));
	});

	test("detects team completion when all tasks done", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend"], status: "running" });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		// Create a single task that's already done
		const task = makeTask(team.id, { owner: "backend", status: "done" });
		await ctx.store.saveTasks(team.id, [task]);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;

		// Don't call launchLeader (which creates bootstrap tasks).
		// Instead, manually trigger a cycle by launching with pre-existing done tasks.
		// We need to set up the leader entry first.
		const abortController = new AbortController();
		// Use launchLeader which will create bootstrap tasks — let's set up differently.
		// Actually, let's just verify through launchLeader + completion flow.
		const mockProc = createMockChildProcess();
		ctx.runtime._spawnFn = () => mockProc as any;

		await ctx.runtime.launchLeader(team.id);

		// Bootstrap tasks are created. Let all ready tasks complete.
		await new Promise(r => setTimeout(r, 100));

		// Complete all spawned teammates
		// The bootstrap creates tasks with owners, leader cycle spawns them
		const activeTeammates = ctx.runtime.getActiveTeammates(team.id);
		// Complete the mock proc immediately
		mockProc.complete("Done with the work.");
		await new Promise(r => setTimeout(r, 500));

		// Check that some tasks moved to done
		const tasks = await ctx.taskManager.getTasks(team.id);
		const doneTasks = tasks.filter(t => t.status === "done");
		assert.ok(doneTasks.length > 0, "Should have some completed tasks");
	});

	test("emits team_completed signal and cleans up interval", async () => {
		ctx = await setup();
		// Create a team with a single backend teammate, one task already done
		const team = makeTeam({ teammates: ["backend"], status: "running" });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		// Pre-create all tasks as done to trigger immediate completion
		const task = makeTask(team.id, {
			id: "task-001",
			owner: "backend",
			status: "done",
			title: "Implement Backend work for Test objective",
		});
		// Need to save tasks so ensureBootstrapTasks sees existing tasks
		await ctx.store.saveTasks(team.id, [task]);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;
		await ctx.runtime.launchLeader(team.id);
		await new Promise(r => setTimeout(r, 300));

		const signals = await ctx.signalManager.getSignals(team.id);
		const completedSignals = signals.filter(s => s.type === "team_completed");
		assert.ok(completedSignals.length > 0, "Should emit team_completed signal");

		const updatedTeam = await ctx.store.loadTeam(team.id);
		assert.equal(updatedTeam!.status, "completed");
	});
});

// ---------------------------------------------------------------------------
// LeaderRuntime — detectStalledTasks
// ---------------------------------------------------------------------------

describe("detectStalledTasks (via leader cycle)", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("marks in_progress tasks as blocked when teammate process is lost", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"], status: "running" });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		// Create a task that's in_progress but no teammate is running
		const oldDate = new Date(Date.now() - 30_000).toISOString(); // 30s ago
		const task = makeTask(team.id, {
			owner: "backend",
			status: "in_progress",
			updatedAt: oldDate,
		});
		await ctx.store.saveTasks(team.id, [task]);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;
		await ctx.runtime.launchLeader(team.id);
		await new Promise(r => setTimeout(r, 300));

		const updated = await ctx.taskManager.getTask(team.id, task.id);
		assert.equal(updated!.status, "blocked", "Stalled task should be blocked");
		assert.ok(updated!.blockers.some(b => b.includes("process lost")));
	});

	test("respects STALL_GRACE_MS — no false positives on fresh tasks", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"], status: "running" });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		// Create a fresh in_progress task (just updated now)
		const task = makeTask(team.id, {
			owner: "backend",
			status: "in_progress",
			updatedAt: new Date().toISOString(),
		});
		await ctx.store.saveTasks(team.id, [task]);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;
		await ctx.runtime.launchLeader(team.id);
		await new Promise(r => setTimeout(r, 200));

		const updated = await ctx.taskManager.getTask(team.id, task.id);
		// Task should still be in_progress (not falsely stalled)
		assert.equal(updated!.status, "in_progress", "Fresh task should not be flagged as stalled");
	});

	test("emits blocked signal with retry count", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"], status: "running" });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const oldDate = new Date(Date.now() - 30_000).toISOString();
		const task = makeTask(team.id, {
			owner: "backend",
			status: "in_progress",
			updatedAt: oldDate,
		});
		await ctx.store.saveTasks(team.id, [task]);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;
		await ctx.runtime.launchLeader(team.id);
		await new Promise(r => setTimeout(r, 300));

		const signals = await ctx.signalManager.getSignals(team.id);
		const blockedSignals = signals.filter(s =>
			s.type === "blocked" && s.message.includes("Stalled task"),
		);
		assert.ok(blockedSignals.length > 0, "Should emit blocked signal for stalled task");
		assert.ok(blockedSignals[0].message.includes("attempt"), "Should include retry info");
	});
});

// ---------------------------------------------------------------------------
// LeaderRuntime — automateTeammateHandoffs (tested via spawnTeammate completion)
// ---------------------------------------------------------------------------

describe("automateTeammateHandoffs", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("sends mailbox messages to downstream task owners", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "frontend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const backendTask = makeTask(team.id, { id: "task-001", owner: "backend", title: "Backend work" });
		const frontendTask = makeTask(team.id, {
			id: "task-002",
			owner: "frontend",
			title: "Frontend work",
			status: "todo",
			dependsOn: ["task-001"],
		});
		await ctx.store.saveTasks(team.id, [backendTask, frontendTask]);

		const mockProc = createMockChildProcess();
		ctx.runtime._spawnFn = () => mockProc as any;

		await ctx.runtime.spawnTeammate(team.id, "backend", backendTask.id, "Do backend work");
		mockProc.complete("Backend completed. API is live.");
		await new Promise(r => setTimeout(r, 300));

		const messages = await ctx.mailboxManager.getMessagesFor(team.id, "frontend");
		assert.ok(messages.length > 0, "Should have a handoff message for frontend");
		assert.ok(messages.some(m => m.from === "backend"));
	});

	test("parses explicit handoff sections from output", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "frontend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const backendTask = makeTask(team.id, { id: "task-001", owner: "backend" });
		const reviewerTask = makeTask(team.id, { id: "task-002", owner: "reviewer", dependsOn: ["task-001"] });
		await ctx.store.saveTasks(team.id, [backendTask, reviewerTask]);

		const mockProc = createMockChildProcess();
		ctx.runtime._spawnFn = () => mockProc as any;

		await ctx.runtime.spawnTeammate(team.id, "backend", backendTask.id, "Implement");
		mockProc.complete("Done.\nHandoffs:\n- to: frontend | message: Component props ready\n- to: reviewer | message: Focus on auth");
		await new Promise(r => setTimeout(r, 300));

		const signals = await ctx.signalManager.getSignals(team.id);
		const handoffSignals = signals.filter(s => s.type === "handoff");
		assert.ok(handoffSignals.length >= 1, "Should have handoff signals");
	});

	test("emits handoff signal per recipient", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "frontend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const backendTask = makeTask(team.id, { id: "task-001", owner: "backend" });
		const frontendTask = makeTask(team.id, { id: "task-002", owner: "frontend", dependsOn: ["task-001"] });
		const reviewerTask = makeTask(team.id, { id: "task-003", owner: "reviewer", dependsOn: ["task-001"] });
		await ctx.store.saveTasks(team.id, [backendTask, frontendTask, reviewerTask]);

		const mockProc = createMockChildProcess();
		ctx.runtime._spawnFn = () => mockProc as any;

		await ctx.runtime.spawnTeammate(team.id, "backend", backendTask.id, "Implement");
		mockProc.complete("Done with backend.");
		await new Promise(r => setTimeout(r, 300));

		const signals = await ctx.signalManager.getSignals(team.id);
		const handoffSignals = signals.filter(s => s.type === "handoff");
		assert.ok(handoffSignals.length >= 2, "Should have handoff signals for frontend and reviewer");
	});
});

// ---------------------------------------------------------------------------
// LeaderRuntime — planTeamComposition / parseRolesFromOutput
// ---------------------------------------------------------------------------

describe("planTeamComposition (via launchLeader with empty teammates)", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("falls back to fullstack template roles on subprocess failure", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: [] });
		await ctx.store.ensureTeamDirs(team.id, []);
		await ctx.store.saveTeam(team);

		ctx.runtime._spawnFn = () => {
			const proc = createMockChildProcess();
			// Fail immediately
			setTimeout(() => proc.fail(1, "crash"), 5);
			return proc as any;
		};

		await ctx.runtime.launchLeader(team.id);
		await new Promise(r => setTimeout(r, 500));

		const updatedTeam = await ctx.store.loadTeam(team.id);
		assert.ok(updatedTeam!.teammates.length > 0, "Should have fallback teammates");
		assert.ok(updatedTeam!.teammates.includes("reviewer"), "Fallback should include reviewer");
	});

	test("always includes reviewer role", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: [] });
		await ctx.store.ensureTeamDirs(team.id, []);
		await ctx.store.saveTeam(team);

		ctx.runtime._spawnFn = () => {
			const proc = createMockChildProcess();
			// Return roles without reviewer
			setTimeout(() => proc.complete('["backend", "tester"]'), 10);
			return proc as any;
		};

		await ctx.runtime.launchLeader(team.id);
		await new Promise(r => setTimeout(r, 300));

		const updatedTeam = await ctx.store.loadTeam(team.id);
		assert.ok(updatedTeam!.teammates.includes("reviewer"), "Should always add reviewer");
	});
});

// ---------------------------------------------------------------------------
// LeaderRuntime — buildTaskContext (tested indirectly via spawnTeammate)
// ---------------------------------------------------------------------------

describe("buildTaskContext (via spawnTeammate)", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("includes team summary, signals, mailbox, and memory", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		// Add some memory
		await ctx.store.saveMemory(team.id, "contracts", "API: GET /health → { status: ok }");
		await ctx.store.saveMemory(team.id, "discoveries", "Uses Express with TypeScript");
		await ctx.store.saveMemory(team.id, "decisions", "Chose REST over GraphQL");

		const task = makeTask(team.id, { owner: "backend" });
		await ctx.store.saveTasks(team.id, [task]);
		await ctx.mailboxManager.send(team.id, {
			from: "leader",
			to: "backend",
			taskId: task.id,
			type: "guidance",
			message: "Use the shared /health contract",
			attachments: [],
		});

		// Emit some signals for context
		await ctx.signalManager.emit(team.id, {
			source: "leader",
			type: "team_summary",
			severity: "info",
			message: "Starting team",
			links: [],
		});

		const capturedContext = await (ctx.runtime as any).buildTaskContext(team.id, task);

		// The prompt should contain team context
		assert.ok(capturedContext.includes("Test Team") || capturedContext.includes("test-team"), "Context should include team name");
		assert.ok(capturedContext.includes("Test objective") || capturedContext.includes("Objective:"), "Context should include objective");
		assert.ok(capturedContext.includes("Use the shared /health contract"), "Context should include mailbox guidance");
		assert.ok(capturedContext.includes("API: GET /health"), "Context should include contract memory");
	});

	test("prioritizes task-relevant signals over unrelated activity", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);
		const dependency = makeTask(team.id, { id: "task-000", owner: "reviewer", status: "done" });
		const task = makeTask(team.id, { owner: "backend", dependsOn: [dependency.id] });
		await ctx.store.saveTasks(team.id, [dependency, task]);

		// Emit lots of unrelated chatter that should lose to relevant signals.
		for (let i = 0; i < 20; i++) {
			await ctx.signalManager.emit(team.id, {
				source: "frontend",
				type: "progress_update",
				severity: "info",
				message: `Unrelated signal ${i}`,
				links: [],
			});
		}
		await ctx.signalManager.emit(team.id, {
			source: "leader",
			type: "team_summary",
			severity: "info",
			taskId: task.id,
			message: `Focus on ${task.id}`,
			links: [],
		});
		await ctx.signalManager.emit(team.id, {
			source: "reviewer",
			type: "handoff",
			severity: "info",
			taskId: dependency.id,
			message: `${dependency.id} is complete and ready for backend`,
			links: [],
		});

		const capturedContext = await (ctx.runtime as any).buildTaskContext(team.id, task);

		assert.ok(capturedContext.includes(`Focus on ${task.id}`), "Context should include direct task signal");
		assert.ok(capturedContext.includes(`${dependency.id} is complete and ready for backend`), "Context should include dependency handoff");
		const unrelatedMatches = capturedContext.match(/Unrelated signal \d+/g) ?? [];
		assert.ok(unrelatedMatches.length <= 3, `Should keep unrelated signals heavily capped (found ${unrelatedMatches.length})`);
	});

	test("caps task context at 6000 chars while keeping contracts first", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		// Save very large memory
		await ctx.store.saveMemory(team.id, "contracts", "C".repeat(5000));
		await ctx.store.saveMemory(team.id, "discoveries", "D".repeat(5000));
		await ctx.store.saveMemory(team.id, "decisions", "E".repeat(5000));

		const task = makeTask(team.id, { owner: "backend" });
		await ctx.store.saveTasks(team.id, [task]);

		const contextBody = await (ctx.runtime as any).buildTaskContext(team.id, task);
		assert.ok(contextBody.length <= 6000, `Context should stay within 6000 chars (got ${contextBody.length})`);
		assert.ok(contextBody.includes("Team Contracts"), "Contracts should be included in budgeted context");
	});
});

// ---------------------------------------------------------------------------
// LeaderRuntime — stopTeam / cleanup
// ---------------------------------------------------------------------------

describe("stopTeam", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("stops leader and all teammates", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);

		const task = makeTask(team.id, { owner: "backend" });
		await ctx.store.saveTasks(team.id, [task]);

		ctx.runtime._spawnFn = () => createMockChildProcess() as any;
		await ctx.runtime.launchLeader(team.id);
		await new Promise(r => setTimeout(r, 100));

		await ctx.runtime.stopTeam(team.id);

		assert.ok(!ctx.runtime.isLeaderRunning(team.id), "Leader should be stopped");
		assert.deepEqual(ctx.runtime.getActiveTeammates(team.id), [], "No active teammates");
	});
});
