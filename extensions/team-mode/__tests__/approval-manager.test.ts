/**
 * Pi Teams — ApprovalManager Unit Tests
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore } from "../core/store.ts";
import { ApprovalManager } from "../managers/approval-manager.ts";
import type { ApprovalRequest, TeamRecord } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setup(): Promise<{
	store: TeamStore;
	approvalManager: ApprovalManager;
	teamId: string;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "pi-teams-approval-"));
	const store = new TeamStore(dir);
	const approvalManager = new ApprovalManager(store);
	const teamId = "team-20260403-001";
	const now = new Date().toISOString();

	const team: TeamRecord = {
		id: teamId,
		name: "test-team",
		status: "running",
		createdAt: now,
		updatedAt: now,
		objective: "Test",
		repoRoots: [],
		teammates: [],
	};
	await store.saveTeam(team);

	return { store, approvalManager, teamId, dir };
}

type RequestInput = Omit<ApprovalRequest, "id" | "teamId" | "status" | "createdAt" | "resolvedAt">;

function baseRequest(overrides: Partial<RequestInput> = {}): RequestInput {
	return {
		taskId: "task-001",
		submittedBy: "backend",
		artifact: "specs/plan.md",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// requestApproval
// ---------------------------------------------------------------------------

describe("ApprovalManager.requestApproval", () => {
	test("assigns sequential apr-NNN IDs", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const a1 = await approvalManager.requestApproval(teamId, baseRequest());
		const a2 = await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-002" }));
		assert.equal(a1.id, "apr-001");
		assert.equal(a2.id, "apr-002");
		await rm(dir, { recursive: true, force: true });
	});

	test("sets status to pending", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const approval = await approvalManager.requestApproval(teamId, baseRequest());
		assert.equal(approval.status, "pending");
		await rm(dir, { recursive: true, force: true });
	});

	test("sets teamId and createdAt", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const before = new Date().toISOString();
		const approval = await approvalManager.requestApproval(teamId, baseRequest());
		const after = new Date().toISOString();
		assert.equal(approval.teamId, teamId);
		assert.ok(approval.createdAt >= before);
		assert.ok(approval.createdAt <= after);
		await rm(dir, { recursive: true, force: true });
	});

	test("preserves caller-supplied fields", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const input: RequestInput = {
			taskId: "task-007",
			submittedBy: "planner",
			artifact: "specs/billing-plan.md",
		};
		const approval = await approvalManager.requestApproval(teamId, input);
		assert.equal(approval.taskId, "task-007");
		assert.equal(approval.submittedBy, "planner");
		assert.equal(approval.artifact, "specs/billing-plan.md");
		await rm(dir, { recursive: true, force: true });
	});

	test("persists approval so it can be retrieved", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const approval = await approvalManager.requestApproval(teamId, baseRequest());
		const found = await approvalManager.getApprovalForTask(teamId, approval.taskId);
		assert.equal(found?.id, approval.id);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

describe("ApprovalManager.approve", () => {
	test("transitions status to approved", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const approval = await approvalManager.requestApproval(teamId, baseRequest());
		const updated = await approvalManager.approve(teamId, approval.id, "leader");
		assert.equal(updated.status, "approved");
		await rm(dir, { recursive: true, force: true });
	});

	test("records reviewedBy and resolvedAt", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const approval = await approvalManager.requestApproval(teamId, baseRequest());
		const before = new Date().toISOString();
		const updated = await approvalManager.approve(teamId, approval.id, "leader");
		const after = new Date().toISOString();
		assert.equal(updated.reviewedBy, "leader");
		assert.ok(updated.resolvedAt !== undefined);
		assert.ok(updated.resolvedAt! >= before);
		assert.ok(updated.resolvedAt! <= after);
		await rm(dir, { recursive: true, force: true });
	});

	test("emits an approval_granted signal", async () => {
		const { approvalManager, teamId, store, dir } = await setup();
		const approval = await approvalManager.requestApproval(teamId, baseRequest());
		await approvalManager.approve(teamId, approval.id, "leader");
		const signals = await store.loadSignals(teamId);
		const granted = signals.find((s) => s.type === "approval_granted");
		assert.ok(granted !== undefined, "expected approval_granted signal");
		assert.equal(granted!.taskId, approval.taskId);
		await rm(dir, { recursive: true, force: true });
	});

	test("throws when approval request is not found", async () => {
		const { approvalManager, teamId, dir } = await setup();
		await assert.rejects(
			() => approvalManager.approve(teamId, "apr-999", "leader"),
			/not found/i,
		);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

describe("ApprovalManager.reject", () => {
	test("transitions status to rejected", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const approval = await approvalManager.requestApproval(teamId, baseRequest());
		const updated = await approvalManager.reject(teamId, approval.id, "leader", "Plan is incomplete");
		assert.equal(updated.status, "rejected");
		await rm(dir, { recursive: true, force: true });
	});

	test("records reviewedBy, feedback, and resolvedAt", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const approval = await approvalManager.requestApproval(teamId, baseRequest());
		const updated = await approvalManager.reject(
			teamId,
			approval.id,
			"leader",
			"Missing error handling",
		);
		assert.equal(updated.reviewedBy, "leader");
		assert.equal(updated.feedback, "Missing error handling");
		assert.ok(updated.resolvedAt !== undefined);
		await rm(dir, { recursive: true, force: true });
	});

	test("emits an approval_rejected signal with feedback", async () => {
		const { approvalManager, teamId, store, dir } = await setup();
		const approval = await approvalManager.requestApproval(teamId, baseRequest());
		await approvalManager.reject(teamId, approval.id, "leader", "Needs revision");
		const signals = await store.loadSignals(teamId);
		const rejected = signals.find((s) => s.type === "approval_rejected");
		assert.ok(rejected !== undefined, "expected approval_rejected signal");
		assert.ok(rejected!.message.includes("Needs revision"));
		await rm(dir, { recursive: true, force: true });
	});

	test("throws when approval request is not found", async () => {
		const { approvalManager, teamId, dir } = await setup();
		await assert.rejects(
			() => approvalManager.reject(teamId, "apr-999", "leader", "feedback"),
			/not found/i,
		);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getApprovals
// ---------------------------------------------------------------------------

describe("ApprovalManager.getApprovals", () => {
	test("returns all approvals when no filter is provided", async () => {
		const { approvalManager, teamId, dir } = await setup();
		await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-001" }));
		await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-002" }));
		const approvals = await approvalManager.getApprovals(teamId);
		assert.equal(approvals.length, 2);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by status pending", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const a1 = await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-001" }));
		const a2 = await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-002" }));
		await approvalManager.approve(teamId, a1.id, "leader");

		const pending = await approvalManager.getApprovals(teamId, { status: "pending" });
		assert.equal(pending.length, 1);
		assert.equal(pending[0].id, a2.id);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by status approved", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const a1 = await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-001" }));
		await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-002" }));
		await approvalManager.approve(teamId, a1.id, "leader");

		const approved = await approvalManager.getApprovals(teamId, { status: "approved" });
		assert.equal(approved.length, 1);
		assert.equal(approved[0].id, a1.id);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getPendingApprovals
// ---------------------------------------------------------------------------

describe("ApprovalManager.getPendingApprovals", () => {
	test("returns only pending approval requests", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const a1 = await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-001" }));
		const a2 = await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-002" }));
		await approvalManager.approve(teamId, a1.id, "leader");

		const pending = await approvalManager.getPendingApprovals(teamId);
		assert.equal(pending.length, 1);
		assert.equal(pending[0].id, a2.id);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns empty array when no pending approvals", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const a = await approvalManager.requestApproval(teamId, baseRequest());
		await approvalManager.approve(teamId, a.id, "leader");

		const pending = await approvalManager.getPendingApprovals(teamId);
		assert.equal(pending.length, 0);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getApprovalForTask
// ---------------------------------------------------------------------------

describe("ApprovalManager.getApprovalForTask", () => {
	test("returns the approval request for a task", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const a = await approvalManager.requestApproval(teamId, baseRequest({ taskId: "task-042" }));
		const found = await approvalManager.getApprovalForTask(teamId, "task-042");
		assert.equal(found?.id, a.id);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns null when no approval exists for the task", async () => {
		const { approvalManager, teamId, dir } = await setup();
		const result = await approvalManager.getApprovalForTask(teamId, "task-999");
		assert.equal(result, null);
		await rm(dir, { recursive: true, force: true });
	});
});
