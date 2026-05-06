import {
	buildAccessibilityHints,
	buildCssLayoutHints,
	buildDesignTokenHints,
	buildFrameworkHints,
	buildResponsiveHints,
	type FigmaFramework,
	type FigmaStyling,
} from "./figma-implementation.js";
import type { FigmaTokenMap } from "./figma-tokens.js";

export interface FigmaSummarizerOptions {
	depth?: number;
	includeHidden?: boolean;
	includeVectors?: boolean;
	includeComponentInternals?: boolean;
	maxVisibleText?: number;
	maxChildren?: number;
}

export interface FigmaRenderedAsset {
	nodeId: string;
	url?: string | null;
	path?: string;
}

export interface FigmaSummaryMetadata {
	truncated: boolean;
	truncatedReasons: string[];
	nextSteps: string[];
}

export interface FigmaNodeSummary {
	id?: string;
	name: string;
	type: string;
	size?: { width: number; height: number };
	layout?: Record<string, unknown>;
	spacing?: Record<string, unknown>;
	style?: Record<string, unknown>;
	text?: string[];
	visibleText?: string[];
	component?: Record<string, unknown>;
	roleGuess?: string;
	children?: FigmaNodeSummary[];
	metadata?: FigmaSummaryMetadata;
}

export interface FigmaTextExtractionResult {
	node: string;
	nodeId?: string;
	texts: string[];
	metadata: FigmaSummaryMetadata;
}

export interface FigmaImplementationContext {
	purpose: string;
	node: FigmaNodeSummary;
	sections: Array<Record<string, unknown>>;
	fields: Array<Record<string, unknown>>;
	buttons: Array<Record<string, unknown>>;
	layoutMeasurements: Record<string, unknown>;
	typography: Array<Record<string, unknown>>;
	colors: Array<Record<string, unknown>>;
	spacing: Array<Record<string, unknown>>;
	cssLayout?: Record<string, unknown>;
	responsive?: Array<Record<string, unknown>>;
	accessibility?: Array<Record<string, unknown>>;
	designTokens?: Record<string, unknown>;
	frameworkHints?: Record<string, unknown>;
	componentHierarchy: FigmaNodeSummary[];
	assets?: FigmaRenderedAsset[];
	metadata: FigmaSummaryMetadata;
}

export interface FigmaImplementationContextOptions extends FigmaSummarizerOptions {
	assets?: FigmaRenderedAsset[];
	framework?: FigmaFramework;
	styling?: FigmaStyling;
	resolveTokens?: boolean;
	includeCodeSnippets?: boolean;
	tokenMap?: FigmaTokenMap;
}

interface SummaryState {
	visibleText: string[];
	truncatedReasons: string[];
	options: Required<Pick<FigmaSummarizerOptions, "depth" | "includeHidden" | "includeVectors" | "includeComponentInternals" | "maxVisibleText" | "maxChildren">>;
}

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 4;
const DEFAULT_MAX_VISIBLE_TEXT = 200;
const DEFAULT_MAX_CHILDREN = 100;
const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "ELLIPSE", "POLYGON", "REGULAR_POLYGON"]);

export function normalizeSummarizerOptions(options: FigmaSummarizerOptions = {}): SummaryState["options"] {
	return {
		depth: clampInteger(options.depth ?? DEFAULT_DEPTH, 1, MAX_DEPTH),
		includeHidden: options.includeHidden ?? false,
		includeVectors: options.includeVectors ?? false,
		includeComponentInternals: options.includeComponentInternals ?? false,
		maxVisibleText: clampInteger(options.maxVisibleText ?? DEFAULT_MAX_VISIBLE_TEXT, 1, DEFAULT_MAX_VISIBLE_TEXT),
		maxChildren: clampInteger(options.maxChildren ?? DEFAULT_MAX_CHILDREN, 1, DEFAULT_MAX_CHILDREN),
	};
}

export function summarizeNode(node: unknown, options: FigmaSummarizerOptions = {}): FigmaNodeSummary {
	const normalized = normalizeSummarizerOptions(options);
	const state: SummaryState = { visibleText: [], truncatedReasons: [], options: normalized };
	const summary = summarizeNodeInternal(node, state, 0, true) ?? emptySummary(node);
	summary.visibleText = state.visibleText;
	summary.metadata = buildMetadata(state, summary);
	return summary;
}

