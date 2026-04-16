/**
 * Pi Teams — TaskManager
 *
 * All task lifecycle operations for a given team: creation, updates,
 * dependency resolution, filtering, and board aggregation.
 *
 * Every method operates on the data stored in `tasks.json` via `TeamStore`.
 * No other files are read or written here — signal emission is the caller's
 * responsibility if side-effects are needed.
 */

import type { TaskBoard, TaskFilter, TaskRecord, TaskStatus } from "../core/types.js";
import type { TeamStore } from "../core/store.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine the next `task-NNN` ID for a team by scanning existing task IDs
 * and incrementing the highest sequence number found.
 *
 * Falls back to `task-001` when the task list is empty.
 */
function nextTaskId(tasks: TaskRecord[]): string {
	if (tasks.length === 0) return "task-001";

	const maxNum = tasks.reduce((max, task) => {
		const match = task.id.match(/^task-(\d+)$/);
		const num = match ? parseInt(match[1], 10) : 0;
		return Math.max(max, num);
	}, 0);

	return `task-${String(maxNum + 1).padStart(3, "0")}`;
}

/**
 * Apply a `TaskFilter` to a list of task records.
 * All non-undefined filter criteria are ANDed together.
 */
function applyFilter(tasks: TaskRecord[], filter: TaskFilter): TaskRecord[] {
	return tasks.filter((task) => {
		if (filter.status !== undefined) {
			const statuses = Array.isArray(filter.status)
				? filter.status
				: [filter.status];
			if (!statuses.includes(task.status)) return false;
		}
		if (filter.owner !== undefined && task.owner !== filter.owner) return false;
		if (filter.priority !== undefined && task.priority !== filter.priority)
			return false;
		if (filter.riskLevel !== undefined && task.riskLevel !== filter.riskLevel)
			return false;
		if (
			filter.approvalRequired !== undefined &&
			task.approvalRequired !== filter.approvalRequired
		)
			return false;
		return true;
	});
}

// ---------------------------------------------------------------------------
// TaskManager
// ---------------------------------------------------------------------------

export class TaskManager {
	/**
	 * Per-team write-serialization queues.
	 *
	 * Every mutating operation (createTask, updateTask, resolveDependencies)
	 * chains onto this promise so that concurrent callers execute their
	 * read-modify-write cycles one at a time per team.  Without this, two
	 * concurrent `updateTask` calls could both read the same snapshot, apply
	 * their own patch, and the second write would silently overwrite the
	 * first's changes (lost-update anomaly).
	 */
	private readonly writeQueues = new Map<string, Promise<unknown>>();

	constructor(private store: TeamStore) {}

