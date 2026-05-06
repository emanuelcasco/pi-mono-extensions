import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildComponentImplementationHints } from "../src/figma-component-hints.js";
import { getImplementationContext, summarizeNode } from "../src/figma-summarizer.js";

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(join(import.meta.dirname, "fixtures", name), "utf8"));
}

test("buildComponentImplementationHints combines summary, variants, accessibility, tokens, and snippets", async () => {
	const node = await fixture("component-instance.json");
	const summary = summarizeNode(node, { depth: 3 });
	const context = getImplementationContext(node, { framework: "react", includeCodeSnippets: true });
	const hints = buildComponentImplementationHints(summary, context, { framework: "react", includeSnippet: true, includeCodeConnect: true }, { rootDir: "/repo", matches: [], metadata: { truncated: false, truncatedReasons: [], nextSteps: [] } });
	assert.equal(hints.componentName, "SettingsModal");
	assert.ok(hints.suggestedProps.some((prop) => prop.name === "children"));
	assert.ok(hints.statesAndVariants.some((variant) => variant.name === "State"));
	assert.ok(hints.accessibilityRequirements.some((hint) => hint.role === "dialog" || hint.role === "button"));
	assert.match(String(hints.frameworkHints?.snippet), /export function SettingsModal/);
	assert.ok(hints.metadata.nextSteps.some((step) => step.includes("Code Connect")));
});
