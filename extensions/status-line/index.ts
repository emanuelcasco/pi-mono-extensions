/**
 * Status Line — configurable footer extension for pi.
 *
 * Modes:
 *   - "basic"  — cwd + branch, token stats, model info (original two-line layout)
 *   - "expert" — visual context gauge, git dirty/ahead/behind, subscription usage indicators
 *
 * Resolution order (first hit wins):
 *   1. PI_STATUS_LINE_MODE environment variable
 *   2. ~/.pi/agent/status-line.json → { "mode": "basic" | "expert" }
 *   3. default → "basic"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import basicStatusLine from "./basic";
import expertStatusLine from "./expert";

type Mode = "basic" | "expert";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "status-line.json");
const DEFAULT_MODE: Mode = "basic";

function readConfigMode(): Mode | undefined {
	try {
		if (!existsSync(CONFIG_PATH)) return undefined;
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw) as { mode?: string };
		if (parsed.mode === "basic" || parsed.mode === "expert") return parsed.mode;
	} catch {}
	return undefined;
}

function resolveMode(): Mode {
	const envMode = process.env.PI_STATUS_LINE_MODE;
	if (envMode === "basic" || envMode === "expert") return envMode;

	const configMode = readConfigMode();
	if (configMode) return configMode;

	return DEFAULT_MODE;
}

export default function (pi: ExtensionAPI): void {
	const mode = resolveMode();

	if (mode === "expert") {
		expertStatusLine(pi);
	} else {
		basicStatusLine(pi);
	}
}
