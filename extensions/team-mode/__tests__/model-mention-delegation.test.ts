import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildModelMentionOrchestrationMessage } from "../index.ts";

const model = {
	label: "gpt-5.6-terra",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	thinkingLevel: "high" as const,
};

describe("@@ model mention delegation prompts", () => {
	test("routes review of the last message through the parent orchestrator", () => {
		const prompt = buildModelMentionOrchestrationMessage(
			"review the last message’s proposed fix. What do you think?",
			[model],
		);

		assert.match(prompt, /@@ selects the worker model only/);
		assert.match(prompt, /full parent conversation/);
		assert.match(prompt, /self-contained worker prompt/);
		assert.match(prompt, /include only what is needed to resolve references/);
		assert.doesNotMatch(prompt, /Review the current repository changes/);
		assert.doesNotMatch(prompt, /Inspect git status/);
	});

	test("leaves task interpretation to the parent orchestrator", () => {
		const prompt = buildModelMentionOrchestrationMessage("review current changes", [model]);

		assert.match(prompt, /review current changes/);
		assert.match(prompt, /user's actual intent/);
		assert.match(prompt, /state whether repository or tool access is needed/);
		assert.doesNotMatch(prompt, /Do not edit files/);
	});

	test("preserves selected model and thinking settings", () => {
		const prompt = buildModelMentionOrchestrationMessage(
			"what do you think about the proposal above?",
			[model],
		);

		assert.match(prompt, /openai-codex\/gpt-5\.6-terra/);
		assert.match(prompt, /thinking: high/);
		assert.match(prompt, /call agent once for each selected target/);
		assert.match(prompt, /Do not copy the routing @@model mention/);
		assert.match(prompt, /without delegating or spawning another agent/);
	});
});
