/**
 * execution-tracker — Gap 3: Indirect execution attack mitigation.
 *
 * Two hooks working together:
 *
 * 1. **Write-time tracking** (`tool_call` on `write` / `edit`):
 *    Records every file written during the session and scans the content
 *    for dangerous execution patterns (curl|bash, eval, exfiltration, etc.).
 *    Does NOT block — only records metadata in the session write registry.
 *
 * 2. **Execution-time correlation** (`tool_call` on `bash`):
 *    Extracts script paths from bash commands and checks them against the
 *    session write registry. If a script was written this session and
 *    contains dangerous patterns, asks/denies before allowing execution.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { blockToolCall, emitDangerous } from "../events.js";
import type { SentinelSession } from "../session.js";
import type { DangerousPattern, WriteEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Dangerous content patterns (for scripts)
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
	{
		label: "curl-pipe-exec",
		pattern: /curl\s.*\|\s*(?:bash|sh|zsh)/,
	},
	{
		label: "wget-pipe-exec",
		pattern: /wget\s.*\|\s*(?:bash|sh|zsh)/,
	},
	{
		label: "eval-subshell",
		pattern: /eval\s+["'$]/,
	},
	{
		label: "network-exfil",
		pattern: /curl\s.*(?:-X\s*POST|--data\b|-d\s)/,
	},
	{
		label: "rm-recursive",
		pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
	},
	{
		label: "privilege-escalation",
		pattern: /(?:chmod\s+777|sudo\s)/,
	},
	{
		label: "persistence",
		pattern: /(?:crontab|systemctl\s+enable|launchctl)/,
	},
];

// ---------------------------------------------------------------------------
// Script execution path extraction
// ---------------------------------------------------------------------------

const EXEC_PATTERNS: readonly RegExp[] = [
	/\b(?:bash|sh|zsh|dash)\s+(\S+)/,
	/\b(?:node|python3?|ruby|perl|tsx?)\s+(\S+)/,
	/\bsource\s+(\S+)/,
	/^\.\s+(\S+)/,
	/^\.\/(\S+)/,
];

/** Extract potential script file paths from a bash command. */
function extractScriptPaths(command: string): string[] {
	const paths: string[] = [];
	for (const pattern of EXEC_PATTERNS) {
		const match = pattern.exec(command);
		if (match?.[1]) {
			const target = match[1];
			// Skip flags
			if (!target.startsWith("-")) {
				paths.push(target);
			}
		}
	}
	return paths;
}

// ---------------------------------------------------------------------------
// Content scanning
// ---------------------------------------------------------------------------

/** Scan content for dangerous execution patterns. Returns matched labels. */
function scanForDangerousContent(content: string): string[] {
	const matched: string[] = [];
	for (const { label, pattern } of DANGEROUS_PATTERNS) {
		if (pattern.test(content)) {
			matched.push(label);
		}
	}
	return matched;
}

// ---------------------------------------------------------------------------
// Guard registration
// ---------------------------------------------------------------------------

