// Pi Team-Mode — Task Manager
//
// TODO-list CRUD matching Claude Code's TaskCreate/TaskUpdate/TaskList/TaskGet
// semantics. Coordinator assigns via TaskUpdate({ owner }); there is no
// auto-claim. update() takes a filesystem lock + CAS version counter so
// concurrent edits from teammate subprocesses don't clobber each other.

import { spawn } from "node:child_process";
import { mkdir, open, unlink } from "node:fs/promises";
import * as path from "node:path";

import {
	generateTaskId,
	type TaskRecord,
	type TaskStatus,
	type TaskStore,
} from "../core/tasks.js";

const HOOK_TIMEOUT_MS = 120_000;
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_MAX_ATTEMPTS = 100;
const LOCK_STALE_MS = 10_000;

export type TaskCreateOpts = {
	subject: string;
	description?: string;
	activeForm?: string;
	metadata?: Record<string, unknown>;
	teamId?: string;
};

export type TaskUpdateOpts = {
	expectedVersion?: number;
	status?: TaskStatus;
	owner?: string | null;
	subject?: string;
	description?: string;
	activeForm?: string;
	result?: string;
	addBlocks?: string[];
	addBlockedBy?: string[];
	metadata?: Record<string, unknown>;
};

export type TaskManagerDeps = {
	store: TaskStore;
	getParentSessionId: () => string;
	getTaskCompletedHook?: () => Promise<string | undefined> | string | undefined;
	getCwd?: () => string;
};

export class TaskManager {
	constructor(private readonly deps: TaskManagerDeps) {}

	async create(opts: TaskCreateOpts): Promise<TaskRecord> {
		const parentSessionId = this.deps.getParentSessionId();
		const now = new Date().toISOString();
		const record: TaskRecord = {
			id: generateTaskId(opts.subject),
			subject: opts.subject,
			description: opts.description,
			activeForm: opts.activeForm,
			status: "pending",
			owner: null,
			blockedBy: [],
			blocks: [],
			metadata: opts.metadata,
			parentSessionId,
			teamId: opts.teamId,
			createdAt: now,
			updatedAt: now,
			version: 1,
		};
		await this.deps.store.save(record);
		return record;
	}

	async update(taskId: string, opts: TaskUpdateOpts): Promise<TaskRecord> {
		const parentSessionId = this.deps.getParentSessionId();
		return withTaskLock(this.deps.store.dir(parentSessionId), taskId, async () => {
			const current = await this.deps.store.load(parentSessionId, taskId);
			if (!current) throw new Error(`unknown task: ${taskId}`);
			if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
				throw new VersionConflictError(current.version, opts.expectedVersion);
			}

			const nextStatus = opts.status ?? current.status;
			const transitioningToCompleted =
				current.status !== "completed" && nextStatus === "completed";

			const updated: TaskRecord = {
				...current,
				subject: opts.subject ?? current.subject,
				description: opts.description ?? current.description,
				activeForm: opts.activeForm ?? current.activeForm,
				owner: opts.owner === undefined ? current.owner : opts.owner,
				status: nextStatus,
				result: opts.result ?? current.result,
				blockedBy: opts.addBlockedBy
					? Array.from(new Set([...current.blockedBy, ...opts.addBlockedBy]))
					: current.blockedBy,
				blocks: opts.addBlocks
					? Array.from(new Set([...current.blocks, ...opts.addBlocks]))
					: current.blocks,
				metadata: opts.metadata
					? { ...(current.metadata ?? {}), ...opts.metadata }
					: current.metadata,
				updatedAt: new Date().toISOString(),
				version: current.version + 1,
			};

			if (transitioningToCompleted) {
				const hook = await this.deps.getTaskCompletedHook?.();
				if (hook && hook.trim()) {
					const hookResult = await this.runHook(hook, updated);
					updated.hookOutput = hookResult.output;
					if (hookResult.exitCode !== 0) {
						updated.status = "failed";
						updated.result = `${updated.result ? updated.result + "\n\n" : ""}[TaskCompleted hook failed, exit ${hookResult.exitCode}] ${hook}`;
					}
				}
			}

			await this.deps.store.save(updated);
			return updated;
		});
	}

	async get(taskId: string): Promise<TaskRecord | null> {
		return this.deps.store.load(this.deps.getParentSessionId(), taskId);
	}

	async list(filter?: {
		status?: TaskStatus;
		owner?: string;
		teamId?: string;
	}): Promise<TaskRecord[]> {
		const all = await this.deps.store.list(this.deps.getParentSessionId());
		let result = all;
		if (filter?.status) result = result.filter((t) => t.status === filter.status);
		if (filter?.owner) result = result.filter((t) => t.owner === filter.owner);
		if (filter?.teamId) result = result.filter((t) => t.teamId === filter.teamId);
		return result;
	}

	async clear(): Promise<void> {
		await this.deps.store.clear(this.deps.getParentSessionId());
	}

	private async runHook(
		hook: string,
		task: TaskRecord,
	): Promise<{ exitCode: number; output: string }> {
		const cwd = this.deps.getCwd?.() ?? process.cwd();
		return new Promise((resolve) => {
			const proc = spawn("sh", ["-c", hook], {
				cwd,
				env: {
					...process.env,
					PI_TEAM_MATE_TASK_ID: task.id,
					PI_TEAM_MATE_TASK_SUBJECT: task.subject,
					PI_TEAM_MATE_TASK_OWNER: task.owner ?? "",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			const append = (chunk: Buffer) => {
				if (output.length < 8192) output += chunk.toString("utf8");
			};
			proc.stdout.on("data", append);
			proc.stderr.on("data", append);
			const timer = setTimeout(() => {
				proc.kill("SIGTERM");
				output += `\n[hook timed out after ${HOOK_TIMEOUT_MS}ms]`;
			}, HOOK_TIMEOUT_MS);
			timer.unref();
			proc.on("close", (code) => {
				clearTimeout(timer);
				resolve({ exitCode: code ?? 1, output: output.trim() });
			});
			proc.on("error", (err) => {
				clearTimeout(timer);
				resolve({ exitCode: 1, output: `[hook spawn error] ${err.message}` });
			});
		});
	}
}

export class VersionConflictError extends Error {
	constructor(public readonly actual: number, public readonly expected: number) {
		super(`version conflict: expected ${expected}, got ${actual}`);
		this.name = "VersionConflictError";
	}
}

async function withTaskLock<T>(
	taskDir: string,
	taskId: string,
	fn: () => Promise<T>,
): Promise<T> {
	await mkdir(taskDir, { recursive: true });
	const lockPath = path.join(taskDir, `${taskId}.lock`);

	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(String(process.pid));
			await handle.close();
			try {
				return await fn();
			} finally {
				await unlink(lockPath).catch(() => {});
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (await isStaleLock(lockPath)) {
				await unlink(lockPath).catch(() => {});
				continue;
			}
			await delay(LOCK_RETRY_DELAY_MS + Math.random() * LOCK_RETRY_DELAY_MS);
		}
	}
	throw new Error(`could not acquire task lock after ${LOCK_MAX_ATTEMPTS} attempts: ${lockPath}`);
}

async function isStaleLock(lockPath: string): Promise<boolean> {
	try {
		const { stat } = await import("node:fs/promises");
		const st = await stat(lockPath);
		return Date.now() - st.mtimeMs > LOCK_STALE_MS;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
