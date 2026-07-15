import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

import { createModelMentionAutocompleteProvider, formatModelMentionDelegationMessage } from "../index.ts";

function makeCurrentProvider(overrides: Partial<AutocompleteProvider> = {}): AutocompleteProvider {
	return {
		triggerCharacters: ["@"],
		async getSuggestions(): Promise<AutocompleteSuggestions | null> {
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const next = [...lines];
			const line = next[cursorLine] ?? "";
			const start = Math.max(0, cursorCol - prefix.length);
			next[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
			return { lines: next, cursorLine, cursorCol: start + item.value.length };
		},
		...overrides,
	};
}

describe("model mention autocomplete provider", () => {
	test("formats handled @@ delegation as a visible session message", () => {
		const message = formatModelMentionDelegationMessage("@@glm review AGENTS.md", [
			{ label: "glm-4.6" },
		]);

		assert.equal(message, "User delegated to glm-4.6:\n\n@@glm review AGENTS.md");
	});

	test("delegates slash-command completion to the wrapped provider", () => {
		let delegated = false;
		const current = makeCurrentProvider({
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				delegated = true;
				assert.equal(prefix, "/ta");
				assert.equal(item.value, "tasks");
				return {
					lines: ["/tasks "],
					cursorLine,
					cursorCol: "/tasks ".length,
				};
			},
		});
		const provider = createModelMentionAutocompleteProvider(current, () => undefined);

		const result = provider.applyCompletion(
			["/ta"],
			0,
			3,
			{ value: "tasks", label: "tasks" },
			"/ta",
		);

		assert.equal(delegated, true);
		assert.deepEqual(result.lines, ["/tasks "]);
		assert.equal(result.cursorCol, "/tasks ".length);
	});

	test("delegates single-at file completion to the wrapped provider", async () => {
		let suggestionsDelegated = false;
		let applyDelegated = false;
		const current = makeCurrentProvider({
			async getSuggestions(): Promise<AutocompleteSuggestions | null> {
				suggestionsDelegated = true;
				return {
					prefix: "@REA",
					items: [{ value: "@README.md", label: "README.md" }],
				};
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				applyDelegated = true;
				assert.equal(prefix, "@REA");
				return {
					lines: ["please read @README.md "],
					cursorLine,
					cursorCol: "please read @README.md ".length,
				};
			},
		});
		const provider = createModelMentionAutocompleteProvider(current, () => undefined);

		const suggestions = await provider.getSuggestions(["please read @REA"], 0, "please read @REA".length, {
			signal: new AbortController().signal,
		});
		assert.equal(suggestionsDelegated, true);
		assert.equal(suggestions?.prefix, "@REA");

		const result = provider.applyCompletion(
			["please read @REA"],
			0,
			"please read @REA".length,
			{ value: "@README.md", label: "README.md" },
			"@REA",
		);

		assert.equal(applyDelegated, true);
		assert.deepEqual(result.lines, ["please read @README.md "]);
	});

	test("preserves default forced completion behavior when wrapped provider has no trigger gate", () => {
		const provider = createModelMentionAutocompleteProvider(makeCurrentProvider(), () => undefined);

		assert.equal(provider.shouldTriggerFileCompletion?.(["please read @REA"], 0, "please read @REA".length), true);
	});

	test("falls back to filesystem suggestions for single-at when wrapped provider returns none", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-at-"));
		try {
			await mkdir(join(dir, "src"));
			await writeFile(join(dir, "README.md"), "hello");
			await writeFile(join(dir, "src", "app.ts"), "export {};\n");

			const provider = createModelMentionAutocompleteProvider(makeCurrentProvider(), () => ({ cwd: dir }) as any);
			const suggestions = await provider.getSuggestions(["please read @REA"], 0, "please read @REA".length, {
				signal: new AbortController().signal,
			});

			assert.equal(suggestions?.prefix, "@REA");
			assert.ok(suggestions?.items.some((item) => item.value === "@README.md"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("applies double-at model mention completion itself", () => {
		const current = makeCurrentProvider({
			applyCompletion(): never {
				throw new Error("expected @@ completions not to delegate");
			},
		});
		const provider = createModelMentionAutocompleteProvider(current, () => undefined);
		const item: AutocompleteItem = { value: "@@openai-codex/gpt-5.4", label: "openai-codex/gpt-5.4" };

		const result = provider.applyCompletion(
			["review @@open"],
			0,
			"review @@open".length,
			item,
			"@@open",
		);

		assert.deepEqual(result.lines, ["review @@openai-codex/gpt-5.4 "]);
		assert.equal(result.cursorCol, "review @@openai-codex/gpt-5.4 ".length);
	});
});
