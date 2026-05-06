export interface FigmaFindNodesOptions {
	query: string;
	depth?: number;
	exact?: boolean;
	caseSensitive?: boolean;
	includeHidden?: boolean;
	includeVectors?: boolean;
	includeComponentInternals?: boolean;
	maxResults?: number;
}

export interface FigmaNodeSearchMatch {
	id?: string;
	name: string;
	type: string;
	path: string;
	visible: boolean;
	text?: string;
	parent?: { id?: string; name: string; type: string; path: string };
	roleHint?: string;
}

export interface FigmaNodeSearchResult {
	query: string;
	matchType: "name" | "text";
	matches: FigmaNodeSearchMatch[];
	metadata: {
		truncated: boolean;
		truncatedReasons: string[];
		nextSteps: string[];
	};
}

interface NormalizedSearchOptions extends Required<Omit<FigmaFindNodesOptions, "query">> {
	query: string;
}

const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "ELLIPSE", "POLYGON", "REGULAR_POLYGON"]);
const DEFAULT_DEPTH = 4;
const DEFAULT_MAX_RESULTS = 50;
const MAX_DEPTH = 12;
const MAX_RESULTS = 200;

export function findNodesByName(node: unknown, options: FigmaFindNodesOptions): FigmaNodeSearchResult {
	return findNodes(node, normalizeOptions(options), "name");
}

export function findNodesByText(node: unknown, options: FigmaFindNodesOptions): FigmaNodeSearchResult {
	return findNodes(node, normalizeOptions(options), "text");
}

function findNodes(root: unknown, options: NormalizedSearchOptions, matchType: "name" | "text"): FigmaNodeSearchResult {
	const matches: FigmaNodeSearchMatch[] = [];
	const truncatedReasons: string[] = [];
	let visited = 0;
	let skippedHidden = 0;
	let skippedVectors = 0;
	let skippedInstances = 0;

	function visit(node: unknown, level: number, path: string, parent?: FigmaNodeSearchMatch["parent"]): void {
		const record = asRecord(node);
		if (!Object.keys(record).length) return;
		const visible = record.visible !== false;
		if (!options.includeHidden && !visible) {
			skippedHidden += 1;
			return;
		}
		const type = String(record.type ?? "UNKNOWN");
		const isVector = VECTOR_TYPES.has(type);
		if (isVector && !options.includeVectors && level > 0) {
			skippedVectors += 1;
			return;
		}
		const name = String(record.name ?? "Unnamed node");
		const nextPath = path ? `${path} > ${name}` : name;
		visited += 1;

		const candidate = matchType === "name" ? name : normalizeText(record.characters) ?? "";
		if (candidate && isMatch(candidate, options)) {
			if (matches.length < options.maxResults) {
				matches.push({
					id: stringValue(record.id),
					name,
					type,
					path: nextPath,
					visible,
					text: matchType === "text" ? candidate : normalizeText(record.characters),
					parent,
					roleHint: roleHint(name, candidate, type),
				});
			} else if (!truncatedReasons.some((reason) => reason.includes("maxResults"))) {
				truncatedReasons.push(`Reached maxResults ${options.maxResults}; additional matches were omitted.`);
			}
		}

		if (level >= options.depth) {
			if (getChildren(record).length && !truncatedReasons.some((reason) => reason.includes("depth limit"))) {
				truncatedReasons.push(`Reached depth limit ${options.depth}; deeper descendants were not searched.`);
			}
			return;
		}
		if (type === "INSTANCE" && !options.includeComponentInternals && level > 0) {
			skippedInstances += 1;
			// Text labels inside instances remain useful search targets without exposing full structure.
			for (const child of getChildren(record)) {
				const childRecord = asRecord(child);
				if (childRecord.type === "TEXT") visit(child, level + 1, nextPath, compactParent(record, nextPath));
			}
			return;
		}
		for (const child of getChildren(record)) visit(child, level + 1, nextPath, compactParent(record, nextPath));
	}

	visit(root, 0, "");

	if (skippedHidden) truncatedReasons.push(`Skipped ${skippedHidden} hidden node(s). Set includeHidden=true to include them.`);
	if (skippedVectors) truncatedReasons.push(`Skipped ${skippedVectors} vector/icon node(s). Set includeVectors=true to include them.`);
	if (skippedInstances) truncatedReasons.push(`Collapsed ${skippedInstances} component instance subtree/subtrees. Set includeComponentInternals=true for internals.`);

	const nextSteps = new Set<string>();
	if (!matches.length) nextSteps.add("Try a broader query, disable exact matching, or search visible text instead of names.");
	if (truncatedReasons.some((reason) => reason.includes("maxResults"))) nextSteps.add("Raise maxResults or narrow the search with nodeId/depth.");
	if (truncatedReasons.some((reason) => reason.includes("depth limit")) && options.depth < MAX_DEPTH) nextSteps.add(`Increase depth to ${options.depth + 1} or search within a more specific nodeId.`);
	if (skippedInstances) nextSteps.add("Set includeComponentInternals=true only for a focused component instance if internal layer matches matter.");

	return {
		query: options.query,
		matchType,
		matches,
		metadata: {
			truncated: truncatedReasons.some((reason) => !reason.startsWith("Skipped")) || matches.length >= options.maxResults,
			truncatedReasons: uniqueStrings(truncatedReasons),
			nextSteps: [...nextSteps],
		},
	};
}

function normalizeOptions(options: FigmaFindNodesOptions): NormalizedSearchOptions {
	return {
		query: options.query,
		depth: clampInteger(options.depth ?? DEFAULT_DEPTH, 1, MAX_DEPTH),
		exact: options.exact ?? false,
		caseSensitive: options.caseSensitive ?? false,
		includeHidden: options.includeHidden ?? false,
		includeVectors: options.includeVectors ?? false,
		includeComponentInternals: options.includeComponentInternals ?? false,
		maxResults: clampInteger(options.maxResults ?? DEFAULT_MAX_RESULTS, 1, MAX_RESULTS),
	};
}

function isMatch(candidate: string, options: NormalizedSearchOptions): boolean {
	const haystack = options.caseSensitive ? candidate : candidate.toLowerCase();
	const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
	return options.exact ? haystack === needle : haystack.includes(needle);
}

function compactParent(record: Record<string, unknown>, path: string): FigmaNodeSearchMatch["parent"] {
	return { id: stringValue(record.id), name: String(record.name ?? "Unnamed node"), type: String(record.type ?? "UNKNOWN"), path };
}

function roleHint(name: string, text: string, type: string): string | undefined {
	const haystack = `${name} ${text}`.toLowerCase();
	if (/button|submit|save|continue|cancel|next|back/.test(haystack)) return "button";
	if (/input|field|placeholder|select|dropdown/.test(haystack)) return "form-control";
	if (/modal|dialog/.test(haystack)) return "dialog";
	if (/icon/.test(haystack) || VECTOR_TYPES.has(type)) return "icon";
	if (/title|heading|header/.test(haystack)) return "heading";
	return undefined;
}

function getChildren(record: Record<string, unknown>): unknown[] {
	return Array.isArray(record.children) ? record.children : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	return text || undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}