export function extractVisibleText(node: unknown, options: FigmaSummarizerOptions = {}): FigmaTextExtractionResult {
	const normalized = normalizeSummarizerOptions(options);
	const state: SummaryState = { visibleText: [], truncatedReasons: [], options: normalized };
	collectVisibleText(node, state);
	const record = asRecord(node);
	return {
		node: String(record.name ?? "Unknown node"),
		nodeId: stringValue(record.id),
		texts: state.visibleText,
		metadata: buildMetadata(state),
	};
}

export function explainNode(node: unknown, options: FigmaSummarizerOptions & { assets?: FigmaRenderedAsset[] } = {}): string {
	const summary = summarizeNode(node, options);
	const lines: string[] = [];
	const size = summary.size ? ` (${formatNumber(summary.size.width)} × ${formatNumber(summary.size.height)})` : "";
	lines.push(`# ${summary.name}`);
	lines.push("");
	lines.push(`This node is a **${summary.type}**${size}${summary.roleGuess ? ` that appears to function as a **${summary.roleGuess}**` : ""}.`);
	if (summary.visibleText?.length) {
		lines.push("");
		lines.push("## Visible text");
		for (const text of summary.visibleText.slice(0, 40)) lines.push(`- ${text}`);
		if (summary.visibleText.length > 40) lines.push(`- …${summary.visibleText.length - 40} more text nodes omitted`);
	}
	if (summary.children?.length) {
		lines.push("");
		lines.push("## Sections");
		summary.children.slice(0, 20).forEach((child, index) => {
			const childSize = child.size ? ` — ${formatNumber(child.size.width)} × ${formatNumber(child.size.height)}` : "";
			const childText = child.text?.length ? ` Text: ${child.text.slice(0, 6).join(" / ")}` : "";
			lines.push(`${index + 1}. **${child.name}** (${child.type}${child.roleGuess ? `, ${child.roleGuess}` : ""})${childSize}.${childText}`);
		});
		if (summary.children.length > 20) lines.push(`${summary.children.length - 20} additional sections omitted.`);
	}
	if (summary.layout || summary.spacing) {
		lines.push("");
		lines.push("## Layout notes");
		if (summary.layout) lines.push(`- Layout: ${compactInline(summary.layout)}`);
		if (summary.spacing) lines.push(`- Spacing/padding: ${compactInline(summary.spacing)}`);
	}
	if (summary.style) {
		lines.push("");
		lines.push("## Visual style");
		lines.push(`- ${compactInline(summary.style)}`);
	}
	if (options.assets?.length) {
		lines.push("");
		lines.push("## Rendered assets");
		for (const asset of options.assets) lines.push(`- ${asset.nodeId}: ${asset.path ?? asset.url ?? "not available"}`);
	}
	if (summary.metadata?.nextSteps.length) {
		lines.push("");
		lines.push("## Suggested next steps");
		for (const step of summary.metadata.nextSteps) lines.push(`- ${step}`);
	}
	return lines.join("\n");
}

export function getImplementationContext(node: unknown, options: FigmaImplementationContextOptions = {}): FigmaImplementationContext {
	const summary = summarizeNode(node, options);
	const typography = collectTypography(node, normalizeSummarizerOptions(options));
	const colors = collectColors(node, normalizeSummarizerOptions(options));
	const spacing = collectSpacing(node, normalizeSummarizerOptions(options));
	const sections = (summary.children ?? []).slice(0, DEFAULT_MAX_CHILDREN).map((child) => ({
		id: child.id,
		name: child.name,
		type: child.type,
		size: child.size,
		layout: child.layout,
		spacing: child.spacing,
		text: child.text ?? [],
		roleGuess: child.roleGuess,
	}));
	const controls = collectControls(summary);
	return {
		purpose: inferPurpose(summary),
		node: summary,
		sections,
		fields: controls.fields,
		buttons: controls.buttons,
		layoutMeasurements: {
			size: summary.size,
			layout: summary.layout,
			spacing: summary.spacing,
			sectionCount: sections.length,
		},
		typography,
		colors,
		spacing,
		cssLayout: buildCssLayoutHints(node),
		responsive: buildResponsiveHints(node),
		accessibility: buildAccessibilityHints(summary),
		designTokens: options.resolveTokens === false ? undefined : buildDesignTokenHints(node, options.tokenMap),
		frameworkHints: buildFrameworkHints(summary, options),
		componentHierarchy: flattenHierarchy(summary).slice(0, DEFAULT_MAX_CHILDREN),
		assets: options.assets?.length ? options.assets : undefined,
		metadata: summary.metadata ?? buildMetadata({ visibleText: [], truncatedReasons: [], options: normalizeSummarizerOptions(options) }),
	};
}

