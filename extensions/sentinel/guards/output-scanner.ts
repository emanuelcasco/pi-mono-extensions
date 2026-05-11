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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { blockToolCall, emitDangerous } from "../events.js";
import type { SentinelSession } from "../session.js";
import type { ScanMatch } from "../types.js";
import {
	expandPaths,
	extractReadTargets,
} from "../patterns/read-targets.js";
import {
	isBinaryContent,
	MAX_SCAN_BYTES,
	scanForSecrets,
} from "../patterns/secrets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_CONFIRM_MATCHES = 5;
const MAX_BASH_SCAN_TARGETS = 100;

function summarizeMatchOverflow(total: number, shown: number): string[] {
	const hidden = total - shown;
	return hidden > 0 ? [`  ... and ${hidden} more potential secret(s) not shown`] : [];
}

function formatCompactLabels(matches: ScanMatch[]): string {
	const unique = [...new Set(matches.map((m) => m.label))];
	const shown = unique.slice(0, MAX_CONFIRM_MATCHES);
	const hidden = unique.length - shown.length;
	return hidden > 0 ? `${shown.join(", ")}, and ${hidden} more type(s)` : shown.join(", ");
}

/** Format scan matches into a compact human-readable confirmation message. */
function formatConfirmMessage(matches: ScanMatch[]): string {
	const shown = matches.slice(0, MAX_CONFIRM_MATCHES);
	const lines = shown.map(
		(m) => `  - ${m.label} (line ${m.line}): ${m.snippet}`,
	);
	return [
		`File may contain ${matches.length} potential secret(s):`,
		...lines,
		...summarizeMatchOverflow(matches.length, shown.length),
		"",
		"Allow this read?",
	].join("\n");
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

		// Skip the dialog entirely if this file was previously allowed.
		if (session.isReadWhitelisted(absolutePath)) {
			return;
		}

		const matches = await scanFile(absolutePath, session);
		if (matches.length === 0) return;

		emitDangerous(pi, {
			feature: "outputScanner",
			toolName: "read",
			input: event.input,
			description: `File contains ${matches.length} potential secret(s).`,
			labels: matches.map((m) => m.label),
		});

		// Secrets found — escalate
		if (ctx.hasUI) {
			const choice = await ctx.ui.select(
				`[sentinel] Secret detected\n\n${formatConfirmMessage(matches)}`,
				[
					"Allow once",
					"Always allow this file",
					"Deny",
				],
			);

			if (choice === "Allow once") return; // User approved — let the read proceed

			if (choice === "Always allow this file") {
				session.addToReadWhitelist(absolutePath);
				return;
			}
		}

		// No UI or user denied — block
		const reason =
			`[sentinel] Blocked: file contains ${matches.length} potential secret(s). ` +
			`Types: ${formatCompactLabels(matches)}.`;
		return blockToolCall(pi, { feature: "outputScanner", toolName: "read", input: event.input, reason, userDenied: ctx.hasUI });
	});

	// -----------------------------------------------------------------------
	// Intercept `bash` commands that read files (cat, head, tail, less)
	// -----------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command ?? "";
		const targets = extractReadTargets(command);
		if (targets.length === 0) return;


		const expandedTargets = (await Promise.all(
			targets.map(async (target) =>
				(await expandPaths(ctx.cwd, target)).map((absolutePath) => ({ target, absolutePath })),
			),
		)).flat().slice(0, MAX_BASH_SCAN_TARGETS);

		const scanResults = await Promise.all(
			expandedTargets
				.filter(({ absolutePath }) => !session.isReadWhitelisted(absolutePath))
				.map(async ({ target, absolutePath }) => ({
					path: target,
					absolutePath,
					matches: await scanFile(absolutePath, session),
				})),
		);
		const allMatches = scanResults.filter((entry) => entry.matches.length > 0);

		if (allMatches.length === 0) return;

		emitDangerous(pi, {
			feature: "outputScanner",
			toolName: "bash",
			input: event.input,
			description: "Bash command reads file(s) that may contain secrets.",
			labels: allMatches.flatMap((entry) => entry.matches.map((m) => m.label)),
		});

		// Build a compact combined confirmation message. Large .env files can
		// contain dozens of matches, so show only a small sample to avoid breaking
		// the confirmation view.
		const flattenedMatches = allMatches.flatMap(({ path, matches }) =>
			matches.map((match) => ({ path, match })),
		);
		const shownMatches = flattenedMatches.slice(0, MAX_CONFIRM_MATCHES);
		const message = [
			...shownMatches.map(
				({ path, match }) =>
					`  - ${match.label} in ${path} (line ${match.line}): ${match.snippet}`,
			),
			...summarizeMatchOverflow(flattenedMatches.length, shownMatches.length),
		].join("\n");

		if (ctx.hasUI) {
			const choice = await ctx.ui.select(
				`[sentinel] Secret detected in bash target\n\nCommand reads file(s) that may contain secrets:\n${message}\n\nAllow execution?`,
				[
					"Allow once",
					"Always allow these files",
					"Deny",
				],
			);

			if (choice === "Allow once") return;

			if (choice === "Always allow these files") {
				for (const { absolutePath } of allMatches) {
					session.addToReadWhitelist(absolutePath);
				}
				return;
			}
		}

		const totalMatches = flattenedMatches.length;
		const reason = `[sentinel] Blocked: bash command reads file(s) with ${totalMatches} potential secret(s).`;
		return blockToolCall(pi, { feature: "outputScanner", toolName: "bash", input: event.input, reason, userDenied: ctx.hasUI });
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
