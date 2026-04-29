import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { aggregateParallelOutputs, mapConcurrent } from "../core/parallel-utils.ts";

describe("mapConcurrent", () => {
	test("keeps result order while limiting concurrency", async () => {
		let running = 0;
		let maxRunning = 0;
		const out = await mapConcurrent([30, 10, 20], 2, async (ms, idx) => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((resolve) => setTimeout(resolve, ms));
			running -= 1;
			return `#${idx}`;
		});
		assert.deepEqual(out, ["#0", "#1", "#2"]);
		assert.ok(maxRunning <= 2);
	});
});

describe("aggregateParallelOutputs", () => {
	test("renders per-task sections", () => {
		const text = aggregateParallelOutputs([
			{ name: "one", output: "A", exitCode: 0 },
			{ name: "two", output: "B", exitCode: 1, error: "boom" },
		]);
		assert.match(text, /Parallel Task 1 \(one\)/);
		assert.match(text, /Parallel Task 2 \(two\)/);
		assert.match(text, /error: boom/);
	});
});
