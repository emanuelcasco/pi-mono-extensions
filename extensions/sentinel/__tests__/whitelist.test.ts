/**
 * Sentinel whitelist persistence tests.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { SentinelSession } from "../session.ts";

describe("SentinelSession whitelist", () => {
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
});
