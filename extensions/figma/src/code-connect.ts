import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface CodeConnectScanOptions {
	fileKey: string;
	nodeId?: string;
	componentKey?: string;
	rootDir?: string;
	cwd: string;
	maxMatches?: number;
	maxFiles?: number;
	maxFileBytes?: number;
}

export interface CodeConnectMatch {
	path: string;
	line: number;
	kind: "figma-connect" | "figma-config" | "figma-file-reference" | "figma-node-reference" | "component-key-reference";
	preview: string;
}

export interface CodeConnectScanResult {
	rootDir: string;
	matches: CodeConnectMatch[];
	metadata: { truncated: boolean; truncatedReasons: string[]; nextSteps: string[] };
}

const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next", ".turbo", ".cache"]);
const DEFAULT_MAX_MATCHES = 40;
const DEFAULT_MAX_FILES = 1500;
const DEFAULT_MAX_FILE_BYTES = 300_000;

export async function findCodeConnectMapping(options: CodeConnectScanOptions): Promise<CodeConnectScanResult> {
	const rootDir = resolveRoot(options.cwd, options.rootDir);
	const maxMatches = clampInteger(options.maxMatches ?? DEFAULT_MAX_MATCHES, 1, 200);
	const maxFiles = clampInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 10_000);
	const maxFileBytes = clampInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1_000, 2_000_000);
	const normalizedNodeId = options.nodeId?.replace(/-/g, ":");
	const urlNodeId = normalizedNodeId?.replace(/:/g, "-");
	const matches: CodeConnectMatch[] = [];
	const truncatedReasons: string[] = [];
	let filesSeen = 0;

	async function scanDir(dir: string): Promise<void> {
		if (filesSeen >= maxFiles || matches.length >= maxMatches) return;
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (IGNORE_DIRS.has(entry.name) || (entry.name.startsWith(".") && !entry.name.startsWith(".figma"))) continue;
				await scanDir(join(dir, entry.name));
				continue;
			}
			if (!entry.isFile() || !isLikelySource(entry.name)) continue;
			filesSeen += 1;
			if (filesSeen > maxFiles) {
				truncatedReasons.push(`Scanned file cap ${maxFiles} reached.`);
				return;
			}
			const filePath = join(dir, entry.name);
			const info = await stat(filePath);
			if (info.size > maxFileBytes) continue;
			await scanFile(filePath);
			if (matches.length >= maxMatches) {
				truncatedReasons.push(`Reached maxMatches ${maxMatches}; additional matches were omitted.`);
				return;
			}
		}
	}

	async function scanFile(filePath: string): Promise<void> {
		const text = await readFile(filePath, "utf8");
		const lines = text.split(/\r?\n/);
		lines.forEach((line, index) => {
			for (const kind of classify(line, filePath, options.fileKey, normalizedNodeId, urlNodeId, options.componentKey)) {
				if (matches.length < maxMatches) matches.push({ path: relative(rootDir, filePath), line: index + 1, kind, preview: line.trim().slice(0, 240) });
			}
		});
	}

	await scanDir(rootDir);
	const nextSteps = matches.length ? ["Open matched files to inspect local component props and implementation conventions."] : ["No local Code Connect mapping was found; use Figma implementation context and existing component search next."];
	if (truncatedReasons.length) nextSteps.push("Narrow rootDir or raise maxMatches/maxFiles if you expect more mappings.");
	return { rootDir, matches, metadata: { truncated: truncatedReasons.length > 0, truncatedReasons: [...new Set(truncatedReasons)], nextSteps } };
}

function classify(line: string, filePath: string, fileKey: string, nodeId?: string, urlNodeId?: string, componentKey?: string): Array<CodeConnectMatch["kind"]> {
	const lowerPath = filePath.toLowerCase();
	const kinds: Array<CodeConnectMatch["kind"]> = [];
	if (/figma\.connect\s*\(/.test(line)) kinds.push("figma-connect");
	if ((/figma\.config\.|figma\.config\.(js|ts|mjs|cjs)$/.test(line) || /figma\.config\./.test(lowerPath) || /\.figma\./.test(lowerPath)) && line.trim()) kinds.push("figma-config");
	if (line.includes(fileKey)) kinds.push("figma-file-reference");
	if (nodeId && (line.includes(nodeId) || (urlNodeId && line.includes(urlNodeId)))) kinds.push("figma-node-reference");
	if (componentKey && line.includes(componentKey)) kinds.push("component-key-reference");
	return kinds;
}

function resolveRoot(cwd: string, rootDir?: string): string {
	if (!rootDir) return cwd;
	const resolved = isAbsolute(rootDir) ? resolve(rootDir) : resolve(cwd, rootDir);
	const cwdResolved = resolve(cwd);
	if (resolved !== cwdResolved && !resolved.startsWith(`${cwdResolved}/`)) throw new Error("rootDir must be inside the current working directory.");
	return resolved;
}

function isLikelySource(name: string): boolean {
	return /(?:figma\.config\..*|\.figma\..*|\.(tsx?|jsx?|vue|svelte|mdx?|json|ya?ml))$/i.test(name);
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}
