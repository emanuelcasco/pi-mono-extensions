/**
 * Pi Teams — TeamStore Unit Tests
 *
 * Tests for the persistence layer. Every test creates its own temporary
 * directory so tests are fully isolated and can run in parallel.
 */

import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore, generateId } from "../core/store.ts";
import type {
  ApprovalRequest,
  LeaderProcess,
  MailboxMessage,
  Signal,
  TaskRecord,
  TeamRecord,
  TeammateProcess,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore(): Promise<{ store: TeamStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-teams-test-"));
  return { store: new TeamStore(dir), dir };
}

function makeTeam(overrides: Partial<TeamRecord> = {}): TeamRecord {
  const now = new Date().toISOString();
  return {
    id: "team-20260403-001",
    name: "test-team",
    status: "running",
    createdAt: now,
    updatedAt: now,
    objective: "Test objective",
    repoRoots: [],
    teammates: ["backend", "frontend"],
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task-001",
    teamId: "team-20260403-001",
    title: "Test task",
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
    teamId: "team-20260403-001",
    source: "backend",
    type: "task_started",
    severity: "info",
    timestamp: new Date().toISOString(),
    message: "Task started",
    links: [],
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: "msg-001",
    teamId: "team-20260403-001",
    from: "backend",
    to: "frontend",
    type: "handoff",
    message: "API contract ready",
    attachments: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeApproval(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    id: "apr-001",
    teamId: "team-20260403-001",
    taskId: "task-001",
    submittedBy: "backend",
    artifact: "specs/plan.md",
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateId
// ---------------------------------------------------------------------------

describe("generateId", () => {
  test("generates team IDs from the provided name with date and time components", () => {
    const id = generateId("team", "My Team");
    assert.match(id, /^my-team-\d{8}-\d{6}$/);
  });

  test("generates sequential IDs for non-team prefixes", () => {
    // Use a unique prefix to avoid interference from other tests
    const prefix = `uniq-${Date.now()}`;
    const id1 = generateId(prefix);
    const id2 = generateId(prefix);
    assert.match(id1, /^\S+-\d{3}$/);
    assert.match(id2, /^\S+-\d{3}$/);
    assert.notEqual(id1, id2);
  });

  test("increments counter for the same prefix", () => {
    const prefix = `seq-${Date.now()}`;
    const id1 = generateId(prefix);
    const id2 = generateId(prefix);
    const n1 = parseInt(id1.split("-").at(-1)!, 10);
    const n2 = parseInt(id2.split("-").at(-1)!, 10);
    assert.equal(n2, n1 + 1);
  });

  test("counters are independent per prefix", () => {
    const ts = Date.now();
    const a = generateId(`alpha-${ts}`);
    const b = generateId(`beta-${ts}`);
    assert.match(a, /-001$/);
    assert.match(b, /-001$/);
  });
});

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

describe("TeamStore — directory helpers", () => {
  test("getTeamsDir returns .pi/teams path", async () => {
    const { store, dir } = await makeStore();
    assert.equal(store.getTeamsDir(), join(dir, ".pi", "teams"));
    await rm(dir, { recursive: true, force: true });
  });

  test("getTeamDir returns correct path under teams dir", async () => {
    const { store, dir } = await makeStore();
    assert.equal(
      store.getTeamDir("team-001"),
      join(dir, ".pi", "teams", "team-001"),
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("getTeammateDir returns correct nested path", async () => {
    const { store, dir } = await makeStore();
    assert.equal(
      store.getTeammateDir("team-001", "backend"),
      join(dir, ".pi", "teams", "team-001", "teammates", "backend"),
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("ensureTeamDirs creates directory tree", async () => {
    const { store, dir } = await makeStore();
    await store.ensureTeamDirs("team-001", ["backend", "frontend"]);

    const { access } = await import("node:fs/promises");
    await assert.doesNotReject(() =>
      access(join(dir, ".pi", "teams", "team-001", "memory")),
    );
    await assert.doesNotReject(() =>
      access(join(dir, ".pi", "teams", "team-001", "leader")),
    );
    await assert.doesNotReject(() =>
      access(
        join(
          dir,
          ".pi",
          "teams",
          "team-001",
          "teammates",
          "backend",
          "outputs",
        ),
      ),
    );
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Team CRUD
// ---------------------------------------------------------------------------

describe("TeamStore — team CRUD", () => {
  test("saveTeam then loadTeam returns same record", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);
    const loaded = await store.loadTeam(team.id);
    assert.deepEqual(loaded, team);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadTeam returns null for non-existent team", async () => {
    const { store, dir } = await makeStore();
    const result = await store.loadTeam("team-does-not-exist");
    assert.equal(result, null);
    await rm(dir, { recursive: true, force: true });
  });

  test("listTeams returns empty array when no teams directory", async () => {
    const { store, dir } = await makeStore();
    const teams = await store.listTeams();
    assert.deepEqual(teams, []);
    await rm(dir, { recursive: true, force: true });
  });

  test("listTeams returns all saved teams", async () => {
    const { store, dir } = await makeStore();
    const team1 = makeTeam({ id: "team-20260403-001", name: "alpha" });
    const team2 = makeTeam({ id: "team-20260403-002", name: "beta" });
    await store.saveTeam(team1);
    await store.saveTeam(team2);

    const teams = await store.listTeams();
    assert.equal(teams.length, 2);
    const ids = teams.map((t) => t.id).sort();
    assert.deepEqual(ids, ["team-20260403-001", "team-20260403-002"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("deleteTeam removes team directory", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);
    await store.deleteTeam(team.id);
    const loaded = await store.loadTeam(team.id);
    assert.equal(loaded, null);
    await rm(dir, { recursive: true, force: true });
  });

  test("deleteTeam is a no-op for non-existent team", async () => {
    const { store, dir } = await makeStore();
    await assert.doesNotReject(() => store.deleteTeam("team-ghost"));
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

describe("TeamStore — task CRUD", () => {
  test("saveTasks then loadTasks returns same list", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);
    const tasks = [makeTask({ id: "task-001" }), makeTask({ id: "task-002" })];
    await store.saveTasks(team.id, tasks);
    const loaded = await store.loadTasks(team.id);
    assert.deepEqual(loaded, tasks);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadTasks returns empty array when no tasks file exists", async () => {
    const { store, dir } = await makeStore();
    const result = await store.loadTasks("team-ghost");
    assert.deepEqual(result, []);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Signal operations
// ---------------------------------------------------------------------------

describe("TeamStore — signal operations", () => {
  test("appendSignal then loadSignals returns signals in order", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    const sig1 = makeSignal({ id: "sig-001", message: "first" });
    const sig2 = makeSignal({ id: "sig-002", message: "second" });
    await store.appendSignal(team.id, sig1);
    await store.appendSignal(team.id, sig2);

    const loaded = await store.loadSignals(team.id);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].message, "first");
    assert.equal(loaded[1].message, "second");
    await rm(dir, { recursive: true, force: true });
  });

  test("loadSignals returns empty array when no file exists", async () => {
    const { store, dir } = await makeStore();
    const result = await store.loadSignals("team-ghost");
    assert.deepEqual(result, []);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadSignalsSince filters signals by timestamp", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    const ts1 = "2026-01-01T00:00:00Z";
    const ts2 = "2026-06-01T00:00:00Z";
    const ts3 = "2026-12-01T00:00:00Z";
    const cursor = "2026-04-01T00:00:00Z";

    await store.appendSignal(
      team.id,
      makeSignal({ id: "sig-001", timestamp: ts1 }),
    );
    await store.appendSignal(
      team.id,
      makeSignal({ id: "sig-002", timestamp: ts2 }),
    );
    await store.appendSignal(
      team.id,
      makeSignal({ id: "sig-003", timestamp: ts3 }),
    );

    const result = await store.loadSignalsSince(team.id, cursor);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "sig-002");
    assert.equal(result[1].id, "sig-003");
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Mailbox operations
// ---------------------------------------------------------------------------

describe("TeamStore — mailbox operations", () => {
  test("appendMessage then loadMessages returns messages in order", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    const msg1 = makeMessage({ id: "msg-001", message: "first" });
    const msg2 = makeMessage({ id: "msg-002", message: "second" });
    await store.appendMessage(team.id, msg1);
    await store.appendMessage(team.id, msg2);

    const loaded = await store.loadMessages(team.id);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].message, "first");
    assert.equal(loaded[1].message, "second");
    await rm(dir, { recursive: true, force: true });
  });

  test("loadMessages returns empty array when no file exists", async () => {
    const { store, dir } = await makeStore();
    const result = await store.loadMessages("team-ghost");
    assert.deepEqual(result, []);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadMessagesFor returns direct and broadcast messages", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    await store.appendMessage(
      team.id,
      makeMessage({ id: "msg-001", to: "frontend", message: "direct" }),
    );
    await store.appendMessage(
      team.id,
      makeMessage({ id: "msg-002", to: "all", message: "broadcast" }),
    );
    await store.appendMessage(
      team.id,
      makeMessage({ id: "msg-003", to: "backend", message: "other" }),
    );

    const result = await store.loadMessagesFor(team.id, "frontend");
    assert.equal(result.length, 2);
    assert.ok(result.some((m) => m.message === "direct"));
    assert.ok(result.some((m) => m.message === "broadcast"));
    await rm(dir, { recursive: true, force: true });
  });

  test("loadMessagesFor returns leader messages and broadcasts when recipient is leader", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    await store.appendMessage(
      team.id,
      makeMessage({ id: "msg-001", to: "leader", message: "to leader" }),
    );
    await store.appendMessage(
      team.id,
      makeMessage({ id: "msg-002", to: "all", message: "broadcast" }),
    );
    await store.appendMessage(
      team.id,
      makeMessage({ id: "msg-003", to: "backend", message: "other" }),
    );

    const result = await store.loadMessagesFor(team.id, "leader");
    // Returns messages where to === "leader" OR to === "all"
    assert.equal(result.length, 2);
    assert.ok(result.some((m) => m.message === "to leader"));
    assert.ok(result.some((m) => m.message === "broadcast"));
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Approval operations
// ---------------------------------------------------------------------------

describe("TeamStore — approval operations", () => {
  test("saveApprovals then loadApprovals returns same list", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    const approvals = [
      makeApproval({ id: "apr-001" }),
      makeApproval({ id: "apr-002" }),
    ];
    await store.saveApprovals(team.id, approvals);
    const loaded = await store.loadApprovals(team.id);
    assert.deepEqual(loaded, approvals);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadApprovals returns empty array when no file exists", async () => {
    const { store, dir } = await makeStore();
    const result = await store.loadApprovals("team-ghost");
    assert.deepEqual(result, []);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Summary and memory
// ---------------------------------------------------------------------------

describe("TeamStore — summary & memory", () => {
  test("saveSummary then loadSummary returns same text", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    const content = "# Summary\n\nAll tasks done.";
    await store.saveSummary(team.id, content);
    const loaded = await store.loadSummary(team.id);
    assert.equal(loaded, content);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadSummary returns null when no file exists", async () => {
    const { store, dir } = await makeStore();
    const result = await store.loadSummary("team-ghost");
    assert.equal(result, null);
    await rm(dir, { recursive: true, force: true });
  });

  test("saveMemory then loadMemory returns same text", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);
    await store.ensureTeamDirs(team.id, []);

    const content = "## Discoveries\n\nAuth uses JWT.";
    await store.saveMemory(team.id, "discoveries", content);
    const loaded = await store.loadMemory(team.id, "discoveries");
    assert.equal(loaded, content);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadMemory returns null when no file exists", async () => {
    const { store, dir } = await makeStore();
    const result = await store.loadMemory("team-ghost", "decisions");
    assert.equal(result, null);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Last-checked cursor
// ---------------------------------------------------------------------------

describe("TeamStore — last-checked cursor", () => {
  test("getLastChecked returns null when team has no lastCheckedAt", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);
    const result = await store.getLastChecked(team.id);
    assert.equal(result, null);
    await rm(dir, { recursive: true, force: true });
  });

  test("setLastChecked updates lastCheckedAt on team record", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    const ts = "2026-04-03T18:00:00.000Z";
    await store.setLastChecked(team.id, ts);

    const loaded = await store.loadTeam(team.id);
    assert.equal(loaded?.lastCheckedAt, ts);
    await rm(dir, { recursive: true, force: true });
  });

  test("setLastChecked is a no-op for non-existent team", async () => {
    const { store, dir } = await makeStore();
    await assert.doesNotReject(() =>
      store.setLastChecked("team-ghost", new Date().toISOString()),
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("getLastChecked returns null for non-existent team", async () => {
    const { store, dir } = await makeStore();
    const result = await store.getLastChecked("team-ghost");
    assert.equal(result, null);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Teammate process state
// ---------------------------------------------------------------------------

describe("TeamStore — teammate process state", () => {
  test("saveTeammateProcess then loadTeammateProcess round-trips", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);
    await store.ensureTeamDirs(team.id, ["backend"]);

    const proc: TeammateProcess = {
      role: "backend",
      teamId: team.id,
      state: "running",
      taskId: "task-001",
      startedAt: new Date().toISOString(),
    };
    await store.saveTeammateProcess(team.id, proc);
    const loaded = await store.loadTeammateProcess(team.id, "backend");
    assert.deepEqual(loaded, proc);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadTeammateProcess returns null when no file exists", async () => {
    const { store, dir } = await makeStore();
    const result = await store.loadTeammateProcess("team-ghost", "backend");
    assert.equal(result, null);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadAllTeammateProcesses returns all processes for team", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam({ teammates: ["backend", "frontend"] });
    await store.saveTeam(team);
    await store.ensureTeamDirs(team.id, ["backend", "frontend"]);

    const backendProc: TeammateProcess = {
      role: "backend",
      teamId: team.id,
      state: "running",
      startedAt: new Date().toISOString(),
    };
    const frontendProc: TeammateProcess = {
      role: "frontend",
      teamId: team.id,
      state: "completed",
      startedAt: new Date().toISOString(),
    };
    await store.saveTeammateProcess(team.id, backendProc);
    await store.saveTeammateProcess(team.id, frontendProc);

    const all = await store.loadAllTeammateProcesses(team.id);
    assert.equal(all.length, 2);
    assert.ok(all.some((p) => p.role === "backend"));
    assert.ok(all.some((p) => p.role === "frontend"));
    await rm(dir, { recursive: true, force: true });
  });

  test("loadAllTeammateProcesses returns empty when team has no processes saved", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam({ teammates: ["backend"] });
    await store.saveTeam(team);
    const all = await store.loadAllTeammateProcesses(team.id);
    assert.deepEqual(all, []);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Leader process state
// ---------------------------------------------------------------------------

describe("TeamStore — leader process state", () => {
  test("saveLeaderProcess then loadLeaderProcess round-trips", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);
    await store.ensureTeamDirs(team.id, []);

    const proc: LeaderProcess = {
      teamId: team.id,
      state: "running",
      startedAt: new Date().toISOString(),
    };
    await store.saveLeaderProcess(team.id, proc);
    const loaded = await store.loadLeaderProcess(team.id);
    assert.deepEqual(loaded, proc);
    await rm(dir, { recursive: true, force: true });
  });

  test("loadLeaderProcess returns null when no file exists", async () => {
    const { store, dir } = await makeStore();
    const result = await store.loadLeaderProcess("team-ghost");
    assert.equal(result, null);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// mtime cache
// ---------------------------------------------------------------------------

describe("TeamStore — mtime cache", () => {
  test("save invalidates cached reads — subsequent load reflects mutation", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    const first = await store.loadTeam(team.id);
    assert.equal(first!.objective, "Test objective");

    // Mutate through saveTeam — the cache must be busted so the next read
    // picks up the new value rather than returning the stale cached entry.
    await store.saveTeam({ ...team, objective: "Updated objective" });
    const second = await store.loadTeam(team.id);
    assert.equal(second!.objective, "Updated objective");

    await rm(dir, { recursive: true, force: true });
  });

  test("cached read returns the same reference when mtime is unchanged", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    const a = await store.loadTeam(team.id);
    const b = await store.loadTeam(team.id);
    // Identity equality proves the parse step was skipped on the 2nd read.
    assert.strictEqual(a, b, "cache should short-circuit the second load");

    await rm(dir, { recursive: true, force: true });
  });

  test("appendSignal invalidates the ndjson cache", async () => {
    const { store, dir } = await makeStore();
    const team = makeTeam();
    await store.saveTeam(team);

    const sig: Signal = {
      id: "sig-001",
      teamId: team.id,
      source: "leader",
      type: "team_summary",
      severity: "info",
      timestamp: new Date().toISOString(),
      message: "first",
      links: [],
    };
    await store.appendSignal(team.id, sig);
    const firstLoad = await store.loadSignals(team.id);
    assert.equal(firstLoad.length, 1);

    await store.appendSignal(team.id, { ...sig, id: "sig-002", message: "second" });
    const secondLoad = await store.loadSignals(team.id);
    assert.equal(secondLoad.length, 2, "append must bust cache");

    await rm(dir, { recursive: true, force: true });
  });
});
