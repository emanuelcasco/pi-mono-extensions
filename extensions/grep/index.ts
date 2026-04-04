/**
 * Grep Extension — dedicated ripgrep tool for pi.
 *
 * Wraps `rg` with built-in output limits and pagination so the model never
 * accidentally dumps thousands of lines into context.  The model is instructed
 * to always use this tool instead of calling rg directly via bash.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const EXCLUDED_DIRS = [".git", ".svn", ".hg", "node_modules", ".pi"];

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Regex pattern to search for" }),
	path: Type.Optional(Type.String({ description: "File or directory to search. Defaults to cwd." })),
	glob: Type.Optional(Type.String({ description: 'Glob filter, e.g. "*.ts", "**/*.{ts,tsx}"' })),
	type: Type.Optional(Type.String({ description: 'File type filter, e.g. "ts", "py", "js"' })),
	output_mode: Type.Optional(
		StringEnum(["content", "files_with_matches", "count"] as const, {
			description: "content: matching lines. files_with_matches: file paths only (default, cheapest). count: match counts per file.",
		}),
	),
	head_limit: Type.Optional(
		Type.Number({
			description: "Max output lines/entries. Defaults to 60. Pass 0 for unlimited (use sparingly).",
		}),
	),
	offset: Type.Optional(Type.Number({ description: "Skip first N entries (for pagination). Defaults to 0." })),
	case_insensitive: Type.Optional(Type.Boolean({ description: "Case-insensitive search (-i). Default false." })),
	context_lines: Type.Optional(
		Type.Number({ description: "Lines of context around each match (-C). Only applies to content mode." }),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "grep",
		label: "Grep",
		description: "Search file contents using ripgrep. Prefer this over bash+rg for all search tasks.",
		promptSnippet: "Search for patterns in files using ripgrep",
		promptGuidelines: [
			"ALWAYS use grep for search tasks. NEVER invoke rg directly via the bash tool — raw rg output is unbounded and wastes context.",
			"Use output_mode='files_with_matches' (default) when you only need to know which files match — it costs far fewer tokens than showing content.",
			"Use head_limit and offset to paginate large result sets rather than reading everything at once.",
		],
		parameters: grepSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const {
				pattern,
				path: searchPath,
				glob,
				type,
				output_mode = "files_with_matches",
				head_limit = 60,
				offset = 0,
				case_insensitive = false,
				context_lines,
			} = params;

			const args: string[] = [];

			// Output mode flags
			if (output_mode === "files_with_matches") {
				args.push("-l");
			} else if (output_mode === "content") {
				args.push("-n");
			} else if (output_mode === "count") {
				args.push("--count");
			}

			// Case-insensitive
			if (case_insensitive) {
				args.push("-i");
			}

			// Context lines (content mode only)
			if (output_mode === "content" && context_lines !== undefined && context_lines > 0) {
				args.push("-C", String(context_lines));
			}

			// Glob filter
			if (glob) {
				args.push("--glob", glob);
			}

			// File type filter
			if (type) {
				args.push("--type", type);
			}

			// Exclude common noise directories
			for (const dir of EXCLUDED_DIRS) {
				args.push("--glob", `!${dir}/**`);
			}

			// Pattern and search root
			args.push(pattern);
			args.push(searchPath ?? ctx.cwd);

			// Run ripgrep
			let result: { stdout: string; stderr: string; code: number; killed?: boolean };
			try {
				result = await pi.exec("rg", args, { signal, timeout: 15000 });
			} catch (err: any) {
				const msg = err?.message ?? String(err);
				if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("enoent")) {
					return {
						content: [
							{
								type: "text" as const,
								text: "ripgrep (rg) is not installed. Install it with: brew install ripgrep",
							},
						],
					};
				}
				throw err;
			}

			// rg exits 1 when no matches are found — that's not an error
			if (result.code === 1) {
				return { content: [{ type: "text" as const, text: "No matches found." }] };
			}

			// Other non-zero codes → real error
			if (result.code !== 0) {
				const errText = result.stderr.trim() || result.stdout.trim();
				if (errText.toLowerCase().includes("not found") || errText.toLowerCase().includes("no such file or directory")) {
					return {
						content: [
							{
								type: "text" as const,
								text: "ripgrep (rg) is not installed. Install it with: brew install ripgrep",
							},
						],
					};
				}
				return {
					content: [{ type: "text" as const, text: `rg error (exit ${result.code}): ${errText}` }],
				};
			}

			// Parse and paginate output
			const allLines = result.stdout.split("\n").filter((l) => l.length > 0);
			const total = allLines.length;
			const start = offset ?? 0;
			const limit = (head_limit ?? 60) === 0 ? allLines.length : (head_limit ?? 60);
			const slice = allLines.slice(start, start + limit);
			const shown = slice.length;

			let text = slice.join("\n");

			if (output_mode === "files_with_matches") {
				text += `\n\n[${total} file${total === 1 ? "" : "s"} matched]`;
				if (total > start + shown && limit > 0) {
					text += `\n[Showing ${shown} of ${total} files. Use offset=${start + limit} for next page.]`;
				}
			} else {
				if (total > start + shown && limit > 0) {
					text += `\n\n[Showing ${shown} of ${total} lines. Use offset=${start + limit} for next page.]`;
				}
			}

			return { content: [{ type: "text" as const, text }] };
		},
	});
}
