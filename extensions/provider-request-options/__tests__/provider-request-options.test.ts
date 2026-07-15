import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
	deepMerge,
	isPlainObject,
	ProviderRequestOptionsLoader,
} from "../config.ts";

describe("deepMerge", () => {
	test("recursively merges nested objects and preserves unrelated fields", () => {
		assert.deepEqual(
			deepMerge(
				{
					model: "gpt",
					text: { format: { type: "text" }, verbosity: "medium" },
					reasoning: { effort: "high" },
				},
				{ text: { verbosity: "low" } },
			),
			{
				model: "gpt",
				text: { format: { type: "text" }, verbosity: "low" },
				reasoning: { effort: "high" },
			},
		);
	});

	test("replaces scalars, booleans, arrays, and values with null", () => {
		assert.deepEqual(
			deepMerge(
				{ count: 1, enabled: true, include: ["old"], service_tier: "auto" },
				{ count: 2, enabled: false, include: ["new", "other"], service_tier: null },
			),
			{ count: 2, enabled: false, include: ["new", "other"], service_tier: null },
		);
	});

	test("keeps nested values when merging an empty object", () => {
		assert.deepEqual(deepMerge({ text: { verbosity: "medium" } }, { text: {} }), {
			text: { verbosity: "medium" },
		});
	});

	test("creates an object when the original payload is not an object", () => {
		assert.deepEqual(deepMerge("payload", { text: { verbosity: "low" } }), {
			text: { verbosity: "low" },
		});
	});

	test("recognizes only non-null, non-array objects", () => {
		assert.equal(isPlainObject({}), true);
		assert.equal(isPlainObject(null), false);
		assert.equal(isPlainObject([]), false);
		assert.equal(isPlainObject("value"), false);
	});
});

describe("ProviderRequestOptionsLoader", () => {
	let dir: string;
	let settingsPath: string;
	let notifications: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "provider-request-options-"));
		settingsPath = join(dir, "settings.json");
		notifications = [];
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function loader(): ProviderRequestOptionsLoader {
		return new ProviderRequestOptionsLoader(settingsPath, (message) => notifications.push(message));
	}

	test("selects the exact active provider and ignores unconfigured providers", () => {
		writeFileSync(settingsPath, JSON.stringify({
			providerRequestOptions: {
				"openai-codex": { text: { verbosity: "low" } },
				OpenAI: { temperature: 0 },
			},
		}));
		const settings = loader();

		assert.deepEqual(settings.getOptions("openai-codex"), { text: { verbosity: "low" } });
		assert.equal(settings.getOptions("openai"), undefined);
	});

	test("reads configuration changes on the next request", () => {
		const settings = loader();
		writeFileSync(settingsPath, JSON.stringify({ providerRequestOptions: { openai: { temperature: 0 } } }));
		assert.deepEqual(settings.getOptions("openai"), { temperature: 0 });

		writeFileSync(settingsPath, JSON.stringify({ providerRequestOptions: { openai: { temperature: 1 } } }));
		assert.deepEqual(settings.getOptions("openai"), { temperature: 1 });
	});

	test("missing files, empty entries, and non-object provider entries are no-ops", () => {
		const settings = loader();
		assert.equal(settings.getOptions("openai"), undefined);

		writeFileSync(settingsPath, JSON.stringify({
			providerRequestOptions: { openai: "low", anthropic: { metadata: {} } },
		}));
		assert.equal(settings.getOptions("openai"), undefined);
		assert.deepEqual(settings.getOptions("anthropic"), { metadata: {} });
		assert.deepEqual(notifications, []);
	});

	test("invalid JSON is a no-op and notifies once until content changes", () => {
		const settings = loader();
		writeFileSync(settingsPath, "{");
		assert.equal(settings.getOptions("openai"), undefined);
		assert.equal(settings.getOptions("openai"), undefined);
		assert.equal(notifications.length, 1);

		writeFileSync(settingsPath, "{ invalid");
		assert.equal(settings.getOptions("openai"), undefined);
		assert.equal(notifications.length, 2);
	});

	test("invalid providerRequestOptions is ignored and notifies once per content", () => {
		const settings = loader();
		writeFileSync(settingsPath, JSON.stringify({ providerRequestOptions: [] }));
		assert.equal(settings.getOptions("openai"), undefined);
		assert.equal(settings.getOptions("openai"), undefined);
		assert.equal(notifications.length, 1);
	});

	test("does not generate reasoning fields", () => {
		writeFileSync(settingsPath, JSON.stringify({
			providerRequestOptions: { openai: { text: { verbosity: "low" } } },
		}));
		const options = loader().getOptions("openai");
		assert.deepEqual(deepMerge({ reasoning: { effort: "high" } }, options!), {
			reasoning: { effort: "high" },
			text: { verbosity: "low" },
		});
	});
});
