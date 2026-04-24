// Pi Team-Mode — Persistence Layer

import { mkdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteJson, listSubdirs, readJson, slugify } from "./fs-utils.js";
import type { TeamRecord, TeammateRecord } from "./types.js";

const DIR_TEAMMATES = "teammates";
const DIR_TEAMS = "teams";
const DIR_RUNTIME = "runtime";
const FILE_RECORD = "record.json";
const FILE_INDEX = "index.json";
const DIR_SESSIONS = "sessions";

/** Defaults to `~/.pi/agent/extensions/team-mode`. Override with `PI_TEAM_MATE_STORAGE_ROOT`. */
export function getStorageRoot(): string {
	const override = process.env.PI_TEAM_MATE_STORAGE_ROOT;
	if (override) return override;
	return path.join(os.homedir(), ".pi", "agent", "extensions", "team-mode");
}

export function generateTeammateId(name?: string): string {
	// Prefix with "agent-" so the id matches Claude Code's task_id namespace
	// (task_stop / send_message accept this id).
	return `agent-${slugify(name ?? "teammate", "teammate")}-${randomUUID().slice(0, 8)}`;
}

export function generateTeamId(name: string): string {
	return `${slugify(name, "team")}-${randomUUID().slice(0, 8)}`;
}

/**
 * Persistent store for teammates, teams, and the per-session name index.
 *
 * Writes are atomic (write-temp + rename). A write-through in-memory cache
 * serves `listTeammates` and `listTeams` so the widget's high-frequency
 * refreshes don't hit the disk for every event.
 */
export class TeamMateStore {
	private teammateCache: Map<string, TeammateRecord> | null = null;
	private teamCache: Map<string, TeamRecord> | null = null;

	constructor(private readonly root: string = getStorageRoot()) {}

	teammateDir(teammateId: string): string {
		return path.join(this.root, DIR_TEAMMATES, teammateId);
	}

	teammateSessionDir(teammateId: string): string {
		return path.join(this.teammateDir(teammateId), DIR_SESSIONS);
	}

	/** Absolute path of the pi session file used by `--session`. */
	teammateSessionFile(teammateId: string): string {
		return path.join(this.teammateSessionDir(teammateId), `${teammateId}.jsonl`);
	}

	teamDir(teamId: string): string {
		return path.join(this.root, DIR_TEAMS, teamId);
	}

	runtimeDir(parentSessionId: string): string {
		return path.join(this.root, DIR_RUNTIME, parentSessionId);
	}

	// --- teammates ---

	async saveTeammate(record: TeammateRecord): Promise<void> {
		const dir = this.teammateDir(record.id);
		await mkdir(path.join(dir, DIR_SESSIONS), { recursive: true });
		await atomicWriteJson(path.join(dir, FILE_RECORD), record);
		if (this.teammateCache) this.teammateCache.set(record.id, record);
	}

	async loadTeammate(teammateId: string): Promise<TeammateRecord | null> {
		if (this.teammateCache?.has(teammateId)) {
			return this.teammateCache.get(teammateId) ?? null;
		}
		const record = await readJson<TeammateRecord>(
			path.join(this.teammateDir(teammateId), FILE_RECORD),
		);
		if (record && this.teammateCache) this.teammateCache.set(record.id, record);
		return record;
	}

	async listTeammates(): Promise<TeammateRecord[]> {
		if (this.teammateCache) return [...this.teammateCache.values()];
		const ids = await listSubdirs(path.join(this.root, DIR_TEAMMATES));
		const records = (await Promise.all(ids.map((id) => this.loadTeammate(id)))).filter(
			(r): r is TeammateRecord => r !== null,
		);
		const cache = new Map<string, TeammateRecord>();
		for (const r of records) cache.set(r.id, r);
		this.teammateCache = cache;
		return records;
	}

	async deleteTeammate(teammateId: string): Promise<void> {
		await rm(this.teammateDir(teammateId), { recursive: true, force: true });
		this.teammateCache?.delete(teammateId);
	}

	// --- teams ---

	async saveTeam(record: TeamRecord): Promise<void> {
		const dir = this.teamDir(record.id);
		await mkdir(dir, { recursive: true });
		await atomicWriteJson(path.join(dir, FILE_RECORD), record);
		if (this.teamCache) this.teamCache.set(record.id, record);
	}

	async loadTeam(teamId: string): Promise<TeamRecord | null> {
		if (this.teamCache?.has(teamId)) return this.teamCache.get(teamId) ?? null;
		const record = await readJson<TeamRecord>(path.join(this.teamDir(teamId), FILE_RECORD));
		if (record && this.teamCache) this.teamCache.set(record.id, record);
		return record;
	}

	async listTeams(): Promise<TeamRecord[]> {
		if (this.teamCache) return [...this.teamCache.values()];
		const ids = await listSubdirs(path.join(this.root, DIR_TEAMS));
		const records = (await Promise.all(ids.map((id) => this.loadTeam(id)))).filter(
			(r): r is TeamRecord => r !== null,
		);
		const cache = new Map<string, TeamRecord>();
		for (const r of records) cache.set(r.id, r);
		this.teamCache = cache;
		return records;
	}

	async deleteTeam(teamId: string): Promise<void> {
		await rm(this.teamDir(teamId), { recursive: true, force: true });
		this.teamCache?.delete(teamId);
	}

	// --- runtime name index (name -> teammateId, per parent session) ---

	async getNameIndex(parentSessionId: string): Promise<Record<string, string>> {
		return (
			(await readJson<Record<string, string>>(path.join(this.runtimeDir(parentSessionId), FILE_INDEX))) ?? {}
		);
	}

	async setNameIndex(parentSessionId: string, index: Record<string, string>): Promise<void> {
		const dir = this.runtimeDir(parentSessionId);
		await mkdir(dir, { recursive: true });
		await atomicWriteJson(path.join(dir, FILE_INDEX), index);
	}

	async clearNameIndex(parentSessionId: string): Promise<void> {
		await rm(this.runtimeDir(parentSessionId), { recursive: true, force: true });
	}
}
