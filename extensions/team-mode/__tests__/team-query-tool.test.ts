/**
 * Pi Teams — team_query tool registration + routing tests
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import registerTeamMode from "../index.ts";
import { TeamStore } from "../core/store.ts";
import { TeamManager } from "../managers/team-manager.ts";
import { TaskManager } from "../managers/task-manager.ts";
import { SignalManager } from "../managers/signal-manager.ts";
import { MailboxManager } from "../managers/mailbox-manager.ts";
import type { TaskRecord, TeamRecord } from "../core/types.ts";

type RegisteredTool = {
	name: string;
	execute: (...args: any[]) => Promise<any>;
	promptGuidelines?: string[];
};

type MockPi = {
	tools: RegisteredTool[];
	events: Map<string, Function>;
	registerTool: (tool: RegisteredTool) => void;
	registerCommand: (...args: any[]) => void;
	registerMessageRenderer: (...args: any[]) => void;
	on: (event: string, handler: Function) => void;
	sendMessage: (...args: any[]) => void;
};

function createMockPi(): MockPi {
	return {
		tools: [],
		events: new Map(),
		registerTool(tool) {
			this.tools.push(tool);
		},
		registerCommand() {
			// not needed for these tests
		},
		registerMessageRenderer() {
			// not needed for these tests
		},
		on(event, handler) {
			this.events.set(event, handler);
		},
		sendMessage() {
			// not needed for tool execution tests
		},
	};
}

function makeTeam(overrides: Partial<TeamRecord> = {}): TeamRecord {
	const now = new Date().toISOString();
	return {
		id: "tool-team-001",
		name: "alpha",
		status: "running",
		createdAt: now,
		updatedAt: now,
		objective: "Ship compact responses",
		repoRoots: [],
		teammates: ["backend"],
		currentPhase: "implementation",
		...overrides,
	};
}

function makeTask(teamId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	const now = new Date().toISOString();
	return {
		id: "task-001",
		teamId,
		title: "Implement compact tool responses",
		owner: "backend",
		status: "done",
		priority: "high",
		dependsOn: [],
		riskLevel: "low",
		approvalRequired: false,
		artifacts: ["specs/tool-response.md"],
		blockers: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

async function seedTeamState(dir: string): Promise<void> {
	const store = new TeamStore(dir);
	const teamManager = new TeamManager(store);
	const taskManager = new TaskManager(store);
	const signalManager = new SignalManager(store);
	const mailboxManager = new MailboxManager(store);

	const team = makeTeam();
	await store.ensureTeamDirs(team.id, team.teammates);
	await store.saveTeam(team);
	await store.saveTasks(team.id, [
		makeTask(team.id, { id: "task-001", status: "done" }),
		makeTask(team.id, { id: "task-002", status: "in_progress", owner: "backend", title: "Investigate compact formatter edge cases" }),
	]);
	await store.saveTeammateProcess(team.id, {
		teamId: team.id,
		role: "backend",
		state: "running",
		taskId: "task-002",
		startedAt: new Date().toISOString(),
		output: "Working through formatter output.",
	});
	await store.saveTeammateOutput(team.id, "backend", "latest.md", "Detailed backend output preview");
	await signalManager.emit(team.id, {
		source: "leader",
		type: "team_summary",
		severity: "info",
		message: "Summary — 1/2 done, 0 blocker(s), 0 approval(s) pending",
		links: [],
	});
	await signalManager.emit(team.id, {
		source: "backend",
		type: "task_started",
		severity: "info",
		taskId: "task-002",
		message: "Started compact formatter edge cases",
		links: [],
	});
	await mailboxManager.send(team.id, {
		from: "leader",
		to: "backend",
		type: "guidance",
		message: "Keep responses under 150 tokens.",
		attachments: [],
	});
	await teamManager.markChecked(team.id);
}

describe("team_query tool", () => {
	let dir = "";

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("registers the consolidated read tool and removes legacy read tools", async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-teams-query-tool-"));
		const pi = createMockPi();
		registerTeamMode(pi as any);

		const toolNames = pi.tools.map((tool) => tool.name).sort();
		assert.equal(toolNames.length, 9);
		assert.equal(toolNames.includes("team_query"), true);
		assert.equal(toolNames.includes("team_status"), false);
		assert.equal(toolNames.includes("team_tasks"), false);
		assert.equal(toolNames.includes("team_signals"), false);
		assert.equal(toolNames.includes("team_teammate"), false);
		assert.equal(toolNames.includes("team_ask"), false);
	});

	test("routes compact and verbose queries through team_query", async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-teams-query-tool-"));
		await seedTeamState(dir);
		const pi = createMockPi();
		registerTeamMode(pi as any);
		const ctx = {
			cwd: dir,
			hasUI: false,
			ui: {
				notify() {},
				setWidget() {},
				theme: { fg: (_tone: string, text: string) => text },
			},
		};
		await pi.events.get("session_start")?.({}, ctx);

		const teamQuery = pi.tools.find((tool) => tool.name === "team_query");
		assert.ok(teamQuery, "team_query should be registered");

		const statusResult = await teamQuery!.execute("call-1", { action: "status", teamId: "tool-team-001" }, null, null, ctx);
		assert.match(statusResult.content[0].text, /^alpha: 1\/2 done \| phase: implementation/);

		const verboseStatus = await teamQuery!.execute("call-2", { action: "status", teamId: "tool-team-001", verbose: true }, null, null, ctx);
		assert.match(verboseStatus.content[0].text, /Team alpha \[tool-team-001\] — running/);

		const tasksResult = await teamQuery!.execute("call-3", { action: "tasks", teamId: "tool-team-001" }, null, null, ctx);
		assert.match(tasksResult.content[0].text, /tool-team-001: 1\/2 done/);

		const signalsResult = await teamQuery!.execute("call-4", { action: "signals", teamId: "tool-team-001", sinceLastCheck: false }, null, null, ctx);
		assert.match(signalsResult.content[0].text, /\[(\d{2}:\d{2})\] leader:/);

		const teammateResult = await teamQuery!.execute("call-5", { action: "teammate", teamId: "tool-team-001", name: "backend" }, null, null, ctx);
		assert.match(teammateResult.content[0].text, /^backend: in_progress \| task: task-002/);

		const askResult = await teamQuery!.execute(
			"call-6",
			{ action: "ask", teamId: "tool-team-001", target: "backend", question: "What are you doing?" },
			null,
			null,
			ctx,
		);
		assert.match(askResult.content[0].text, /^backend: in_progress on task-002/);
		assert.match(askResult.content[0].text, /Forwarded to backend's mailbox/);

		await pi.events.get("session_shutdown")?.({}, ctx);
	});

	test("team_create guidance prefers objective-only calls", async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-teams-query-tool-"));
		const pi = createMockPi();
		registerTeamMode(pi as any);
		const teamCreate = pi.tools.find((tool) => tool.name === "team_create");
		assert.ok(teamCreate?.promptGuidelines?.some((line) => line.includes("Prefer providing only the objective")));
	});
});
