/**
 * Pi Team-Mode — Teammate Spec Loader
 *
 * Reads role specs from `.pi/teammates/<role>.md` or `.claude/teammates/<role>.md`
 * (checked in that order). Frontmatter fields drive runtime behavior; the
 * markdown body becomes the teammate's system prompt.
 */

import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";

import type { TeammateSpec } from "./types.js";

const SPEC_DIRS = [".pi/teammates", ".claude/teammates"] as const;

/**
 * Locate and parse a teammate spec by role name.
 * Returns `null` if no matching spec file exists in either directory.
 */
export async function loadTeammateSpec(
	cwd: string,
	role: string,
): Promise<TeammateSpec | null> {
	for (const dir of SPEC_DIRS) {
		const filePath = path.join(cwd, dir, `${role}.md`);
		const spec = await tryRead(filePath, role);
		if (spec) return spec;
	}
	return null;
}

/** List all available teammate specs in the current project. Exported for tests and future /teammate specs command. */
export async function listTeammateSpecs(cwd: string): Promise<TeammateSpec[]> {
	const specs: TeammateSpec[] = [];
	const seen = new Set<string>();
	for (const dir of SPEC_DIRS) {
		const absDir = path.join(cwd, dir);
		let entries: string[] = [];
		try {
			entries = await readdir(absDir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const role = entry.slice(0, -3);
			if (seen.has(role)) continue;
			const spec = await tryRead(path.join(absDir, entry), role);
			if (spec) {
				seen.add(role);
				specs.push(spec);
			}
		}
	}
	return specs;
}

async function tryRead(filePath: string, role: string): Promise<TeammateSpec | null> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	return parseSpec(raw, role, filePath);
}

/**
 * Parse a markdown file with YAML-ish frontmatter.
 *
 * Frontmatter is delimited by `---` lines. Supports scalar values and simple
 * comma-separated arrays (e.g. `tools: read, bash, grep`). We intentionally
 * avoid a YAML dependency — the spec grammar is deliberately small.
 */
export function parseSpec(raw: string, fallbackRole: string, sourcePath: string): TeammateSpec {
	const lines = raw.split(/\r?\n/);
	let body = raw;
	const fm: Record<string, string> = {};

	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
		if (end > 0) {
			for (let i = 1; i < end; i++) {
				const line = lines[i];
				const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
				if (match) {
					fm[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
				}
			}
			body = lines.slice(end + 1).join("\n").trim();
		}
	}

	const tools = fm.tools ? fm.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

	return {
		name: fm.name || fallbackRole,
		description: fm.description,
		needsWorktree: parseBool(fm.needsWorktree),
		hasMemory: parseBool(fm.hasMemory),
		modelTier: fm.modelTier,
		tools,
		systemPrompt: body,
		sourcePath,
	};
}

function parseBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const v = value.toLowerCase();
	if (v === "true" || v === "yes" || v === "1") return true;
	if (v === "false" || v === "no" || v === "0") return false;
	return undefined;
}