function summarizeNodeInternal(node: unknown, state: SummaryState, level: number, isRoot = false): FigmaNodeSummary | null {
	const record = asRecord(node);
	if (!state.options.includeHidden && record.visible === false) return null;
	const type = String(record.type ?? "UNKNOWN");
	const isVector = VECTOR_TYPES.has(type);
	if (isVector && !state.options.includeVectors && !isRoot) return null;

	const name = String(record.name ?? "Unnamed node");
	const text = type === "TEXT" ? normalizeText(record.characters) : undefined;
	if (text) pushVisibleText(state, text);

	const summary: FigmaNodeSummary = {
		id: stringValue(record.id),
		name,
		type,
		size: extractSize(record),
		layout: extractLayout(record),
		spacing: extractSpacing(record),
		style: extractStyle(record),
		text: text ? [text] : undefined,
		component: extractComponent(record),
		roleGuess: guessRole(record, text),
	};

	const shouldCollapseInstance = type === "INSTANCE" && !state.options.includeComponentInternals && !isRoot;
	const shouldVisitChildren = level < state.options.depth && (!isVector || state.options.includeVectors) && !shouldCollapseInstance;
	const children = getChildren(record);

	if (shouldCollapseInstance) {
		const before = state.visibleText.length;
		collectVisibleText(record, state);
		const instanceText = state.visibleText.slice(before);
		if (instanceText.length) summary.text = uniqueStrings([...(summary.text ?? []), ...instanceText]).slice(0, 20);
		if (children.length) state.truncatedReasons.push(`Collapsed component instance "${name}" (${children.length} internal child nodes hidden).`);
	} else if (children.length && shouldVisitChildren) {
		const visibleChildren: FigmaNodeSummary[] = [];
		for (const child of children) {
			if (visibleChildren.length >= state.options.maxChildren) {
				state.truncatedReasons.push(`Capped children of "${name}" at ${state.options.maxChildren}.`);
				break;
			}
			const childSummary = summarizeNodeInternal(child, state, level + 1);
			if (childSummary) visibleChildren.push(childSummary);
		}
		if (visibleChildren.length) summary.children = visibleChildren;
	} else if (children.length && level >= state.options.depth) {
		state.truncatedReasons.push(`Reached depth limit ${state.options.depth} at "${name}".`);
	}

	return pruneEmpty(summary);
}

function collectVisibleText(node: unknown, state: SummaryState): void {
	const record = asRecord(node);
	if (!state.options.includeHidden && record.visible === false) return;
	const type = String(record.type ?? "UNKNOWN");
	if (type === "TEXT") {
		const text = normalizeText(record.characters);
		if (text) pushVisibleText(state, text);
	}
	if (VECTOR_TYPES.has(type) && !state.options.includeVectors) return;
	if (type === "INSTANCE" && !state.options.includeComponentInternals) {
		// Text labels inside component instances are useful, but the structural internals are not.
		for (const child of getChildren(record)) collectVisibleText(child, state);
		return;
	}
	for (const child of getChildren(record)) collectVisibleText(child, state);
}

function pushVisibleText(state: SummaryState, text: string): void {
	if (state.visibleText.length >= state.options.maxVisibleText) {
		if (!state.truncatedReasons.some((reason) => reason.includes("visible text"))) {
			state.truncatedReasons.push(`Capped visible text at ${state.options.maxVisibleText} items.`);
		}
		return;
	}
	state.visibleText.push(text);
}

function collectTypography(node: unknown, options: SummaryState["options"]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	walk(node, options, (record, path) => {
		if (record.type !== "TEXT") return;
		const style = asRecord(record.style);
		out.push({
			path,
			text: normalizeText(record.characters)?.slice(0, 80),
			fontFamily: style.fontFamily,
			fontPostScriptName: style.fontPostScriptName,
			fontSize: style.fontSize,
			fontWeight: style.fontWeight,
			lineHeightPx: style.lineHeightPx,
			letterSpacing: style.letterSpacing,
			color: firstSolidPaint(record.fills),
		});
	});
	return dedupeObjects(out, ["fontFamily", "fontSize", "fontWeight", "lineHeightPx", "color"]).slice(0, 50);
}

