/**
 * Pi Teams — Persistence Layer (TeamStore)
 *
 * Manages all team data on disk inside the `~/.pi/agent/extensions/teams/`
 * directory tree.
 *
 * Conventions:
 *  - Structured data (team metadata, tasks, approvals) → JSON files
 *  - Append-only logs (signals, mailbox messages)      → NDJSON files
 *  - Human-readable summaries / memory                 → Markdown files
 *
 * All public methods handle missing files gracefully and never throw on
 * expected absence — they return `null` or empty arrays instead.
 *
 * Dependencies: only `node:fs/promises` and `node:path`.
 */

import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  ApprovalRequest,
  LeaderProcess,
  MailboxMessage,
  Signal,
  TaskRecord,
  TeamIntent,
  TeamRecord,
  TeammateProcess,
} from "./types.js";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Per-prefix monotonic counters, reset each process lifetime. */
const idCounters = new Map<string, number>();

function toIdSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "team";
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * Generate a short, human-readable ID like `billing-fix-20260403-142530` or `sig-042`.
 *
 * @param prefix  Short category label (e.g. `"team"`, `"task"`, `"sig"`, `"msg"`)
 * @param seed    Optional descriptive value used for team IDs
 * @returns       Unique string ID
 */
export function generateId(prefix: string, seed?: string): string {
  const count = (idCounters.get(prefix) ?? 0) + 1;
  idCounters.set(prefix, count);
  const seq = String(count).padStart(3, "0");

  // For teams, use a descriptive slug plus a timestamp to avoid collisions
  // with finished runs that reuse the same name.
  if (prefix === "team") {
    return `${toIdSlug(seed ?? prefix)}-${formatTimestamp(new Date())}`;
  }

  return `${prefix}-${seq}`;
}

// ---------------------------------------------------------------------------
// File-name constants
// ---------------------------------------------------------------------------

const FILE_TEAM = "team.json";
const FILE_TASKS = "tasks.json";
const FILE_SIGNALS = "signals.ndjson";
const FILE_SIGNALS_COMPACTED = "signals-compacted.ndjson";
const FILE_MAILBOX = "mailbox.ndjson";
const FILE_APPROVALS = "approvals.json";
const FILE_SUMMARY = "summary.md";

const MEMORY_FILES = {
  discoveries: "discoveries.md",
  decisions: "decisions.md",
  contracts: "contracts.md",
} as const;

type MemoryType = keyof typeof MEMORY_FILES;

// ---------------------------------------------------------------------------
// In-memory mtime cache
// ---------------------------------------------------------------------------

/**
 * Per-path cache of parsed file contents keyed by mtime. A leader cycle runs
 * every ~20s and reads `team.json`, `tasks.json`, and the two NDJSON logs
 * repeatedly; without caching, each cycle would re-parse ~tens of KB of
 * JSON. `stat()` is ~10× cheaper than `readFile()+JSON.parse()` for these
 * files, so we stat-on-read and skip parsing when the mtime is unchanged.
 *
 * The cache is correct under our concurrency model because every writer in
 * this process goes through `TeamStore` — after a local write the cache is
 * invalidated explicitly. External writers (another process editing the
 * same directory) are still detected via the mtime check on read.
 */
type CacheEntry = { mtimeMs: number; value: unknown };
const fileCache = new Map<string, CacheEntry>();

function cacheInvalidate(path: string): void {
  fileCache.delete(path);
}

/**
 * Read a file with mtime-keyed caching. Returns `null` if the file does not
 * exist, matching the semantics of the `readJson` / `readText` helpers.
 */
async function cachedRead<T>(
  path: string,
  parse: (raw: string) => T,
): Promise<T | null> {
  let mtimeMs: number;
  try {
    const st = await stat(path);
    mtimeMs = st.mtimeMs;
  } catch {
    cacheInvalidate(path);
    return null;
  }

  const cached = fileCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.value as T;
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    cacheInvalidate(path);
    return null;
  }

  const value = parse(raw);
  fileCache.set(path, { mtimeMs, value });
  return value;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/** Read and parse a JSON file; returns `null` if the file does not exist. */
async function readJson<T>(path: string): Promise<T | null> {
  return cachedRead<T>(path, (raw) => JSON.parse(raw) as T);
}

/**
 * Atomically write a JSON file (pretty-printed for human readability).
 *
 * Writes to a sibling `.tmp` file first, then renames it over the target.
 * `rename(2)` is atomic on POSIX/macOS when both paths are on the same
 * filesystem, so a concurrent reader always sees either the old complete
 * content or the new complete content — never an empty or partial file.
 */
