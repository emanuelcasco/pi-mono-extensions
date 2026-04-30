import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { TeamMateStore } from "../core/store.ts";
import { AgentManager } from "../managers/agent-manager.ts";

async function withManager(fn: (manager: AgentManager, store: TeamMateStore) => Promise<void>) {
	const root = await mkdtemp(path.join(tmpdir(), "team-mode-test-"));
	try {
		const store = new TeamMateStore(root);
		const manager = new AgentManager({
			store,
			getParentSessionId: () => "parent",
			getDefaultCwd: () => process.cwd(),
			runTransientSession: async (opts) => ({
				teammateId: opts.id,
				name: opts.name,
				description: opts.description,
				status: "completed",
				result: `TRANSIENT:${opts.message}`,
				exitCode: 0,
				provider: opts.provider,
				model: opts.model,
				thinkingLevel: opts.thinkingLevel,
				modelRationale: opts.modelRationale,
				runtime: "transient",
			}),
		});
		await fn(manager, store);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("AgentManager transient runtime", () => {
	test("routes transient spawn without durable teammate record", async () => {
		await withManager(async (manager, store) => {
			const result = await manager.spawn({
				description: "quick scan",
				prompt: "Summarize files",
				runtime: "transient",
			});

			assert.equal(result.status, "completed");
			assert.equal(result.runtime, "transient");
			assert.match(result.result, /Task: quick scan/);
			assert.deepEqual(await store.listTeammates(), []);
			assert.deepEqual(await store.getNameIndex("parent"), {});
		});
	});

	test("rejects transient-incompatible options", async () => {
		await withManager(async (manager) => {
			await assert.rejects(
				() => manager.spawn({ description: "x", prompt: "p", runtime: "transient", isolation: "worktree" }),
				/does not support isolation "worktree"/,
			);
			await assert.rejects(
				() => manager.spawn({ description: "x", prompt: "p", runtime: "transient", background: true }),
				/does not support run_in_background/,
			);
			await assert.rejects(
				() => manager.spawn({ description: "x", prompt: "p", runtime: "transient", teamId: "team-1" }),
				/does not support team_name/,
			);
			await assert.rejects(
				() => manager.spawn({ description: "x", prompt: "p", runtime: "transient", name: "later" }),
				/does not support name/,
			);
		});
	});
});
