/**
 * Sentinel whitelist persistence tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { SentinelSession } from "../session.ts";

describe("SentinelSession whitelist", () => {
	let agentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "sentinel-whitelist-test-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(agentDir, { recursive: true, force: true });
	});

	test("starts empty", () => {
		const session = new SentinelSession();
		assert.equal(session.isWhitelisted("/some/path"), false);
	});

	test("adds and checks whitelist entries", () => {
		const session = new SentinelSession();
		session.addToWhitelist("/Users/me/.pi/agent/skills/figma/SKILL.md");
		assert.equal(
			session.isWhitelisted("/Users/me/.pi/agent/skills/figma/SKILL.md"),
			true,
		);
		assert.equal(session.isWhitelisted("/other/path"), false);
	});

	test("reset does not clear whitelist", () => {
		const session = new SentinelSession();
		session.addToWhitelist("/persisted/path");
		session.reset();
		assert.equal(session.isWhitelisted("/persisted/path"), true);
	});

	test("read whitelist is separate from permission whitelist", () => {
		const session = new SentinelSession();
		session.addToReadWhitelist("/safe/example-doc.md");
		assert.equal(session.isReadWhitelisted("/safe/example-doc.md"), true);
		assert.equal(session.isWhitelisted("/safe/example-doc.md"), false);
	});
});
