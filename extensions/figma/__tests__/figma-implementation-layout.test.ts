import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { getImplementationContext } from "../src/figma-summarizer.js";
import { buildCssLayoutHints, buildResponsiveHints } from "../src/figma-implementation.js";

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(join(import.meta.dirname, "fixtures", name), "utf8"));
}

test("buildCssLayoutHints maps auto-layout to CSS flex and grid hints", async () => {
	const node = await fixture("complex-auto-layout.json");
	const hints = buildCssLayoutHints(node);
	assert.deepEqual((hints.css as Record<string, unknown>).display, "flex");
	assert.equal((hints.css as Record<string, unknown>).flexDirection, "column");
	assert.equal((hints.css as Record<string, unknown>).gap, "16px");
	assert.equal((hints.css as Record<string, unknown>).padding, "20px 24px 20px 24px");
	assert.ok(Array.isArray((hints.css as Record<string, unknown>).layoutGrids));
});

test("buildResponsiveHints recommends fill, hug, fixed, and wrap behavior", async () => {
	const node = await fixture("complex-auto-layout.json");
	const hints = buildResponsiveHints(node);
	assert.ok(hints.some((hint) => String(hint.name) === "Header Row" && (hint.recommendations as string[]).some((rec) => rec.includes("width: 100%"))));
	assert.ok(hints.some((hint) => String(hint.name) === "Dashboard Card" && (hint.recommendations as string[]).some((rec) => rec.includes("Fixed width"))));
});

test("implementation context includes layout, responsive, accessibility, tokens, and snippets", async () => {
	const node = await fixture("variables-and-styles.json");
	const context = getImplementationContext(node, {
		framework: "react",
		styling: "styled-components",
		includeCodeSnippets: true,
		tokenMap: {
			styles: { "S:primary-fill": { name: "Color/Primary", type: "FILL" }, "S:text-button": { name: "Typography/Button", type: "TEXT" } },
			variables: { "VariableID:color-primary": { name: "color.primary" }, "VariableID:text-on-primary": { name: "color.onPrimary" }, "VariableID:radius-md": { name: "radius.md" } },
			collections: {},
			warnings: [],
		},
	});
	assert.ok(context.cssLayout);
	assert.ok(context.accessibility?.some((hint) => hint.role === "button"));
	assert.ok((context.designTokens?.resolved as Array<Record<string, unknown>>).some((token) => token.name === "Color/Primary"));
	assert.equal(context.frameworkHints?.framework, "react");
	assert.match(String(context.frameworkHints?.snippet), /styled\.section/);
});
