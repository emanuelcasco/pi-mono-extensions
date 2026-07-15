import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Value } from "@sinclair/typebox/value";

import { multiEditSchema } from "../index.ts";

describe("multiEditSchema", () => {
	test("accepts patch mode without classic parameters", () => {
		assert.equal(
			Value.Check(multiEditSchema, {
				patch: "*** Begin Patch\n*** End Patch",
			}),
			true,
		);
	});

	test("accepts classic and multi-edit modes without patch", () => {
		assert.equal(
			Value.Check(multiEditSchema, {
				path: "src/index.ts",
				oldText: "before",
				newText: "after",
			}),
			true,
		);
		assert.equal(
			Value.Check(multiEditSchema, {
				path: "src/index.ts",
				multi: [{ oldText: "before", newText: "after" }],
			}),
			true,
		);
	});

	test("rejects patch combined with a top-level path", () => {
		assert.equal(
			Value.Check(multiEditSchema, {
				path: ".agents/skills/prepare-release-pr/SKILL.md",
				patch: [
					"*** Begin Patch",
					"*** Update File: .agents/skills/prepare-release-pr/SKILL.md",
					"*** End Patch",
				].join("\n"),
			}),
			false,
		);
	});

	test("rejects patch combined with any classic mode parameter", () => {
		for (const classicParameter of [
			{ oldText: "before" },
			{ newText: "after" },
			{ multi: [] },
		]) {
			assert.equal(
				Value.Check(multiEditSchema, {
					patch: "*** Begin Patch\n*** End Patch",
					...classicParameter,
				}),
				false,
			);
		}
	});
});
