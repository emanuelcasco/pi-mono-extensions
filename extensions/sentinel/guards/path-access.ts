import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { configLoader, type ResolvedSentinelConfig } from "../config.js";
import { blockToolCall } from "../events.js";
import {
	checkPathAccess,
	isTooBroadGrant,
	pathAccessGrantsForChoice,
} from "../path-access.js";
import { extractBashPathCandidates } from "../patterns/bash-paths.js";
import { resolveTargetPath } from "../patterns/permissions.js";

type GrantChoice =
	| "allow_once"
	| "allow_file_session"
	| "allow_files_session"
	| "allow_directory_session"
	| "allow_file_always"
	| "allow_files_always"
	| "allow_directory_always"
	| "deny";

type PathPromptKind = "existing_file" | "new_file" | "directory" | "multiple_files";

function choicesForPathPrompt(kind: PathPromptKind): Array<{ value: GrantChoice; label: string }> {
	switch (kind) {
		case "new_file":
			return [
				{ value: "allow_once", label: "Allow once" },
				{ value: "allow_directory_session", label: "Allow creating files in this folder for this session" },
				{ value: "allow_directory_always", label: "Always allow creating files in this folder" },
				{ value: "deny", label: "Deny" },
			];
		case "directory":
			return [
				{ value: "allow_once", label: "Allow once" },
				{ value: "allow_directory_session", label: "Allow this folder for this session" },
				{ value: "allow_directory_always", label: "Always allow this folder" },
				{ value: "deny", label: "Deny" },
			];
		case "multiple_files":
			return [
				{ value: "allow_once", label: "Allow once" },
				{ value: "allow_files_session", label: "Allow these files for this session" },
				{ value: "allow_files_always", label: "Always allow these files" },
				{ value: "deny", label: "Deny" },
			];
		case "existing_file":
		default:
			return [
				{ value: "allow_once", label: "Allow once" },
				{ value: "allow_file_session", label: "Allow this file for this session" },
				{ value: "allow_file_always", label: "Always allow this file" },
				{ value: "deny", label: "Deny" },
			];
	}
}

function promptKindForPath(absolutePath: string, toolName: string): PathPromptKind {
	try {
		if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) return "directory";
	} catch {
		// Fall through to operation-based classification.
	}
	return toolName === "write" && !existsSync(absolutePath) ? "new_file" : "existing_file";
}

function allInSameDirectory(paths: readonly string[]): boolean {
	if (paths.length < 2) return false;
	const first = dirname(paths[0]);
	return paths.every((path) => dirname(path) === first);
}

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
		return guardPaths(config, [absolutePath], toolName, input, ctx);
	}

	async function guardPaths(
		config: ResolvedSentinelConfig,
		absolutePaths: readonly string[],
		toolName: string,
		input: Record<string, unknown>,
		ctx: { cwd: string; hasUI: boolean; ui: { select?: (title: string, options: string[]) => Promise<string | undefined> } },
	): Promise<{ block: true; reason: string } | undefined> {
		if (!config.features.pathAccess || config.pathAccess.mode === "allow") return;

		const denied = absolutePaths
			.map((absolutePath) => checkPathAccess(absolutePath, ctx.cwd, config.pathAccess.allowedPaths))
			.filter((check) => !check.allowed) as Array<{ allowed: false; absolutePath: string; reason: string }>;
		if (denied.length === 0) return;

		const deniedPaths = denied.map((check) => check.absolutePath);
		const reason = denied.length === 1
			? denied[0].reason
			: `Paths are outside the current working directory: ${deniedPaths.join(", ")}`;
		if (config.pathAccess.mode === "block" || !ctx.hasUI) {
			return blockToolCall(pi, { feature: "pathAccess", toolName, input, reason }, `[sentinel] ${reason}`);
		}

		const promptKind = deniedPaths.length > 1 && allInSameDirectory(deniedPaths)
			? "multiple_files"
			: promptKindForPath(deniedPaths[0], toolName);
		const choices = choicesForPathPrompt(promptKind);
		const pathLines = deniedPaths.length === 1
			? [`Path: ${deniedPaths[0]}`]
			: ["Paths:", ...deniedPaths.map((path) => `  - ${path}`)];

		const selectedLabel = await ctx.ui.select?.(
			[
				"[sentinel] Path access outside current project",
				`Tool: ${toolName}`,
				...pathLines,
				`Project: ${ctx.cwd}`,
				"",
				"Allow access?",
			].join("\n"),
			choices.map((choice) => choice.label),
		);
		const choice = choices.find((item) => item.label === selectedLabel)?.value ?? "deny";

		if (choice === "allow_once") return;

		const grants = pathAccessGrantsForChoice(choice, deniedPaths, ctx.cwd);
		if (grants.length > 0) {
			for (const grant of grants) {
				if (isTooBroadGrant(grant.broadCheckPath)) {
					return { block: true, reason: `[sentinel] Refusing overly broad ${grant.directory ? "directory" : "path"} grant.` };
				}
				configLoader.addAllowedPath(grant.scope, grant.grant);
			}
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
		const pendingByDirectory = new Map<string, string[]>();
		for (const absolutePath of candidates) {
			const check = checkPathAccess(absolutePath, ctx.cwd, config.pathAccess.allowedPaths);
			if (check.allowed) continue;
			const paths = pendingByDirectory.get(dirname(absolutePath)) ?? [];
			paths.push(absolutePath);
			pendingByDirectory.set(dirname(absolutePath), paths);
		}
		for (const paths of pendingByDirectory.values()) {
			const result = paths.length > 1
				? await guardPaths(config, paths, "bash", event.input, ctx)
				: await guardPath(config, paths[0], "bash", event.input, ctx);
			if (result) return result;
		}
	});
}
