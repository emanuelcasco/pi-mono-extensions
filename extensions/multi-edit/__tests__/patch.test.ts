/**
 * parsePatch + applyPatchOperations — contract tests.
 *
 * Pins the Codex apply_patch behavior before Phase C1 rewrites the parser.
 * Anything tested here is part of the "parity required" surface; edge cases
 * left untested (EOF sentinel, 4-pass fuzzy match) may change in C1.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyPatchOperations, parsePatch } from "../patch.ts";
import { createRealWorkspace } from "../workspace.ts";

const stubPi: ExtensionAPI = {
	events: { emit: () => {} },
} as unknown as ExtensionAPI;

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "multi-edit-patch-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("parsePatch — structural errors", () => {
	test("rejects patch missing '*** Begin Patch'", () => {
		assert.throws(() => parsePatch("not a patch\n*** End Patch"), /first line of the patch must be/);
	});

	test("rejects patch missing '*** End Patch'", () => {
		assert.throws(() => parsePatch("*** Begin Patch\nno end"), /last line of the patch must be/);
	});

	test("rejects empty patch", () => {
		assert.throws(() => parsePatch(""), /empty or invalid/);
	});

	test("rejects invalid hunk header", () => {
		const patch = "*** Begin Patch\n*** Frobnicate: a.txt\n*** End Patch";
		assert.throws(() => parsePatch(patch), /not a valid hunk header/);
	});
});

describe("parsePatch — Add File", () => {
	test("parses a single add-file op", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: new.txt",
			"+line one",
			"+line two",
			"*** End Patch",
		].join("\n");
		const ops = parsePatch(patch);
		assert.equal(ops.length, 1);
		assert.equal(ops[0].kind, "add");
		if (ops[0].kind === "add") {
			assert.equal(ops[0].path, "new.txt");
			assert.equal(ops[0].contents, "line one\nline two\n");
		}
	});
});

describe("parsePatch — Delete File", () => {
	test("parses a single delete-file op", () => {
		const patch = "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch";
		const ops = parsePatch(patch);
		assert.equal(ops.length, 1);
		assert.equal(ops[0].kind, "delete");
		if (ops[0].kind === "delete") {
			assert.equal(ops[0].path, "old.txt");
		}
	});
});

describe("parsePatch — Update File", () => {
	test("parses an update with a single context-anchored hunk", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src.txt",
			"@@",
			" unchanged",
			"-old line",
			"+new line",
			"*** End Patch",
		].join("\n");
		const ops = parsePatch(patch);
		assert.equal(ops.length, 1);
		assert.equal(ops[0].kind, "update");
		if (ops[0].kind === "update") {
			assert.equal(ops[0].hunks.length, 1);
			assert.equal(ops[0].hunks[0].oldBlock, "unchanged\nold line");
			assert.equal(ops[0].hunks[0].newBlock, "unchanged\nnew line");
		}
	});

	test("rejects move operations", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src.txt",
			"*** Move to: dst.txt",
			"*** End Patch",
		].join("\n");
		assert.throws(() => parsePatch(patch), /Move to.*not supported/);
	});
});

describe("applyPatchOperations — Add File round-trip", () => {
	test("creates the file with the given contents", async () => {
		await withTmp(async (dir) => {
			const patch = [
				"*** Begin Patch",
				"*** Add File: greet.txt",
				"+hello",
				"+world",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await readFile(join(dir, "greet.txt"), "utf-8"), "hello\nworld\n");
		});
	});
});

describe("applyPatchOperations — Delete File round-trip", () => {
	test("removes the target file", async () => {
		await withTmp(async (dir) => {
			const victim = join(dir, "gone.txt");
			await writeFile(victim, "bye\n");

			const patch = "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch";
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await exists(victim), false);
		});
	});

	test("rejects deletion of a non-existent file", async () => {
		await withTmp(async (dir) => {
			const patch = "*** Begin Patch\n*** Delete File: ghost.txt\n*** End Patch";
			const ops = parsePatch(patch);
			await assert.rejects(
				() => applyPatchOperations(ops, createRealWorkspace(stubPi), dir),
				/does not exist/,
			);
		});
	});
});

describe("applyPatchOperations — Update File round-trip", () => {
	test("applies a single-hunk replacement", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "src.txt");
			await writeFile(file, "keep\nold\ntail\n");

			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				" keep",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await readFile(file, "utf-8"), "keep\nnew\ntail\n");
		});
	});

	test("applies two non-overlapping hunks", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "src.txt");
			await writeFile(file, "a\nb\nc\nd\ne\nf\ng\n");

			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				" a",
				"-b",
				"+B",
				"@@",
				" e",
				"-f",
				"+F",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await readFile(file, "utf-8"), "a\nB\nc\nd\ne\nF\ng\n");
		});
	});
});

describe("applyPatchOperations — multi-op", () => {
	test("applies add + update + delete in one batch", async () => {
		await withTmp(async (dir) => {
			const keep = join(dir, "keep.txt");
			const gone = join(dir, "gone.txt");
			await writeFile(keep, "foo\nbar\n");
			await writeFile(gone, "delete me\n");

			const patch = [
				"*** Begin Patch",
				"*** Add File: new.txt",
				"+created",
				"*** Update File: keep.txt",
				"@@",
				" foo",
				"-bar",
				"+BAR",
				"*** Delete File: gone.txt",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);

			assert.equal(await readFile(join(dir, "new.txt"), "utf-8"), "created\n");
			assert.equal(await readFile(keep, "utf-8"), "foo\nBAR\n");
			assert.equal(await exists(gone), false);
		});
	});
});

describe("applyPatchOperations — trimEnd hunk matching", () => {
	test("matches hunk when file has trailing spaces on context/old lines", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "ws.ts");
			// File has trailing spaces on some lines.
			await writeFile(file, "keep  \nold  \ntail\n");

			// Patch references the lines without trailing spaces (model generated clean).
			const patch = [
				"*** Begin Patch",
				"*** Update File: ws.ts",
				"@@",
				" keep",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			// The matched block (including context line "keep  ") is replaced by
			// newBlock ("keep\nnew") — trailing spaces on the context line are
			// cleaned as a side effect of the replacement.
			assert.equal(await readFile(file, "utf-8"), "keep\nnew\ntail\n");
		});
	});

	test("matches context prefix with trailing whitespace difference", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "ctx.ts");
			await writeFile(file, "function foo() {  \n  return 1;\n}\n");

			// Context line doesn't have the trailing spaces the file has.
			const patch = [
				"*** Begin Patch",
				"*** Update File: ctx.ts",
				"@@ function foo() {",
				"-  return 1;",
				"+  return 2;",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await readFile(file, "utf-8"), "function foo() {  \n  return 2;\n}\n");
		});
	});
});
