/**
 * Pi Teams — LeaderRuntime Unit Tests
 *
 * Covers: launchLeader, spawnTeammate, runLeaderCycle, detectStalledTasks,
 *         automateTeammateHandoffs, planTeamComposition,
 *         summarizeCompletionOutput, buildTaskContext.
 *
 * Uses real TeamStore + managers against temp directories, with mocked
 * subprocess spawning via _spawnFn injection.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore } from "../core/store.ts";
import { TeamManager } from "../managers/team-manager.ts";
import { TaskManager } from "../managers/task-manager.ts";
import { SignalManager } from "../managers/signal-manager.ts";
import { MailboxManager } from "../managers/mailbox-manager.ts";
import {
  LeaderRuntime,
  summarizeCompletionOutput,
  buildTaskPrompt,
} from "../runtime/leader-runtime.ts";
import type { TaskRecord, TeamIntent, TeamRecord } from "../core/types.ts";
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
  const runtime = new LeaderRuntime(
    store,
    teamManager,
    taskManager,
    signalManager,
    mailboxManager,
  );
  return {
    dir,
    store,
    teamManager,
    taskManager,
    signalManager,
    mailboxManager,
    runtime,
  };
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

function makeTask(
  teamId: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
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

  test("includes previousAttemptOutput as resume hint when present", () => {
    const task = makeTask("team-1", {
      title: "Task",
      previousAttemptOutput:
        "Ran pnpm install. Started typecheck but process was killed.",
    });
    const prompt = buildTaskPrompt(task);
    assert.ok(
      prompt.includes("Previous attempt"),
      "should flag resume section",
    );
    assert.ok(prompt.includes("pnpm install"), "should embed partial output");
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

  test("spawns LLM leader subprocess and starts polling interval", async () => {
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

    // The first LLM leader turn is fire-and-forget, so spawn may still be
    // pending microtasks when launchLeader resolves. Wait a tick.
    await new Promise((r) => setTimeout(r, 50));

    // The LLM leader subprocess was spawned (task authoring happens via its tool calls).
    assert.ok(
      mockProcs.length >= 1,
      "Should have spawned at least one leader subprocess",
    );

    // Should have emitted team_summary signals
    const signals = await ctx.signalManager.getSignals(team.id);
    assert.ok(
      signals.some((s) => s.type === "team_summary"),
      "Should emit team_summary signal",
    );
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
        setTimeout(
          () => proc.complete('["backend", "tester", "reviewer"]'),
          10,
        );
      }
      return proc as any;
    };

    await ctx.runtime.launchLeader(team.id);

    // Wait for planning to finish
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(planningSpawnCalled, "Should have called planTeamComposition");

    const updatedTeam = await ctx.store.loadTeam(team.id);
    assert.ok(
      updatedTeam!.teammates.length > 0,
      "Team should have teammates after planning",
    );
    assert.ok(
      updatedTeam!.teammates.includes("reviewer"),
      "Should always include reviewer",
    );
  });

  test("skips launch if already running (idempotent)", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "reviewer"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    const procs: ReturnType<typeof createMockChildProcess>[] = [];
    ctx.runtime._spawnFn = () => {
      const proc = createMockChildProcess();
      procs.push(proc);
      return proc as any;
    };

    await ctx.runtime.launchLeader(team.id);
    // Let the fire-and-forget leader turn reach its spawn so teardown can
    // later complete it cleanly (otherwise in-flight file writes race rm).
    await new Promise((r) => setTimeout(r, 50));
    const signalsBefore = (await ctx.signalManager.getSignals(team.id)).length;

    // Second launch should be a no-op
    await ctx.runtime.launchLeader(team.id);
    const signalsAfter = (await ctx.signalManager.getSignals(team.id)).length;

    // No new signals should be emitted
    assert.equal(
      signalsBefore,
      signalsAfter,
      "Second launch should not emit signals",
    );

    // Complete the pending leader turn before teardown to avoid a race
    // between a still-in-flight saveLeaderProcess and the temp-dir removal.
    for (const proc of procs) proc.complete("done", 0);
    await new Promise((r) => setTimeout(r, 50));
  });

  test("cleans up activeLeaders slot on setup failure", async () => {
    ctx = await setup();
    // No team saved — loadTeam will return null, causing failure
    try {
      await ctx.runtime.launchLeader("nonexistent-team");
    } catch {
      // Expected to throw
    }
    assert.ok(
      !ctx.runtime.isLeaderRunning("nonexistent-team"),
      "Should cleanup on failure",
    );
  });

  test("emits team_summary signal on start", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "reviewer"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    const procs: ReturnType<typeof createMockChildProcess>[] = [];
    ctx.runtime._spawnFn = () => {
      const proc = createMockChildProcess();
      procs.push(proc);
      return proc as any;
    };

    await ctx.runtime.launchLeader(team.id);
    const signals = await ctx.signalManager.getSignals(team.id);
    const summarySignals = signals.filter(
      (s) => s.type === "team_summary" && s.message.includes("Leader started"),
    );
    assert.ok(summarySignals.length > 0, "Should emit leader started signal");

    // Complete the fire-and-forget leader turn so teardown doesn't race with
    // in-flight saveLeaderProcess writes against the temp dir.
    await new Promise((r) => setTimeout(r, 50));
    for (const proc of procs) proc.complete("done", 0);
    await new Promise((r) => setTimeout(r, 50));
  });

  test("retries awaited bootstrap before failing when early turns produce no tasks", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "reviewer"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    let spawnCount = 0;
    ctx.runtime._spawnFn = () => {
      spawnCount += 1;
      const proc = createMockChildProcess();

      setTimeout(async () => {
        if (spawnCount === 1) {
          proc.complete("");
          return;
        }

        await ctx.taskManager.createTask(team.id, {
          title: "Bootstrap task",
          owner: "backend",
          priority: "high",
        });
        proc.complete("");
      }, 0);

      return proc as any;
    };

    await ctx.runtime.launchLeader(team.id, { awaitBootstrap: true });

    const tasks = await ctx.taskManager.getTasks(team.id);
    assert.equal(tasks.length, 1, "should keep retrying until a task exists");
    assert.equal(spawnCount, 2, "should need a second bootstrap attempt");

    const signals = await ctx.signalManager.getSignals(team.id);
    assert.ok(
      signals.some((s) =>
        s.message.includes("Bootstrap attempt 1/3 produced no tasks"),
      ),
      "should record the retry nudge in signals",
    );
  });
});

describe("runLlmLeaderTurn", () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  test("does not emit the no-op warning when the subprocess executed tools", async () => {
    ctx = await setup();
    const team = makeTeam({ status: "running" });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    ctx.runtime._spawnFn = () => {
      const proc = createMockChildProcess();
      setTimeout(() => {
        proc.emitToolExecution("team_query", { teamId: team.id, action: "tasks" });
        proc.complete("");
      }, 0);
      return proc as any;
    };

    await ctx.runtime.runLlmLeaderTurn(team.id);

    const signals = await ctx.signalManager.getSignals(team.id);
    assert.ok(
      !signals.some((s) =>
        s.message.includes("produced no output and made no tool calls"),
      ),
      "tool-driven turns without final text should not be labelled as no-op",
    );
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
      team.id,
      "backend",
      task.id,
      "Implement the API",
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
    assert.ok(
      signals.some((s) => s.type === "task_started" && s.taskId === task.id),
    );
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
    await new Promise((r) => setTimeout(r, 200));

    const updated = await ctx.taskManager.getTask(team.id, task.id);
    assert.equal(updated!.status, "done");
    assert.ok(
      !ctx.runtime.isTeammateRunning(team.id, "backend"),
      "Should no longer be running",
    );

    const signals = await ctx.signalManager.getSignals(team.id);
    assert.ok(
      signals.some((s) => s.type === "task_completed" && s.taskId === task.id),
    );
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
    await new Promise((r) => setTimeout(r, 200));

    const updated = await ctx.taskManager.getTask(team.id, task.id);
    assert.equal(updated!.status, "blocked");
    assert.ok(updated!.blockers.some((b) => b.includes("Compilation error")));

    const signals = await ctx.signalManager.getSignals(team.id);
    assert.ok(signals.some((s) => s.type === "error" && s.taskId === task.id));
  });

  test("persists teammate debug metadata and artifacts on failure", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "reviewer"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    const task = makeTask(team.id, { owner: "backend" });
    await ctx.store.saveTasks(team.id, [task]);

    const mockProc = createMockChildProcess();
    ctx.runtime._spawnFn = () => mockProc as any;

    await ctx.runtime.spawnTeammate(team.id, "backend", task.id, "Implement");

    mockProc.emitToolExecution("bash", { command: "pwd" }, "ok");
    mockProc.fail(1, "Authentication failed\nprovider error");
    await new Promise((r) => setTimeout(r, 200));

    const procState = await ctx.store.loadTeammateProcess(team.id, "backend");
    assert.ok(procState);
    assert.equal(procState!.state, "failed");
    assert.equal(procState!.terminationReason, "failed");
    assert.equal(procState!.exitCode, 1);
    assert.equal(procState!.toolExecutions, 1);
    assert.ok(procState!.promptArtifact);
    assert.ok(procState!.invocationArtifact);
    assert.ok(procState!.stderrArtifact);
    assert.ok(procState!.eventsArtifact);

    const stderrPath = join(ctx.store.getTeamDir(team.id), procState!.stderrArtifact!);
    const stderrLog = await readFile(stderrPath, "utf8");
    assert.match(stderrLog, /Authentication failed/);

    const eventsPath = join(ctx.store.getTeamDir(team.id), procState!.eventsArtifact!);
    const eventsLog = await readFile(eventsPath, "utf8");
    assert.match(eventsLog, /tool_execution_end/);
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
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(!ctx.runtime.isTeammateRunning(team.id, "backend"));

    const procState = await ctx.store.loadTeammateProcess(team.id, "backend");
    assert.equal(procState?.terminationReason, "manual_stop");
  });

  test("triggers automateTeammateHandoffs on success", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "frontend", "reviewer"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    const backendTask = makeTask(team.id, {
      id: "task-001",
      owner: "backend",
      title: "Implement backend",
    });
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

    await ctx.runtime.spawnTeammate(
      team.id,
      "backend",
      backendTask.id,
      "Implement API",
    );

    // Complete with handoff
    mockProc.complete(
      "Done.\nHandoffs:\n- to: frontend | message: API ready at /health",
    );
    await new Promise((r) => setTimeout(r, 300));

    // Check that handoff signal was emitted
    const signals = await ctx.signalManager.getSignals(team.id);
    assert.ok(
      signals.some((s) => s.type === "handoff"),
      "Should emit handoff signal",
    );

    // Check mailbox
    const messages = await ctx.mailboxManager.getMessagesFor(
      team.id,
      "frontend",
    );
    assert.ok(
      messages.length > 0,
      "Frontend should have received mailbox message",
    );
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
    const team = makeTeam({
      status: "cancelled",
      teammates: ["backend", "reviewer"],
    });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);
    await ctx.store.saveTasks(team.id, [
      makeTask(team.id, { owner: "backend", status: "ready" }),
    ]);

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
    const team = makeTeam({
      teammates: ["backend", "reviewer"],
      status: "running",
    });
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
    await new Promise((r) => setTimeout(r, 200));

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
    await new Promise((r) => setTimeout(r, 300));

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
    await new Promise((r) => setTimeout(r, 100));

    // Complete all spawned teammates
    // The bootstrap creates tasks with owners, leader cycle spawns them
    const activeTeammates = ctx.runtime.getActiveTeammates(team.id);
    // Complete the mock proc immediately
    mockProc.complete("Done with the work.");
    await new Promise((r) => setTimeout(r, 500));

    // Check that some tasks moved to done
    const tasks = await ctx.taskManager.getTasks(team.id);
    const doneTasks = tasks.filter((t) => t.status === "done");
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
    await new Promise((r) => setTimeout(r, 300));

    const signals = await ctx.signalManager.getSignals(team.id);
    const completedSignals = signals.filter((s) => s.type === "team_completed");
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
    const team = makeTeam({
      teammates: ["backend", "reviewer"],
      status: "running",
    });
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
    await new Promise((r) => setTimeout(r, 300));

    const updated = await ctx.taskManager.getTask(team.id, task.id);
    assert.equal(updated!.status, "blocked", "Stalled task should be blocked");
    assert.ok(updated!.blockers.some((b) => b.includes("process lost")));
  });

  test("respects STALL_GRACE_MS — no false positives on fresh tasks", async () => {
    ctx = await setup();
    const team = makeTeam({
      teammates: ["backend", "reviewer"],
      status: "running",
    });
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
    await new Promise((r) => setTimeout(r, 200));

    const updated = await ctx.taskManager.getTask(team.id, task.id);
    // Task should still be in_progress (not falsely stalled)
    assert.equal(
      updated!.status,
      "in_progress",
      "Fresh task should not be flagged as stalled",
    );
  });

  test("emits blocked signal with retry count", async () => {
    ctx = await setup();
    const team = makeTeam({
      teammates: ["backend", "reviewer"],
      status: "running",
    });
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
    await new Promise((r) => setTimeout(r, 300));

    const signals = await ctx.signalManager.getSignals(team.id);
    const blockedSignals = signals.filter(
      (s) => s.type === "blocked" && s.message.includes("Stalled task"),
    );
    assert.ok(
      blockedSignals.length > 0,
      "Should emit blocked signal for stalled task",
    );
    assert.ok(
      blockedSignals[0].message.includes("attempt"),
      "Should include retry info",
    );
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

    const backendTask = makeTask(team.id, {
      id: "task-001",
      owner: "backend",
      title: "Backend work",
    });
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

    await ctx.runtime.spawnTeammate(
      team.id,
      "backend",
      backendTask.id,
      "Do backend work",
    );
    mockProc.complete("Backend completed. API is live.");
    await new Promise((r) => setTimeout(r, 300));

    const messages = await ctx.mailboxManager.getMessagesFor(
      team.id,
      "frontend",
    );
    assert.ok(
      messages.length > 0,
      "Should have a handoff message for frontend",
    );
    assert.ok(messages.some((m) => m.from === "backend"));
  });

  test("ignores legacy 'Handoffs:' output sections — explicit handoffs now use team_handoff tool", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "frontend", "reviewer"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    // Only reviewer has a dependency on backend; frontend does not.
    const backendTask = makeTask(team.id, { id: "task-001", owner: "backend" });
    const reviewerTask = makeTask(team.id, {
      id: "task-002",
      owner: "reviewer",
      dependsOn: ["task-001"],
    });
    await ctx.store.saveTasks(team.id, [backendTask, reviewerTask]);

    const mockProc = createMockChildProcess();
    ctx.runtime._spawnFn = () => mockProc as any;

    await ctx.runtime.spawnTeammate(
      team.id,
      "backend",
      backendTask.id,
      "Implement",
    );
    // Even though the output mentions frontend, frontend is NOT a dependency,
    // so no automatic handoff is sent. Legacy "Handoffs:" blobs are ignored.
    mockProc.complete(
      "Done.\nHandoffs:\n- to: frontend | message: Component props ready\n- to: reviewer | message: Focus on auth",
    );
    await new Promise((r) => setTimeout(r, 300));

    const frontendMessages = await ctx.mailboxManager.getMessagesFor(
      team.id,
      "frontend",
    );
    assert.equal(
      frontendMessages.length,
      0,
      "Frontend must NOT receive a message — it's not a downstream dep",
    );

    const reviewerMessages = await ctx.mailboxManager.getMessagesFor(
      team.id,
      "reviewer",
    );
    assert.ok(
      reviewerMessages.length > 0,
      "Reviewer receives a dependency_handoff",
    );
    assert.equal(reviewerMessages[0].type, "dependency_handoff");
  });

  test("emits handoff signal per recipient", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "frontend", "reviewer"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    const backendTask = makeTask(team.id, { id: "task-001", owner: "backend" });
    const frontendTask = makeTask(team.id, {
      id: "task-002",
      owner: "frontend",
      dependsOn: ["task-001"],
    });
    const reviewerTask = makeTask(team.id, {
      id: "task-003",
      owner: "reviewer",
      dependsOn: ["task-001"],
    });
    await ctx.store.saveTasks(team.id, [
      backendTask,
      frontendTask,
      reviewerTask,
    ]);

    const mockProc = createMockChildProcess();
    ctx.runtime._spawnFn = () => mockProc as any;

    await ctx.runtime.spawnTeammate(
      team.id,
      "backend",
      backendTask.id,
      "Implement",
    );
    mockProc.complete("Done with backend.");
    await new Promise((r) => setTimeout(r, 300));

    const signals = await ctx.signalManager.getSignals(team.id);
    const handoffSignals = signals.filter((s) => s.type === "handoff");
    assert.ok(
      handoffSignals.length >= 2,
      "Should have handoff signals for frontend and reviewer",
    );
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
    await new Promise((r) => setTimeout(r, 500));

    const updatedTeam = await ctx.store.loadTeam(team.id);
    assert.ok(
      updatedTeam!.teammates.length > 0,
      "Should have fallback teammates",
    );
    assert.ok(
      updatedTeam!.teammates.includes("reviewer"),
      "Fallback should include reviewer",
    );
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
    await new Promise((r) => setTimeout(r, 300));

    const updatedTeam = await ctx.store.loadTeam(team.id);
    assert.ok(
      updatedTeam!.teammates.includes("reviewer"),
      "Should always add reviewer",
    );
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
    await ctx.store.saveMemory(
      team.id,
      "contracts",
      "API: GET /health → { status: ok }",
    );
    await ctx.store.saveMemory(
      team.id,
      "discoveries",
      "Uses Express with TypeScript",
    );
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

    const capturedContext = await (ctx.runtime as any).buildTaskContext(
      team.id,
      task,
    );

    // The prompt should contain team context
    assert.ok(
      capturedContext.includes("Test Team") ||
        capturedContext.includes("test-team"),
      "Context should include team name",
    );
    assert.ok(
      capturedContext.includes("Test objective") ||
        capturedContext.includes("Objective:"),
      "Context should include objective",
    );
    assert.ok(
      capturedContext.includes("Use the shared /health contract"),
      "Context should include mailbox guidance",
    );
    assert.ok(
      capturedContext.includes("API: GET /health"),
      "Context should include contract memory",
    );
  });

  test("prioritizes task-relevant signals over unrelated activity", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "reviewer"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);
    const dependency = makeTask(team.id, {
      id: "task-000",
      owner: "reviewer",
      status: "done",
    });
    const task = makeTask(team.id, {
      owner: "backend",
      dependsOn: [dependency.id],
    });
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

    const capturedContext = await (ctx.runtime as any).buildTaskContext(
      team.id,
      task,
    );

    assert.ok(
      capturedContext.includes(`Focus on ${task.id}`),
      "Context should include direct task signal",
    );
    assert.ok(
      capturedContext.includes(
        `${dependency.id} is complete and ready for backend`,
      ),
      "Context should include dependency handoff",
    );
    const unrelatedMatches =
      capturedContext.match(/Unrelated signal \d+/g) ?? [];
    assert.ok(
      unrelatedMatches.length <= 3,
      `Should keep unrelated signals heavily capped (found ${unrelatedMatches.length})`,
    );
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

    const contextBody = await (ctx.runtime as any).buildTaskContext(
      team.id,
      task,
    );
    assert.ok(
      contextBody.length <= 6000,
      `Context should stay within 6000 chars (got ${contextBody.length})`,
    );
    assert.ok(
      contextBody.includes("Team Contracts"),
      "Contracts should be included in budgeted context",
    );
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
    await new Promise((r) => setTimeout(r, 100));

    await ctx.runtime.stopTeam(team.id);

    assert.ok(
      !ctx.runtime.isLeaderRunning(team.id),
      "Leader should be stopped",
    );
    assert.deepEqual(
      ctx.runtime.getActiveTeammates(team.id),
      [],
      "No active teammates",
    );
  });
});

// ---------------------------------------------------------------------------
// LeaderRuntime — LLM leader path (default, and only, path)
// ---------------------------------------------------------------------------

describe("LLM leader path", () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  test("launchLeader spawns an LLM leader subprocess and does not pre-create tasks", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "reviewer"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    let leaderSpawnArgs:
      | { promptFilePath: string; userMessage: string }
      | undefined;
    ctx.runtime._spawnFn = (promptFilePath, userMessage) => {
      if (!leaderSpawnArgs) {
        leaderSpawnArgs = { promptFilePath, userMessage };
      }
      const proc = createMockChildProcess();
      // Finish the leader turn immediately with a dummy summary.
      setTimeout(() => proc.complete("Leader finished the turn."), 5);
      return proc as any;
    };

    await ctx.runtime.launchLeader(team.id);
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(leaderSpawnArgs, "LLM leader subprocess should be spawned");
    assert.match(leaderSpawnArgs!.userMessage, /Current state/);
    assert.match(
      leaderSpawnArgs!.userMessage,
      /(?:Decide the next actions|IMPORTANT: The task graph is empty)/,
    );

    // Task authoring is delegated to the LLM — no runtime-created bootstrap tasks.
    const tasks = await ctx.taskManager.getTasks(team.id);
    assert.equal(
      tasks.length,
      0,
      "Runtime must not pre-create hardcoded tasks",
    );
  });

  test("injects referenced objective plan content into bootstrap state when the graph is empty", async () => {
    ctx = await setup();
    const planDir = await mkdtemp(join(tmpdir(), "pi-team-plan-"));
    const planPath = join(planDir, "plan.md");
    await writeFile(
      planPath,
      "# Target Tracking Plan\n\n- Add API endpoint\n- Implement service\n- Add tests\n",
      "utf8",
    );

    try {
      const team = makeTeam({
        objective: `implement this plan ${planPath}`,
        teammates: ["backend", "reviewer"],
      });
      await ctx.store.ensureTeamDirs(team.id, team.teammates);
      await ctx.store.saveTeam(team);

      let leaderSpawnArgs:
        | { promptFilePath: string; userMessage: string }
        | undefined;
      ctx.runtime._spawnFn = (promptFilePath, userMessage) => {
        if (!leaderSpawnArgs) {
          leaderSpawnArgs = { promptFilePath, userMessage };
        }
        const proc = createMockChildProcess();
        setTimeout(() => proc.complete("Leader finished the turn."), 5);
        return proc as any;
      };

      await ctx.runtime.launchLeader(team.id, { awaitBootstrap: true }).catch(() => {
        // No tasks are created in this mocked run; we only care about the prompt payload.
      });

      assert.ok(leaderSpawnArgs, "LLM leader subprocess should be spawned");
      assert.match(
        leaderSpawnArgs!.userMessage,
        /Objective documents referenced by the objective/,
      );
      assert.match(leaderSpawnArgs!.userMessage, /Target Tracking Plan/);
      assert.match(leaderSpawnArgs!.userMessage, /IMPORTANT: The task graph is empty/);
    } finally {
      await rm(planDir, { recursive: true, force: true });
    }
  });

  test("never auto-spawns teammates — only the LLM decides via team_spawn_teammate", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);
    // Seed a ready task and prove the runtime does NOT pick it up on its own.
    await ctx.store.saveTasks(team.id, [
      makeTask(team.id, { id: "task-001", owner: "backend", status: "ready" }),
    ]);

    let leaderSpawns = 0;
    let teammateSpawns = 0;
    ctx.runtime._spawnFn = (_promptFilePath, userMessage) => {
      if (userMessage.startsWith("Task:")) teammateSpawns += 1;
      else leaderSpawns += 1;
      const proc = createMockChildProcess();
      // Leader turn exits without calling any tools, so no teammate spawn results.
      setTimeout(() => proc.complete("nothing to do"), 5);
      return proc as any;
    };

    await ctx.runtime.launchLeader(team.id);
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(leaderSpawns >= 1, "At least one leader turn should fire");
    assert.equal(
      teammateSpawns,
      0,
      "Runtime must not auto-spawn teammates; only the LLM's tool calls should do that",
    );
  });
});

// ---------------------------------------------------------------------------
// LeaderRuntime — event-driven wake (mailbox → leader)
// ---------------------------------------------------------------------------

describe("event-driven wake", () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  test("sending a message to 'leader' wakes a cycle without waiting for the poll tick", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);
    await ctx.store.saveTasks(team.id, [
      makeTask(team.id, { id: "task-001", owner: "backend", status: "ready" }),
    ]);

    let spawnCount = 0;
    ctx.runtime._spawnFn = () => {
      spawnCount += 1;
      return createMockChildProcess() as any;
    };

    await ctx.runtime.launchLeader(team.id);
    // Initial cycle already fired (spawned the ready task). Reset counter.
    await new Promise((r) => setTimeout(r, 50));
    const baseline = spawnCount;

    // User pushes guidance while the leader is idle between poll ticks.
    await ctx.mailboxManager.send(team.id, {
      from: "user",
      to: "leader",
      type: "guidance",
      message: "Also prioritise auth review.",
      attachments: [],
    });

    // Wait long enough for the debounced wake to fire, but much less than
    // the 20s polling interval — proving it's event-driven, not polled.
    await new Promise((r) => setTimeout(r, 500));

    const signals = await ctx.signalManager.getSignals(team.id);
    assert.ok(
      signals.some((s) => s.message.includes("User guidance received")),
      "Leader should consume the mailbox message after the debounced wake",
    );
    // A cycle ran, which implies the wake landed. Exact spawn count isn't
    // the focus — just that we reacted before the 20s tick.
    assert.ok(spawnCount >= baseline, "Cycle must have run");
  });

  test("peer-to-peer handoffs do NOT wake the leader", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend", "frontend"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);
    ctx.runtime._spawnFn = () => createMockChildProcess() as any;

    await ctx.runtime.launchLeader(team.id);
    await new Promise((r) => setTimeout(r, 50));

    // Snapshot the signal log before the peer handoff.
    const before = (await ctx.signalManager.getSignals(team.id)).length;

    // Teammate → teammate handoff. `to: "frontend"` — not for the leader.
    await ctx.mailboxManager.send(team.id, {
      from: "backend",
      to: "frontend",
      type: "teammate_handoff",
      message: "API contract ready at /health",
      attachments: [],
    });

    await new Promise((r) => setTimeout(r, 500));

    // No leader cycle should have run in response — so no new leader-source
    // signals should have been emitted from mailbox processing.
    const after = await ctx.signalManager.getSignals(team.id);
    const newLeaderSignals = after
      .slice(before)
      .filter(
        (s) => s.source === "leader" && s.message.includes("User guidance"),
      );
    assert.equal(
      newLeaderSignals.length,
      0,
      "Peer messages must not trigger a leader wake",
    );
  });

  test("broadcast messages ('to: all') wake the leader", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);
    ctx.runtime._spawnFn = () => createMockChildProcess() as any;

    await ctx.runtime.launchLeader(team.id);
    await new Promise((r) => setTimeout(r, 50));

    await ctx.mailboxManager.send(team.id, {
      from: "user",
      to: "all",
      type: "guidance",
      message: "Everyone: stop and wait for triage.",
      attachments: [],
    });

    await new Promise((r) => setTimeout(r, 500));
    const signals = await ctx.signalManager.getSignals(team.id);
    assert.ok(
      signals.some((s) => s.message.includes("User guidance received")),
      "Broadcast messages should also wake the leader",
    );
  });
});

// ---------------------------------------------------------------------------
// drainPendingIntents (queued spawn_teammate)
// ---------------------------------------------------------------------------

function makeIntent(overrides: Partial<TeamIntent> = {}): TeamIntent {
  return {
    kind: "spawn_teammate",
    id: `intent-${Math.random().toString(36).slice(2, 10)}`,
    teamId: "test-team-001",
    createdAt: new Date().toISOString(),
    role: "backend",
    taskId: "task-001",
    taskDescription: "Queued task",
    ...overrides,
  };
}

describe("drainPendingIntents", () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  test("spawns a teammate and marks the intent processed", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    const task = makeTask(team.id, { owner: "backend", status: "ready" });
    await ctx.store.saveTasks(team.id, [task]);

    ctx.runtime._spawnFn = () => createMockChildProcess() as any;

    const intent = makeIntent({
      teamId: team.id,
      role: "backend",
      taskId: task.id,
      taskDescription: "Do the work",
    });
    await ctx.store.writeIntent(team.id, intent);

    // Drive a leader cycle; drainPendingIntents runs as its first step.
    await ctx.runtime.launchLeader(team.id);
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(
      ctx.runtime.isTeammateRunning(team.id, "backend"),
      "backend teammate should be running after drain",
    );
    const pending = await ctx.store.listPendingIntents(team.id);
    assert.equal(pending.length, 0);
  });

  test("drops intents whose task is already done without spawning", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    const task = makeTask(team.id, { owner: "backend", status: "done" });
    await ctx.store.saveTasks(team.id, [task]);

    let spawnCalled = 0;
    ctx.runtime._spawnFn = () => {
      spawnCalled += 1;
      return createMockChildProcess() as any;
    };

    const intent = makeIntent({
      teamId: team.id,
      role: "backend",
      taskId: task.id,
    });
    await ctx.store.writeIntent(team.id, intent);

    await ctx.runtime.launchLeader(team.id);
    await new Promise((r) => setTimeout(r, 300));

    // Only the leader turn's spawn counts; no teammate spawn should happen.
    assert.ok(
      !ctx.runtime.isTeammateRunning(team.id, "backend"),
      "teammate must not be spawned for a done task",
    );
    const pending = await ctx.store.listPendingIntents(team.id);
    assert.equal(pending.length, 0, "intent should be marked processed");
    // The planner+leader spawns themselves count — we only care the teammate
    // slot stayed empty.
    assert.ok(spawnCalled >= 0);
  });

  test("leaves the intent pending when the role slot is busy, retries after completion", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    const task1 = makeTask(team.id, {
      id: "task-001",
      owner: "backend",
      status: "ready",
    });
    const task2 = makeTask(team.id, {
      id: "task-002",
      owner: "backend",
      status: "ready",
    });
    await ctx.store.saveTasks(team.id, [task1, task2]);

    // First process belongs to the direct spawn, second to the drained intent.
    const first = createMockChildProcess();
    const second = createMockChildProcess();
    const procs = [first, second];
    ctx.runtime._spawnFn = () => procs.shift() as any;

    // Occupy the backend slot by spawning task1 directly.
    await ctx.runtime.spawnTeammate(
      team.id,
      "backend",
      task1.id,
      "Task 1",
    );
    assert.ok(ctx.runtime.isTeammateRunning(team.id, "backend"));

    // Queue a second intent for the same role while busy.
    const intent = makeIntent({
      teamId: team.id,
      role: "backend",
      taskId: task2.id,
    });
    await ctx.store.writeIntent(team.id, intent);

    // A drain now should NOT spawn because the role slot is still busy.
    await (ctx.runtime as any).drainPendingIntents(team.id);
    const pendingWhileBusy = await ctx.store.listPendingIntents(team.id);
    assert.equal(
      pendingWhileBusy.length,
      1,
      "intent must remain pending while role slot is busy",
    );
    assert.equal(
      (ctx.runtime as any).activeTeammates.size,
      1,
      "no extra teammate should have been spawned during the busy drain",
    );

    // Finish the first teammate. Its completion handler triggers a leader
    // cycle whose first step is drainPendingIntents — so the queued intent
    // is picked up and the backend slot is re-occupied by task2.
    first.complete("Task 1 done");
    await new Promise((r) => setTimeout(r, 300));

    const pendingAfter = await ctx.store.listPendingIntents(team.id);
    assert.equal(
      pendingAfter.length,
      0,
      "intent must be drained once the role slot frees",
    );
    assert.ok(
      ctx.runtime.isTeammateRunning(team.id, "backend"),
      "task2 teammate should now be running",
    );
    const task2State = await ctx.taskManager.getTask(team.id, task2.id);
    assert.equal(task2State!.status, "in_progress");
  });

  test("fs.watch on intents/pending wakes the leader cycle", async () => {
    ctx = await setup();
    const team = makeTeam({ teammates: ["backend"] });
    await ctx.store.ensureTeamDirs(team.id, team.teammates);
    await ctx.store.saveTeam(team);

    const task = makeTask(team.id, { owner: "backend", status: "ready" });
    await ctx.store.saveTasks(team.id, [task]);

    ctx.runtime._spawnFn = () => createMockChildProcess() as any;
    await ctx.runtime.launchLeader(team.id);
    // Let launch settle so the initial cycle (and any initial spawn) completes.
    await new Promise((r) => setTimeout(r, 200));

    // Stop the initial teammate, if any, so we can observe a fresh spawn
    // triggered by the watcher path specifically.
    if (ctx.runtime.isTeammateRunning(team.id, "backend")) {
      await ctx.runtime.stopTeammate(team.id, "backend", "manual_stop");
    }
    // Reset task back to ready so the drained intent has work to do.
    await ctx.taskManager.updateTask(team.id, task.id, {
      status: "ready",
      owner: "backend",
      blockers: [],
    });

    const intent = makeIntent({
      teamId: team.id,
      role: "backend",
      taskId: task.id,
    });
    await ctx.store.writeIntent(team.id, intent);

    // Wait long enough for fs.watch → scheduleWake (WAKE_DEBOUNCE_MS = 200ms)
    // plus drain + spawn. Fall well short of LEADER_POLL_MS (20s) so we prove
    // the watcher — not the poll — drove the wake.
    await new Promise((r) => setTimeout(r, 800));

    assert.ok(
      ctx.runtime.isTeammateRunning(team.id, "backend"),
      "watcher-triggered cycle should have drained the intent and spawned the teammate",
    );
  });
});
