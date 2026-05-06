import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

export type FigmaAssetType = "svgIcons" | "nodeRenders" | "imageFills";
export type FigmaAssetKind = "svgIcon" | "nodeRender" | "imageFill";

export interface FigmaAssetCandidate {
	kind: FigmaAssetKind;
	nodeId?: string;
	nodeName?: string;
	nodeType?: string;
	nodePath: string;
	imageRef?: string;
	fillIndex?: number;
	suggestedName: string;
}

export interface FigmaAssetManifestEntry extends FigmaAssetCandidate {
	format: "png" | "jpg" | "svg" | "webp" | "unknown";
	path?: string;
	url?: string | null;
	sha256?: string;
	bytes?: number;
}

export interface FigmaAssetCollectionResult {
	assets: FigmaAssetCandidate[];
	metadata: { truncated: boolean; truncatedReasons: string[]; nextSteps: string[] };
}

export interface FigmaExtractAssetsResult {
	nodeId: string;
	assetTypes: FigmaAssetType[];
	assets: FigmaAssetManifestEntry[];
	metadata: { truncated: boolean; truncatedReasons: string[]; nextSteps: string[] };
}

const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "ELLIPSE", "POLYGON", "REGULAR_POLYGON"]);
const DEFAULT_MAX_ASSETS = 80;

export function collectAssetCandidates(node: unknown, options: { assetTypes?: FigmaAssetType[]; includeHidden?: boolean; maxAssets?: number } = {}): FigmaAssetCollectionResult {
	const assetTypes = new Set(options.assetTypes?.length ? options.assetTypes : (["svgIcons", "nodeRenders", "imageFills"] as FigmaAssetType[]));
	const maxAssets = clampInteger(options.maxAssets ?? DEFAULT_MAX_ASSETS, 1, 500);
	const assets: FigmaAssetCandidate[] = [];
	const truncatedReasons: string[] = [];

	function push(candidate: FigmaAssetCandidate): void {
		if (assets.length >= maxAssets) {
			if (!truncatedReasons.some((reason) => reason.includes("maxAssets"))) truncatedReasons.push(`Reached maxAssets ${maxAssets}; additional assets were omitted.`);
			return;
		}
		assets.push(candidate);
	}

	walk(node, options.includeHidden ?? false, (record, path, level) => {
		const name = String(record.name ?? "Asset");
		const type = String(record.type ?? "UNKNOWN");
		const id = stringValue(record.id);
		if (assetTypes.has("svgIcons") && id && isIconCandidate(record)) {
			push({ kind: "svgIcon", nodeId: id, nodeName: name, nodeType: type, nodePath: path, suggestedName: `${safeFilename(name || id)}.svg` });
		}
		if (assetTypes.has("nodeRenders") && id && (level === 0 || /asset|illustration|image|card|avatar|logo/i.test(name))) {
			push({ kind: "nodeRender", nodeId: id, nodeName: name, nodeType: type, nodePath: path, suggestedName: `${safeFilename(name || id)}.png` });
		}
		if (assetTypes.has("imageFills")) {
			const fills = Array.isArray(record.fills) ? record.fills : [];
			fills.forEach((fill, index) => {
				const fillRecord = asRecord(fill);
				const imageRef = stringValue(fillRecord.imageRef);
				if (imageRef) push({ kind: "imageFill", nodeId: id, nodeName: name, nodeType: type, nodePath: path, imageRef, fillIndex: index, suggestedName: `${safeFilename(name || imageRef)}.${formatFromScaleMode(fillRecord.scaleMode)}` });
			});
		}
	});

	return {
		assets,
		metadata: {
			truncated: truncatedReasons.length > 0,
			truncatedReasons,
			nextSteps: truncatedReasons.length ? ["Raise maxAssets or extract assets from a narrower child node."] : [],
		},
	};
}

export async function manifestEntryFromFile(candidate: FigmaAssetCandidate, filePath: string, url?: string | null, format?: FigmaAssetManifestEntry["format"]): Promise<FigmaAssetManifestEntry> {
	const bytes = await readFile(filePath);
	return { ...candidate, path: filePath, url, format: format ?? formatFromPath(filePath), sha256: sha256(bytes), bytes: bytes.byteLength };
}

export function manifestEntryFromUrl(candidate: FigmaAssetCandidate, url: string | null | undefined, format: FigmaAssetManifestEntry["format"]): FigmaAssetManifestEntry {
	return { ...candidate, url: url ?? null, format };
}

export function sha256(value: Buffer | Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function safeFilename(value: string): string {
	return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "figma-asset";
}

export function formatFromPath(path: string): FigmaAssetManifestEntry["format"] {
	const extension = extname(path || basename(path)).toLowerCase().replace(/^\./, "");
	if (extension === "png" || extension === "jpg" || extension === "svg" || extension === "webp") return extension;
	if (extension === "jpeg") return "jpg";
	return "unknown";
}

function formatFromScaleMode(_value: unknown): "png" {
	return "png";
}

function isIconCandidate(record: Record<string, unknown>): boolean {
	const type = String(record.type ?? "UNKNOWN");
	const name = String(record.name ?? "");
	const box = asRecord(record.absoluteBoundingBox);
	const width = numberValue(box.width) ?? 0;
	const height = numberValue(box.height) ?? 0;
	return VECTOR_TYPES.has(type) || /\b(icon|logo|glyph)\b/i.test(name) || (width > 0 && height > 0 && width <= 64 && height <= 64 && !Array.isArray(record.children));
}

function walk(node: unknown, includeHidden: boolean, visit: (record: Record<string, unknown>, path: string, level: number) => void, path = "", level = 0): void {
	const record = asRecord(node);
	if (!includeHidden && record.visible === false) return;
	const name = String(record.name ?? "Unnamed node");
	const nextPath = path ? `${path} > ${name}` : name;
	visit(record, nextPath, level);
	for (const child of Array.isArray(record.children) ? record.children : []) walk(child, includeHidden, visit, nextPath, level + 1);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}
