import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type SentinelConfigScope = "global" | "local" | "memory";
export type SentinelPathAccessMode = "allow" | "ask" | "block";

export interface SentinelConfig {
	enabled?: boolean;
	features?: {
		outputScanner?: boolean;
		executionTracker?: boolean;
		permissionGate?: boolean;
		pathAccess?: boolean;
	};
	pathAccess?: {
		mode?: SentinelPathAccessMode;
		allowedPaths?: string[];
	};
	permissionGate?: {
		requireConfirmation?: boolean;
		allowedPatterns?: string[];
		autoDenyPatterns?: string[];
	};
	outputScanner?: {
		readAllowedPaths?: string[];
	};
}

export interface ResolvedSentinelConfig {
	enabled: boolean;
	features: {
		outputScanner: boolean;
		executionTracker: boolean;
		permissionGate: boolean;
		pathAccess: boolean;
	};
	pathAccess: {
		mode: SentinelPathAccessMode;
		allowedPaths: string[];
	};
	permissionGate: {
		requireConfirmation: boolean;
		allowedPatterns: string[];
		autoDenyPatterns: string[];
	};
	outputScanner: {
		readAllowedPaths: string[];
	};
}

export const DEFAULT_SENTINEL_CONFIG: ResolvedSentinelConfig = {
	enabled: true,
	features: {
		outputScanner: true,
		executionTracker: true,
		permissionGate: true,
		pathAccess: false,
	},
	pathAccess: {
		mode: "ask",
		allowedPaths: [],
	},
	permissionGate: {
		requireConfirmation: true,
		allowedPatterns: [],
		autoDenyPatterns: [],
	},
	outputScanner: {
		readAllowedPaths: [],
	},
};

export function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (!envDir) return join(homedir(), ".pi", "agent");
	if (envDir === "~") return homedir();
	if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
	return envDir;
}

function readJson(path: string): SentinelConfig | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SentinelConfig;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: SentinelConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function localScopeId(cwd: string): string {
	const normalizedCwd = resolve(cwd);
	const slug = (basename(normalizedCwd) || "root")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "root";
	const hash = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 12);
	return `${slug}-${hash}.json`;
}

function legacyLocalConfigPath(cwd: string): string {
	return join(resolve(cwd), ".pi", "extensions", "sentinel.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig<T>(base: T, override?: SentinelConfig | Record<string, unknown>): T {
	if (!override) return structuredClone(base);
	const result = structuredClone(base) as Record<string, unknown>;
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		const existing = result[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			result[key] = mergeConfig(existing, value);
		} else if (Array.isArray(value)) {
			result[key] = [...value];
		} else {
			result[key] = value;
		}
	}
	return result as T;
}

function dedupe(values: string[]): string[] {
	return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

export class SentinelConfigLoader {
	private globalConfig: SentinelConfig | undefined;
	private localConfig: SentinelConfig | undefined;
	private memoryConfig: SentinelConfig = {};
	private resolvedConfig: ResolvedSentinelConfig | undefined;
	private localCwd = process.cwd();

	load(cwd = process.cwd()): void {
		this.localCwd = cwd;
		this.globalConfig = readJson(this.getConfigPath("global"));
		const legacyLocalConfig = readJson(legacyLocalConfigPath(this.localCwd));
		const scopedLocalConfig = readJson(this.getConfigPath("local"));
		this.localConfig = legacyLocalConfig && scopedLocalConfig
			? mergeConfig(legacyLocalConfig, scopedLocalConfig)
			: scopedLocalConfig ?? legacyLocalConfig;
		this.resolvedConfig = undefined;
	}

	getConfig(): ResolvedSentinelConfig {
		if (this.resolvedConfig) return this.resolvedConfig;
		let resolved = structuredClone(DEFAULT_SENTINEL_CONFIG) as ResolvedSentinelConfig;
		resolved = mergeConfig(resolved, this.globalConfig);
		resolved = mergeConfig(resolved, this.localConfig);
		resolved = mergeConfig(resolved, this.memoryConfig);
		resolved.pathAccess.allowedPaths = dedupe(resolved.pathAccess.allowedPaths);
		resolved.permissionGate.allowedPatterns = dedupe(resolved.permissionGate.allowedPatterns);
		resolved.permissionGate.autoDenyPatterns = dedupe(resolved.permissionGate.autoDenyPatterns);
		resolved.outputScanner.readAllowedPaths = dedupe(resolved.outputScanner.readAllowedPaths);
		this.resolvedConfig = resolved;
		return resolved;
	}

	getRawConfig(scope: SentinelConfigScope): SentinelConfig | undefined {
		return scope === "global" ? this.globalConfig : scope === "local" ? this.localConfig : this.memoryConfig;
	}

	getConfigPath(scope: Exclude<SentinelConfigScope, "memory">): string {
		return scope === "global"
			? join(getAgentDir(), "extensions", "sentinel.json")
			: join(getAgentDir(), "extensions", "sentinel", "projects", localScopeId(this.localCwd));
	}

	save(scope: SentinelConfigScope, partial: SentinelConfig): void {
		if (scope === "memory") {
			this.memoryConfig = mergeConfig(this.memoryConfig, partial);
			this.resolvedConfig = undefined;
			return;
		}

		const current = scope === "global" ? (this.globalConfig ?? {}) : (this.localConfig ?? {});
		const next = mergeConfig(current, partial);
		writeJson(this.getConfigPath(scope), next);
		if (scope === "global") this.globalConfig = next;
		else this.localConfig = next;
		this.resolvedConfig = undefined;
	}

	private addListValue(scope: SentinelConfigScope, path: string, list: "allowedPaths" | "readAllowedPaths"): void {
		const raw = this.getRawConfig(scope);
		const current = list === "allowedPaths"
			? raw?.pathAccess?.allowedPaths ?? []
			: raw?.outputScanner?.readAllowedPaths ?? [];
		const values = dedupe([...current, path]);
		this.save(scope, list === "allowedPaths"
			? { pathAccess: { allowedPaths: values } }
			: { outputScanner: { readAllowedPaths: values } });
	}

	addAllowedPath(scope: SentinelConfigScope, path: string): void {
		this.addListValue(scope, path, "allowedPaths");
	}

	addReadAllowedPath(scope: SentinelConfigScope, path: string): void {
		this.addListValue(scope, path, "readAllowedPaths");
	}
}

export const configLoader = new SentinelConfigLoader();
