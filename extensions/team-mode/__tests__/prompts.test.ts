// Pi Team-Mode — Prompt addenda + notification XML

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
	formatTaskNotification,
	getCoordinatorSystemPrompt,
	isCoordinatorMode,
} from "../core/prompts.ts";

describe("TEAMMATE_SYSTEM_PROMPT_ADDENDUM", () => {
	test("instructs teammates to use send_message", () => {
		assert.match(TEAMMATE_SYSTEM_PROMPT_ADDENDUM, /send_message/);
		assert.match(TEAMMATE_SYSTEM_PROMPT_ADDENDUM, /team-wide broadcasts/);
		assert.match(TEAMMATE_SYSTEM_PROMPT_ADDENDUM, /not visible to others/);
	});
});

describe("getCoordinatorSystemPrompt", () => {
	const prompt = getCoordinatorSystemPrompt();
	test("teaches coordinator role", () => {
		assert.match(prompt, /coordinator/i);
		assert.match(prompt, /Your Role/);
	});
	test("references the 5 core tools", () => {
		for (const name of [
			"agent",
			"send_message",
			"task_stop",
			"task_create",
			"task_list",
		]) {
			assert.match(prompt, new RegExp(`\\b${name}\\b`), `mentions ${name}`);
		}
	});
	test("describes task-notification wake-up", () => {
		assert.match(prompt, /<task-notification>/);
		assert.match(prompt, /end your response/i);
		assert.match(prompt, /Never fabricate or predict/);
	});
});

describe("formatTaskNotification", () => {
	test("basic completion", () => {
		const xml = formatTaskNotification({
			taskId: "agent-researcher-abc",
			status: "completed",
			summary: 'Agent "research auth" completed',
			result: "Found null pointer at validate.ts:42",
			durationMs: 1234,
		});
		assert.match(xml, /<task-notification>/);
		assert.match(xml, /<task-id>agent-researcher-abc<\/task-id>/);
		assert.match(xml, /<status>completed<\/status>/);
		assert.match(xml, /<duration_ms>1234<\/duration_ms>/);
		assert.match(xml, /<result>Found null pointer at validate.ts:42<\/result>/);
	});

	test("escapes XML special chars", () => {
		const xml = formatTaskNotification({
			taskId: "agent-x",
			status: "failed",
			summary: "boom",
			result: "<script>alert('xss')</script>",
		});
		assert.match(xml, /&lt;script&gt;/);
		assert.doesNotMatch(xml, /<script>/);
	});

	test("omits optional sections", () => {
		const xml = formatTaskNotification({
			taskId: "agent-x",
			status: "killed",
			summary: "stopped by user",
		});
		assert.doesNotMatch(xml, /<result>/);
		assert.doesNotMatch(xml, /<usage>/);
	});
});

describe("isCoordinatorMode", () => {
	test("reads PI_TEAM_MATE_COORDINATOR", () => {
		const prev = process.env.PI_TEAM_MATE_COORDINATOR;
		try {
			process.env.PI_TEAM_MATE_COORDINATOR = "1";
			assert.equal(isCoordinatorMode(), true);
			process.env.PI_TEAM_MATE_COORDINATOR = "true";
			assert.equal(isCoordinatorMode(), true);
			process.env.PI_TEAM_MATE_COORDINATOR = "";
			assert.equal(isCoordinatorMode(), false);
			delete process.env.PI_TEAM_MATE_COORDINATOR;
			assert.equal(isCoordinatorMode(), false);
		} finally {
			if (prev === undefined) delete process.env.PI_TEAM_MATE_COORDINATOR;
			else process.env.PI_TEAM_MATE_COORDINATOR = prev;
		}
	});
});
