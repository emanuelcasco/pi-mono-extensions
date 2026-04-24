/**
 * Pi Team-Mode — Teammate Spec Loader Tests
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { listTeammateSpecs, loadTeammateSpec, parseSpec } from "../core/teammate-specs.ts";

describe("parseSpec", () => {
	test("parses frontmatter and body", () => {
		const raw = `---
name: researcher
description: investigates the codebase
needsWorktree: false
hasMemory: true
modelTier: sonnet:high
tools: read, bash, grep
---
You are a researcher.`;
		const spec = parseSpec(raw, "researcher", "/tmp/x.md");
		assert.equal(spec.name, "researcher");
		assert.equal(spec.description, "investigates the codebase");
		assert.equal(spec.needsWorktree, false);
		assert.equal(spec.hasMemory, true);
		assert.equal(spec.modelTier, "sonnet:high");
		assert.deepEqual(spec.tools, ["read", "bash", "grep"]);
		assert.equal(spec.systemPrompt, "You are a researcher.");
	});

	test("falls back to role name when frontmatter is missing", () => {
		const spec = parseSpec("You are a tester.", "tester", "/tmp/x.md");
		assert.equal(spec.name, "tester");
		assert.equal(spec.systemPrompt, "You are a tester.");
		assert.equal(spec.description, undefined);
		assert.equal(spec.tools, undefined);
	});

	test("handles single-quoted values", () => {
		const spec = parseSpec(
			`---\nname: 'quoted'\n---\nbody`,
			"fallback",
			"/tmp/x.md",
		);
		assert.equal(spec.name, "quoted");
	});
});

describe("loadTeammateSpec", () => {
	test("reads .pi/teammates/<role>.md first", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-specs-"));
		try {
			await mkdir(join(dir, ".pi", "teammates"), { recursive: true });
			await writeFile(
				join(dir, ".pi", "teammates", "researcher.md"),
				"---\nname: researcher\n---\nsystem",
				"utf8",
			);
			const spec = await loadTeammateSpec(dir, "researcher");
			assert.ok(spec);
			assert.equal(spec.name, "researcher");
			assert.equal(spec.systemPrompt, "system");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("falls back to .claude/teammates/<role>.md", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-specs-"));
		try {
			await mkdir(join(dir, ".claude", "teammates"), { recursive: true });
			await writeFile(join(dir, ".claude", "teammates", "tester.md"), "body", "utf8");
			const spec = await loadTeammateSpec(dir, "tester");
			assert.ok(spec);
			assert.equal(spec.systemPrompt, "body");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns null when no spec exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-specs-"));
		try {
			assert.equal(await loadTeammateSpec(dir, "missing"), null);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("listTeammateSpecs", () => {
	test("de-duplicates specs that exist in both locations", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-specs-"));
		try {
			await mkdir(join(dir, ".pi", "teammates"), { recursive: true });
			await mkdir(join(dir, ".claude", "teammates"), { recursive: true });
			await writeFile(join(dir, ".pi", "teammates", "a.md"), "body a pi", "utf8");
			await writeFile(join(dir, ".claude", "teammates", "a.md"), "body a claude", "utf8");
			await writeFile(join(dir, ".claude", "teammates", "b.md"), "body b", "utf8");
			const specs = await listTeammateSpecs(dir);
			const names = specs.map((s) => s.name).sort();
			assert.deepEqual(names, ["a", "b"]);
			const a = specs.find((s) => s.name === "a")!;
			assert.equal(a.systemPrompt, "body a pi", ".pi takes precedence over .claude");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
