/**
 * Pi Sentinel — read-targets tests.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	expandPaths,
	extractReadTargets,
} from "../patterns/read-targets.ts";

describe("extractReadTargets", () => {
	test("detects cat, head, tail, less, more", () => {
		assert.deepEqual(extractReadTargets("cat .env"), [".env"]);
		assert.deepEqual(extractReadTargets("head -n 5 .env.local"), [
			"5",
			".env.local",
		]);
		assert.deepEqual(extractReadTargets("tail -f logs/app.log"), [
			"logs/app.log",
		]);
		assert.deepEqual(extractReadTargets("less README.md"), ["README.md"]);
		assert.deepEqual(extractReadTargets("more config.json"), ["config.json"]);
	});

	test("skips flags for direct commands", () => {
		assert.deepEqual(extractReadTargets("cat -n .env"), [".env"]);
		assert.deepEqual(extractReadTargets("head --lines=10 .env"), [".env"]);
	});

	test("detects grep and rg", () => {
		assert.deepEqual(extractReadTargets('grep -ri "linear" .env*'), [
			".env*",
		]);
		assert.deepEqual(
			extractReadTargets("rg --hidden api_key src/"),
			["api_key", "src/"],
		);
		assert.deepEqual(
			extractReadTargets("grep pattern file1 file2"),
			["pattern", "file1", "file2"],
		);
	});

	test("skips quoted patterns in grep/rg", () => {
		assert.deepEqual(
			extractReadTargets('grep -i "secret" .env .env.local'),
			[".env", ".env.local"],
		);
		assert.deepEqual(
			extractReadTargets("grep -E 'password|token' .env"),
			[".env"],
		);
	});

	test("stops at shell operators for grep/rg", () => {
		assert.deepEqual(
			extractReadTargets('grep x .env | head -5'),
			["x", ".env"],
		);
		assert.deepEqual(
			extractReadTargets("grep x .env && cat .env"),
			["x", ".env"],
		);
	});

	test("detects awk and sed", () => {
		assert.deepEqual(
			extractReadTargets("awk '{print $1}' .env"),
			[".env"],
		);
		assert.deepEqual(
			extractReadTargets("sed 's/foo/bar/g' .env"),
			[".env"],
		);
	});

	test("detects jq and yq", () => {
		assert.deepEqual(
			extractReadTargets("jq '.api_key' config.json"),
			["config.json"],
		);
		assert.deepEqual(
			extractReadTargets("yq '.secrets' config.yaml"),
			["config.yaml"],
		);
	});

	test("does not flag unrelated commands", () => {
		assert.deepEqual(extractReadTargets("npm run dev"), []);
		assert.deepEqual(extractReadTargets("echo hello"), []);
		assert.deepEqual(extractReadTargets("ls -la"), []);
	});
});

describe("expandPaths", () => {
	test("returns single path when no wildcards", async () => {
		const result = await expandPaths("/tmp", ".env");
		assert.deepEqual(result, ["/tmp/.env"]);
	});

	test("expands simple globs", async () => {
		const result = await expandPaths("/tmp", ".env*");
		// /tmp may or may not have .env files; just verify it returns paths
		assert.ok(Array.isArray(result));
		assert.ok(result.length > 0);
	});
});
