import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readAuthToken } from "pi-common/auth";
import { createHttpClient, type HttpClient } from "pi-common/http-client";
import { createRateLimiter, type RateLimiter } from "pi-common/rate-limiter";
import { figmaCache } from "./figma-cache.js";
import {
	collectAssetCandidates,
	manifestEntryFromFile,
	manifestEntryFromUrl,
	safeFilename,
	type FigmaAssetManifestEntry,
	type FigmaAssetType,
	type FigmaExtractAssetsResult,
} from "./figma-assets.js";
import { findCodeConnectMapping, type CodeConnectScanResult } from "./code-connect.js";
import { buildComponentImplementationHints, type FigmaComponentImplementationHints } from "./figma-component-hints.js";
import {
	explainNode,
	extractVisibleText,
	getImplementationContext,
	summarizeNode,
	type FigmaImplementationContext,
	type FigmaImplementationContextOptions,
	type FigmaNodeSummary,
	type FigmaRenderedAsset,
	type FigmaSummarizerOptions,
	type FigmaTextExtractionResult,
} from "./figma-summarizer.js";
import { findNodesByName, findNodesByText, type FigmaFindNodesOptions, type FigmaNodeSearchResult } from "./figma-search.js";
import { buildFigmaTokenMap } from "./figma-tokens.js";

export interface FigmaClientOptions {
	baseUrl?: string;
	timeoutMs?: number;
}

export interface RenderNodesOptions {
	format?: "png" | "jpg" | "svg" | "pdf";
	scale?: number;
	outputDir?: string;
	download?: boolean;
	cwd: string;
}

export interface FigmaGetNodesOptions {
	depth?: number;
}

export interface ParsedFigmaUrl {
	fileKey: string;
	nodeId?: string;
}

export interface RenderNodesResult {
	images: Record<string, string | null>;
	savedFiles: Array<{ nodeId: string; path: string }>;
}

export interface ExtractAssetsOptions {
	depth?: number;
	assetTypes?: FigmaAssetType[];
	outputDir?: string;
	includeHidden?: boolean;
	maxAssets?: number;
	cwd: string;
}

export interface ComponentHintsOptions extends FigmaImplementationContextOptions {
	includeCodeConnect?: boolean;
	includeSnippet?: boolean;
	rootDir?: string;
	cwd: string;
}

export class FigmaClient {
	private readonly http: HttpClient;
	private readonly limiter: RateLimiter;

	constructor(options: FigmaClientOptions = {}) {
		this.http = createHttpClient({
			baseUrl: options.baseUrl ?? "https://api.figma.com",
			timeoutMs: options.timeoutMs ?? 30_000,
			service: "Figma",
			headers: async () => ({ "X-Figma-Token": await readFigmaToken() }),
		});
		this.limiter = createRateLimiter({ minIntervalMs: 1_000 });
	}

	getFile(fileKey: string, depth?: number): Promise<unknown> {
		const query = depth ? `?depth=${depth}` : "";
		return this.cached(`file:${fileKey}:${depth ?? "all"}`, () => this.get(`/v1/files/${fileKey}${query}`));
	}

