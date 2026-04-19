/**
 * Pi Teams — Intent Queue Unit Tests
 *
 * Covers the TeamStore intent-queue API used by subprocesses to hand off
 * spawn requests to the main session's LeaderRuntime.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore } from "../core/store.ts";
import type { TeamIntent } from "../core/types.ts";

async function makeStore(): Promise<{ store: TeamStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-teams-intent-test-"));
  return { store: new TeamStore(dir), dir };
}

function makeIntent(overrides: Partial<TeamIntent> = {}): TeamIntent {
  return {
    kind: "spawn_teammate",
    id: `intent-${Math.random().toString(36).slice(2, 10)}`,
    teamId: "team-abc",
    createdAt: new Date().toISOString(),
    role: "researcher",
    taskId: "task-001",
    taskDescription: "Investigate the thing",
    ...overrides,
  };
}

describe("TeamStore — intent queue", () => {
  test("writeIntent + listPendingIntents round-trip preserves all fields", async () => {
    const { store, dir } = await makeStore();
    try {
      const intent = makeIntent({
        context: "Use the README as the starting point.",
        cwd: "/tmp/repo",
      });
      await store.writeIntent(intent.teamId, intent);

      const [fetched] = await store.listPendingIntents(intent.teamId);
      assert.ok(fetched, "expected the intent to be listed");
      assert.deepEqual(fetched, intent);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("listPendingIntents sorts by createdAt ascending", async () => {
    const { store, dir } = await makeStore();
    try {
      const teamId = "team-abc";
      const a = makeIntent({ id: "a", createdAt: "2026-04-19T10:00:00.000Z" });
      const b = makeIntent({ id: "b", createdAt: "2026-04-19T09:00:00.000Z" });
      const c = makeIntent({ id: "c", createdAt: "2026-04-19T11:00:00.000Z" });
      // Write out of order to prove sorting isn't accidentally insertion order.
      await store.writeIntent(teamId, a);
      await store.writeIntent(teamId, b);
      await store.writeIntent(teamId, c);

      const ids = (await store.listPendingIntents(teamId)).map((i) => i.id);
      assert.deepEqual(ids, ["b", "a", "c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("markIntentProcessed moves the file to processed/", async () => {
    const { store, dir } = await makeStore();
    try {
      const intent = makeIntent();
      await store.writeIntent(intent.teamId, intent);
      await store.markIntentProcessed(intent.teamId, intent.id);

      const pending = await store.listPendingIntents(intent.teamId);
      assert.equal(pending.length, 0);

      const processedDir = join(store.getIntentsDir(intent.teamId), "processed");
      const entries = await readdir(processedDir);
      assert.deepEqual(entries, [`${intent.id}.json`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("markIntentProcessed is idempotent when the source is already missing", async () => {
    const { store, dir } = await makeStore();
    try {
      const intent = makeIntent();
      await store.writeIntent(intent.teamId, intent);
      await store.markIntentProcessed(intent.teamId, intent.id);
      // Second call must not throw — mirrors a drain that marks processed
      // after the intent was already moved by an earlier run.
      await assert.doesNotReject(() =>
        store.markIntentProcessed(intent.teamId, intent.id),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("listPendingIntents skips malformed files without throwing", async () => {
    const { store, dir } = await makeStore();
    try {
      const teamId = "team-abc";
      const good = makeIntent({ id: "good" });
      await store.writeIntent(teamId, good);

      // Inject a malformed file alongside the good one.
      const pendingDir = join(store.getIntentsDir(teamId), "pending");
      await mkdir(pendingDir, { recursive: true });
      await writeFile(join(pendingDir, "broken.json"), "{ not valid json");

      const intents = await store.listPendingIntents(teamId);
      assert.equal(intents.length, 1);
      assert.equal(intents[0]?.id, "good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ensureTeamDirs creates intents/pending and intents/processed", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.ensureTeamDirs("team-xyz", ["backend"]);
      const base = store.getIntentsDir("team-xyz");
      await assert.doesNotReject(() => access(join(base, "pending")));
      await assert.doesNotReject(() => access(join(base, "processed")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("listPendingIntents returns [] when the directory does not exist", async () => {
    const { store, dir } = await makeStore();
    try {
      const intents = await store.listPendingIntents("never-created");
      assert.deepEqual(intents, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
