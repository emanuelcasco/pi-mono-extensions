/**
 * Pi Teams — ApprovalManager
 *
 * High-level API for managing approval requests for risky task plans.
 *
 * Approval requests are stored in `approvals.json` as a mutable list (reads
 * the full list, mutates in memory, then writes back). Side-effects such as
 * signal emission are handled directly through `TeamStore` so this class has
 * no dependency on `SignalManager`.
 */

import type { ApprovalRequest, Signal } from "./types.js";
import type { TeamStore } from "./store.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive the next approval ID for a team by counting existing requests.
 * IDs are sequential: `apr-001`, `apr-002`, …
 */
async function nextApprovalId(store: TeamStore, teamId: string): Promise<string> {
	const existing = await store.loadApprovals(teamId);
	const next = existing.length + 1;
	return `apr-${String(next).padStart(3, "0")}`;
}

/**
 * Derive the next signal ID for a team by counting existing signals.
 * IDs are sequential: `sig-001`, `sig-002`, …
 *
 * Duplicated from SignalManager intentionally — ApprovalManager must emit
 * signals without taking a SignalManager dependency to avoid circular imports.
 */
async function nextSignalId(store: TeamStore, teamId: string): Promise<string> {
	const existing = await store.loadSignals(teamId);
	const next = existing.length + 1;
	return `sig-${String(next).padStart(3, "0")}`;
}

/**
 * Emit an `approval_granted` or `approval_rejected` signal directly via the
 * store, bypassing SignalManager to avoid a circular dependency.
 */
async function emitApprovalSignal(
	store: TeamStore,
	teamId: string,
	type: "approval_granted" | "approval_rejected",
	approval: ApprovalRequest,
	reviewedBy: string,
	feedback?: string,
): Promise<void> {
	const id = await nextSignalId(store, teamId);
	const message =
		type === "approval_granted"
			? `Approval granted for task ${approval.taskId} by ${reviewedBy}`
			: `Approval rejected for task ${approval.taskId} by ${reviewedBy}${
					feedback ? `: ${feedback}` : ""
				}`;

	const signal: Signal = {
		id,
		teamId,
		source: reviewedBy,
		type,
		severity: type === "approval_granted" ? "info" : "warning",
		taskId: approval.taskId,
		timestamp: new Date().toISOString(),
		message,
		links: [approval.artifact],
	};

	await store.appendSignal(teamId, signal);
}

// ---------------------------------------------------------------------------
// ApprovalManager
// ---------------------------------------------------------------------------

export class ApprovalManager {
	constructor(private store: TeamStore) {}

	// -------------------------------------------------------------------------
	// Write
	// -------------------------------------------------------------------------

	/**
	 * Submit a new approval request for a task plan.
	 *
	 * Assigns a sequential ID (`apr-NNN`), sets status to `pending`, records
	 * `createdAt`, and appends the request to the team's `approvals.json`.
	 */
	async requestApproval(
		teamId: string,
		request: Omit<ApprovalRequest, "id" | "teamId" | "status" | "createdAt" | "resolvedAt">,
	): Promise<ApprovalRequest> {
		const id = await nextApprovalId(this.store, teamId);
		const now = new Date().toISOString();

		const full: ApprovalRequest = {
			...request,
			id,
			teamId,
			status: "pending",
			createdAt: now,
		};

		const existing = await this.store.loadApprovals(teamId);
		await this.store.saveApprovals(teamId, [...existing, full]);

		return full;
	}

	/**
	 * Approve a pending request.
	 *
	 * Sets `status` to `approved`, records `reviewedBy` and `resolvedAt`, then
	 * emits an `approval_granted` signal.
	 *
	 * @throws {Error} If the request is not found.
	 */
	async approve(
		teamId: string,
		requestId: string,
		reviewedBy: string,
	): Promise<ApprovalRequest> {
		const approvals = await this.store.loadApprovals(teamId);
		const idx = approvals.findIndex((a) => a.id === requestId);

		if (idx === -1) {
			throw new Error(`Approval request "${requestId}" not found in team "${teamId}"`);
		}

		const updated: ApprovalRequest = {
			...approvals[idx],
			status: "approved",
			reviewedBy,
			resolvedAt: new Date().toISOString(),
		};

		approvals[idx] = updated;
		await this.store.saveApprovals(teamId, approvals);

		await emitApprovalSignal(this.store, teamId, "approval_granted", updated, reviewedBy);

		return updated;
	}

	/**
	 * Reject a pending request with reviewer feedback.
	 *
	 * Sets `status` to `rejected`, records `reviewedBy`, `feedback`, and
	 * `resolvedAt`, then emits an `approval_rejected` signal.
	 *
	 * @throws {Error} If the request is not found.
	 */
	async reject(
		teamId: string,
		requestId: string,
		reviewedBy: string,
		feedback: string,
	): Promise<ApprovalRequest> {
		const approvals = await this.store.loadApprovals(teamId);
		const idx = approvals.findIndex((a) => a.id === requestId);

		if (idx === -1) {
			throw new Error(`Approval request "${requestId}" not found in team "${teamId}"`);
		}

		const updated: ApprovalRequest = {
			...approvals[idx],
			status: "rejected",
			reviewedBy,
			feedback,
			resolvedAt: new Date().toISOString(),
		};

		approvals[idx] = updated;
		await this.store.saveApprovals(teamId, approvals);

		await emitApprovalSignal(
			this.store,
			teamId,
			"approval_rejected",
			updated,
			reviewedBy,
			feedback,
		);

		return updated;
	}

	// -------------------------------------------------------------------------
	// Read
	// -------------------------------------------------------------------------

	/**
	 * Return all approval requests for a team, with an optional status filter.
	 */
	async getApprovals(
		teamId: string,
		filter?: { status?: string },
	): Promise<ApprovalRequest[]> {
		const approvals = await this.store.loadApprovals(teamId);

		if (!filter?.status) return approvals;

		return approvals.filter((a) => a.status === filter.status);
	}

	/**
	 * Return all approval requests that are currently awaiting review.
	 */
	async getPendingApprovals(teamId: string): Promise<ApprovalRequest[]> {
		const approvals = await this.store.loadApprovals(teamId);
		return approvals.filter((a) => a.status === "pending");
	}

	/**
	 * Return the first approval request associated with a given task, or `null`
	 * if no request exists for that task.
	 */
	async getApprovalForTask(
		teamId: string,
		taskId: string,
	): Promise<ApprovalRequest | null> {
		const approvals = await this.store.loadApprovals(teamId);
		return approvals.find((a) => a.taskId === taskId) ?? null;
	}
}
