/**
 * Pi Teams — MailboxManager Unit Tests
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore } from "../core/store.ts";
import { MailboxManager } from "../managers/mailbox-manager.ts";
import type { MailboxMessage, TeamRecord } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setup(): Promise<{
	store: TeamStore;
	mailboxManager: MailboxManager;
	teamId: string;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "pi-teams-mailbox-"));
	const store = new TeamStore(dir);
	const mailboxManager = new MailboxManager(store);
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

	return { store, mailboxManager, teamId, dir };
}

type SendInput = Omit<MailboxMessage, "id" | "teamId" | "createdAt">;

function baseMsg(overrides: Partial<SendInput> = {}): SendInput {
	return {
		from: "backend",
		to: "frontend",
		type: "handoff",
		message: "API contract ready",
		attachments: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

describe("MailboxManager.send", () => {
	test("assigns sequential msg-NNN IDs", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		const m1 = await mailboxManager.send(teamId, baseMsg());
		const m2 = await mailboxManager.send(teamId, baseMsg());
		assert.equal(m1.id, "msg-001");
		assert.equal(m2.id, "msg-002");
		await rm(dir, { recursive: true, force: true });
	});

	test("sets teamId and createdAt on the message", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		const before = new Date().toISOString();
		const msg = await mailboxManager.send(teamId, baseMsg());
		const after = new Date().toISOString();
		assert.equal(msg.teamId, teamId);
		assert.ok(msg.createdAt >= before);
		assert.ok(msg.createdAt <= after);
		await rm(dir, { recursive: true, force: true });
	});

	test("preserves all caller-supplied fields", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		const input: SendInput = {
			from: "backend",
			to: "frontend",
			taskId: "task-007",
			type: "contract_handoff",
			message: "Here is the API spec",
			attachments: ["specs/api.md"],
		};
		const msg = await mailboxManager.send(teamId, input);
		assert.equal(msg.from, "backend");
		assert.equal(msg.to, "frontend");
		assert.equal(msg.taskId, "task-007");
		assert.equal(msg.type, "contract_handoff");
		assert.equal(msg.message, "Here is the API spec");
		assert.deepEqual(msg.attachments, ["specs/api.md"]);
		await rm(dir, { recursive: true, force: true });
	});

	test("persists message so it can be retrieved by getMessages", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg({ message: "persist check" }));
		const messages = await mailboxManager.getMessages(teamId);
		assert.ok(messages.some((m) => m.message === "persist check"));
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------

describe("MailboxManager.getMessages", () => {
	test("returns all messages when no filter is provided", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg());
		await mailboxManager.send(teamId, baseMsg({ to: "all" }));
		const messages = await mailboxManager.getMessages(teamId);
		assert.equal(messages.length, 2);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by to", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg({ to: "frontend", message: "fe" }));
		await mailboxManager.send(teamId, baseMsg({ to: "backend", message: "be" }));
		const messages = await mailboxManager.getMessages(teamId, { to: "frontend" });
		assert.equal(messages.length, 1);
		assert.equal(messages[0].message, "fe");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by from", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg({ from: "backend" }));
		await mailboxManager.send(teamId, baseMsg({ from: "frontend" }));
		const messages = await mailboxManager.getMessages(teamId, { from: "backend" });
		assert.equal(messages.length, 1);
		assert.equal(messages[0].from, "backend");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by taskId", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg({ taskId: "task-001" }));
		await mailboxManager.send(teamId, baseMsg({ taskId: "task-002" }));
		const messages = await mailboxManager.getMessages(teamId, { taskId: "task-001" });
		assert.equal(messages.length, 1);
		assert.equal(messages[0].taskId, "task-001");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by type", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg({ type: "handoff" }));
		await mailboxManager.send(teamId, baseMsg({ type: "review_request" }));
		const messages = await mailboxManager.getMessages(teamId, { type: "handoff" });
		assert.equal(messages.length, 1);
		assert.equal(messages[0].type, "handoff");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters by since (strictly after)", async () => {
		const { mailboxManager, teamId, store, dir } = await setup();
		await store.appendMessage(teamId, {
			id: "msg-001",
			teamId,
			from: "backend",
			to: "frontend",
			type: "handoff",
			message: "old",
			attachments: [],
			createdAt: "2026-01-01T00:00:00Z",
		});
		await store.appendMessage(teamId, {
			id: "msg-002",
			teamId,
			from: "backend",
			to: "frontend",
			type: "handoff",
			message: "new",
			attachments: [],
			createdAt: "2026-12-01T00:00:00Z",
		});

		const result = await mailboxManager.getMessages(teamId, {
			since: "2026-06-01T00:00:00Z",
		});
		assert.equal(result.length, 1);
		assert.equal(result[0].message, "new");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getMessagesFor
// ---------------------------------------------------------------------------

describe("MailboxManager.getMessagesFor", () => {
	test("returns direct messages and broadcast messages for recipient", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg({ to: "frontend", message: "direct" }));
		await mailboxManager.send(teamId, baseMsg({ to: "all", message: "broadcast" }));
		await mailboxManager.send(teamId, baseMsg({ to: "backend", message: "other" }));

		const result = await mailboxManager.getMessagesFor(teamId, "frontend");
		assert.equal(result.length, 2);
		assert.ok(result.some((m) => m.message === "direct"));
		assert.ok(result.some((m) => m.message === "broadcast"));
		await rm(dir, { recursive: true, force: true });
	});

	test("returns empty array when no messages for recipient", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg({ to: "backend" }));
		const result = await mailboxManager.getMessagesFor(teamId, "frontend");
		assert.equal(result.length, 0);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getMessagesFrom
// ---------------------------------------------------------------------------

describe("MailboxManager.getMessagesFrom", () => {
	test("returns messages from specified sender", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg({ from: "backend", message: "from be" }));
		await mailboxManager.send(teamId, baseMsg({ from: "frontend", message: "from fe" }));

		const result = await mailboxManager.getMessagesFrom(teamId, "backend");
		assert.equal(result.length, 1);
		assert.equal(result[0].message, "from be");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getMessagesForTask
// ---------------------------------------------------------------------------

describe("MailboxManager.getMessagesForTask", () => {
	test("returns messages scoped to the given task", async () => {
		const { mailboxManager, teamId, dir } = await setup();
		await mailboxManager.send(teamId, baseMsg({ taskId: "task-001", message: "for t1" }));
		await mailboxManager.send(teamId, baseMsg({ taskId: "task-002", message: "for t2" }));
		await mailboxManager.send(teamId, baseMsg({ message: "no task" }));

		const result = await mailboxManager.getMessagesForTask(teamId, "task-001");
		assert.equal(result.length, 1);
		assert.equal(result[0].message, "for t1");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getNewMessages
// ---------------------------------------------------------------------------

describe("MailboxManager.getNewMessages", () => {
	test("returns messages after since for recipient and broadcasts", async () => {
		const { mailboxManager, teamId, store, dir } = await setup();
		const since = "2026-06-01T00:00:00Z";

		await store.appendMessage(teamId, {
			id: "msg-001",
			teamId,
			from: "backend",
			to: "frontend",
			type: "handoff",
			message: "old direct",
			attachments: [],
			createdAt: "2026-01-01T00:00:00Z",
		});
		await store.appendMessage(teamId, {
			id: "msg-002",
			teamId,
			from: "backend",
			to: "frontend",
			type: "handoff",
			message: "new direct",
			attachments: [],
			createdAt: "2026-12-01T00:00:00Z",
		});
		await store.appendMessage(teamId, {
			id: "msg-003",
			teamId,
			from: "backend",
			to: "all",
			type: "handoff",
			message: "new broadcast",
			attachments: [],
			createdAt: "2026-12-01T00:00:00Z",
		});
		await store.appendMessage(teamId, {
			id: "msg-004",
			teamId,
			from: "backend",
			to: "backend",
			type: "handoff",
			message: "other new",
			attachments: [],
			createdAt: "2026-12-01T00:00:00Z",
		});

		const result = await mailboxManager.getNewMessages(teamId, "frontend", since);
		assert.equal(result.length, 2);
		assert.ok(result.some((m) => m.message === "new direct"));
		assert.ok(result.some((m) => m.message === "new broadcast"));
		await rm(dir, { recursive: true, force: true });
	});

	test("returns empty array when nothing is newer than since", async () => {
		const { mailboxManager, teamId, store, dir } = await setup();
		await store.appendMessage(teamId, {
			id: "msg-001",
			teamId,
			from: "backend",
			to: "frontend",
			type: "handoff",
			message: "old",
			attachments: [],
			createdAt: "2026-01-01T00:00:00Z",
		});
		const result = await mailboxManager.getNewMessages(
			teamId,
			"frontend",
			"2026-06-01T00:00:00Z",
		);
		assert.equal(result.length, 0);
		await rm(dir, { recursive: true, force: true });
	});
});