function collectColors(node: unknown, options: SummaryState["options"]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	walk(node, options, (record, path) => {
		for (const [source, paints] of [["fills", record.fills], ["strokes", record.strokes]] as const) {
			for (const paint of compactPaints(paints) ?? []) out.push({ path, source, ...paint });
		}
	});
	return dedupeObjects(out, ["source", "type", "hex", "opacity"]).slice(0, 60);
}

function collectSpacing(node: unknown, options: SummaryState["options"]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	walk(node, options, (record, path) => {
		const spacing = extractSpacing(record);
		if (spacing) out.push({ path, ...spacing });
	});
	return dedupeObjects(out, ["itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"]).slice(0, 50);
}

function collectControls(summary: FigmaNodeSummary): { fields: Array<Record<string, unknown>>; buttons: Array<Record<string, unknown>> } {
	const fields: Array<Record<string, unknown>> = [];
	const buttons: Array<Record<string, unknown>> = [];
	for (const node of flattenHierarchy(summary)) {
		const text = (node.text ?? []).join(" / ");
		const searchable = `${node.name} ${text}`.toLowerCase();
		if (node.roleGuess === "button" || /\b(button|continue|back|cancel|save|submit|done|next|previous|go back)\b/i.test(searchable)) {
			buttons.push({ id: node.id, name: node.name, text: node.text ?? [], size: node.size });
		} else if (/\b(input|field|select|dropdown|checkbox|radio|toggle|year|value|baseline|target)\b/i.test(searchable)) {
			fields.push({ id: node.id, name: node.name, text: node.text ?? [], size: node.size, roleGuess: node.roleGuess });
		}
	}
	return { fields: fields.slice(0, 60), buttons: buttons.slice(0, 40) };
}

function walk(node: unknown, options: SummaryState["options"], visit: (record: Record<string, unknown>, path: string) => void, path = ""): void {
	const record = asRecord(node);
	if (!options.includeHidden && record.visible === false) return;
	const type = String(record.type ?? "UNKNOWN");
	const name = String(record.name ?? "Unnamed node");
	const nextPath = path ? `${path} > ${name}` : name;
	visit(record, nextPath);
	if (VECTOR_TYPES.has(type) && !options.includeVectors) return;
	if (type === "INSTANCE" && !options.includeComponentInternals) {
		for (const child of getChildren(record)) {
			const childRecord = asRecord(child);
			if (childRecord.type === "TEXT") visit(childRecord, `${nextPath} > ${String(childRecord.name ?? "Text")}`);
		}
		return;
	}
	for (const child of getChildren(record)) walk(child, options, visit, nextPath);
}

function buildMetadata(state: SummaryState, summary?: FigmaNodeSummary): FigmaSummaryMetadata {
	const truncatedReasons = uniqueStrings(state.truncatedReasons);
	const nextSteps = new Set<string>();
	if ((summary?.children?.length ?? 0) >= state.options.maxChildren || truncatedReasons.some((reason) => reason.includes("Capped children"))) {
		nextSteps.add("Inspect a specific child node by ID with figma_get_node_summary.");
	}
	if (truncatedReasons.some((reason) => reason.includes("depth limit")) && state.options.depth < MAX_DEPTH) {
		nextSteps.add(`Call figma_get_node_summary with depth ${state.options.depth + 1} for more hierarchy.`);
	}
	if (truncatedReasons.some((reason) => reason.includes("Collapsed component instance"))) {
		nextSteps.add("Set includeComponentInternals=true for a specific component instance if its internals matter.");
	}
	if (truncatedReasons.some((reason) => reason.includes("visible text"))) {
		nextSteps.add("Use figma_extract_text on a narrower child node to see more text.");
	}
	return { truncated: truncatedReasons.length > 0, truncatedReasons, nextSteps: [...nextSteps] };
}

function inferPurpose(summary: FigmaNodeSummary): string {
	const text = summary.visibleText?.slice(0, 6).join("; ");
	if (text) return `${summary.name} appears to be a ${summary.type.toLowerCase()} for: ${text}`;
	return `${summary.name} appears to be a ${summary.type.toLowerCase()} design node.`;
}

function flattenHierarchy(summary: FigmaNodeSummary): FigmaNodeSummary[] {
	const out: FigmaNodeSummary[] = [];
	function visit(node: FigmaNodeSummary): void {
		out.push({ ...node, children: undefined, visibleText: undefined, metadata: undefined });
		for (const child of node.children ?? []) visit(child);
	}
	visit(summary);
	return out;
}

