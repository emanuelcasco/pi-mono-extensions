export interface FigmaTokenMap {
	styles: Record<string, { key?: string; name: string; type?: string; description?: string }>;
	variables: Record<string, { key?: string; name: string; collectionName?: string; resolvedType?: string }>;
	collections: Record<string, { name: string; modes?: Array<{ modeId: string; name: string }> }>;
	warnings: string[];
}

export function buildFigmaTokenMap(stylesResponse: unknown, variablesResponse: unknown): FigmaTokenMap {
	const warnings: string[] = [];
	const styles: FigmaTokenMap["styles"] = {};
	for (const style of getNestedArray(stylesResponse, ["meta", "styles"])) {
		const record = asRecord(style);
		const id = stringValue(record.node_id) ?? stringValue(record.nodeId) ?? stringValue(record.key);
		if (!id) continue;
		styles[id] = { key: stringValue(record.key), name: String(record.name ?? id), type: stringValue(record.style_type) ?? stringValue(record.styleType), description: stringValue(record.description) };
	}

	const variables: FigmaTokenMap["variables"] = {};
	const collections: FigmaTokenMap["collections"] = {};
	const meta = asRecord(asRecord(variablesResponse).meta ?? variablesResponse);
	const rawCollections = asRecord(meta.variableCollections ?? meta.variable_collections);
	for (const [collectionId, raw] of Object.entries(rawCollections)) {
		const record = asRecord(raw);
		collections[collectionId] = {
			name: String(record.name ?? collectionId),
			modes: Array.isArray(record.modes) ? record.modes.map((mode) => ({ modeId: String(asRecord(mode).modeId ?? asRecord(mode).mode_id ?? ""), name: String(asRecord(mode).name ?? "Mode") })) : undefined,
		};
	}
	const rawVariables = asRecord(meta.variables);
	for (const [variableId, raw] of Object.entries(rawVariables)) {
		const record = asRecord(raw);
		const collectionId = stringValue(record.variableCollectionId) ?? stringValue(record.variable_collection_id);
		variables[variableId] = {
			key: stringValue(record.key),
			name: String(record.name ?? variableId),
			collectionName: collectionId ? collections[collectionId]?.name : undefined,
			resolvedType: stringValue(record.resolvedType) ?? stringValue(record.resolved_type),
		};
	}
	if (!Object.keys(styles).length) warnings.push("No named styles were available to resolve style IDs.");
	if (!Object.keys(variables).length) warnings.push("No local variables were available to resolve variable IDs.");
	return { styles, variables, collections, warnings };
}

function getNestedArray(value: unknown, path: readonly string[]): unknown[] {
	let current = value;
	for (const segment of path) current = asRecord(current)[segment];
	return Array.isArray(current) ? current : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