	getNodes(fileKey: string, nodeIds: readonly string[], options: FigmaGetNodesOptions = {}): Promise<unknown> {
		const ids = normalizeNodeIds(nodeIds).join(",");
		const depth = options.depth ? clampInteger(options.depth, 1, 4) : undefined;
		const depthQuery = depth ? `&depth=${depth}` : "";
		return this.cached(`nodes:${fileKey}:${ids}:${depth ?? "all"}`, () => this.get(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(ids)}${depthQuery}`));
	}

	getStyles(fileKey: string): Promise<unknown> {
		return this.cached(`styles:${fileKey}`, () => this.get(`/v1/files/${fileKey}/styles`));
	}

	getComponents(fileKey: string): Promise<unknown> {
		return this.cached(`components:${fileKey}`, () => this.get(`/v1/files/${fileKey}/components`));
	}

	getComponentSets(fileKey: string): Promise<unknown> {
		return this.cached(`componentSets:${fileKey}`, () => this.get(`/v1/files/${fileKey}/component_sets`));
	}

	getVariables(fileKey: string): Promise<unknown> {
		return this.cached(`variables:${fileKey}`, () => this.get(`/v1/files/${fileKey}/variables/local`));
	}

	async searchComponents(fileKey: string, query: string): Promise<unknown> {
		const response = await this.getComponents(fileKey);
		const components = getNestedArray(response, ["meta", "components"]);
		const needle = query.toLowerCase();
		return components.filter((component) => {
			const record = component as Record<string, unknown>;
			return String(record.name ?? "").toLowerCase().includes(needle) || String(record.description ?? "").toLowerCase().includes(needle);
		});
	}

	async getDesignContext(fileKey: string, nodeId?: string): Promise<unknown> {
		if (nodeId) return this.getTargetDesignContext(fileKey, nodeId);

		const file = await this.getFile(fileKey, 2);
		const fileRecord = asRecord(file);
		return {
			file: {
				name: fileRecord.name,
				lastModified: fileRecord.lastModified,
				version: fileRecord.version,
			},
			document: {
				name: asRecord(fileRecord.document).name,
				children: collectTopLevelStructure(fileRecord.document),
			},
			metadata: {
				truncated: true,
				note: "Only canvases and top-level frames are returned by default. Pass nodeId and use processed node tools for details.",
				nextSteps: ["Call figma_get_node_summary or figma_explain_node for a specific node.", "Use figma_get_file only for raw debugging."],
			},
		};
	}

	async getNodeSummary(fileKey: string, nodeId: string, options: FigmaSummarizerOptions = {}): Promise<FigmaNodeSummary> {
		return summarizeNode(await this.getSingleNodeDocument(fileKey, nodeId, options.depth ?? 2), options);
	}

	async extractText(fileKey: string, nodeId: string, options: FigmaSummarizerOptions = {}): Promise<FigmaTextExtractionResult> {
		return extractVisibleText(await this.getSingleNodeDocument(fileKey, nodeId, options.depth ?? 2), options);
	}

	async explainNode(fileKey: string, nodeId: string, options: FigmaSummarizerOptions & { assets?: FigmaRenderedAsset[] } = {}): Promise<string> {
		return explainNode(await this.getSingleNodeDocument(fileKey, nodeId, options.depth ?? 2), options);
	}

	async getImplementationContext(fileKey: string, nodeId: string, options: FigmaImplementationContextOptions = {}): Promise<FigmaImplementationContext> {
		const document = await this.getSingleNodeDocument(fileKey, nodeId, options.depth ?? 2);
		if (options.resolveTokens === false) return getImplementationContext(document, options);
		try {
			const [styles, variables] = await Promise.all([this.getStyles(fileKey), this.getVariables(fileKey)]);
			return getImplementationContext(document, { ...options, tokenMap: buildFigmaTokenMap(styles, variables) });
		} catch {
			return getImplementationContext(document, options);
		}
	}

	async findNodesByName(fileKey: string, params: FigmaFindNodesOptions & { nodeId?: string }): Promise<FigmaNodeSearchResult> {
		const document = await this.getSearchRoot(fileKey, params);
		const result = findNodesByName(document, params);
		if (!params.nodeId) {
			result.metadata.nextSteps.unshift("Full-file search is depth-limited; pass nodeId from figma_get_design_context to search a specific frame more precisely.");
		}
		return result;
	}

	async findNodesByText(fileKey: string, params: FigmaFindNodesOptions & { nodeId?: string }): Promise<FigmaNodeSearchResult> {
		const document = await this.getSearchRoot(fileKey, params);
		const result = findNodesByText(document, params);
		if (!params.nodeId) {
			result.metadata.nextSteps.unshift("Full-file search is depth-limited; pass nodeId from figma_get_design_context to search a specific frame more precisely.");
		}
		return result;
	}

	async getNodeMetadata(fileKey: string, nodeIds: readonly string[]): Promise<unknown> {
		const response = await this.getNodes(fileKey, nodeIds, { depth: 2 });
		const nodes = asRecord(response).nodes;
		return Object.entries(asRecord(nodes)).map(([id, value]) => {
			const document = asRecord(asRecord(value).document);
			return {
				id,
				name: document.name,
				type: document.type,
				boundingBox: document.absoluteBoundingBox,
				constraints: document.constraints,
				layout: {
					layoutMode: document.layoutMode,
					itemSpacing: document.itemSpacing,
					paddingLeft: document.paddingLeft,
					paddingRight: document.paddingRight,
					paddingTop: document.paddingTop,
					paddingBottom: document.paddingBottom,
					primaryAxisAlignItems: document.primaryAxisAlignItems,
					counterAxisAlignItems: document.counterAxisAlignItems,
				},
				cornerRadius: document.cornerRadius,
				opacity: document.opacity,
				effects: document.effects ?? [],
				fills: document.fills ?? [],
				strokes: document.strokes ?? [],
				strokeWeight: document.strokeWeight,
				children: getNestedArray(document, ["children"]).map((child) => {
					const childRecord = asRecord(child);
					return {
						id: childRecord.id,
						name: childRecord.name,
						type: childRecord.type,
						boundingBox: childRecord.absoluteBoundingBox,
						visible: childRecord.visible ?? true,
					};
				}),
			};
		});
	}

	async renderNodes(fileKey: string, nodeIds: readonly string[], options: RenderNodesOptions): Promise<RenderNodesResult> {
		const ids = normalizeNodeIds(nodeIds).join(",");
		const format = options.format ?? "png";
		const scale = options.scale ?? 2;
		const response = await this.get<{ images?: Record<string, string | null>; err?: string }>(
			`/v1/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=${format}&scale=${scale}`,
		);
		if (response.err) throw new Error(response.err);

		const images = response.images ?? {};
		const savedFiles: Array<{ nodeId: string; path: string }> = [];
		if (options.download ?? true) {
			const outputDir = await resolveOutputDir(options.cwd, options.outputDir);
			await mkdir(outputDir, { recursive: true });
			for (const [nodeId, url] of Object.entries(images)) {
				if (!url) continue;
				const extension = format === "jpg" ? "jpg" : format;
				const safeNodeId = nodeId.replace(/[^a-z0-9_-]/gi, "_");
				const outputPath = resolve(outputDir, `${fileKey}_${safeNodeId}.${extension}`);
				const bytes = await this.http.download(url);
				await writeFile(outputPath, Buffer.from(bytes));
				savedFiles.push({ nodeId, path: outputPath });
			}
		}

		return { images, savedFiles };
	}

	getImageFills(fileKey: string): Promise<Record<string, string>> {
		return this.cached(`imageFills:${fileKey}`, async () => {
			const response = await this.get<{ meta?: { images?: Record<string, string> } }>(`/v1/files/${fileKey}/images`);
			return response.meta?.images ?? {};
		});
	}

	async extractAssets(fileKey: string, nodeId: string, options: ExtractAssetsOptions): Promise<FigmaExtractAssetsResult> {
		const document = await this.getSingleNodeDocument(fileKey, nodeId, options.depth ?? 3);
		const assetTypes = options.assetTypes?.length ? options.assetTypes : (["svgIcons", "nodeRenders", "imageFills"] as FigmaAssetType[]);
		const collected = collectAssetCandidates(document, { assetTypes, includeHidden: options.includeHidden, maxAssets: options.maxAssets });
		const outputDir = await resolveOutputDir(options.cwd, options.outputDir);
		await mkdir(outputDir, { recursive: true });
		const manifest: FigmaAssetManifestEntry[] = [];

		const svgCandidates = collected.assets.filter((asset) => asset.kind === "svgIcon" && asset.nodeId);
		if (svgCandidates.length) {
			const rendered = await this.renderNodes(fileKey, svgCandidates.map((asset) => asset.nodeId as string), { cwd: options.cwd, outputDir, format: "svg", download: true });
			for (const candidate of svgCandidates) {
				const file = rendered.savedFiles.find((saved) => saved.nodeId === candidate.nodeId);
				manifest.push(file ? await manifestEntryFromFile(candidate, file.path, rendered.images[candidate.nodeId as string], "svg") : manifestEntryFromUrl(candidate, rendered.images[candidate.nodeId as string], "svg"));
			}
		}

		const renderCandidates = collected.assets.filter((asset) => asset.kind === "nodeRender" && asset.nodeId);
		if (renderCandidates.length) {
			const rendered = await this.renderNodes(fileKey, renderCandidates.map((asset) => asset.nodeId as string), { cwd: options.cwd, outputDir, format: "png", download: true });
			for (const candidate of renderCandidates) {
				const file = rendered.savedFiles.find((saved) => saved.nodeId === candidate.nodeId);
				manifest.push(file ? await manifestEntryFromFile(candidate, file.path, rendered.images[candidate.nodeId as string], "png") : manifestEntryFromUrl(candidate, rendered.images[candidate.nodeId as string], "png"));
			}
		}

		const imageFillCandidates = collected.assets.filter((asset) => asset.kind === "imageFill" && asset.imageRef);
		if (imageFillCandidates.length) {
			const images = await this.getImageFills(fileKey);
			for (const candidate of imageFillCandidates) {
				const url = images[candidate.imageRef as string];
				if (!url) {
					manifest.push(manifestEntryFromUrl(candidate, null, "unknown"));
					continue;
				}
				const bytes = await this.http.download(url);
				const extension = url.includes(".webp") ? "webp" : url.includes(".jpg") || url.includes(".jpeg") ? "jpg" : "png";
				const outputPath = resolve(outputDir, `${safeFilename(candidate.suggestedName.replace(/\.[^.]+$/, ""))}-${safeFilename(candidate.imageRef as string).slice(0, 12)}.${extension}`);
				await writeFile(outputPath, Buffer.from(bytes));
				manifest.push(await manifestEntryFromFile(candidate, outputPath, url, extension));
			}
		}

		const unresolvedFills = manifest.filter((entry) => entry.kind === "imageFill" && !entry.url).length;
		return {
			nodeId: normalizeNodeId(nodeId),
			assetTypes,
			assets: manifest,
			metadata: {
				truncated: collected.metadata.truncated,
				truncatedReasons: [...collected.metadata.truncatedReasons, ...(unresolvedFills ? [`${unresolvedFills} image fill(s) could not be resolved to downloadable URLs.`] : [])],
				nextSteps: [...collected.metadata.nextSteps, "Use manifest nodePath values to map downloaded files back to source Figma layers."],
			},
		};
	}

	findCodeConnectMapping(options: { fileKey: string; nodeId?: string; componentKey?: string; rootDir?: string; maxMatches?: number; cwd: string }): Promise<CodeConnectScanResult> {
		return findCodeConnectMapping(options);
	}

	async getComponentImplementationHints(fileKey: string, nodeId: string, options: ComponentHintsOptions): Promise<FigmaComponentImplementationHints> {
		const summary = await this.getNodeSummary(fileKey, nodeId, options);
		const implementation = await this.getImplementationContext(fileKey, nodeId, { ...options, includeCodeSnippets: options.includeSnippet ?? options.includeCodeSnippets });
		const codeConnect = options.includeCodeConnect === false ? undefined : await this.findCodeConnectMapping({ fileKey, nodeId, rootDir: options.rootDir, cwd: options.cwd });
		return buildComponentImplementationHints(summary, implementation, { framework: options.framework, styling: options.styling, includeSnippet: options.includeSnippet ?? options.includeCodeSnippets, includeCodeConnect: options.includeCodeConnect !== false }, codeConnect);
	}

	private get<T = unknown>(path: string): Promise<T> {
		return this.limiter.schedule(() => this.http.get<T>(path));
	}

	private async getTargetDesignContext(fileKey: string, nodeId: string): Promise<unknown> {
		const [file, targetSummary] = await Promise.all([this.getFile(fileKey, 2), this.getNodeSummary(fileKey, nodeId, { depth: 2 })]);
		const fileRecord = asRecord(file);
		const normalizedNodeId = normalizeNodeId(nodeId);
		const shallowStructure = collectTopLevelStructure(fileRecord.document);
		const targetLocation = findShallowLocation(fileRecord.document, normalizedNodeId);

		return {
			file: {
				name: fileRecord.name,
				lastModified: fileRecord.lastModified,
				version: fileRecord.version,
			},
			targetNode: targetSummary,
			location: targetLocation ?? {
				targetNodeId: normalizedNodeId,
				note: "Target node is not present in the shallow file tree, so ancestors/siblings are unavailable without raw debugging.",
			},
			document: {
				name: asRecord(fileRecord.document).name,
				children: shallowStructure,
			},
			metadata: {
				truncated: targetSummary.metadata?.truncated ?? true,
				note: "Design context is compact: target summary plus shallow file structure only.",
				nextSteps: targetSummary.metadata?.nextSteps?.length
					? targetSummary.metadata.nextSteps
					: ["Call figma_explain_node for a human-readable explanation.", "Call figma_get_implementation_context for coding details."],
			},
		};
	}

	private async getSingleNodeDocument(fileKey: string, nodeId: string, depth: number): Promise<unknown> {
		const normalizedNodeId = normalizeNodeId(nodeId);
		const response = await this.getNodes(fileKey, [normalizedNodeId], { depth });
		const document = asRecord(asRecord(asRecord(response).nodes)[normalizedNodeId]).document;
		if (!document) throw new Error(`Figma node ${normalizedNodeId} was not found in file ${fileKey}.`);
		return document;
	}

	private async getSearchRoot(fileKey: string, params: FigmaFindNodesOptions & { nodeId?: string }): Promise<unknown> {
		const depth = params.depth ? clampInteger(params.depth, 1, 4) : 4;
		if (params.nodeId) return this.getSingleNodeDocument(fileKey, params.nodeId, depth);
		const file = await this.getFile(fileKey, depth);
		return asRecord(file).document;
	}

	private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
		return figmaCache.getOrSet(key, load) as Promise<T>;
	}
}

export function readFigmaToken(): Promise<string> {
	return readAuthToken({ envName: "FIGMA_TOKEN", authPath: ["figma", "token"] });
}

export function parseFigmaUrl(url: string): ParsedFigmaUrl {
	const parsed = new URL(url);
	const parts = parsed.pathname.split("/").filter(Boolean);
	const fileKey = parts[1];
	if (!fileKey || !["design", "file", "proto"].includes(parts[0] ?? "")) {
		throw new Error("Expected a Figma URL like https://www.figma.com/design/<fileKey>/...");
	}
	const nodeId = parsed.searchParams.get("node-id") ?? undefined;
	return { fileKey, nodeId: nodeId ? normalizeNodeId(nodeId) : undefined };
}

export function normalizeNodeId(nodeId: string): string {
	return nodeId.replace(/-/g, ":");
}

export function normalizeNodeIds(nodeIds: readonly string[]): string[] {
	return nodeIds.map(normalizeNodeId);
}

async function resolveOutputDir(cwd: string, outputDir?: string): Promise<string> {
	if (!outputDir) return mkdtemp(join(tmpdir(), "pi-figma-assets-"));
	return isAbsolute(outputDir) ? outputDir : resolve(cwd, outputDir);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getChildren(value: unknown): unknown[] {
	const children = asRecord(value).children;
	return Array.isArray(children) ? children : [];
}

function getNestedArray(value: unknown, path: readonly string[]): unknown[] {
	let current = value;
	for (const segment of path) current = asRecord(current)[segment];
	return Array.isArray(current) ? current : [];
}

function collectTopLevelStructure(value: unknown): Array<{ id: unknown; name: unknown; type: unknown; children?: Array<{ id: unknown; name: unknown; type: unknown }> }> {
	const document = asRecord(value);
	return getChildren(document).map((page) => {
		const pageRecord = asRecord(page);
		return {
			id: pageRecord.id,
			name: pageRecord.name,
			type: pageRecord.type,
			children: getChildren(pageRecord).slice(0, 100).map((child) => {
				const childRecord = asRecord(child);
				return { id: childRecord.id, name: childRecord.name, type: childRecord.type };
			}),
		};
	});
}

function findShallowLocation(value: unknown, nodeId: string): unknown {
	for (const page of getChildren(value)) {
		const pageRecord = asRecord(page);
		const pageChildren = getChildren(pageRecord);
		for (const child of pageChildren) {
			const childRecord = asRecord(child);
			if (childRecord.id === nodeId) {
				return {
					page: { id: pageRecord.id, name: pageRecord.name, type: pageRecord.type },
					ancestors: [{ id: pageRecord.id, name: pageRecord.name, type: pageRecord.type }],
					siblingNames: pageChildren.filter((sibling) => asRecord(sibling).id !== nodeId).slice(0, 100).map((sibling) => asRecord(sibling).name),
				};
			}
		}
	}
	return null;
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}
