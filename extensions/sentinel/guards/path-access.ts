import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { configLoader, type ResolvedSentinelConfig } from "../config.js";
import { blockToolCall } from "../events.js";
import {
	checkPathAccess,
	isTooBroadGrant,
	pathAccessGrantForChoice,
} from "../path-access.js";
import { extractBashPathCandidates } from "../patterns/bash-paths.js";
import { resolveTargetPath } from "../patterns/permissions.js";

type GrantChoice =
	| "allow_once"
	| "allow_file_session"
	| "allow_directory_session"
	| "allow_file_always"
	| "allow_directory_always"
	| "deny";

const CHOICES: Array<{ value: GrantChoice; label: string }> = [
	{ value: "allow_once", label: "Allow once" },
	{ value: "allow_file_session", label: "Allow file this session" },
	{ value: "allow_directory_session", label: "Allow directory this session" },
	{ value: "allow_file_always", label: "Allow file always" },
	{ value: "allow_directory_always", label: "Allow directory always" },
	{ value: "deny", label: "Deny" },
];

const MAX_BASH_PATH_CANDIDATES = 50;
const TOOL_PATH_NORMALIZERS = {
	read: (path: string) => path.startsWith("@") ? path.slice(1) : path,
	write: (path: string) => path,
	edit: (path: string) => path,
} as const;

export function registerPathAccess(pi: ExtensionAPI): void {
	async function guardPath(
		config: ResolvedSentinelConfig,
		absolutePath: string,
		toolName: string,
		input: Record<string, unknown>,
		ctx: { cwd: string; hasUI: boolean; ui: { select?: (title: string, options: string[]) => Promise<string | undefined> } },
	): Promise<{ block: true; reason: string } | undefined> {
		if (!config.features.pathAccess || config.pathAccess.mode === "allow") return;

		const check = checkPathAccess(absolutePath, ctx.cwd, config.pathAccess.allowedPaths);
		if (check.allowed) return;

		const reason = check.reason;
		if (config.pathAccess.mode === "block" || !ctx.hasUI) {
			return blockToolCall(pi, { feature: "pathAccess", toolName, input, reason }, `[sentinel] ${reason}`);
		}

		const selectedLabel = await ctx.ui.select?.(
			[
				"[sentinel] Path access outside current project",
				`Tool: ${toolName}`,
				`Path: ${absolutePath}`,
				`Project: ${ctx.cwd}`,
				"",
				"Allow access?",
			].join("\n"),
			CHOICES.map((choice) => choice.label),
		);
		const choice = CHOICES.find((item) => item.label === selectedLabel)?.value ?? "deny";

		if (choice === "allow_once") return;

		const grant = pathAccessGrantForChoice(choice, absolutePath, ctx.cwd);
		if (grant) {
			if (isTooBroadGrant(grant.broadCheckPath)) {
				return { block: true, reason: `[sentinel] Refusing overly broad ${grant.directory ? "directory" : "path"} grant.` };
			}
			configLoader.addAllowedPath(grant.scope, grant.grant);
			return;
		}

		return blockToolCall(pi, { feature: "pathAccess", toolName, input, reason, userDenied: true }, `[sentinel] ${reason}`);
	}

	for (const [toolName, normalizePath] of Object.entries(TOOL_PATH_NORMALIZERS) as Array<[keyof typeof TOOL_PATH_NORMALIZERS, (path: string) => string]>) {
		pi.on("tool_call", async (event, ctx) => {
			if (!isToolCallEventType(toolName, event)) return;
			const rawPath = event.input.path;
			if (!rawPath) return;
			return guardPath(configLoader.getConfig(), resolveTargetPath(normalizePath(rawPath), ctx.cwd), toolName, event.input, ctx);
		});
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command ?? "";
		const config = configLoader.getConfig();
		const candidates = extractBashPathCandidates(command, ctx.cwd).slice(0, MAX_BASH_PATH_CANDIDATES);
		for (const absolutePath of candidates) {
			const result = await guardPath(config, absolutePath, "bash", event.input, ctx);
			if (result) return result;
		}
	});
}
