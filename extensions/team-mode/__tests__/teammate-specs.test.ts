/**
 * Tests for the teammate-spec loader and frontmatter parser.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	BUILT_IN_TEAMMATE_SPECS,
	genericSpec,
	loadTeammateSpecs,
	parseTeammateSpecFile,
	resolveTeammateSpec,
} from "../core/teammate-specs.ts";

describe("parseTeammateSpecFile", () => {
	test("returns null when frontmatter is missing", () => {
		assert.equal(parseTeammateSpecFile("no frontmatter here"), null);
	});

	test("returns null when name is missing", () => {
		const raw = ["---", "description: foo", "---", "", "body"].join("\n");
		assert.equal(parseTeammateSpecFile(raw), null);
	});

	test("returns null when body is empty", () => {
		const raw = ["---", "name: backend", "---", "", ""].join("\n");
		assert.equal(parseTeammateSpecFile(raw), null);
	});

	test("parses a full spec", () => {
		const raw = [
			"---",
			"name: security",
			"description: Audits changes for security concerns",
			"needsWorktree: false",
			"hasMemory: true",
			"modelTier: deep",
			"---",
			"",
			"You are a security auditor. Flag anything risky.",
		].join("\n");

		const spec = parseTeammateSpecFile(raw);
		assert.ok(spec);
		assert.equal(spec!.name, "security");
		assert.equal(spec!.description, "Audits changes for security concerns");
		assert.equal(spec!.needsWorktree, false);
		assert.equal(spec!.hasMemory, true);
		assert.equal(spec!.modelTier, "deep");
		assert.match(spec!.systemPrompt, /security auditor/);
	});

	test("flag defaults are false", () => {
		const raw = ["---", "name: minimal", "---", "", "do stuff"].join("\n");
		const spec = parseTeammateSpecFile(raw);
		assert.ok(spec);
		assert.equal(spec!.needsWorktree, false);
		assert.equal(spec!.hasMemory, false);
		assert.equal(spec!.modelTier, undefined);
	});

	test("ignores unrecognised modelTier values", () => {
		const raw = [
			"---",
			"name: odd",
			"modelTier: ultra",
			"---",
			"",
			"x",
		].join("\n");
		const spec = parseTeammateSpecFile(raw);
		assert.equal(spec!.modelTier, undefined);
	});
});

describe("resolveTeammateSpec", () => {
	test("discovered specs take precedence over built-ins", () => {
		const override = {
			name: "backend",
			systemPrompt: "custom",
			needsWorktree: false,
			hasMemory: false,
		};
		const spec = resolveTeammateSpec("backend", { backend: override });
		assert.equal(spec.systemPrompt, "custom");
	});

	test("falls back to built-in spec", () => {
		const spec = resolveTeammateSpec("backend");
		assert.equal(spec.name, "backend");
		assert.equal(spec.needsWorktree, BUILT_IN_TEAMMATE_SPECS.backend.needsWorktree);
	});

	test("returns generic spec for unknown role", () => {
		const spec = resolveTeammateSpec("custom-role");
		assert.deepEqual(spec, genericSpec("custom-role"));
	});
});

describe("loadTeammateSpecs", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("returns empty object when directory is missing", async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-teams-spec-"));
		const specs = await loadTeammateSpecs(dir);
		assert.deepEqual(specs, {});
	});

	test("loads valid specs from .claude/teammates/*.md", async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-teams-spec-"));
		const specsDir = join(dir, ".claude", "teammates");
		await mkdir(specsDir, { recursive: true });
		await writeFile(
			join(specsDir, "security.md"),
			[
				"---",
				"name: security",
				"needsWorktree: true",
				"---",
				"",
				"Audit changes for security issues.",
			].join("\n"),
		);
		await writeFile(join(specsDir, "ignore-me.txt"), "not a spec");
		await writeFile(
			join(specsDir, "broken.md"),
			"no frontmatter at all — should be skipped silently",
		);

		const specs = await loadTeammateSpecs(dir);
		assert.equal(Object.keys(specs).length, 1);
		assert.ok(specs.security);
		assert.equal(specs.security.needsWorktree, true);
		assert.equal(specs.security.sourcePath, join(specsDir, "security.md"));
	});
});
