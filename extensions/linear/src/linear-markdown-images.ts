export interface MarkdownImageReference {
	index: number;
	source: "description";
	altText: string;
	url: string;
	rawMarkdown: string;
	line: number;
	start: number;
	end: number;
	contextSnippet: string;
}

export interface ExtractMarkdownImagesOptions {
	source?: MarkdownImageReference["source"];
	contextLines?: number;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g;

export function extractMarkdownImages(markdown: string, options: ExtractMarkdownImagesOptions = {}): MarkdownImageReference[] {
	const source = options.source ?? "description";
	const contextLines = options.contextLines ?? 2;
	const lineStarts = getLineStarts(markdown);
	const lines = markdown.split("\n");
	const references: MarkdownImageReference[] = [];

	for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
		const rawMarkdown = match[0];
		const rawUrl = match[2] ?? "";
		const url = unwrapMarkdownUrl(rawUrl);
		if (!url) continue;

		const start = match.index ?? 0;
		const end = start + rawMarkdown.length;
		const line = lineForOffset(lineStarts, start);
		references.push({
			index: references.length + 1,
			source,
			altText: unescapeMarkdownText(match[1] ?? ""),
			url,
			rawMarkdown,
			line,
			start,
			end,
			contextSnippet: buildContextSnippet(lines, line, contextLines),
		});
	}

	return references;
}

function unwrapMarkdownUrl(rawUrl: string): string {
	const trimmed = rawUrl.trim();
	if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1).trim();
	return trimmed;
}

function unescapeMarkdownText(value: string): string {
	return value.replace(/\\([\\\[\]])/g, "$1");
}

function getLineStarts(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index++) {
		if (text[index] === "\n") starts.push(index + 1);
	}
	return starts;
}

function lineForOffset(lineStarts: number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const start = lineStarts[mid] ?? 0;
		const next = lineStarts[mid + 1] ?? Number.POSITIVE_INFINITY;
		if (offset >= start && offset < next) return mid + 1;
		if (offset < start) high = mid - 1;
		else low = mid + 1;
	}
	return lineStarts.length;
}

function buildContextSnippet(lines: string[], line: number, contextLines: number): string {
	const start = Math.max(1, line - contextLines);
	const end = Math.min(lines.length, line + contextLines);
	return lines
		.slice(start - 1, end)
		.map((text, index) => `${start + index}: ${text}`)
		.join("\n");
}
