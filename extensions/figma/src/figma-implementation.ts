import type { FigmaNodeSummary } from "./figma-summarizer.js";
import type { FigmaTokenMap } from "./figma-tokens.js";

export type FigmaFramework = "react" | "html" | "vue" | "angular" | "react-native";
export type FigmaStyling = "css" | "css-modules" | "styled-components" | "tailwind" | "inline";

export interface FigmaImplementationOptions {
	framework?: FigmaFramework;
	styling?: FigmaStyling;
	resolveTokens?: boolean;
	includeCodeSnippets?: boolean;
	tokenMap?: FigmaTokenMap;
}

export function buildCssLayoutHints(node: unknown): Record<string, unknown> {
	const record = asRecord(node);
	const mode = stringValue(record.layoutMode);
	const css: Record<string, unknown> = {};
	const notes: string[] = [];
	if (mode === "HORIZONTAL" || mode === "VERTICAL") {
		css.display = "flex";
		css.flexDirection = mode === "HORIZONTAL" ? "row" : "column";
		if (numberValue(record.itemSpacing) !== undefined) css.gap = px(numberValue(record.itemSpacing));
		const padding = paddingValue(record);
		if (padding) css.padding = padding;
		const justify = mapPrimary(record.primaryAxisAlignItems);
		const align = mapCounter(record.counterAxisAlignItems);
		if (justify) css.justifyContent = justify;
		if (align) css.alignItems = align;
		if (record.layoutWrap === "WRAP") css.flexWrap = "wrap";
	} else {
		css.position = "relative";
		notes.push("No auto-layout mode detected; absolute positioning may be needed for overlapping/freeform children.");
	}
	const grids = compactLayoutGrids(record.layoutGrids);
	if (grids.length) {
		css.layoutGrids = grids;
		notes.push("Figma layout grids can map to CSS grid columns or container guides.");
	}
	const sizing = compactObject({
		horizontal: record.layoutSizingHorizontal,
		vertical: record.layoutSizingVertical,
		width: numberValue(asRecord(record.absoluteBoundingBox).width),
		height: numberValue(asRecord(record.absoluteBoundingBox).height),
	});
	return compactObject({ nodeId: record.id, nodeName: record.name, figma: compactObject({ layoutMode: mode, layoutWrap: record.layoutWrap }), css, sizing, notes }) ?? {};
}

export function buildResponsiveHints(node: unknown): Array<Record<string, unknown>> {
	const hints: Array<Record<string, unknown>> = [];
	walk(node, (record, path) => {
		const recommendations: string[] = [];
		const constraints = asRecord(record.constraints);
		if (constraints.horizontal === "SCALE" || constraints.horizontal === "LEFT_RIGHT") recommendations.push("Use width: 100% or stretch within the parent container.");
		if (constraints.vertical === "SCALE" || constraints.vertical === "TOP_BOTTOM") recommendations.push("Let height stretch or derive it from content plus min-height.");
		if (record.layoutGrow === 1) recommendations.push("Use flex: 1 for fill-container sizing.");
		if (record.layoutAlign === "STRETCH" || record.layoutSizingHorizontal === "FILL") recommendations.push("Use align-self: stretch or width: 100%.");
		if (record.layoutSizingHorizontal === "HUG" || record.layoutSizingVertical === "HUG") recommendations.push("Prefer intrinsic/content sizing; avoid hard-coded dimensions unless necessary.");
		if (record.layoutSizingHorizontal === "FIXED") recommendations.push("Fixed width from Figma may need max-width or responsive breakpoints.");
		if (record.layoutWrap === "WRAP") recommendations.push("Enable flex-wrap and test narrow container widths.");
		if (numberValue(record.minWidth) !== undefined) recommendations.push(`Respect min-width: ${px(numberValue(record.minWidth))}.`);
		if (numberValue(record.maxWidth) !== undefined) recommendations.push(`Respect max-width: ${px(numberValue(record.maxWidth))}.`);
		if (recommendations.length) {
			hints.push({ id: record.id, name: record.name, type: record.type, path, constraints: compactObject(constraints), recommendations: uniqueStrings(recommendations) });
		}
	});
	return hints.slice(0, 60);
}

