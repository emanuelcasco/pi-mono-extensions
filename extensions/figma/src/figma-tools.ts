import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerAuthConfigurator, runWithAuthRetry, type AuthConfiguratorOptions } from "pi-common/auth-config";
import { jsonToolResult, textToolResult } from "pi-common/tool-result";
import { FigmaClient, parseFigmaUrl } from "./figma-client.js";
import {
	FigmaGetDesignContextParams,
	FigmaGetFileParams,
	FigmaGetNodesParams,
	FigmaProcessedNodeParams,
	FigmaProcessedNodeWithRenderParams,
	FigmaParseUrlParams,
	FigmaRenderNodesParams,
	FigmaSearchComponentsParams,
	FigmaSingleFileParams,
} from "./figma-schemas.js";

const DEFAULT_PROCESSED_MAX_CHARS = 20_000;
const DEFAULT_RAW_MAX_CHARS = 40_000;

interface ProcessedNodeParams {
	fileKey: string;
	nodeId: string;
	depth?: number;
	includeHidden?: boolean;
	includeVectors?: boolean;
	includeComponentInternals?: boolean;
	renderImage?: boolean;
	outputDir?: string;
	format?: "png" | "jpg" | "svg" | "pdf";
	scale?: number;
	maxResponseChars?: number;
}

const FIGMA_AUTH: AuthConfiguratorOptions = {
	service: "figma",
	displayName: "Figma",
	envName: "FIGMA_TOKEN",
	authPath: ["figma", "token"],
	commandName: "figma-auth",
	toolName: "figma_configure_auth",
	tokenUrl: "https://www.figma.com/settings/tokens",
	scopeInstructions: ["Enable File content/read access for the files, projects, or team you want pi to inspect.", "No write/admin scopes are required."],
};

function withFigmaAuth<T>(ctx: ExtensionContext, operation: () => Promise<T>): Promise<T> {
	return runWithAuthRetry(ctx, FIGMA_AUTH, operation);
}

