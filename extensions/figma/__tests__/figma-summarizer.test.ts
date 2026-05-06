import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { extractVisibleText, getImplementationContext, summarizeNode } from "../src/figma-summarizer.js";

async function fixture(name: string): Promise<unknown> {
	const path = join(import.meta.dirname, "fixtures", name);
	return JSON.parse(await readFile(path, "utf8"));
}

test("summarizeNode excludes hidden nodes and vector internals by default", async () => {
	const node = await fixture("hidden-and-vectors.json");
	const summary = summarizeNode(node, { depth: 3 });
	assert.deepEqual(summary.visibleText, ["Visible copy"]);
	assert.equal(summary.children?.some((child) => child.name === "Hidden text"), false);
	assert.equal(summary.children?.some((child) => child.name === "Search icon"), false);
});

test("summarizeNode can include hidden nodes and vectors when requested", async () => {
	const node = await fixture("hidden-and-vectors.json");
	const summary = summarizeNode(node, { depth: 3, includeHidden: true, includeVectors: true });
	assert.deepEqual(summary.visibleText, ["Visible copy", "Hidden copy"]);
	assert.ok(summary.children?.some((child) => child.name === "Hidden text"));
	assert.ok(summary.children?.some((child) => child.name === "Search icon"));
});

test("component instances collapse structural internals while retaining useful text", async () => {
	const node = await fixture("component-instance.json");
	const summary = summarizeNode(node, { depth: 2 });
	const instance = summary.children?.find((child) => child.type === "INSTANCE");
	assert.equal(instance?.children, undefined);
	assert.deepEqual(instance?.text, ["Continue"]);
	assert.ok(summary.metadata?.truncatedReasons.some((reason) => reason.includes("Collapsed component instance")));
});

test("extractVisibleText returns capped text metadata", async () => {
	const node = await fixture("complex-auto-layout.json");
	const result = extractVisibleText(node, { maxVisibleText: 1 });
	assert.deepEqual(result.texts, ["Water risk summary"]);
	assert.equal(result.metadata.truncated, true);
	assert.ok(result.metadata.nextSteps.includes("Use figma_extract_text on a narrower child node to see more text."));
});

test("getImplementationContext deterministically extracts typography colors spacing and controls", async () => {
	const node = await fixture("complex-auto-layout.json");
	const context = getImplementationContext(node, { depth: 3 });
	assert.match(context.purpose, /Water risk summary/);
	assert.equal(context.sections.length, 2);
	assert.ok(context.buttons.some((button) => button.name === "Save button"));
	assert.ok(context.typography.some((entry) => entry.fontFamily === "Inter" && entry.fontSize === 18));
	assert.ok(context.colors.some((entry) => entry.hex === "#ffffff"));
	assert.ok(context.spacing.some((entry) => entry.itemSpacing === 16));
});

test("depth and children caps produce truncation metadata", async () => {
	const node = await fixture("complex-auto-layout.json");
	const depthLimited = summarizeNode(node, { depth: 1 });
	assert.equal(depthLimited.metadata?.truncated, true);
	assert.ok(depthLimited.metadata?.nextSteps.some((step) => step.includes("depth 2")));

	const childLimited = summarizeNode(node, { depth: 2, maxChildren: 1 });
	assert.equal(childLimited.children?.length, 1);
	assert.ok(childLimited.metadata?.truncatedReasons.some((reason) => reason.includes("Capped children")));
});
