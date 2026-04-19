/**
 * Pi Teams — Model Configuration
 *
 * Resolves which concrete model to use for a teammate subprocess based on:
 *  - the active LLM provider (anthropic, openai-codex, ...)
 *  - a role -> tier mapping (cheap / mid / deep)
 *  - an optional per-task tier override set by the leader
 *
 * Keeping policy (tiers by role/task) separate from physics (provider model IDs)
 * lets users swap providers without rewriting task logic.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ModelTier = "cheap" | "mid" | "deep";

export interface ProviderCatalog {
	cheap: string;
	mid: string;
	deep: string;
}

export interface ModelConfig {
	/** Which provider's catalog to use. "auto" runs detectProvider(). */
	provider: string;
	/** Per-provider tier -> concrete model mapping. */
	providers: Record<string, ProviderCatalog>;
	/** Role -> default tier. Leader uses this unless a task overrides. */
	roleTiers: Record<string, ModelTier>;
	/** Fallback tier for roles not listed in roleTiers. */
	defaultTier: ModelTier;
}

export interface ResolvedModel {
	model: string;
	tier: ModelTier;
	provider: string;
}

/**
 * Built-in defaults. Mirrors pi-subagents conventions:
 *  - research / docs -> cheap
 *  - implementation -> mid
 *  - planning / review -> deep (high thinking)
 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
	provider: "auto",
	providers: {
		anthropic: {
			cheap: "anthropic/claude-haiku-4-5",
			mid: "anthropic/claude-sonnet-4-6",
			deep: "anthropic/claude-opus-4-7:high",
		},
		"openai-codex": {
			cheap: "openai-codex/gpt-5.4-mini",
			mid: "openai-codex/gpt-5.4",
			deep: "openai-codex/gpt-5.4:high",
		},
	},
	roleTiers: {
		researcher: "cheap",
		docs: "cheap",
		backend: "mid",
		frontend: "mid",
		tester: "mid",
		planner: "deep",
		reviewer: "deep",
	},
	defaultTier: "mid",
};

const CONFIG_FILENAME = "model-config.json";
const SETTINGS_FILENAME = "settings.json";
const AUTH_FILENAME = "auth.json";

function getPiAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function readJsonFileSync<T>(filePath: string): T | null {
	try {
		if (!existsSync(filePath)) return null;
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}

function providerFromModelHint(modelHint: string): string | null {
	if (!modelHint) return null;
	if (/claude|anthropic|haiku|sonnet|opus/i.test(modelHint)) return "anthropic";
	if (/gpt|codex|openai/i.test(modelHint)) return "openai-codex";
	return null;
}

/**
 * Infer which provider the user is on.
 * Priority: explicit config > PI_TEAM_MODEL_PROVIDER env > process model hints >
 * pi settings.json defaultProvider/defaultModel > auth.json presence > API keys >
 * anthropic fallback.
 */
export function detectProvider(explicit?: string): string {
	if (explicit && explicit !== "auto") return explicit;

	const envOverride = process.env.PI_TEAM_MODEL_PROVIDER;
	if (envOverride) return envOverride;

	const modelHint = process.env.PI_MODEL ?? process.env.ANTHROPIC_MODEL ?? process.env.OPENAI_MODEL ?? "";
	const hintedProvider = providerFromModelHint(modelHint);
	if (hintedProvider) return hintedProvider;

	const piAgentDir = getPiAgentDir();
	const settings = readJsonFileSync<{ defaultProvider?: string; defaultModel?: string }>(
		join(piAgentDir, SETTINGS_FILENAME),
	);
	if (settings?.defaultProvider && settings.defaultProvider in DEFAULT_MODEL_CONFIG.providers) {
		return settings.defaultProvider;
	}
	const settingsHint = providerFromModelHint(settings?.defaultModel ?? "");
	if (settingsHint) return settingsHint;

	const auth = readJsonFileSync<Record<string, unknown>>(join(piAgentDir, AUTH_FILENAME));
	if (auth) {
		if (settings?.defaultProvider && auth[settings.defaultProvider]) {
			return settings.defaultProvider;
		}
		if (auth["openai-codex"]) return "openai-codex";
		if (auth.anthropic) return "anthropic";
	}

	if (process.env.ANTHROPIC_API_KEY) return "anthropic";
	if (process.env.OPENAI_API_KEY) return "openai-codex";

	return "anthropic";
}

/**
 * Resolve the concrete model string for a role + optional tier override.
 * Returns null if the provider has no catalog entry for the resolved tier.
 */
export function resolveModel(
	config: ModelConfig,
	role: string,
	tierOverride?: ModelTier,
): ResolvedModel | null {
	const provider = detectProvider(config.provider);
	const catalog = config.providers[provider];
	if (!catalog) return null;

	const tier = tierOverride ?? config.roleTiers[role] ?? config.defaultTier;
	const model = catalog[tier];
	if (!model) return null;

	return { model, tier, provider };
}

/** Path to the per-project model config file. */
function configPath(teamsDir: string): string {
	return join(teamsDir, CONFIG_FILENAME);
}

/**
 * Load model config from disk, merging with defaults so missing keys are
 * always present. Returns DEFAULT_MODEL_CONFIG when no file exists.
 */
export async function loadModelConfig(teamsDir: string): Promise<ModelConfig> {
	try {
		const raw = await readFile(configPath(teamsDir), "utf8");
		const parsed = JSON.parse(raw) as Partial<ModelConfig>;
		return mergeWithDefaults(parsed);
	} catch {
		return DEFAULT_MODEL_CONFIG;
	}
}

/** Persist a full model config to disk. Creates the teams dir if needed. */
export async function saveModelConfig(teamsDir: string, config: ModelConfig): Promise<void> {
	await mkdir(teamsDir, { recursive: true });
	await writeFile(configPath(teamsDir), JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
}

function mergeWithDefaults(partial: Partial<ModelConfig>): ModelConfig {
	return {
		provider: partial.provider ?? DEFAULT_MODEL_CONFIG.provider,
		providers: {
			...DEFAULT_MODEL_CONFIG.providers,
			...(partial.providers ?? {}),
		},
		roleTiers: {
			...DEFAULT_MODEL_CONFIG.roleTiers,
			...(partial.roleTiers ?? {}),
		},
		defaultTier: partial.defaultTier ?? DEFAULT_MODEL_CONFIG.defaultTier,
	};
}

export function isModelTier(value: string): value is ModelTier {
	return value === "cheap" || value === "mid" || value === "deep";
}
