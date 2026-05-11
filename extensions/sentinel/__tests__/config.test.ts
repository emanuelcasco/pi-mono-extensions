import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { SentinelConfigLoader } from "../config.ts";

describe("SentinelConfigLoader", () => {
	let agentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "sentinel-config-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "sentinel-config-cwd-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	test("uses defaults when no config files exist", () => {
		const loader = new SentinelConfigLoader();
		loader.load(cwd);
		const config = loader.getConfig();
		assert.equal(config.enabled, true);
		assert.equal(config.features.outputScanner, true);
		assert.equal(config.features.pathAccess, false);
		assert.equal(config.pathAccess.mode, "ask");
	});

	test("merges global, local, and memory with expected precedence", () => {
		const loader = new SentinelConfigLoader();
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(loader.getConfigPath("global"), JSON.stringify({ pathAccess: { allowedPaths: ["/global"] } }), { flag: "w" });
		loader.load(cwd);
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(loader.getConfigPath("local"), JSON.stringify({ features: { pathAccess: true }, pathAccess: { allowedPaths: ["/local"] } }), { flag: "w" });
		loader.load(cwd);
		loader.save("memory", { pathAccess: { mode: "block", allowedPaths: ["/memory"] } });
		const config = loader.getConfig();
		assert.equal(config.features.pathAccess, true);
		assert.equal(config.pathAccess.mode, "block");
		assert.deepEqual(config.pathAccess.allowedPaths, ["/memory"]);
	});

	test("save writes global and local config files", () => {
		const loader = new SentinelConfigLoader();
		loader.load(cwd);
		loader.save("global", { enabled: false });
		loader.save("local", { features: { pathAccess: true } });
		assert.deepEqual(loader.getRawConfig("global"), { enabled: false });
		assert.deepEqual(loader.getRawConfig("local"), { features: { pathAccess: true } });
	});
});