	/**
	 * Enqueue a mutating operation for a team so that it runs serially
	 * with respect to all other mutations on the same team.
	 */
	private enqueue<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.writeQueues.get(teamId) ?? Promise.resolve();
		const next = prev.then(fn, fn); // run even if the previous op failed
		this.writeQueues.set(teamId, next);
		// Clean up the queue entry once this operation settles so the Map
		// does not grow without bound over the lifetime of the process.
		void next.then(
			() => { if (this.writeQueues.get(teamId) === next) this.writeQueues.delete(teamId); },
			() => { if (this.writeQueues.get(teamId) === next) this.writeQueues.delete(teamId); },
		);
		return next;
	}

	// -------------------------------------------------------------------------
	// Core CRUD
	// -------------------------------------------------------------------------

	/**
	 * Create a new task for a team.
	 *
	 * Generates a `task-NNN` ID, applies sensible defaults for any omitted
	 * fields, then appends the task to `tasks.json`.
	 */
	async createTask(
		teamId: string,
		taskData: Omit<TaskRecord, "id" | "teamId" | "createdAt" | "updatedAt">,
	): Promise<TaskRecord> {
		return this.enqueue(teamId, async () => {
			const tasks = await this.store.loadTasks(teamId);
			const now = new Date().toISOString();

			// Build with explicit nullish-coalescing so there are no duplicate
			// literal keys in the object literal (avoids TS2783).
			const task: TaskRecord = {
				// Fields with defaults
				status: taskData.status ?? "todo",
				priority: taskData.priority ?? "medium",
				riskLevel: taskData.riskLevel ?? "low",
				approvalRequired: taskData.approvalRequired ?? false,
				dependsOn: taskData.dependsOn ?? [],
				artifacts: taskData.artifacts ?? [],
				blockers: taskData.blockers ?? [],
				// Pass-through fields from caller
				title: taskData.title,
				description: taskData.description,
				owner: taskData.owner,
				branch: taskData.branch,
				worktree: taskData.worktree,
				// System-managed fields — always overridden here
				id: nextTaskId(tasks),
				teamId,
				createdAt: now,
				updatedAt: now,
			};

			await this.store.saveTasks(teamId, [...tasks, task]);
			return task;
		});
	}

	/**
	 * Apply a partial update to a task.
	 *
	 * Immutable fields (`id`, `teamId`, `createdAt`) are always preserved.
	 * `updatedAt` is refreshed automatically.
	 *
	 * @throws When the task ID is not found in the team's task list.
	 */
	async updateTask(
		teamId: string,
		taskId: string,
		patch: Partial<TaskRecord>,
	): Promise<TaskRecord> {
		return this.enqueue(teamId, async () => {
			const tasks = await this.store.loadTasks(teamId);
			const index = tasks.findIndex((t) => t.id === taskId);

			if (index === -1) throw new Error(`Task not found: ${taskId}`);

			const existing = tasks[index];
			const now = new Date().toISOString();

			const updated: TaskRecord = {
				...existing,
				...patch,
				// Protect immutable fields
				id: existing.id,
				teamId: existing.teamId,
				createdAt: existing.createdAt,
				updatedAt: now,
			};

			// Build a new array — never mutate `tasks` in place, as the store
			// cache may hand out the same array to concurrent readers.
			const next = tasks.slice();
			next[index] = updated;
			await this.store.saveTasks(teamId, next);
			return updated;
		});
	}

	// -------------------------------------------------------------------------
	// Queries
	// -------------------------------------------------------------------------

	/**
	 * Return all tasks for a team, optionally filtered.
	 *
	 * When no filter is provided the full list is returned as-is.
	 */
	async getTasks(teamId: string, filter?: TaskFilter): Promise<TaskRecord[]> {
		const tasks = await this.store.loadTasks(teamId);
		return filter ? applyFilter(tasks, filter) : tasks;
	}

	/**
	 * Return a single task by ID.
	 *
	 * Returns `null` when no task with that ID exists in the team.
	 */
	async getTask(teamId: string, taskId: string): Promise<TaskRecord | null> {
		const tasks = await this.store.loadTasks(teamId);
		return tasks.find((t) => t.id === taskId) ?? null;
	}

	/**
	 * Return a board view: all tasks plus a summary of counts by status.
	 */
	async getTaskBoard(teamId: string): Promise<TaskBoard> {
		const tasks = await this.store.loadTasks(teamId);

		return {
			teamId,
			tasks,
			summary: {
				done: tasks.filter((t) => t.status === "done").length,
				inProgress: tasks.filter((t) => t.status === "in_progress").length,
				blocked: tasks.filter((t) => t.status === "blocked").length,
				awaitingApproval: tasks.filter(
					(t) => t.status === "awaiting_approval",
				).length,
				total: tasks.length,
			},
		};
	}

	/**
	 * Return tasks whose status is `ready` (no unresolved dependencies and
	 * not yet assigned to a teammate).
	 */
	async getReadyTasks(teamId: string): Promise<TaskRecord[]> {
		return this.getTasks(teamId, { status: "ready" });
	}

	/**
	 * Return tasks that are `blocked`, filtered to those that have at least
	 * one recorded blocker reason.
	 */
	async getBlockedTasks(teamId: string): Promise<TaskRecord[]> {
		const tasks = await this.store.loadTasks(teamId);
		return tasks.filter(
			(t) => t.status === "blocked" && t.blockers.length > 0,
		);
	}

	/**
	 * Return all non-cancelled tasks owned by a specific teammate role.
	 */
	async getTasksForOwner(teamId: string, owner: string): Promise<TaskRecord[]> {
		const tasks = await this.store.loadTasks(teamId);
		return tasks.filter(
			(t) => t.owner === owner && t.status !== "cancelled",
		);
	}

	// -------------------------------------------------------------------------
	// Lifecycle helpers
	// -------------------------------------------------------------------------

	/**
	 * Set the `owner` field on a task, leaving all other fields unchanged.
	 */
	async assignTask(
		teamId: string,
		taskId: string,
		owner: string,
	): Promise<TaskRecord> {
		return this.updateTask(teamId, taskId, { owner });
	}

	/**
	 * After one or more tasks reach `done`, scan all pending tasks and promote
	 * any whose entire `dependsOn` list is now satisfied to `ready`.
	 *
	 * Only tasks with status `todo` or `blocked` are eligible for promotion.
	 * Tasks without dependencies are not touched (they should already be `ready`
	 * or `in_progress`).
	 *
	 * @returns The list of tasks that were promoted (possibly empty).
	 */
	async resolveDependencies(teamId: string): Promise<TaskRecord[]> {
		return this.enqueue(teamId, async () => {
			const tasks = await this.store.loadTasks(teamId);
			const doneIds = new Set(
				tasks.filter((t) => t.status === "done").map((t) => t.id),
			);

			const now = new Date().toISOString();
			const promoted: TaskRecord[] = [];

			for (const task of tasks) {
				// Only promote tasks that are waiting on something
				if (task.status !== "todo" && task.status !== "blocked") continue;
				// Tasks with no declared dependencies are not managed here
				if (task.dependsOn.length === 0) continue;
				// Promote only when every listed dependency is complete
				if (task.dependsOn.every((depId) => doneIds.has(depId))) {
					promoted.push({ ...task, status: "ready" as TaskStatus, updatedAt: now });
				}
			}

			if (promoted.length > 0) {
				// Merge promoted records back into the full task list
				const promotedById = new Map(promoted.map((t) => [t.id, t]));
				const merged = tasks.map((t) => promotedById.get(t.id) ?? t);
				await this.store.saveTasks(teamId, merged);
			}

			return promoted;
		});
	}
}