function extractSize(record: Record<string, unknown>): { width: number; height: number } | undefined {
	const box = asRecord(record.absoluteBoundingBox) ?? asRecord(record.absoluteRenderBounds);
	const width = numberValue(box.width);
	const height = numberValue(box.height);
	return width !== undefined && height !== undefined ? { width, height } : undefined;
}

function extractLayout(record: Record<string, unknown>): Record<string, unknown> | undefined {
	return compactObject({
		mode: record.layoutMode,
		primaryAxisAlignItems: record.primaryAxisAlignItems,
		counterAxisAlignItems: record.counterAxisAlignItems,
		layoutWrap: record.layoutWrap,
		layoutAlign: record.layoutAlign,
		layoutGrow: record.layoutGrow,
		layoutSizingHorizontal: record.layoutSizingHorizontal,
		layoutSizingVertical: record.layoutSizingVertical,
		minWidth: record.minWidth,
		maxWidth: record.maxWidth,
		minHeight: record.minHeight,
		maxHeight: record.maxHeight,
		layoutGrids: compactLayoutGrids(record.layoutGrids),
		constraints: record.constraints,
	});
}

function extractSpacing(record: Record<string, unknown>): Record<string, unknown> | undefined {
	return compactObject({
		itemSpacing: record.itemSpacing,
		counterAxisSpacing: record.counterAxisSpacing,
		paddingLeft: record.paddingLeft,
		paddingRight: record.paddingRight,
		paddingTop: record.paddingTop,
		paddingBottom: record.paddingBottom,
	});
}

function compactLayoutGrids(value: unknown): Array<Record<string, unknown>> | undefined {
	if (!Array.isArray(value)) return undefined;
	const grids = value
		.slice(0, 4)
		.map((grid) => {
			const record = asRecord(grid);
			return compactObject({ pattern: record.pattern, count: record.count, gutterSize: record.gutterSize, sectionSize: record.sectionSize, alignment: record.alignment });
		})
		.filter((grid): grid is Record<string, unknown> => Boolean(grid));
	return grids.length ? grids : undefined;
}

function compactBoundVariables(value: unknown): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	function visit(raw: unknown, path: string): void {
		if (Array.isArray(raw)) {
			raw.forEach((item, index) => visit(item, `${path}[${index}]`));
			return;
		}
		const record = asRecord(raw);
		if (typeof record.id === "string") {
			out[path || "value"] = record.id;
			return;
		}
		for (const [key, child] of Object.entries(record)) visit(child, path ? `${path}.${key}` : key);
	}
	visit(value, "");
	return Object.keys(out).length ? out : undefined;
}

function extractStyle(record: Record<string, unknown>): Record<string, unknown> | undefined {
	return compactObject({
		fills: compactPaints(record.fills),
		strokes: compactPaints(record.strokes),
		strokeWeight: record.strokeWeight,
		cornerRadius: record.cornerRadius,
		opacity: record.opacity,
		effects: compactEffects(record.effects),
		textStyle: record.type === "TEXT" ? compactTextStyle(record.style) : undefined,
		styleIds: compactObject(asRecord(record.styles)),
		boundVariables: compactBoundVariables(record.boundVariables),
	});
}

function extractComponent(record: Record<string, unknown>): Record<string, unknown> | undefined {
	return compactObject({
		componentId: record.componentId,
		componentSetId: record.componentSetId,
		componentProperties: compactComponentProperties(record.componentProperties),
	});
}

function compactPaints(value: unknown): Array<Record<string, unknown>> | undefined {
	if (!Array.isArray(value)) return undefined;
	const paints = value
		.filter((paint) => asRecord(paint).visible !== false)
		.slice(0, 8)
		.map((paint) => {
			const record = asRecord(paint);
			return compactObject({
				type: record.type,
				hex: record.type === "SOLID" ? colorToHex(asRecord(record.color), numberValue(record.opacity) ?? 1) : undefined,
				rgba: record.type === "SOLID" ? colorToRgba(asRecord(record.color), numberValue(record.opacity) ?? 1) : undefined,
				opacity: record.opacity,
				scaleMode: record.scaleMode,
				imageRef: record.imageRef ? "present" : undefined,
			});
		})
		.filter((paint): paint is Record<string, unknown> => Boolean(paint && Object.keys(paint).length > 0));
	return paints.length ? paints : undefined;
}

