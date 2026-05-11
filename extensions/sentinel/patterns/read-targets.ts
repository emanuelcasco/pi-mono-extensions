/**
 * Pure helpers for extracting file-read targets from bash commands.
 * Kept separate from output-scanner.ts so they can be unit-tested
 * without pulling in ExtensionAPI imports.
 */

import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const MAX_EXPANDED_PATHS = 100;

/**
 * Strip quoted substrings so they don't confuse the tokenizer.
 */
function stripQuotes(s: string): string {
	return s.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");
}

/**
 * Extract file paths from bash commands that read file content.
 * Targets: cat, head, tail, less, more, grep, rg, sed, awk, strings,
 * nl, sort, uniq, wc, diff, tac, rev, xxd, hexdump, od, base64, file,
 * jq, yq, and similar file-reading utilities.
 */
export function extractReadTargets(command: string): string[] {
	const paths: string[] = [];

	// Commands that take a script / filter / pattern first, then files:
	//   grep [options] pattern file...
	//   rg   [options] pattern file...
	//   awk  [options] 'script' file...
	//   sed  [options] 'script' file...
	//   jq   [options] filter  file...
	const scriptCommands =
		/\b(?:grep|rg|egrep|fgrep|awk|sed|perl|python3?|jq|yq)\b/g;
	let sm: RegExpExecArray | null;
	while ((sm = scriptCommands.exec(command)) !== null) {
		const tail = command.slice(sm.index + sm[0].length);
		const tokens = stripQuotes(tail)
			.split(/\s+/)
			.filter(Boolean);
		for (const token of tokens) {
			// Stop at shell operators and redirects
			if (/^[|;&]|^(\d?[<>]|>>|<<)/.test(token)) break;
			// Skip flags
			if (token.startsWith("-")) continue;
			paths.push(token);
		}
	}

	// Commands that take files directly after the command name.
	const directCommands =
		/\b(?:cat|head|tail|less|more|nl|tac|rev|strings|xxd|hexdump|od|base64|file|sort|uniq|wc|diff|comm|join|cut|paste|column)\b/g;
	let dm: RegExpExecArray | null;
	while ((dm = directCommands.exec(command)) !== null) {
		const tail = command.slice(dm.index + dm[0].length);
		const tokens = stripQuotes(tail)
			.split(/\s+/)
			.filter(Boolean);
		for (const token of tokens) {
			// Stop at shell operators and redirects
			if (/^[|;&]|^(\d?[<>]|>>|<<)/.test(token)) break;
			// Skip flags
			if (token.startsWith("-")) continue;
			paths.push(token);
		}
	}

	return [...new Set(paths)];
}

/**
 * Expand globs like `.env*` into concrete file paths.
 * Falls back to the raw path if expansion fails or if there is no wildcard.
 */
export async function expandPaths(
	cwd: string,
	rawTarget: string,
): Promise<string[]> {
	const absolutePath = resolve(cwd, rawTarget);
	const base = basename(absolutePath);
	const dir = dirname(absolutePath);

	if (!base.includes("*") && !base.includes("?")) {
		return [absolutePath];
	}

	try {
		const entries = await readdir(dir);
		const regex = new RegExp(
			"^" +
				base
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, ".*")
					.replace(/\?/g, ".") +
				"$",
		);
		const matches = entries.filter((f) => regex.test(f));
		if (matches.length === 0) {
			return [absolutePath];
		}
		return matches.slice(0, MAX_EXPANDED_PATHS).map((f) => join(dir, f));
	} catch {
		return [absolutePath];
	}
}
