/**
 * Pi Teams — Integration Tests
 *
 * End-to-end lifecycle tests that wire the real store + managers + leader
 * runtime together while mocking teammate subprocesses.
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore } from "../core/store.ts";
import { TeamManager } from "../managers/team-manager.ts";
import { TaskManager } from "../managers/task-manager.ts";
import { SignalManager } from "../managers/signal-manager.ts";
import { MailboxManager } from "../managers/mailbox-manager.ts";
import { ApprovalManager } from "../managers/approval-manager.ts";
import { LeaderRuntime } from "../runtime/leader-runtime.ts";
import type { TaskRecord, TeamRecord } from "../core/types.ts";
import { createMockChildProcess, type MockChildProcess } from "./helpers/mock-subprocess.ts";

type IntegrationContext = {
	dir: string;
	store: TeamStore;
	teamManager: TeamManager;
	taskManager: TaskManager;
	signalManager: SignalManager;
	mailboxManager: MailboxManager;
	approvalManager: ApprovalManager;
	runtime: LeaderRuntime;
};

async function setup(): Promise<IntegrationContext> {
	const dir = await mkdtemp(join(tmpdir(), "pi-teams-int-test-"));
	const store = new TeamStore(dir);
	const teamManager = new TeamManager(store);
	const taskManager = new TaskManager(store);
	const signalManager = new SignalManager(store);
	const mailboxManager = new MailboxManager(store);
	const approvalManager = new ApprovalManager(store);
	const runtime = new LeaderRuntime(store, teamManager, taskManager, signalManager, mailboxManager);
	return { dir, store, teamManager, taskManager, signalManager, mailboxManager, approvalManager, runtime };
}

async function teardown(ctx: IntegrationContext): Promise<void> {
	await ctx.runtime.cleanup();
	await new Promise((resolve) => setTimeout(resolve, 25));
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await rm(ctx.dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
			return;
		} catch (error) {
			if (attempt === 2) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

function makeTeam(overrides: Partial<TeamRecord> = {}): TeamRecord {
	const now = new Date().toISOString();
	return {
		id: "integration-team-001",
		name: "Integration Team",
		status: "running",
		createdAt: now,
		updatedAt: now,
		objective: "Validate integration flow",
		repoRoots: ["/tmp/fake-repo"],
		teammates: ["backend", "reviewer"],
		...overrides,
	};
}

function makeTask(teamId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	const now = new Date().toISOString();
	return {
		id: "task-001",
		teamId,
		title: "Test task",
		status: "ready",
		priority: "high",
		dependsOn: [],
		riskLevel: "low",
		approvalRequired: false,
		artifacts: [],
		blockers: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`Condition not met within ${timeoutMs}ms`);
}

describe("team-mode integration", () => {
	let ctx: IntegrationContext;

	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("happy path lifecycle completes end-to-end", async () => {
		ctx = await setup();
		const team = makeTeam();
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);
		const backendTask = makeTask(team.id, {
			id: "task-001",
			title: "Implement backend endpoint",
			owner: "backend",
			status: "ready",
		});
		const reviewerTask = makeTask(team.id, {
			id: "task-002",
			title: "Review backend endpoint",
			owner: "reviewer",
			status: "todo",
			dependsOn: [backendTask.id],
			priority: "medium",
		});
		await ctx.store.saveTasks(team.id, [backendTask, reviewerTask]);

		const processes: Partial<Record<string, MockChildProcess>> = {};
		let spawnOrder = 0;
		ctx.runtime._spawnFn = () => {
			spawnOrder += 1;
			const role = spawnOrder === 1 ? "backend" : "reviewer";
			const proc = createMockChildProcess();
			processes[role] = proc;
			return proc as any;
		};

		await ctx.runtime.launchLeader(team.id);
		await waitFor(() => Boolean(processes.backend));
		processes.backend!.complete("Implemented endpoint successfully.\nHandoffs:\n- to: reviewer | message: Please verify the /health endpoint behavior.");

		await waitFor(async () => (await ctx.taskManager.getTask(team.id, "task-001"))?.status === "done");
		await waitFor(() => Boolean(processes.reviewer));
		processes.reviewer!.complete("Reviewed endpoint successfully.");

		await waitFor(async () => (await ctx.teamManager.getTeam(team.id))?.status === "completed");
		const signals = await ctx.signalManager.getSignals(team.id);
		assert.equal(signals.some((signal) => signal.type === "team_completed"), true);
		assert.equal((await ctx.taskManager.getTask(team.id, "task-002"))?.status, "done");
	});

	test("stalled task is blocked and can recover on a subsequent cycle", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);
		const staleTimestamp = new Date(Date.now() - 20_000).toISOString();
		const stalledTask = makeTask(team.id, {
			id: "task-001",
			title: "Recoverable backend task",
			owner: "backend",
			status: "in_progress",
			updatedAt: staleTimestamp,
			createdAt: staleTimestamp,
		});
		await ctx.store.saveTasks(team.id, [stalledTask]);

		await ctx.runtime.launchLeader(team.id);
		await waitFor(async () => (await ctx.taskManager.getTask(team.id, stalledTask.id))?.status === "blocked");
		const blockedSignals = await ctx.signalManager.getSignals(team.id, { type: "blocked" });
		assert.equal(blockedSignals.length > 0, true);

		await ctx.taskManager.updateTask(team.id, stalledTask.id, {
			status: "ready",
			blockers: [],
		});

		let recoveredProcess: MockChildProcess | undefined;
		ctx.runtime._spawnFn = () => {
			recoveredProcess = createMockChildProcess();
			return recoveredProcess as any;
		};
		await (ctx.runtime as any).runLeaderCycleInner(team.id);
		await waitFor(() => Boolean(recoveredProcess));
		recoveredProcess!.complete("Recovered successfully.");
		await waitFor(async () => (await ctx.taskManager.getTask(team.id, stalledTask.id))?.status === "done");
	});

	test("explicit handoffs are delivered through the mailbox", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend", "frontend", "reviewer"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);
		const backendTask = makeTask(team.id, {
			id: "task-001",
			title: "Implement API contract",
			owner: "backend",
			status: "ready",
		});
		const frontendTask = makeTask(team.id, {
			id: "task-002",
			title: "Integrate frontend",
			owner: "frontend",
			status: "todo",
			dependsOn: [backendTask.id],
		});
		await ctx.store.saveTasks(team.id, [backendTask, frontendTask]);

		let backendProcess: MockChildProcess | undefined;
		ctx.runtime._spawnFn = () => {
			backendProcess = createMockChildProcess();
			return backendProcess as any;
		};
		await ctx.runtime.launchLeader(team.id);
		await waitFor(() => Boolean(backendProcess));
		backendProcess!.complete([
			"Backend API finished.",
			"Handoffs:",
			"- to: frontend | message: API is ready at /health and returns { status: 'ok' }",
			"- to: reviewer | message: Focus review on the response schema.",
		].join("\n"));

		await waitFor(async () => (await ctx.mailboxManager.getMessagesFor(team.id, "frontend")).length > 0);
		const frontendMessages = await ctx.mailboxManager.getMessagesFor(team.id, "frontend");
		assert.equal(frontendMessages.some((message) => message.message.includes("API is ready at /health")), true);
		const handoffSignals = await ctx.signalManager.getSignals(team.id, { type: "handoff" });
		assert.equal(handoffSignals.length >= 2, true);
	});

	test("approval-gated task waits for approval before spawning", async () => {
		ctx = await setup();
		const team = makeTeam({ teammates: ["backend"] });
		await ctx.store.ensureTeamDirs(team.id, team.teammates);
		await ctx.store.saveTeam(team);
		const gatedTask = makeTask(team.id, {
			id: "task-001",
			title: "Risky backend refactor",
			owner: "backend",
			status: "awaiting_approval",
			approvalRequired: true,
			riskLevel: "high",
		});
		await ctx.store.saveTasks(team.id, [gatedTask]);
		const approval = await ctx.approvalManager.requestApproval(team.id, {
			taskId: gatedTask.id,
			submittedBy: "backend",
			artifact: "specs/risky-plan.md",
		});

		let spawnCount = 0;
		let process: MockChildProcess | undefined;
		ctx.runtime._spawnFn = () => {
			spawnCount += 1;
			process = createMockChildProcess();
			return process as any;
		};
		await ctx.runtime.launchLeader(team.id);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(spawnCount, 0, "approval-gated task should not spawn before approval");

		await ctx.approvalManager.approve(team.id, approval.id, "user");
		await ctx.taskManager.updateTask(team.id, gatedTask.id, { status: "ready", blockers: [] });
		await (ctx.runtime as any).runLeaderCycleInner(team.id);
		await waitFor(() => Boolean(process));
		process!.complete("Approved work completed.");
		await waitFor(async () => (await ctx.taskManager.getTask(team.id, gatedTask.id))?.status === "done");
		const approvalSignals = await ctx.signalManager.getSignals(team.id, { type: "approval_granted" });
		assert.equal(approvalSignals.length, 1);
	});
});
