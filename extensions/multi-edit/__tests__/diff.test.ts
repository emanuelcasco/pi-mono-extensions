/**
 * generateDiffString — contract tests.
 *
 * Locks the rendered diff format before Phase C rewrites the renderer.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { generateDiffString } from "../diff.ts";

describe("generateDiffString", () => {
	test("returns empty output and undefined firstChangedLine when content is identical", () => {
		const { diff, firstChangedLine } = generateDiffString("a\nb\nc\n", "a\nb\nc\n");
		assert.equal(diff, "");
		assert.equal(firstChangedLine, undefined);
	});

	test("single-line replacement emits + and - markers with line numbers", () => {
		const before = "line1\nline2\nline3\n";
		const after = "line1\nCHANGED\nline3\n";
		const { diff, firstChangedLine } = generateDiffString(before, after);
		assert.match(diff, /-2 line2/);
		assert.match(diff, /\+2 CHANGED/);
		assert.equal(firstChangedLine, 2);
	});

	test("shows leading context before a change", () => {
		const before = "a\nb\nc\nd\nTARGET\n";
		const after = "a\nb\nc\nd\nREPLACED\n";
		const { diff } = generateDiffString(before, after, 4);
		for (const ctx of ["a", "b", "c", "d"]) {
			assert.ok(diff.includes(` ${ctx}`) || diff.match(new RegExp(`\\s\\d+ ${ctx}`)), `missing context '${ctx}' in:\n${diff}`);
		}
	});

	test("firstChangedLine is 1-indexed against the new content", () => {
		const before = "one\ntwo\nthree\nfour\n";
		const after = "one\ntwo\nthree\nFOUR\n";
		const { firstChangedLine } = generateDiffString(before, after);
		assert.equal(firstChangedLine, 4);
	});

	test("pads line numbers to the width of the largest line number", () => {
		const before = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
		const after = before.replace("line6", "CHANGED");
		const { diff } = generateDiffString(before, after);
		// 12 lines → 2-char wide line numbers
		assert.match(diff, /- 6 line6/);
		assert.match(diff, /\+ 6 CHANGED/);
	});

	test("collapses large unchanged runs between two changes with '...' marker", () => {
		const lines: string[] = [];
		for (let i = 1; i <= 40; i++) lines.push(`line${i}`);
		const before = lines.join("\n") + "\n";
		const after = before.replace("line1\n", "FIRST\n").replace("line40", "LAST");
		const { diff } = generateDiffString(before, after, 4);
		assert.ok(diff.includes("..."), `expected collapsed marker in:\n${diff}`);
		assert.match(diff, /-\s?1 line1/);
		assert.match(diff, /\+\s?1 FIRST/);
		assert.match(diff, /-40 line40/);
		assert.match(diff, /\+40 LAST/);
	});

	test("handles addition-only (empty → content)", () => {
		const { diff, firstChangedLine } = generateDiffString("", "new line\n");
		assert.match(diff, /\+1 new line/);
		assert.equal(firstChangedLine, 1);
	});

	test("handles deletion-only (content → empty)", () => {
		const { diff, firstChangedLine } = generateDiffString("gone\n", "");
		assert.match(diff, /-1 gone/);
		assert.equal(firstChangedLine, 1);
	});
});