export function registerExecutionTracker(
	pi: ExtensionAPI,
	session: SentinelSession,
): void {
	// -----------------------------------------------------------------------
	// 4a. Write-time tracking — record writes and flag dangerous content
	// -----------------------------------------------------------------------

	// Track `write` tool calls
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("write", event)) return;

		const rawPath = event.input.path;
		const content = event.input.content;
		if (!rawPath || typeof content !== "string") return;

		const absolutePath = resolve(ctx.cwd, rawPath);
		const dangerousPatterns = scanForDangerousContent(content);

		session.registerWrite({
			path: absolutePath,
			timestamp: Date.now(),
			hasDangerousContent: dangerousPatterns.length > 0,
			dangerousPatterns,
		});

		if (dangerousPatterns.length > 0) {
			ctx.ui.notify(
				`[sentinel] Write tracked: ${rawPath} flagged (${dangerousPatterns.join(", ")})`,
				"warning",
			);
		}
	});

	// Track `edit` tool calls
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event)) return;

		const rawPath = event.input.path;
		const edits = event.input.edits as
			| Array<{ oldText: string; newText: string }>
			| undefined;
		if (!rawPath || !edits?.length) return;

		const absolutePath = resolve(ctx.cwd, rawPath);
		const allNewText = edits.map((e) => e.newText).join("\n");
		const dangerousPatterns = scanForDangerousContent(allNewText);

		// For edits, merge with existing entry if present
		const existing = session.getWrite(absolutePath);
		const mergedPatterns = existing
			? [...new Set([...existing.dangerousPatterns, ...dangerousPatterns])]
			: dangerousPatterns;

		session.registerWrite({
			path: absolutePath,
			timestamp: Date.now(),
			hasDangerousContent: mergedPatterns.length > 0,
			dangerousPatterns: mergedPatterns,
		});

		if (dangerousPatterns.length > 0) {
			ctx.ui.notify(
				`[sentinel] Edit tracked: ${rawPath} flagged (${dangerousPatterns.join(", ")})`,
				"warning",
			);
		}
	});

	// -----------------------------------------------------------------------
	// 4b. Execution-time correlation — check bash against write registry
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command ?? "";
		const scriptPaths = extractScriptPaths(command);
		if (scriptPaths.length === 0) return;

		for (const scriptPath of scriptPaths) {
			const absolutePath = resolve(ctx.cwd, scriptPath);
			const writeEntry = session.getWrite(absolutePath);

			// Not written this session — skip
			if (!writeEntry) continue;

			// Written this session but no dangerous content — notify only
			if (!writeEntry.hasDangerousContent) {
				ctx.ui.notify(
					`[sentinel] Executing session-written file: ${scriptPath}`,
					"info",
				);
				continue;
			}

			// Re-verify: file may have been modified externally since we tracked the write
			const currentPatterns = await rescanFileIfChanged(
				absolutePath,
				writeEntry,
			);

			// File was modified and no longer dangerous
			if (currentPatterns.length === 0) {
				session.registerWrite({
					...writeEntry,
					hasDangerousContent: false,
					dangerousPatterns: [],
				});
				ctx.ui.notify(
					`[sentinel] File ${scriptPath} was modified — no longer flagged`,
					"info",
				);
				continue;
			}

			emitDangerous(pi, {
				feature: "executionTracker",
				toolName: "bash",
				input: event.input,
				description: "Bash command executes a session-written file with dangerous content.",
				labels: currentPatterns,
			});

			// Dangerous content confirmed — escalate
			const message = [
				`About to execute a file written earlier in this session:`,
				`  Path: ${scriptPath}`,
				`  Flagged patterns: ${currentPatterns.join(", ")}`,
				"",
				"Allow execution?",
			].join("\n");

			if (ctx.hasUI) {
				const allowed = await ctx.ui.confirm(
					"[sentinel] Dangerous script execution",
					message,
				);
				if (allowed) continue;
			}

			// No UI or user denied — block
			const reason =
				`[sentinel] Blocked: bash executes ${scriptPath}, written this session ` +
				`with dangerous patterns: ${currentPatterns.join(", ")}.`;
			return blockToolCall(pi, { feature: "executionTracker", toolName: "bash", input: event.input, reason, userDenied: ctx.hasUI });
		}
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-read and re-scan a file to verify dangerous content is still present.
 * Handles the edge case where the file was modified externally between
 * write-time tracking and execution-time correlation.
 */
async function rescanFileIfChanged(
	absolutePath: string,
	writeEntry: WriteEntry,
): Promise<string[]> {
	try {
		const fileStat = await stat(absolutePath);

		// If the file was modified after we tracked the write, re-scan
		if (fileStat.mtimeMs > writeEntry.timestamp) {
			const content = await readFile(absolutePath, "utf-8");
			return scanForDangerousContent(content);
		}

		// File unchanged — trust the original scan
		return writeEntry.dangerousPatterns;
	} catch {
		// File gone or unreadable — no longer dangerous
		return [];
	}
}

