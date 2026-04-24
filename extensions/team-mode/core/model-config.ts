/**
 * Pi Team-Mode — Model Configuration
 *
 * Explicit role × tier × provider model catalog, matching the team-mode
 * convention. Stored at `~/.pi/agent/extensions/team-mode/model-config.json`.
 *
 * This is the PRIMARY way team-mode picks models. The regex step-down logic
 * in `model-picker.ts` is now only the fallback (for cases where no config
 * file exists, or the resolved provider has no catalog entry).
 *
 * Schema (all fields optional; defaults are merged in):
 *
 *   {
 *     "provider": "openai-codex" | "anthropic" | "auto",
 *     "providers": {
 *       "openai-codex": {
 *         "cheap": "openai-codex/gpt-5.4-mini",
 *         "mid":   "openai-codex/gpt-5.4",
 *         "deep":  "openai-codex/gpt-5.4:high"
 *       },
 *       "anthropic": {
 *         "cheap": "anthropic/claude-haiku-4-5",
 *         "mid":   "anthropic/claude-sonnet-4-6",
 *         "deep":  "anthropic/claude-opus-4-7:high"
 *       }
 *     },
 *     "roleTiers": {
 *       "researcher": "cheap",
 *       "docs":       "cheap",
 *       "backend":    "mid",
 *       "frontend":   "mid",
 *       "tester":     "mid",
 *       "planner":    "deep",
 *       "reviewer":   "deep"
 *     },
 *     "defaultTier": "mid"
 *   }
 *
 * Resolution order inside `resolveModel`:
 *   1. tierOverride (from caller's `model` param if it's "cheap"/"mid"/"deep")
 *   2. roleTiers[role]
 *   3. defaultTier
 *
 * Provider resolution:
 *   1. config.provider when not "auto"
 *   2. PI_TEAM_MATE_MODEL_PROVIDER env override
 *   3. pi settings.json defaultProvider (if that provider exists in catalogs)
 *   4. anthropic fallback
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getStorageRoot } from "./store.js";

export type ModelTier = "cheap" | "mid" | "deep";

export type ProviderCatalog = {
	cheap: string;
	mid: string;
	deep: string;
};

export type ModelConfig = {
	/** Provider to use for all teammates. Use "auto" to detect from settings. */
	provider: string;
	/** Per-provider tier → fully-qualified model id. */
	providers: Record<string, ProviderCatalog>;
	/** Role (subagent_type) → default tier. */
	roleTiers: Record<string, ModelTier>;
	/** Fallback tier for roles not in roleTiers. */
	defaultTier: ModelTier;
	/** Shell command run after a task transitions to completed. Non-zero exit reverts the task to failed. */
	taskCompletedHook?: string;
};

export type ResolvedModel = {
	/** Bare model id (no `provider/` prefix). Pi `--model` value. */
	model: string;
	/** Pi `--provider` value. */
	provider: string;
	/** Tier that was selected. */
	tier: ModelTier;
	/** One-line explanation of the resolution path. */
	rationale: string;
};

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

export function isModelTier(value: string): value is ModelTier {
	return value === "cheap" || value === "mid" || value === "deep";
}

/** Path to the model-config file for team-mode. */
export function modelConfigPath(storageRoot: string = getStorageRoot()): string {
	return join(storageRoot, CONFIG_FILENAME);
}

let cachedConfig: { root: string; config: ModelConfig } | null = null;

/**
 * Load model config from disk, merging with built-in defaults so missing keys
 * are always populated. Returns DEFAULT_MODEL_CONFIG when no file exists.
 *
 * Cached for process lifetime (user-edited config rarely changes mid-session);
 * call `invalidateModelConfigCache()` after `saveModelConfig` if you edit it.
 */
export async function loadModelConfig(
	storageRoot: string = getStorageRoot(),
): Promise<ModelConfig> {
	if (cachedConfig && cachedConfig.root === storageRoot) return cachedConfig.config;
	try {
		const raw = await readFile(modelConfigPath(storageRoot), "utf8");
		const parsed = JSON.parse(raw) as Partial<ModelConfig>;
		const merged = mergeWithDefaults(parsed);
		cachedConfig = { root: storageRoot, config: merged };
		return merged;
	} catch {
		cachedConfig = { root: storageRoot, config: DEFAULT_MODEL_CONFIG };
		return DEFAULT_MODEL_CONFIG;
	}
}

export function invalidateModelConfigCache(): void {
	cachedConfig = null;
}

/** Persist a full model config to disk. Creates the storage dir if needed. */
export async function saveModelConfig(
	config: ModelConfig,
	storageRoot: string = getStorageRoot(),
): Promise<void> {
	await mkdir(storageRoot, { recursive: true });
	await writeFile(modelConfigPath(storageRoot), JSON.stringify(config, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	invalidateModelConfigCache();
}

/**
 * Resolve the concrete `{ provider, model }` for a role + optional tier.
 * Returns `null` if the resolved provider has no catalog entry.
 *
 * @param config          The loaded model config.
 * @param role            The teammate's role (subagent_type). Empty string = use defaultTier.
 * @param tierOverride    Optional tier to force, regardless of role mapping.
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
	const fqn = catalog[tier];
	if (!fqn) return null;

	const { provider: splitProvider, id } = splitFqn(fqn);
	const rationale = buildRationale(role, tier, tierOverride, provider, config);

	return {
		provider: splitProvider ?? provider,
		model: id,
		tier,
		rationale,
	};
}

/**
 * Infer which provider to use when `config.provider === "auto"`.
 * Priority: env > pi settings.json defaultProvider > auth.json > api keys > anthropic.
 */
export function detectProvider(explicit?: string): string {
	if (explicit && explicit !== "auto") return explicit;

	const envOverride = process.env.PI_TEAM_MATE_MODEL_PROVIDER;
	if (envOverride) return envOverride;

	const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

	const settings = readJsonFileSync<{ defaultProvider?: string; defaultModel?: string }>(
		join(piAgentDir, SETTINGS_FILENAME),
	);
	if (settings?.defaultProvider && settings.defaultProvider in DEFAULT_MODEL_CONFIG.providers) {
		return settings.defaultProvider;
	}
	const hintedFromModel = providerFromModelHint(settings?.defaultModel ?? "");
	if (hintedFromModel) return hintedFromModel;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeWithDefaults(partial: Partial<ModelConfig>): ModelConfig {
	const base: ModelConfig = {
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
	if (partial.taskCompletedHook !== undefined) {
		base.taskCompletedHook = partial.taskCompletedHook;
	}
	return base;
}

function providerFromModelHint(modelHint: string): string | null {
	if (!modelHint) return null;
	if (/claude|anthropic|haiku|sonnet|opus/i.test(modelHint)) return "anthropic";
	if (/gpt|codex|openai/i.test(modelHint)) return "openai-codex";
	return null;
}

function readJsonFileSync<T>(filePath: string): T | null {
	try {
		if (!existsSync(filePath)) return null;
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}

function splitFqn(fqn: string): { provider?: string; id: string } {
	const idx = fqn.indexOf("/");
	if (idx < 0) return { id: fqn };
	return { provider: fqn.slice(0, idx), id: fqn.slice(idx + 1) };
}

function buildRationale(
	role: string,
	tier: ModelTier,
	tierOverride: ModelTier | undefined,
	provider: string,
	config: ModelConfig,
): string {
	if (tierOverride) {
		return `tier override "${tier}" on provider "${provider}"`;
	}
	if (role && config.roleTiers[role]) {
		return `role "${role}" → tier "${tier}" on provider "${provider}"`;
	}
	return `default tier "${tier}" on provider "${provider}"`;
}
