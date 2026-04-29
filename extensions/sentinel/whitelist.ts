/**
 * Whitelist persistence for sentinel permission gate.
 *
 * Stores user-approved paths in ~/.pi/agent/sentinel-whitelist.json
 * so that repeated write/edit operations to the same outside-project
 * path do not trigger confirmation dialogs every session.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WHITELIST_FILENAME = "sentinel-whitelist.json";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function getAgentDir(): string {
	const envDir = process.env[AGENT_DIR_ENV];
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
		return envDir;
	}
	return join(homedir(), ".pi", "agent");
}

function getWhitelistPath(): string {
	return join(getAgentDir(), WHITELIST_FILENAME);
}

export function loadWhitelist(): Set<string> {
	const filePath = getWhitelistPath();
	if (!existsSync(filePath)) {
		return new Set();
	}
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as { paths?: string[] };
		return new Set(Array.isArray(parsed.paths) ? parsed.paths : []);
	} catch {
		return new Set();
	}
}

export function saveWhitelist(paths: Iterable<string>): void {
	const filePath = getWhitelistPath();
	const data = { paths: [...paths] };
	try {
		writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
	} catch {
		// silently fail if we can't write; the user still gets their operation
	}
}
