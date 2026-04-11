/**
 * Multi-Edit Extension — replaces the built-in `edit` tool.
 *
 * Supports all original parameters (path, oldText, newText) plus:
 * - `multi`: array of {path, oldText, newText} edits applied in sequence
 * - `patch`: Codex-style apply_patch payload
 *
 * When both top-level params and `multi` are provided, the top-level edit
 * is treated as an implicit first item prepended to the multi list.
 *
 * A preflight pass is performed before mutating files:
 * - multi/top-level mode: preflight via virtualized built-in edit tool
 * - patch mode: preflight by applying patch operations on a virtual filesystem
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { applyClassicEdits } from "./classic.ts";
import { applyPatchOperations, parsePatch } from "./patch.ts";
import type { EditItem } from "./types.ts";
import { createRealWorkspace, createVirtualWorkspace } from "./workspace.ts";

const editItemSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute). Inherits from top-level path if omitted." })),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

const multiEditSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute)" })),
	oldText: Type.Optional(Type.String({ description: "Exact text to find and replace (must match exactly)" })),
	newText: Type.Optional(Type.String({ description: "New text to replace the old text with" })),
	multi: Type.Optional(
		Type.Array(editItemSchema, {
			description: "Multiple edits to apply in sequence. Each item has path, oldText, and newText.",
		}),
	),
	patch: Type.Optional(
		Type.String({
			description:
				"Codex-style apply_patch payload (*** Begin Patch ... *** End Patch). Mutually exclusive with path/oldText/newText/multi.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits. Supports a `multi` parameter for batch edits across one or more files, and a `patch` parameter for Codex-style patches.",
		promptSnippet:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		promptGuidelines: [
			"Use edit for precise changes (old text must match exactly)",
			"Use the `multi` parameter to apply multiple edits in a single tool call",
			"Use the `patch` parameter for Codex-style multi-file / hunk-based edits",
		],
		parameters: multiEditSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, oldText, newText, multi, patch } = params;

			const hasAnyClassicParam = path !== undefined || oldText !== undefined || newText !== undefined || multi !== undefined;
			if (patch !== undefined && hasAnyClassicParam) {
				throw new Error("The `patch` parameter is mutually exclusive with path/oldText/newText/multi.");
			}

			if (patch !== undefined) {
				const ops = parsePatch(patch);

				// Preflight on virtual filesystem before mutating real files.
				await applyPatchOperations(ops, createVirtualWorkspace(ctx.cwd), ctx.cwd, signal, { collectDiff: false });

				// Apply for real.
				const applied = await applyPatchOperations(ops, createRealWorkspace(pi), ctx.cwd, signal, { collectDiff: true });
				const summary = applied.map((r, i) => `${i + 1}. ${r.message}`).join("\n");
				const combinedDiff = applied
					.filter((r) => r.diff)
					.map((r) => `File: ${r.path}\n${r.diff}`)
					.join("\n\n");
				const firstChangedLine = applied.find((r) => r.firstChangedLine !== undefined)?.firstChangedLine;
				return {
					content: [{ type: "text" as const, text: `Applied patch with ${applied.length} operation(s).\n${summary}` }],
					details: {
						diff: combinedDiff,
						firstChangedLine,
					},
				};
			}

			// Build classic edit list.
			const edits: EditItem[] = [];
			const hasTopLevel = path !== undefined && oldText !== undefined && newText !== undefined;

			if (hasTopLevel) {
				edits.push({ path: path!, oldText: oldText!, newText: newText! });
			} else if (path !== undefined || oldText !== undefined || newText !== undefined) {
				// When multi is present, only a bare top-level `path` (for inheritance) is allowed.
				// Any other partial combination (e.g. path+oldText, oldText+newText) is an error.
				const hasOnlyPath = path !== undefined && oldText === undefined && newText === undefined;
				if (!hasOnlyPath || multi === undefined) {
					const missing: string[] = [];
					if (path === undefined) missing.push("path");
					if (oldText === undefined) missing.push("oldText");
					if (newText === undefined) missing.push("newText");
					throw new Error(
						`Incomplete top-level edit: missing ${missing.join(", ")}. Provide all three (path, oldText, newText) or use only the multi parameter.`,
					);
				}
				// path-only top-level with multi is fine — path is inherited below.
			}

			if (multi) {
				for (const item of multi) {
					edits.push({
						path: item.path ?? path ?? "",
						oldText: item.oldText,
						newText: item.newText,
					});
				}
			}

			if (edits.length === 0) {
				throw new Error("No edits provided. Supply path/oldText/newText, a multi array, or a patch.");
			}

			// Validate that every edit has a path.
			for (let i = 0; i < edits.length; i++) {
				if (!edits[i].path) {
					throw new Error(
						`Edit ${i + 1} is missing a path. Provide a path on each multi item or set a top-level path to inherit.`,
					);
				}
			}

			// Preflight pass on virtual workspace before mutating real files.
			// Uses sequential occurrence matching so same-file edits are resolved
			// in file order (positional ordering).
			try {
				await applyClassicEdits(edits, createVirtualWorkspace(ctx.cwd), ctx.cwd, signal, { collectDiff: false });
			} catch (err: any) {
				throw new Error(`Preflight failed before mutating files.\n${err.message ?? String(err)}`);
			}

			// Apply for real. `rollbackOnError` restores any file we already
			// wrote if a later file in the batch fails mid-write.
			const results = await applyClassicEdits(edits, createRealWorkspace(pi), ctx.cwd, signal, {
				collectDiff: true,
				rollbackOnError: true,
			});

			if (results.length === 1) {
				const r = results[0];
				return {
					content: [{ type: "text" as const, text: r.message }],
					details: {
						diff: r.diff ?? "",
						firstChangedLine: r.firstChangedLine,
					},
				};
			}

			const combinedDiff = results
				.filter((r) => r.diff)
				.map((r) => r.diff)
				.join("\n");

			const firstChanged = results.find((r) => r.firstChangedLine !== undefined)?.firstChangedLine;
			const summary = results.map((r, i) => `${i + 1}. ${r.message}`).join("\n");

			return {
				content: [{ type: "text" as const, text: `Applied ${results.length} edit(s) successfully.\n${summary}` }],
				details: {
					diff: combinedDiff,
					firstChangedLine: firstChanged,
				},
			};
		},
	});
}
