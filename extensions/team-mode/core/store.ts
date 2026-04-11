/**
 * Pi Teams — Persistence Layer (TeamStore)
 *
 * Manages all team data on disk inside the `.pi/teams/` directory tree.
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

import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
	ApprovalRequest,
	LeaderProcess,
	MailboxMessage,
	Signal,
	TaskRecord,
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
// Low-level helpers
// ---------------------------------------------------------------------------

/** Read and parse a JSON file; returns `null` if the file does not exist. */
async function readJson<T>(path: string): Promise<T | null> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
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
	} catch (err) {
		try { await unlink(tmp); } catch { /* ignore stale .tmp */ }
		throw err;
	}
}

/** Read all lines from an NDJSON file; skips blank lines. */
async function readNdjson<T>(path: string): Promise<T[]> {
	try {
		const raw = await readFile(path, "utf8");
		return raw
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as T);
	} catch {
		return [];
	}
}

/** Append a single JSON record as a new line to an NDJSON file. */
async function appendNdjson<T>(path: string, record: T): Promise<void> {
	const line = `${JSON.stringify(record)}\n`;
	await writeFile(path, line, { flag: "a", encoding: "utf8" });
}

/** Read a text file; returns `null` if it does not exist. */
async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// TeamStore
// ---------------------------------------------------------------------------

/**
 * Manages the full `.pi/teams/` directory tree for a given project root.
 *
 * Typical usage:
 * ```ts
 * const store = new TeamStore(process.cwd());
 * const team = await store.loadTeam("team-20260403-001");
 * ```
 */
export class TeamStore {
	private readonly baseDir: string;

	/**
	 * @param baseDir  Root directory of the project (typically `process.cwd()`).
	 *                 The `.pi/teams/` tree will be created inside this directory.
	 */
	constructor(baseDir: string) {
		this.baseDir = baseDir;
	}

	// -------------------------------------------------------------------------
	// Directory helpers
	// -------------------------------------------------------------------------

	/** Absolute path to the `.pi/teams/` directory. */
	getTeamsDir(): string {
		return join(this.baseDir, ".pi", "teams");
	}

	/** Absolute path to a specific team's directory. */
	getTeamDir(teamId: string): string {
		return join(this.getTeamsDir(), teamId);
	}

	/** Absolute path to a specific teammate's directory inside a team. */
	getTeammateDir(teamId: string, role: string): string {
		return join(this.getTeamDir(teamId), "teammates", role);
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

		// Per-teammate directories
		for (const role of roles) {
			await mkdir(join(teamDir, "teammates", role, "outputs"), { recursive: true });
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
	 * List all teams found in the `.pi/teams/` directory.
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
			const record = await readJson<TeamRecord>(join(teamsDir, entry, FILE_TEAM));
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
		try {
			await rm(this.getTeamDir(teamId), { recursive: true, force: true });
		} catch {
			// Ignore — directory may already be absent
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
		const result = await readJson<TaskRecord[]>(join(this.getTeamDir(teamId), FILE_TASKS));
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
		return readNdjson<MailboxMessage>(join(this.getTeamDir(teamId), FILE_MAILBOX));
	}

	/**
	 * Load mailbox messages addressed to a specific recipient.
	 *
	 * Matches messages where `to` equals `recipient`, `'all'`, or `'leader'`
	 * when `recipient === 'leader'`.
	 */
	async loadMessagesFor(teamId: string, recipient: string): Promise<MailboxMessage[]> {
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
	async saveApprovals(teamId: string, approvals: ApprovalRequest[]): Promise<void> {
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
		await writeFile(join(dir, FILE_SUMMARY), summary, "utf8");
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
	async saveMemory(teamId: string, type: MemoryType, content: string): Promise<void> {
		const dir = join(this.getTeamDir(teamId), "memory");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, MEMORY_FILES[type]), content, "utf8");
	}

	/**
	 * Load a durable memory document for the team.
	 * Returns `null` when the file does not exist.
	 *
	 * @param type  Which memory document to read (`discoveries`, `decisions`, `contracts`)
	 */
	async loadMemory(teamId: string, type: MemoryType): Promise<string | null> {
		return readText(join(this.getTeamDir(teamId), "memory", MEMORY_FILES[type]));
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
	async saveTeammateProcess(teamId: string, process: TeammateProcess): Promise<void> {
		const dir = this.getTeammateDir(teamId, process.role);
		await mkdir(dir, { recursive: true });
		await writeJson(join(dir, 'process.json'), process);
	}

	/** Load teammate process state. Returns null if not found. */
	async loadTeammateProcess(teamId: string, role: string): Promise<TeammateProcess | null> {
		const dir = this.getTeammateDir(teamId, role);
		return readJson<TeammateProcess>(join(dir, 'process.json'));
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
	async saveTeammateOutput(teamId: string, role: string, filename: string, content: string): Promise<void> {
		const dir = join(this.getTeammateDir(teamId, role), 'outputs');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, filename), content, 'utf8');
	}

	// -------------------------------------------------------------------------
	// Leader process state
	// -------------------------------------------------------------------------

	/** Save leader process state to `leader/process.json`. */
	async saveLeaderProcess(teamId: string, process: LeaderProcess): Promise<void> {
		const dir = join(this.getTeamDir(teamId), 'leader');
		await mkdir(dir, { recursive: true });
		await writeJson(join(dir, 'process.json'), process);
	}

	/** Load leader process state. Returns null if not found. */
	async loadLeaderProcess(teamId: string): Promise<LeaderProcess | null> {
		return readJson<LeaderProcess>(join(this.getTeamDir(teamId), 'leader', 'process.json'));
	}
}

export default TeamStore;