export function buildAccessibilityHints(summary: FigmaNodeSummary): Array<Record<string, unknown>> {
	const hints: Array<Record<string, unknown>> = [];
	for (const node of flatten(summary)) {
		const text = (node.text ?? []).join(" ");
		const haystack = `${node.name} ${text} ${node.roleGuess ?? ""}`.toLowerCase();
		let role: string | undefined;
		let tag: string | undefined;
		const notes: string[] = [];
		if (/button|submit|save|continue|cancel|next|back/.test(haystack)) {
			role = "button";
			tag = "button";
			notes.push("Ensure it is keyboard-focusable and supports Enter/Space activation.");
		} else if (/link|learn more|view details/.test(haystack)) {
			role = "link";
			tag = "a";
			notes.push("Use an href when navigation is intended.");
		} else if (/input|field|placeholder|select|dropdown/.test(haystack)) {
			role = /select|dropdown/.test(haystack) ? "combobox" : "textbox";
			tag = /select|dropdown/.test(haystack) ? "select" : "input";
			notes.push("Associate a visible label or aria-label with the control.");
		} else if (/checkbox|toggle/.test(haystack)) {
			role = "checkbox";
			tag = "input";
			notes.push("Expose checked state and keyboard toggling.");
		} else if (/radio/.test(haystack)) {
			role = "radio";
			tag = "input";
			notes.push("Group radios with fieldset/legend or radiogroup labeling.");
		} else if (/modal|dialog/.test(haystack)) {
			role = "dialog";
			tag = "dialog";
			notes.push("Trap focus, restore focus on close, and label with aria-labelledby.");
		} else if (/tab/.test(haystack)) {
			role = "tab";
			tag = "button";
			notes.push("Implement roving tabindex and aria-selected.");
		} else if (/icon|image|avatar|photo/.test(haystack)) {
			role = "img";
			tag = "img";
			notes.push(/icon/.test(haystack) ? "Use aria-hidden for decorative icons or provide accessible name when meaningful." : "Provide descriptive alt text.");
		} else if (/title|heading|header/.test(haystack)) {
			role = "heading";
			tag = "h2";
		}
		if (role || node.roleGuess) hints.push({ id: node.id, name: node.name, role: role ?? node.roleGuess, suggestedTag: tag, labelSource: text ? "visible text" : "node name", accessibleName: text || node.name, notes });
	}
	return hints.slice(0, 60);
}

export function buildDesignTokenHints(node: unknown, tokenMap?: FigmaTokenMap): Record<string, unknown> {
	const resolved: Array<Record<string, unknown>> = [];
	const unresolved: string[] = [];
	walk(node, (record, path) => {
		const styles = asRecord(record.styles);
		for (const [property, id] of Object.entries(styles)) {
			const styleId = String(id);
			const name = tokenMap?.styles[styleId]?.name;
			if (name) resolved.push({ path, property, id: styleId, kind: "style", name, type: tokenMap?.styles[styleId]?.type });
			else unresolved.push(styleId);
		}
		for (const binding of collectVariableBindings(record.boundVariables)) {
			const variable = tokenMap?.variables[binding.id];
			if (variable) resolved.push({ path, property: binding.property, id: binding.id, kind: "variable", name: variable.name, collection: variable.collectionName });
			else unresolved.push(binding.id);
		}
	});
	return { resolved: resolved.slice(0, 80), unresolved: uniqueStrings(unresolved).slice(0, 80), warnings: tokenMap ? [] : ["Token resolution requires Figma styles/variables metadata; unresolved IDs are still reported when present."] };
}

export function buildFrameworkHints(summary: FigmaNodeSummary, options: FigmaImplementationOptions): Record<string, unknown> | undefined {
	if (!options.framework && !options.styling && !options.includeCodeSnippets) return undefined;
	const framework = options.framework ?? "react";
	const styling = options.styling ?? "css";
	const componentName = toPascalCase(summary.name || "FigmaComponent");
	const className = toKebabCase(summary.name || "figma-component");
	return compactObject({
		framework,
		styling,
		componentName,
		fileHints: framework === "react" ? [`${componentName}.tsx`, `${componentName}.styles.ts`] : [`${className}.html`, `${className}.css`],
		notes: ["Starter snippets are heuristic scaffolds, not production-ready generated code.", "Map Figma text/layers to semantic elements before final implementation."],
		snippet: options.includeCodeSnippets ? snippetFor(summary, framework, styling, componentName, className) : undefined,
	}) as Record<string, unknown> | undefined;
}

