import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DelegationManager } from "../managers/delegation-manager.ts";

type SpawnCall = {
	description: string;
	prompt: string;
	name?: string;
	thinkingLevel?: string;
};

function makeFakeAgents() {
	const calls: SpawnCall[] = [];
	let queued = 0;
	let idx = 0;
	return {
		calls,
		get queued() {
			return queued;
		},
		setQueuedCount(value: number) {
			queued = value;
		},
		async spawn(opts: SpawnCall & Record<string, unknown>) {
			calls.push(opts);
			idx += 1;
			return {
				teammateId: `agent-${idx}`,
				name: opts.name ?? `agent-${idx}`,
				description: opts.description,
				status: "completed" as const,
				result: `RESULT:${opts.prompt}`,
				exitCode: 0,
			};
		},
	};
}

describe("DelegationManager", () => {
	test("runParallel expands count and aggregates", async () => {
		const fake = makeFakeAgents();
		const manager = new DelegationManager(fake as never);
		const result = await manager.runParallel({
			tasks: [{ description: "scan", prompt: "P", name: "worker", count: 2, thinkingLevel: "low" }],
			concurrency: 2,
		});
		assert.equal(result.mode, "parallel");
		assert.equal(result.steps, 2);
		assert.equal(fake.calls.length, 2);
		assert.equal(fake.calls[0]?.name, "worker-1");
		assert.equal(fake.calls[1]?.name, "worker-2");
		assert.equal(fake.calls[0]?.thinkingLevel, "low");
		assert.match(result.output, /Parallel Task 1/);
	});

	test("runChain applies templates and chain_dir files", async () => {
		const fake = makeFakeAgents();
		const manager = new DelegationManager(fake as never);
		const result = await manager.runChain({
			task: "TOP",
			chain: [
				{
					description: "one",
					prompt: "Task={task}",
					output: "step1.txt",
				},
				{
					description: "two",
					reads: ["step1.txt"],
					prompt: "Prev={previous}",
				},
			],
		});
		assert.equal(result.mode, "chain");
		assert.ok(result.chainDir);
		assert.equal(fake.calls.length, 2);
		assert.match(fake.calls[0]?.prompt ?? "", /Task=TOP/);
		assert.match(fake.calls[1]?.prompt ?? "", /--- step1\.txt ---/);
		assert.match(fake.calls[1]?.prompt ?? "", /RESULT:Task=TOP/);
	});
});