export function registerFigmaTools(pi: ExtensionAPI): void {
	const client = new FigmaClient();
	registerAuthConfigurator(pi, FIGMA_AUTH);

	pi.registerTool({
		name: "figma_parse_url",
		label: "Figma Parse URL",
		description: "Parse a Figma URL into fileKey and nodeId values for the other figma_* tools.",
		promptSnippet: "Parse Figma URLs into file key and node ID.",
		parameters: FigmaParseUrlParams,
		async execute(_toolCallId, params) {
			return jsonToolResult(parseFigmaUrl(params.url));
		},
	});

	pi.registerTool({
		name: "figma_get_design_context",
		label: "Figma Design Context",
		description: "Fetch compact LLM-ready Figma context. With nodeId returns target node summary, ancestors/page, and sibling names; without nodeId returns canvases and top-level frames only.",
		promptSnippet: "Explore compact Figma file structure and a target node summary without full raw JSON.",
		promptGuidelines: [
			"Use figma_configure_auth only when Figma auth is missing, invalid, expired, or the user asks to update the token; never ask the user to paste tokens in chat.",
			"Use figma_parse_url, figma_render_nodes, and figma_explain_node or figma_get_node_summary as the default workflow.",
			"Use figma_get_implementation_context when translating a design into code.",
			"Do not call figma_get_nodes by default; use it only when raw Figma JSON is explicitly needed or when debugging the extension.",
			"Use figma_render_nodes when screenshots or visual assets are needed.",
		],
		parameters: FigmaGetDesignContextParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.getDesignContext(params.fileKey, params.nodeId));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_get_node_summary",
		label: "Figma Node Summary",
		description: "Fetch a compact structured summary of a Figma node: dimensions, layout, spacing, styles, visible text, component properties, and shallow child hierarchy. Default depth is 2; hidden nodes, vectors, and component internals are omitted by default.",
		promptSnippet: "Get LLM-ready structured summaries of Figma frames/components.",
		parameters: FigmaProcessedNodeParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.getNodeSummary(params.fileKey, params.nodeId, processedOptions(params)));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_extract_text",
		label: "Figma Extract Text",
		description: "Extract visible text nodes from a Figma node without raw JSON. Hidden text is excluded by default and results are capped for LLM readability.",
		promptSnippet: "Extract visible text from Figma designs.",
		parameters: FigmaProcessedNodeParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.extractText(params.fileKey, params.nodeId, processedOptions(params)));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_explain_node",
		label: "Figma Explain Node",
		description: "Explain a Figma node in human-readable Markdown using compact summary, visible text, shallow hierarchy, and optional rendered image asset. Primary tool for questions like 'Explain this component'.",
		promptSnippet: "Explain a Figma component/frame in Markdown without raw JSON.",
		parameters: FigmaProcessedNodeWithRenderParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const assets = params.renderImage ? await withFigmaAuth(ctx, () => renderAssets(client, ctx, params)) : undefined;
			const result = await withFigmaAuth(ctx, () => client.explainNode(params.fileKey, params.nodeId, { ...processedOptions(params), assets }));
			return limitedTextToolResult(result, params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS);
		},
	});

	pi.registerTool({
		name: "figma_get_implementation_context",
		label: "Figma Implementation Context",
		description: "Return concise design-to-code context for a Figma node: purpose, sections, fields/buttons, measurements, typography, colors, spacing, assets, and React-friendly component hierarchy.",
		promptSnippet: "Get coding-ready Figma implementation context.",
		parameters: FigmaProcessedNodeWithRenderParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const assets = params.renderImage ? await withFigmaAuth(ctx, () => renderAssets(client, ctx, params)) : undefined;
			const result = await withFigmaAuth(ctx, () => client.getImplementationContext(params.fileKey, params.nodeId, { ...processedOptions(params), assets }));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_get_file",
		label: "Figma File",
		description: "Fetch a raw Figma file JSON document. Use only when raw Figma JSON is explicitly needed or when debugging the extension; prefer figma_get_node_summary, figma_explain_node, or figma_get_design_context.",
		parameters: FigmaGetFileParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.getFile(params.fileKey, params.depth));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_RAW_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_get_nodes",
		label: "Figma Nodes",
		description: "Fetch raw Figma JSON for one or more nodes/frames/components by node ID. Use only when raw Figma JSON is explicitly needed or when debugging the extension; do not use by default.",
		parameters: FigmaGetNodesParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.getNodes(params.fileKey, params.nodeIds));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_RAW_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_get_node_metadata",
		label: "Figma Node Metadata",
		description: "Fetch compact spatial/layout metadata for one or more Figma nodes.",
		parameters: FigmaGetNodesParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.getNodeMetadata(params.fileKey, params.nodeIds));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_get_styles",
		label: "Figma Styles",
		description: "Fetch named styles from a Figma file, including colors, text, effects, and grids.",
		parameters: FigmaSingleFileParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.getStyles(params.fileKey));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_get_variables",
		label: "Figma Variables",
		description: "Fetch local Figma variables and collections for design tokens.",
		parameters: FigmaSingleFileParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.getVariables(params.fileKey));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_get_components",
		label: "Figma Components",
		description: "Fetch Figma component metadata for a file.",
		parameters: FigmaSingleFileParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.getComponents(params.fileKey));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_get_component_sets",
		label: "Figma Component Sets",
		description: "Fetch Figma component set metadata for a file.",
		parameters: FigmaSingleFileParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.getComponentSets(params.fileKey));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_search_components",
		label: "Figma Search Components",
		description: "Search Figma components in a file by name or description.",
		parameters: FigmaSearchComponentsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () => client.searchComponents(params.fileKey, params.query));
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});

	pi.registerTool({
		name: "figma_render_nodes",
		label: "Figma Render Nodes",
		description: "Render one or more Figma nodes to image URLs and optionally download them as local assets.",
		parameters: FigmaRenderNodesParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await withFigmaAuth(ctx, () =>
				client.renderNodes(params.fileKey, params.nodeIds, {
					cwd: ctx.cwd,
					outputDir: params.outputDir,
					format: params.format,
					scale: params.scale,
					download: params.download,
				}),
			);
			return jsonToolResult(result, { maxChars: params.maxResponseChars ?? DEFAULT_PROCESSED_MAX_CHARS });
		},
	});
}

function processedOptions(params: ProcessedNodeParams) {
	return {
		depth: params.depth,
		includeHidden: params.includeHidden,
		includeVectors: params.includeVectors,
		includeComponentInternals: params.includeComponentInternals,
	};
}

async function renderAssets(client: FigmaClient, ctx: ExtensionContext, params: ProcessedNodeParams): Promise<Array<{ nodeId: string; url?: string | null; path?: string }>> {
	const rendered = await client.renderNodes(params.fileKey, [params.nodeId], {
		cwd: ctx.cwd,
		outputDir: params.outputDir,
		format: params.format,
		scale: params.scale,
		download: true,
	});
	return Object.entries(rendered.images).map(([nodeId, url]) => ({
		nodeId,
		url,
		path: rendered.savedFiles.find((file) => file.nodeId === nodeId)?.path,
	}));
}

function limitedTextToolResult(text: string, maxChars: number) {
	const truncated = text.length > maxChars;
	const output = truncated ? `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters; call figma_get_node_summary on a narrower child node]` : text;
	return textToolResult(output, { truncated, characters: text.length });
}