function snippetFor(summary: FigmaNodeSummary, framework: FigmaFramework, styling: FigmaStyling, componentName: string, className: string): string {
	const text = summary.visibleText?.slice(0, 3).join(" / ") || summary.name;
	if (framework === "react-native") return `export function ${componentName}() {\n  return <View><Text>${escapeSnippet(text)}</Text></View>;\n}`;
	if (framework === "vue") return `<template>\n  <section class=\"${className}\">${escapeSnippet(text)}</section>\n</template>`;
	if (framework === "angular") return `<section class=\"${className}\">${escapeSnippet(text)}</section>`;
	if (framework === "html") return `<section class=\"${className}\">${escapeSnippet(text)}</section>`;
	if (styling === "styled-components") return `const ${componentName}Root = styled.section\`\n  display: flex;\n\`;\n\nexport function ${componentName}() {\n  return <${componentName}Root>${escapeSnippet(text)}</${componentName}Root>;\n}`;
	return `export function ${componentName}() {\n  return <section className=\"${className}\">${escapeSnippet(text)}</section>;\n}`;
}

function flatten(summary: FigmaNodeSummary): FigmaNodeSummary[] {
	const out: FigmaNodeSummary[] = [];
	function visit(node: FigmaNodeSummary): void {
		out.push(node);
		for (const child of node.children ?? []) visit(child);
	}
	visit(summary);
	return out;
}

function walk(node: unknown, visit: (record: Record<string, unknown>, path: string) => void, path = ""): void {
	const record = asRecord(node);
	const name = String(record.name ?? "Unnamed node");
	const nextPath = path ? `${path} > ${name}` : name;
	visit(record, nextPath);
	for (const child of Array.isArray(record.children) ? record.children : []) walk(child, visit, nextPath);
}

function collectVariableBindings(value: unknown): Array<{ property: string; id: string }> {
	const out: Array<{ property: string; id: string }> = [];
	function visit(raw: unknown, property: string): void {
		if (Array.isArray(raw)) raw.forEach((item, index) => visit(item, `${property}[${index}]`));
		else {
			const record = asRecord(raw);
			if (typeof record.id === "string") out.push({ property, id: record.id });
			for (const [key, child] of Object.entries(record)) if (key !== "id" && key !== "type") visit(child, property ? `${property}.${key}` : key);
		}
	}
	visit(value, "");
	return out;
}

function compactLayoutGrids(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 4).map((grid) => {
		const record = asRecord(grid);
		return compactObject({ pattern: record.pattern, count: record.count, gutterSize: record.gutterSize, sectionSize: record.sectionSize, alignment: record.alignment }) ?? {};
	});
}

function paddingValue(record: Record<string, unknown>): string | undefined {
	const top = numberValue(record.paddingTop);
	const right = numberValue(record.paddingRight);
	const bottom = numberValue(record.paddingBottom);
	const left = numberValue(record.paddingLeft);
	if ([top, right, bottom, left].every((value) => value === undefined)) return undefined;
	return [top ?? 0, right ?? 0, bottom ?? 0, left ?? 0].map(px).join(" ");
}

function mapPrimary(value: unknown): string | undefined {
	return ({ MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" } as Record<string, string>)[String(value)];
}

function mapCounter(value: unknown): string | undefined {
	return ({ MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline", STRETCH: "stretch" } as Record<string, string>)[String(value)];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (raw === undefined || raw === null) continue;
		if (Array.isArray(raw) && raw.length === 0) continue;
		if (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0) continue;
		out[key] = raw;
	}
	return Object.keys(out).length ? out : undefined;
}

function px(value: number | undefined): string {
	return `${value ?? 0}px`;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function toPascalCase(value: string): string {
	const result = value.replace(/[^a-z0-9]+/gi, " ").trim().split(/\s+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
	return /^[A-Z]/.test(result) ? result : `Figma${result || "Component"}`;
}

function toKebabCase(value: string): string {
	return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "figma-component";
}

function escapeSnippet(value: string): string {
	return value.replace(/[<>]/g, "");
}
