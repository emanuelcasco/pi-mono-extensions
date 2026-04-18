/**
 * Pi Teams — Teammate Specs
 *
 * Teammate roles are resolved as **data**, not code. Each role has a
 * `TeammateSpec` that carries its system prompt and runtime flags
 * (worktree isolation, memory access). Specs come from three places, in
 * priority order:
 *
 *   1. Per-project `.claude/teammates/*.md` — frontmatter-based definitions
 *      checked into the repo. Discovered via `loadTeammateSpecs(cwd)`.
 *   2. Built-in specs — the seven roles that used to be hardcoded in
 *      `TEAMMATE_ROLE_PROMPTS`. Still exported for ecosystem compatibility.
 *   3. Generic fallback — an unknown role gets a minimal prompt so the team
 *      doesn't crash on an unrecognised name.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { TEAMMATE_ROLE_PROMPTS } from "./types.js";

/** Runtime description of a teammate role. */
export interface TeammateSpec {
  /** Role name (e.g. "backend"). Must be filesystem-safe. */
  name: string;
  /** Short human-readable description — surfaced in catalogs. */
  description?: string;
  /** System prompt injected into the teammate subprocess. */
  systemPrompt: string;
  /** When true, the teammate gets a dedicated git worktree for isolated writes. */
  needsWorktree: boolean;
  /** When true, `## Team Memory` guidance is appended to the prompt. */
  hasMemory: boolean;
  /** Optional per-role model tier override (takes precedence over the default). */
  modelTier?: "cheap" | "mid" | "deep";
  /** Absolute path to the source file, if the spec came from disk. */
  sourcePath?: string;
}

/**
 * Built-in specs. Match the pre-file-based defaults so existing teams keep
 * working. New roles should prefer `.claude/teammates/*.md` files.
 */
export const BUILT_IN_TEAMMATE_SPECS: Record<string, TeammateSpec> = {
  researcher: {
    name: "researcher",
    description: "Investigates codebase, gathers information, explores constraints",
    systemPrompt: TEAMMATE_ROLE_PROMPTS.researcher,
    needsWorktree: false,
    hasMemory: true,
  },
  planner: {
    name: "planner",
    description: "Creates detailed implementation plans from findings",
    systemPrompt: TEAMMATE_ROLE_PROMPTS.planner,
    needsWorktree: false,
    hasMemory: true,
  },
  backend: {
    name: "backend",
    description: "Implements server-side code (APIs, services, database changes)",
    systemPrompt: TEAMMATE_ROLE_PROMPTS.backend,
    needsWorktree: true,
    hasMemory: true,
  },
  frontend: {
    name: "frontend",
    description: "Implements user-facing code (components, pages, styles)",
    systemPrompt: TEAMMATE_ROLE_PROMPTS.frontend,
    needsWorktree: true,
    hasMemory: true,
  },
  reviewer: {
    name: "reviewer",
    description: "Reviews code for correctness, security, and quality",
    systemPrompt: TEAMMATE_ROLE_PROMPTS.reviewer,
    needsWorktree: false,
    hasMemory: false,
  },
  tester: {
    name: "tester",
    description: "Writes and runs tests (unit, integration, edge cases)",
    systemPrompt: TEAMMATE_ROLE_PROMPTS.tester,
    needsWorktree: true,
    hasMemory: false,
  },
  docs: {
    name: "docs",
    description: "Writes and updates documentation",
    systemPrompt: TEAMMATE_ROLE_PROMPTS.docs,
    needsWorktree: true,
    hasMemory: true,
  },
};

/** Fallback spec used when no registered spec matches a role name. */
export function genericSpec(role: string): TeammateSpec {
  return {
    name: role,
    description: `${role} specialist (no registered spec)`,
    systemPrompt: `You are a ${role} specialist. Complete the assigned task carefully and report results clearly.`,
    needsWorktree: false,
    hasMemory: false,
  };
}

/**
 * Resolve a role to its effective spec.
 *
 * @param role        Role name to resolve.
 * @param discovered  Optional registry of file-based specs (takes precedence).
 */
export function resolveTeammateSpec(
  role: string,
  discovered?: Record<string, TeammateSpec>,
): TeammateSpec {
  if (discovered?.[role]) return discovered[role];
  if (BUILT_IN_TEAMMATE_SPECS[role]) return BUILT_IN_TEAMMATE_SPECS[role];
  return genericSpec(role);
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

const TRUTHY = new Set(["true", "yes", "1"]);
const FALSY = new Set(["false", "no", "0"]);

function parseBool(raw: string, fallback: boolean): boolean {
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return fallback;
}

function parseTier(raw: string): TeammateSpec["modelTier"] | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "cheap" || value === "mid" || value === "deep") return value;
  return undefined;
}

/**
 * Parse a single `*.md` file with YAML-ish frontmatter into a `TeammateSpec`.
 *
 * Returns `null` when the file has no frontmatter, no `name` field, or no
 * body — it's better to silently skip malformed specs than to crash the leader.
 *
 * Supported frontmatter keys:
 *   name          required — role identifier
 *   description   optional — human-readable summary
 *   needsWorktree optional — default false; accepts true/false/yes/no/1/0
 *   hasMemory     optional — default false; same accepted values
 *   modelTier     optional — one of "cheap" | "mid" | "deep"
 */
export function parseTeammateSpecFile(
  raw: string,
  sourcePath?: string,
): TeammateSpec | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }

  const name = fields.name?.trim();
  const systemPrompt = body.trim();
  if (!name || !systemPrompt) return null;

  return {
    name,
    description: fields.description || undefined,
    systemPrompt,
    needsWorktree: parseBool(fields.needsWorktree ?? "", false),
    hasMemory: parseBool(fields.hasMemory ?? "", false),
    modelTier: fields.modelTier ? parseTier(fields.modelTier) : undefined,
    sourcePath,
  };
}

/**
 * Scan `<cwd>/.claude/teammates/*.md` for frontmatter specs.
 *
 * Missing directory, read errors, and malformed files are silently ignored —
 * file-based specs are purely additive.
 */
export async function loadTeammateSpecs(
  cwd: string,
): Promise<Record<string, TeammateSpec>> {
  const dir = join(cwd, ".claude", "teammates");
  const specs: Record<string, TeammateSpec> = {};

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return specs;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      const raw = await readFile(path, "utf8");
      const spec = parseTeammateSpecFile(raw, path);
      if (spec) specs[spec.name] = spec;
    } catch {
      // Malformed spec — skip.
    }
  }

  return specs;
}
