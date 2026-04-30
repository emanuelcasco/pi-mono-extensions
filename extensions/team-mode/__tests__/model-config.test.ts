/**
 * Pi Team-Mode — Model Config Tests
 *
 * Covers loadModelConfig / resolveModel / detectProvider and asserts the
 * exact shape the user keeps at ~/.pi/agent/extensions/team-mode/model-config.json
 * resolves to openai-codex/gpt-5.4-{mini,regular,:high} by role/tier.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
	DEFAULT_MODEL_CONFIG,
	detectProvider,
	isModelTier,
	loadModelConfig,
	modelConfigPath,
	resolveModel,
	saveModelConfig,
	type ModelConfig,
} from "../core/model-config.ts";

function withEnv<T>(patch: NodeJS.ProcessEnv, fn: () => T): T {
	const prev: NodeJS.ProcessEnv = {};
	for (const k of Object.keys(patch)) {
		prev[k] = process.env[k];
		if (patch[k] === undefined) delete process.env[k];
		else process.env[k] = patch[k];
	}
	try {
		return fn();
	} finally {
		for (const k of Object.keys(patch)) {
			if (prev[k] === undefined) delete process.env[k];
			else process.env[k] = prev[k];
		}
	}
}

const USER_CONFIG: ModelConfig = {
	provider: "openai-codex",
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
	tiers: {
		...DEFAULT_MODEL_CONFIG.tiers,
		cheap: { name: "Cheap", thinkingLevel: "minimal" },
		mid: { name: "Mid", thinkingLevel: "medium" },
		deep: { name: "Deep", thinkingLevel: "high" },
	},
	roles: {
		...DEFAULT_MODEL_CONFIG.roles,
		researcher: "cheap",
		docs: "cheap",
		backend: "mid",
		frontend: "mid",
		tester: "mid",
		planner: "deep",
		reviewer: "deep",
		leader: "mid",
	},
	roleTiers: {
		researcher: "cheap",
		docs: "cheap",
		backend: "mid",
		frontend: "mid",
		tester: "mid",
		planner: "deep",
		reviewer: "deep",
		leader: "mid",
	},
	defaultTier: "mid",
	defaultThinkingLevel: undefined,
	tierThinkingLevels: {
		...(DEFAULT_MODEL_CONFIG.tierThinkingLevels ?? {}),
		cheap: "minimal",
		mid: "medium",
		deep: "high",
	},
	roleThinkingLevels: {},
};

describe("isModelTier", () => {
	test("accepts the three tiers", () => {
		assert.equal(isModelTier("cheap"), true);
		assert.equal(isModelTier("mid"), true);
		assert.equal(isModelTier("deep"), true);
	});

	test("rejects anything else", () => {
		assert.equal(isModelTier("MID"), false);
		assert.equal(isModelTier("fast"), false);
		assert.equal(isModelTier(""), false);
	});
});

describe("loadModelConfig / saveModelConfig", () => {
	test("round-trips a config to disk", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			await saveModelConfig(USER_CONFIG, dir);
			const loaded = await loadModelConfig(dir);
			assert.deepEqual(loaded, USER_CONFIG);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns defaults when config file is missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			const loaded = await loadModelConfig(dir);
			assert.deepEqual(loaded, DEFAULT_MODEL_CONFIG);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("merges partial config with defaults", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			await writeFile(
				modelConfigPath(dir),
				JSON.stringify({ provider: "openai-codex", defaultTier: "cheap" }),
				"utf8",
			);
			const loaded = await loadModelConfig(dir);
			assert.equal(loaded.provider, "openai-codex");
			assert.equal(loaded.defaultTier, "cheap");
			// defaults are still there
			assert.equal(loaded.roleTiers.researcher, "cheap");
			assert.ok(loaded.providers.anthropic);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("accepts compact tiers/roles config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "team-mode-cfg-"));
		try {
			await writeFile(
				modelConfigPath(dir),
				JSON.stringify({
					provider: "openai-codex",
					defaultTier: "md",
					tiers: {
						sm: { name: "Small", thinkingLevel: "low" },
						md: { name: "Medium", thinkingLevel: "medium" },
						lg: { name: "Large", thinkingLevel: "high" },
					},
					roles: {
						researcher: "sm",
						backend: "md",
						planner: "lg",
					},
				}),
				"utf8",
			);
			const loaded = await loadModelConfig(dir);
			assert.equal(loaded.roles.researcher, "sm");
			assert.equal(loaded.tiers.sm?.thinkingLevel, "low");
			const resolved = resolveModel(loaded, "planner");
			assert.ok(resolved);
			assert.equal(resolved.tier, "lg");
			assert.equal(resolved.model, "gpt-5.4");
			assert.equal(resolved.thinkingLevel, "high");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveModel — user's real config", () => {
	test("researcher → openai-codex/gpt-5.4-mini", () => {
		const resolved = resolveModel(USER_CONFIG, "researcher");
		assert.ok(resolved);
		assert.equal(resolved.provider, "openai-codex");
		assert.equal(resolved.model, "gpt-5.4-mini");
		assert.equal(resolved.tier, "cheap");
		assert.match(resolved.rationale, /researcher/);
	});

	test("backend → openai-codex/gpt-5.4", () => {
		const resolved = resolveModel(USER_CONFIG, "backend");
		assert.ok(resolved);
		assert.equal(resolved.model, "gpt-5.4");
		assert.equal(resolved.tier, "mid");
	});

	test("reviewer → openai-codex/gpt-5.4 with high thinking (deep)", () => {
		const resolved = resolveModel(USER_CONFIG, "reviewer");
		assert.ok(resolved);
		assert.equal(resolved.model, "gpt-5.4");
		assert.equal(resolved.tier, "deep");
		assert.equal(resolved.thinkingLevel, "high");
	});

	test("roleThinkingLevels overrides tier defaults", () => {
		const resolved = resolveModel(
			{
				...USER_CONFIG,
				roleThinkingLevels: { reviewer: "xhigh" },
			},
			"reviewer",
		);
		assert.ok(resolved);
		assert.equal(resolved.model, "gpt-5.4");
		assert.equal(resolved.thinkingLevel, "xhigh");
	});

	test("unknown role falls back to defaultTier (mid)", () => {
		const resolved = resolveModel(USER_CONFIG, "unknown-role");
		assert.ok(resolved);
		assert.equal(resolved.tier, "mid");
		assert.match(resolved.rationale, /default tier/);
	});

	test("tierOverride wins over role", () => {
		const resolved = resolveModel(USER_CONFIG, "reviewer", "cheap");
		assert.ok(resolved);
		assert.equal(resolved.tier, "cheap");
		assert.equal(resolved.model, "gpt-5.4-mini");
		assert.match(resolved.rationale, /override/);
	});

	test("returns null when resolved provider has no catalog", () => {
		const noOpenAI: ModelConfig = {
			...USER_CONFIG,
			provider: "missing-provider",
		};
		assert.equal(resolveModel(noOpenAI, "backend"), null);
	});
});

describe("detectProvider", () => {
	test("explicit non-auto wins", () => {
		assert.equal(detectProvider("anthropic"), "anthropic");
		assert.equal(detectProvider("openai-codex"), "openai-codex");
	});

	test("auto consults PI_TEAM_MATE_MODEL_PROVIDER env", () => {
		withEnv({ PI_TEAM_MATE_MODEL_PROVIDER: "openai-codex" }, () => {
			assert.equal(detectProvider("auto"), "openai-codex");
		});
	});

	test("auto falls through to anthropic when nothing is configured", () => {
		withEnv(
			{
				PI_TEAM_MATE_MODEL_PROVIDER: undefined,
				PI_CODING_AGENT_DIR: "/tmp/nonexistent-dir-for-test",
				ANTHROPIC_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			() => {
				assert.equal(detectProvider("auto"), "anthropic");
			},
		);
	});
});
