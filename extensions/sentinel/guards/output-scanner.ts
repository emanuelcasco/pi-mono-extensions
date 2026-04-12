/**
 * output-scanner — Gap 2: Content-in-location attack mitigation.
 *
 * Pre-reads files before `read` tool calls execute and scans for secret
 * patterns. If secrets are found, asks the user before allowing the read.
 *
 * Since `tool_result` is read-only in the pi extension API, we intercept
 * at `tool_call` time — read the file ourselves, scan it, and make an
 * ASK/DENY decision before the actual read proceeds.
 *
 * Also intercepts `bash` commands that read files (cat, head, tail, less)
 * and pre-scans the target files.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

import type { SentinelSession } from "../session.js";
import type { ScanMatch } from "../types.js";
import {
	isBinaryContent,
	MAX_SCAN_BYTES,
	scanForSecrets,
} from "../patterns/secrets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format scan matches into a human-readable confirmation message. */
function formatConfirmMessage(matches: ScanMatch[]): string {
	const lines = matches.map(
		(m) => `  - ${m.label} (line ${m.line}): ${m.snippet}`,
	);
	return [
		"File may contain secrets:",
		...lines,
		"",
		"Allow this read?",
	].join("\n");
}

/**
 * Extract file paths from bash commands that read file content.
 * Targets: cat, head, tail, less, more.
 */
function extractReadTargets(command: string): string[] {
	const pattern = /\b(?:cat|head|tail|less|more)\s+([^\s|;&]+)/g;
	const paths: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(command)) !== null) {
		const target = match[1];
		// Skip flags (start with -)
		if (!target.startsWith("-")) {
			paths.push(target);
		}
	}
	return paths;
}

/**
 * Pre-read a file and scan for secrets. Uses the session scan cache to
 * avoid redundant filesystem reads on unchanged files.
 *
 * Returns the scan matches, or an empty array if the file is binary,
 * too large, or unreadable.
 */
async function scanFile(
	absolutePath: string,
	session: SentinelSession,
): Promise<ScanMatch[]> {
	try {
		const fileStat = await stat(absolutePath);

		// Check cache first
		const cached = session.getCachedScan(absolutePath, fileStat.mtimeMs);
		if (cached) return cached.matches;

		// Skip files larger than scan limit
		if (fileStat.size > MAX_SCAN_BYTES) return [];

		// Skip non-files (directories, symlinks, etc.)
		if (!fileStat.isFile()) return [];

		const content = await readFile(absolutePath, "utf-8");

		// Skip binary files
		if (isBinaryContent(content)) {
			session.cacheScan(absolutePath, fileStat.mtimeMs, {
				hasSecrets: false,
				matches: [],
			});
			return [];
		}

		const result = scanForSecrets(content);
		session.cacheScan(absolutePath, fileStat.mtimeMs, result);
		return result.matches;
	} catch {
		// File unreadable (permissions, doesn't exist, etc.) — let the tool handle the error
		return [];
	}
}

// ---------------------------------------------------------------------------
// Guard registration
// ---------------------------------------------------------------------------

export function registerOutputScanner(
	pi: ExtensionAPI,
	session: SentinelSession,
): void {
	// -----------------------------------------------------------------------
	// Intercept `read` tool calls
	// -----------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;

		const rawPath = event.input.path;
		if (!rawPath) return;

		const absolutePath = resolve(
			ctx.cwd,
			rawPath.startsWith("@") ? rawPath.slice(1) : rawPath,
		);

		const matches = await scanFile(absolutePath, session);
		if (matches.length === 0) return;

		// Secrets found — escalate
		if (ctx.hasUI) {
			const allowed = await ctx.ui.confirm(
				"[sentinel] Secret detected",
				formatConfirmMessage(matches),
			);
			if (allowed) return; // User approved — let the read proceed
		}

		// No UI or user denied — block
		return {
			block: true,
			reason:
				`[sentinel] Blocked: file contains ${matches.length} potential secret(s). ` +
				matches.map((m) => m.label).join(", ") +
				".",
		};
	});

	// -----------------------------------------------------------------------
	// Intercept `bash` commands that read files (cat, head, tail, less)
	// -----------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command ?? "";
		const targets = extractReadTargets(command);
		if (targets.length === 0) return;

		// Scan all targeted files
		const allMatches: Array<{ path: string; matches: ScanMatch[] }> = [];
		for (const target of targets) {
			const absolutePath = resolve(ctx.cwd, target);
			const matches = await scanFile(absolutePath, session);
			if (matches.length > 0) {
				allMatches.push({ path: target, matches });
			}
		}

		if (allMatches.length === 0) return;

		// Build a combined confirmation message
		const message = allMatches
			.flatMap(({ path, matches }) =>
				matches.map(
					(m) => `  - ${m.label} in ${path} (line ${m.line}): ${m.snippet}`,
				),
			)
			.join("\n");

		if (ctx.hasUI) {
			const allowed = await ctx.ui.confirm(
				"[sentinel] Secret detected in bash target",
				`Command reads file(s) that may contain secrets:\n${message}\n\nAllow execution?`,
			);
			if (allowed) return;
		}

		const totalMatches = allMatches.reduce(
			(sum, entry) => sum + entry.matches.length,
			0,
		);
		return {
			block: true,
			reason:
				`[sentinel] Blocked: bash command reads file(s) with ${totalMatches} potential secret(s).`,
		};
	});

	// -----------------------------------------------------------------------
	// Invalidate scan cache when context-guard reports a file modification
	// -----------------------------------------------------------------------
	pi.events.on("context-guard:file-modified", (data: unknown) => {
		const event = data as { path?: string } | undefined;
		if (event?.path) {
			session.invalidateScanCache(resolve(event.path));
		}
	});
}
