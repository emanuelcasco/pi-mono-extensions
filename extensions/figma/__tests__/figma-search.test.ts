import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { findNodesByName, findNodesByText } from "../src/figma-search.js";

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(join(import.meta.dirname, "fixtures", name), "utf8"));
}

test("findNodesByName supports partial, exact, and case-sensitive matching", async () => {
	const node = await fixture("complex-auto-layout.json");
	assert.deepEqual(findNodesByName(node, { query: "button" }).matches.map((match) => match.name), ["Save button", "Button label"]);
	assert.equal(findNodesByName(node, { query: "save button", exact: true }).matches.length, 1);
	assert.equal(findNodesByName(node, { query: "save button", exact: true, caseSensitive: true }).matches.length, 0);
});

test("findNodesByText returns path and parent context", async () => {
	const node = await fixture("complex-auto-layout.json");
	const result = findNodesByText(node, { query: "Water risk" });
	assert.equal(result.matches[0]?.text, "Water risk summary");
	assert.equal(result.matches[0]?.parent?.name, "Header Row");
	assert.match(result.matches[0]?.path ?? "", /Dashboard Card > Header Row > Title/);
});

test("findNodesByName respects hidden and vector filters", async () => {
	const node = await fixture("hidden-and-vectors.json");
	assert.equal(findNodesByName(node, { query: "Hidden" }).matches.length, 0);
	assert.equal(findNodesByName(node, { query: "Hidden", includeHidden: true }).matches.length, 1);
	assert.equal(findNodesByName(node, { query: "icon" }).matches.length, 0);
	assert.equal(findNodesByName(node, { query: "icon", includeVectors: true }).matches.length, 1);
});

test("findNodesByText searches collapsed instance text but not vector internals", async () => {
	const node = await fixture("component-instance.json");
	const result = findNodesByText(node, { query: "Continue" });
	assert.equal(result.matches.length, 1);
	assert.equal(result.matches[0]?.parent?.name, "Primary CTA instance");
	assert.ok(result.metadata.nextSteps.some((step) => step.includes("includeComponentInternals")));
});

test("findNodesByName enforces depth and result caps", async () => {
	const node = await fixture("complex-auto-layout.json");
	const depthLimited = findNodesByName(node, { query: "Title", depth: 1 });
	assert.equal(depthLimited.matches.length, 0);
	assert.ok(depthLimited.metadata.truncatedReasons.some((reason) => reason.includes("depth limit")));

	const capped = findNodesByName(node, { query: "", maxResults: 1 });
	assert.equal(capped.matches.length, 1);
	assert.ok(capped.metadata.truncatedReasons.some((reason) => reason.includes("maxResults")));
});
