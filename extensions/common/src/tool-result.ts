export interface ToolResultOptions {
	maxChars?: number;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

const DEFAULT_MAX_CHARS = 40_000;

export function textToolResult(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

export function jsonToolResult(data: unknown, options: ToolResultOptions = {}): ToolResult {
	const pretty = JSON.stringify(data, null, 2);
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const truncated = pretty.length > maxChars;
	const text = truncated
		? `${pretty.slice(0, maxChars)}\n\n[truncated ${pretty.length - maxChars} characters; narrow the query or request specific IDs]`
		: pretty;
	return {
		content: [{ type: "text", text }],
		details: { truncated, characters: pretty.length },
	};
}
