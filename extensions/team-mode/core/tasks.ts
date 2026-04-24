// Pi Team-Mode — Task Board
//
// A shared TODO list scoped per parent session, matching Claude Code's
// TaskCreate/TaskUpdate/TaskList/TaskGet shape. The coordinator (parent LLM
// or human via /tasks) assigns tasks to teammates via TaskUpdate; there is
// no auto-claim — that is intentional.

import { mkdir, readdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteJson, readJson, slugify } from "./fs-utils.js";
import { getStorageRoot } from "./store.js";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "deleted";

export type TaskRecord = {
	id: string;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	owner?: string | null;
	blockedBy: string[];
	blocks: string[];
	metadata?: Record<string, unknown>;
	parentSessionId: string;
	teamId?: string;
	createdAt: string;
	updatedAt: string;
	/** Optimistic CAS counter. Bumped on every successful save. */
	version: number;
	/** Final summary (filled by whoever completes the task). */
	result?: string;
	/** Output captured from a quality-gate hook (if any ran). */
	hookOutput?: string;
};

const DIR_TASKS = "tasks";
const FILE_TASK_SUFFIX = ".json";

export class TaskStore {
	constructor(private readonly root: string = getStorageRoot()) {}

	dir(parentSessionId: string): string {
		return path.join(this.root, DIR_TASKS, parentSessionId);
	}

	private file(parentSessionId: string, taskId: string): string {
		return path.join(this.dir(parentSessionId), `${taskId}${FILE_TASK_SUFFIX}`);
	}

	async save(record: TaskRecord): Promise<void> {
		const dir = this.dir(record.parentSessionId);
		await mkdir(dir, { recursive: true });
		await atomicWriteJson(this.file(record.parentSessionId, record.id), record);
	}

	async load(parentSessionId: string, taskId: string): Promise<TaskRecord | null> {
		return readJson<TaskRecord>(this.file(parentSessionId, taskId));
	}

	async list(parentSessionId: string): Promise<TaskRecord[]> {
		const dir = this.dir(parentSessionId);
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const files = entries.filter((e) => e.endsWith(FILE_TASK_SUFFIX));
		return (
			await Promise.all(files.map((f) => readJson<TaskRecord>(path.join(dir, f))))
		).filter((r): r is TaskRecord => r !== null);
	}

	async delete(parentSessionId: string, taskId: string): Promise<void> {
		await rm(this.file(parentSessionId, taskId), { force: true });
	}

	async clear(parentSessionId: string): Promise<void> {
		await rm(this.dir(parentSessionId), { recursive: true, force: true });
	}
}

export function generateTaskId(subject: string): string {
	return `task-${slugify(subject, "task")}-${randomUUID().slice(0, 8)}`;
}

/** True when every dependency in `blockedBy` is completed or deleted. */
export function isUnblocked(task: TaskRecord, byId: Map<string, TaskRecord>): boolean {
	for (const depId of task.blockedBy) {
		const dep = byId.get(depId);
		if (!dep) continue;
		if (dep.status !== "completed" && dep.status !== "deleted") return false;
	}
	return true;
}