async function writeJson<T>(filePath: string, data: T): Promise<void> {
  const tmp = `${filePath}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, filePath);
    cacheInvalidate(filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* ignore stale .tmp */
    }
    throw err;
  }
}

/** Read all lines from an NDJSON file; skips blank lines. */
async function readNdjson<T>(path: string): Promise<T[]> {
  const parsed = await cachedRead<T[]>(path, (raw) =>
    raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T),
  );
  return parsed ?? [];
}

/** Append a single JSON record as a new line to an NDJSON file. */
async function appendNdjson<T>(path: string, record: T): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  await writeFile(path, line, { flag: "a", encoding: "utf8" });
  cacheInvalidate(path);
}

/** Read a text file; returns `null` if it does not exist. */
async function readText(path: string): Promise<string | null> {
  return cachedRead<string>(path, (raw) => raw);
}

// ---------------------------------------------------------------------------
// TeamStore
// ---------------------------------------------------------------------------

/**
 * Manages the full `teams/` directory tree rooted under a given base dir.
 *
 * Typical usage:
 * ```ts
 * const store = new TeamStore(join(os.homedir(), ".pi", "agent", "extensions"));
 * const team = await store.loadTeam("team-20260403-001");
 * ```
 */
export class TeamStore {
  private readonly baseDir: string;

  /**
   * @param baseDir  Storage root for team data. The `teams/` subdirectory is
   *                 created inside it. Production callers pass
   *                 `~/.pi/agent/extensions` (resolved via `os.homedir()`),
   *                 so team state lives at
   *                 `~/.pi/agent/extensions/teams/<team-id>/`.
   */
  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  // -------------------------------------------------------------------------
  // Directory helpers
  // -------------------------------------------------------------------------

  /** Absolute path to the `teams/` directory for this project. */
  getTeamsDir(): string {
    return join(this.baseDir, "teams");
  }

  /** Absolute path to a specific team's directory. */
  getTeamDir(teamId: string): string {
    return join(this.getTeamsDir(), teamId);
  }

  /** Absolute path to a specific teammate's directory inside a team. */
  getTeammateDir(teamId: string, role: string): string {
    return join(this.getTeamDir(teamId), "teammates", role);
  }

  /** Absolute path to the intents directory for a team. */
  getIntentsDir(teamId: string): string {
    return join(this.getTeamDir(teamId), "intents");
  }

  /**
   * Create the full directory tree for a team, including sub-directories for
   * each teammate role and the durable memory store.
   *
   * Safe to call multiple times — existing directories are left untouched.
   */
  async ensureTeamDirs(teamId: string, roles: string[]): Promise<void> {
    const teamDir = this.getTeamDir(teamId);

    // Top-level team directories
    await mkdir(join(teamDir, "memory"), { recursive: true });
    await mkdir(join(teamDir, "leader"), { recursive: true });
    await mkdir(join(teamDir, "intents", "pending"), { recursive: true });
    await mkdir(join(teamDir, "intents", "processed"), { recursive: true });

    // Per-teammate directories
    for (const role of roles) {
      await mkdir(join(teamDir, "teammates", role, "outputs"), {
        recursive: true,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Team CRUD
  // -------------------------------------------------------------------------

  /** Persist a team record to `team.json`. */
  async saveTeam(team: TeamRecord): Promise<void> {
    const dir = this.getTeamDir(team.id);
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, FILE_TEAM), team);
  }

  /**
   * Load a team record by id.
   * Returns `null` if the team directory or file does not exist.
   */
  async loadTeam(teamId: string): Promise<TeamRecord | null> {
    return readJson<TeamRecord>(join(this.getTeamDir(teamId), FILE_TEAM));
  }

  /**
   * List all teams found in the `teams/` directory under `baseDir`.
   * Returns an empty array when the directory does not exist.
   */
  async listTeams(): Promise<TeamRecord[]> {
    const teamsDir = this.getTeamsDir();
    let entries: string[];

    try {
      entries = await readdir(teamsDir);
    } catch {
      return [];
    }

    const teams: TeamRecord[] = [];

    for (const entry of entries) {
      const record = await readJson<TeamRecord>(
        join(teamsDir, entry, FILE_TEAM),
      );
      if (record) {
        teams.push(record);
      }
    }

    return teams;
  }

  /**
   * Remove a team and all its associated files.
   * No-op if the directory does not exist.
   */
  async deleteTeam(teamId: string): Promise<void> {
    const teamDir = this.getTeamDir(teamId);
    try {
      await rm(teamDir, { recursive: true, force: true });
    } catch {
      // Ignore — directory may already be absent
    }
    // Drop any cached entries for files under this team dir.
    for (const key of [...fileCache.keys()]) {
      if (key === teamDir || key.startsWith(`${teamDir}/`))
        fileCache.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Task CRUD
  // -------------------------------------------------------------------------

  /** Persist the full task list for a team to `tasks.json`. */
  async saveTasks(teamId: string, tasks: TaskRecord[]): Promise<void> {
    const dir = this.getTeamDir(teamId);
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, FILE_TASKS), tasks);
  }

  /**
   * Load all tasks for a team.
   * Returns an empty array when the file does not exist.
   */
  async loadTasks(teamId: string): Promise<TaskRecord[]> {
    const result = await readJson<TaskRecord[]>(
      join(this.getTeamDir(teamId), FILE_TASKS),
    );
    return result ?? [];
  }

  // -------------------------------------------------------------------------
  // Signal operations (NDJSON append-only)
  // -------------------------------------------------------------------------

  /** Append a signal to `signals.ndjson`. */
  async appendSignal(teamId: string, signal: Signal): Promise<void> {
    const dir = this.getTeamDir(teamId);
    await mkdir(dir, { recursive: true });
    await appendNdjson(join(dir, FILE_SIGNALS), signal);
  }

  /**
   * Load all signals for a team.
   * Returns an empty array when the file does not exist.
   */
  async loadSignals(teamId: string): Promise<Signal[]> {
    return readNdjson<Signal>(join(this.getTeamDir(teamId), FILE_SIGNALS));
  }

  /**
   * Persist a compacted signal view to `signals-compacted.ndjson`.
   * This preserves the raw append-only log while giving readers a smaller,
   * summarised view for context building and status aggregation.
   */
  async saveCompactedSignals(teamId: string, signals: Signal[]): Promise<void> {
    const dir = this.getTeamDir(teamId);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, FILE_SIGNALS_COMPACTED);
    const content = signals.map((signal) => JSON.stringify(signal)).join("\n");
    await writeFile(filePath, content.length > 0 ? `${content}\n` : "", "utf8");
    cacheInvalidate(filePath);
  }

  /**
   * Load the compacted signal view for a team.
   * Returns `null` when no compacted file exists yet.
   */
  async loadCompactedSignals(teamId: string): Promise<Signal[] | null> {
    const raw = await readText(
      join(this.getTeamDir(teamId), FILE_SIGNALS_COMPACTED),
    );
    if (raw === null) return null;
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Signal);
  }

  /**
   * Load the preferred signal view for context consumers.
   * Uses the compacted log when available, otherwise falls back to the raw log.
   */
  async loadContextSignals(teamId: string): Promise<Signal[]> {
    const compacted = await this.loadCompactedSignals(teamId);
    if (compacted) return compacted;
    return this.loadSignals(teamId);
  }

  /**
   * Load signals emitted at or after `since` (ISO 8601 timestamp).
   * Returns an empty array when the file does not exist or no signals match.
   */
  async loadSignalsSince(teamId: string, since: string): Promise<Signal[]> {
    const all = await this.loadSignals(teamId);
    return all.filter((s) => s.timestamp >= since);
  }

  // -------------------------------------------------------------------------
  // Mailbox operations (NDJSON append-only)
  // -------------------------------------------------------------------------

  /** Append a message to `mailbox.ndjson`. */
  async appendMessage(teamId: string, msg: MailboxMessage): Promise<void> {
    const dir = this.getTeamDir(teamId);
    await mkdir(dir, { recursive: true });
    await appendNdjson(join(dir, FILE_MAILBOX), msg);
  }

  /**
   * Load all mailbox messages for a team.
   * Returns an empty array when the file does not exist.
   */
  async loadMessages(teamId: string): Promise<MailboxMessage[]> {
    return readNdjson<MailboxMessage>(
      join(this.getTeamDir(teamId), FILE_MAILBOX),
    );
  }

  /**
   * Load mailbox messages addressed to a specific recipient.
   *
   * Matches messages where `to` equals `recipient`, `'all'`, or `'leader'`
   * when `recipient === 'leader'`.
   */
  async loadMessagesFor(
    teamId: string,
    recipient: string,
  ): Promise<MailboxMessage[]> {
    const all = await this.loadMessages(teamId);
    return all.filter(
      (m) =>
        m.to === recipient ||
        m.to === "all" ||
        (recipient === "leader" && m.to === "leader"),
    );
  }

  // -------------------------------------------------------------------------
  // Approval operations
  // -------------------------------------------------------------------------

  /** Persist the full list of approval requests to `approvals.json`. */
  async saveApprovals(
    teamId: string,
    approvals: ApprovalRequest[],
  ): Promise<void> {
    const dir = this.getTeamDir(teamId);
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, FILE_APPROVALS), approvals);
  }

  /**
   * Load all approval requests for a team.
   * Returns an empty array when the file does not exist.
   */
  async loadApprovals(teamId: string): Promise<ApprovalRequest[]> {
    const result = await readJson<ApprovalRequest[]>(
      join(this.getTeamDir(teamId), FILE_APPROVALS),
    );
    return result ?? [];
  }

  // -------------------------------------------------------------------------
  // Summary (Markdown)
  // -------------------------------------------------------------------------

  /** Persist the team summary markdown to `summary.md`. */
  async saveSummary(teamId: string, summary: string): Promise<void> {
    const dir = this.getTeamDir(teamId);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, FILE_SUMMARY);
    await writeFile(filePath, summary, "utf8");
    cacheInvalidate(filePath);
  }

  /**
   * Load the team summary markdown.
   * Returns `null` when the file does not exist.
   */
  async loadSummary(teamId: string): Promise<string | null> {
    return readText(join(this.getTeamDir(teamId), FILE_SUMMARY));
  }

  // -------------------------------------------------------------------------
  // Team memory (durable knowledge surviving team completion)
  // -------------------------------------------------------------------------

  /**
   * Persist a durable memory document for the team.
   *
   * @param type  Which memory document to write (`discoveries`, `decisions`, `contracts`)
   */
  async saveMemory(
    teamId: string,
    type: MemoryType,
    content: string,
  ): Promise<void> {
    const dir = join(this.getTeamDir(teamId), "memory");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, MEMORY_FILES[type]);
    await writeFile(filePath, content, "utf8");
    cacheInvalidate(filePath);
  }

  /**
   * Load a durable memory document for the team.
   * Returns `null` when the file does not exist.
   *
   * @param type  Which memory document to read (`discoveries`, `decisions`, `contracts`)
   */
  async loadMemory(teamId: string, type: MemoryType): Promise<string | null> {
    return readText(
      join(this.getTeamDir(teamId), "memory", MEMORY_FILES[type]),
    );
  }

  // -------------------------------------------------------------------------
  // Last-checked cursor
  // -------------------------------------------------------------------------

  /**
   * Return the ISO 8601 timestamp of when the user last inspected this team.
   * Returns `null` when the team has never been checked or does not exist.
   */
  async getLastChecked(teamId: string): Promise<string | null> {
    const team = await this.loadTeam(teamId);
    return team?.lastCheckedAt ?? null;
  }

  /**
   * Update the `lastCheckedAt` field on the team record.
   * No-op if the team record does not exist.
   */
  async setLastChecked(teamId: string, timestamp: string): Promise<void> {
    const team = await this.loadTeam(teamId);
    if (!team) return;

    const updated: TeamRecord = {
      ...team,
      lastCheckedAt: timestamp,
      updatedAt: new Date().toISOString(),
    };
    await this.saveTeam(updated);
  }

  // -------------------------------------------------------------------------
  // Teammate process state
  // -------------------------------------------------------------------------

  /** Save teammate process state to `teammates/{role}/process.json`. */
  async saveTeammateProcess(
    teamId: string,
    process: TeammateProcess,
  ): Promise<void> {
    const dir = this.getTeammateDir(teamId, process.role);
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, "process.json"), process);
  }

  /**
   * Preserve the current `process.json` for a role under
   * `teammates/{role}/history/process-{taskId}.json` before a new task
   * overwrites it. A single role slot is reused across tasks (stall detection
   * relies on that), so without archiving the previous task's final state is
   * silently clobbered the moment the same role starts its next task.
   *
   * No-op when the file doesn't exist or refers to the same task already.
   */
  async archiveTeammateProcess(
    teamId: string,
    role: string,
    newTaskId: string,
  ): Promise<void> {
    const existing = await this.loadTeammateProcess(teamId, role);
    if (!existing) return;
    if (existing.taskId === newTaskId) return;
    const historyDir = join(this.getTeammateDir(teamId, role), "history");
    await mkdir(historyDir, { recursive: true });
    await writeJson(
      join(historyDir, `process-${existing.taskId}.json`),
      existing,
    );
  }

  /** Load teammate process state. Returns null if not found. */
  async loadTeammateProcess(
    teamId: string,
    role: string,
  ): Promise<TeammateProcess | null> {
    const dir = this.getTeammateDir(teamId, role);
    return readJson<TeammateProcess>(join(dir, "process.json"));
  }

  /** Load all teammate process states for a team. */
  async loadAllTeammateProcesses(teamId: string): Promise<TeammateProcess[]> {
    const team = await this.loadTeam(teamId);
    if (!team) return [];
    const processes: TeammateProcess[] = [];
    for (const role of team.teammates) {
      const proc = await this.loadTeammateProcess(teamId, role);
      if (proc) processes.push(proc);
    }
    return processes;
  }

  /** Save teammate output to `teammates/{role}/outputs/{filename}`. */
  async saveTeammateOutput(
    teamId: string,
    role: string,
    filename: string,
    content: string,
  ): Promise<void> {
    const dir = join(this.getTeammateDir(teamId, role), "outputs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), content, "utf8");
  }

  /** Save teammate debug data to `teammates/{role}/debug/{filename}`. */
  async saveTeammateDebugArtifact(
    teamId: string,
    role: string,
    filename: string,
    content: string,
  ): Promise<string> {
    const dir = join(this.getTeammateDir(teamId, role), "debug");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), content, "utf8");
    return `teammates/${role}/debug/${filename}`;
  }

  // -------------------------------------------------------------------------
  // Leader process state
  // -------------------------------------------------------------------------

  /** Save leader process state to `leader/process.json`. */
  async saveLeaderProcess(
    teamId: string,
    process: LeaderProcess,
  ): Promise<void> {
    const dir = join(this.getTeamDir(teamId), "leader");
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, "process.json"), process);
  }

  /** Load leader process state. Returns null if not found. */
  async loadLeaderProcess(teamId: string): Promise<LeaderProcess | null> {
    return readJson<LeaderProcess>(
      join(this.getTeamDir(teamId), "leader", "process.json"),
    );
  }

  /** Save leader debug data to `leader/debug/{filename}`. */
  async saveLeaderDebugArtifact(
    teamId: string,
    filename: string,
    content: string,
  ): Promise<string> {
    const dir = join(this.getTeamDir(teamId), "leader", "debug");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), content, "utf8");
    return `leader/debug/${filename}`;
  }

  // -------------------------------------------------------------------------
  // Intent queue (subprocess → main-session handoff)
  // -------------------------------------------------------------------------

  /**
   * Atomically write a pending intent file. Creates `intents/pending` on
   * demand so subprocesses running against freshly-created teams do not
   * need to pre-provision the tree.
   */
  async writeIntent(teamId: string, intent: TeamIntent): Promise<void> {
    const pendingDir = join(this.getIntentsDir(teamId), "pending");
    await mkdir(pendingDir, { recursive: true });
    const finalPath = join(pendingDir, `${intent.id}.json`);
    const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(intent, null, 2), "utf8");
      await rename(tmpPath, finalPath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore stale .tmp */
      }
      throw err;
    }
  }

  /**
   * List pending intents for a team, sorted by `createdAt` ascending.
   * Malformed files are skipped rather than throwing so a single bad file
   * cannot wedge the drain cycle.
   */
  async listPendingIntents(teamId: string): Promise<TeamIntent[]> {
    const pendingDir = join(this.getIntentsDir(teamId), "pending");
    let entries: string[];
    try {
      entries = await readdir(pendingDir);
    } catch {
      return [];
    }

    const intents: TeamIntent[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = join(pendingDir, entry);
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as TeamIntent;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.id === "string" &&
          typeof parsed.createdAt === "string" &&
          typeof parsed.kind === "string"
        ) {
          intents.push(parsed);
        }
      } catch {
        // Skip malformed/partial files; the caller logs and moves on.
      }
    }

    intents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return intents;
  }

  /**
   * Move `pending/<intentId>.json` to `processed/<intentId>.json`.
   * Idempotent: a missing pending file is swallowed so the caller can mark
   * an intent processed more than once without error.
   */
  async markIntentProcessed(teamId: string, intentId: string): Promise<void> {
    const intentsDir = this.getIntentsDir(teamId);
    const from = join(intentsDir, "pending", `${intentId}.json`);
    const to = join(intentsDir, "processed", `${intentId}.json`);
    await mkdir(join(intentsDir, "processed"), { recursive: true });
    try {
      await rename(from, to);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return;
      throw err;
    }
  }
}

export default TeamStore;
