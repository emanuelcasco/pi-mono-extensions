import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectProvider } from "../core/model-config.ts";

type EnvSnapshot = Record<string, string | undefined>;

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_TEAM_MODEL_PROVIDER",
  "PI_MODEL",
  "ANTHROPIC_MODEL",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("detectProvider", () => {
  let envSnapshot = snapshotEnv();

  afterEach(() => {
    restoreEnv(envSnapshot);
    envSnapshot = snapshotEnv();
  });

  test("prefers pi settings defaultProvider when env hints are absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-team-model-config-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    delete process.env.PI_TEAM_MODEL_PROVIDER;
    delete process.env.PI_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.OPENAI_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.4" }),
      "utf8",
    );

    try {
      assert.equal(detectProvider(), "openai-codex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to auth.json when settings are absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-team-model-config-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    delete process.env.PI_TEAM_MODEL_PROVIDER;
    delete process.env.PI_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.OPENAI_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ "openai-codex": { token: "x" } }),
      "utf8",
    );

    try {
      assert.equal(detectProvider(), "openai-codex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