function firstSolidPaint(value: unknown): string | undefined {
	return compactPaints(value)?.find((paint) => paint.type === "SOLID")?.hex as string | undefined;
}

function compactEffects(value: unknown): Array<Record<string, unknown>> | undefined {
	if (!Array.isArray(value)) return undefined;
	const effects = value
		.filter((effect) => asRecord(effect).visible !== false)
		.slice(0, 6)
		.map((effect) => {
			const record = asRecord(effect);
			return compactObject({
				type: record.type,
				radius: record.radius,
				offset: record.offset,
				color: record.color ? colorToRgba(asRecord(record.color), 1) : undefined,
			});
		})
		.filter((effect): effect is Record<string, unknown> => Boolean(effect && Object.keys(effect).length > 0));
	return effects.length ? effects : undefined;
}

function compactTextStyle(value: unknown): Record<string, unknown> | undefined {
	const style = asRecord(value);
	return compactObject({
		fontFamily: style.fontFamily,
		fontPostScriptName: style.fontPostScriptName,
		fontSize: style.fontSize,
		fontWeight: style.fontWeight,
		lineHeightPx: style.lineHeightPx,
		letterSpacing: style.letterSpacing,
		textAlignHorizontal: style.textAlignHorizontal,
		textAlignVertical: style.textAlignVertical,
	});
}

function compactComponentProperties(value: unknown): Record<string, unknown> | undefined {
	const properties = asRecord(value);
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(properties).slice(0, 30)) {
		const record = asRecord(raw);
		out[key] = compactObject({ type: record.type, value: record.value, preferredValues: record.preferredValues });
	}
	return Object.keys(out).length ? out : undefined;
}

function guessRole(record: Record<string, unknown>, text?: string): string | undefined {
	const haystack = `${String(record.name ?? "")} ${text ?? ""}`.toLowerCase();
	if (/modal|dialog/.test(haystack)) return "modal";
	if (/header|title/.test(haystack)) return "modal-header";
	if (/footer|action/.test(haystack)) return "modal-actions";
	if (/button|continue|cancel|save|go back|back|next|submit/.test(haystack)) return "button";
	if (/input|field|select|dropdown|checkbox|radio|toggle/.test(haystack)) return "form-control";
	if (/summary|preview|card/.test(haystack)) return "content-card";
	if (/icon/.test(haystack)) return "icon";
	return undefined;
}

function emptySummary(node: unknown): FigmaNodeSummary {
	const record = asRecord(node);
	return { id: stringValue(record.id), name: String(record.name ?? "Unknown node"), type: String(record.type ?? "UNKNOWN") };
}

function pruneEmpty<T extends object>(value: T): T {
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		const current = record[key];
		if (current === undefined || (Array.isArray(current) && current.length === 0) || (isPlainObject(current) && Object.keys(current).length === 0)) {
			delete record[key];
		}
	}
	return value;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (raw === undefined || raw === null) continue;
		if (Array.isArray(raw) && raw.length === 0) continue;
		if (isPlainObject(raw) && Object.keys(raw).length === 0) continue;
		out[key] = raw;
	}
	return Object.keys(out).length ? out : undefined;
}

function getChildren(record: Record<string, unknown>): unknown[] {
	return Array.isArray(record.children) ? record.children : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	return text || undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function colorToRgba(color: Record<string, unknown>, opacity: number): string | undefined {
	const r = numberValue(color.r);
	const g = numberValue(color.g);
	const b = numberValue(color.b);
	if (r === undefined || g === undefined || b === undefined) return undefined;
	const a = numberValue(color.a) ?? opacity;
	return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${round(a)})`;
}

function colorToHex(color: Record<string, unknown>, opacity: number): string | undefined {
	const r = numberValue(color.r);
	const g = numberValue(color.g);
	const b = numberValue(color.b);
	if (r === undefined || g === undefined || b === undefined) return undefined;
	const hex = [r, g, b].map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("");
	const alpha = numberValue(color.a) ?? opacity;
	return alpha >= 1 ? `#${hex}` : `#${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function dedupeObjects(values: Array<Record<string, unknown>>, keys: string[]): Array<Record<string, unknown>> {
	const seen = new Set<string>();
	const out: Array<Record<string, unknown>> = [];
	for (const value of values) {
		const key = keys.map((property) => JSON.stringify(value[property])).join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
	}
	return out;
}

function compactInline(value: Record<string, unknown>): string {
	return JSON.stringify(value).replace(/[{}]/g, "").replace(/\"/g, "");
}
