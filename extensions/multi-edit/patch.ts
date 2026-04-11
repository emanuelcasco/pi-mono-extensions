/**
 * Codex-style apply_patch engine.
 *
 * Accepts payloads bracketed by `*** Begin Patch` / `*** End Patch` and
 * supports three operations: Add File, Delete File, Update File.
 *
 * Design — this is a recursive-descent parser over a line cursor. Each
 * grammar rule owns a small function; there is no shared mutable index
 * bookkeeping or nested-loop state machine. Hunks are stored as raw
 * `oldBlock`/`newBlock` strings so the applier can run `indexOf` directly
 * instead of reconstructing line arrays on each apply.
 *
 * Compatibility notes (vs the original Codex apply_patch format):
 * - Hunks MUST start with a "@@" header. Missing headers are rejected.
 * - Only exact-match hunk anchoring — no 4-pass fuzzy `seekSequence`.
 * - `*** End of File` sentinel hunks are not recognized.
 * - `*** Move to:` is rejected.
 */

import { isAbsolute, resolve as resolvePath } from "path";

import { generateDiffString } from "./diff.ts";
import type { Hunk, PatchOperation, PatchOpResult, Workspace } from "./types.ts";

// ---------------------------------------------------------------------------
// Line cursor
// ---------------------------------------------------------------------------

class LineCursor {
	private pos = 0;
	constructor(private readonly lines: readonly string[]) {}

	peek(): string | undefined {
		return this.lines[this.pos];
	}

	next(): string | undefined {
		return this.lines[this.pos++];
	}

	hasMore(): boolean {
		return this.pos < this.lines.length;
	}

	/** Consume lines while the predicate holds. Returns the number consumed. */
	skipWhile(pred: (line: string) => boolean): number {
		let count = 0;
		while (this.hasMore() && pred(this.peek()!)) {
			this.pos++;
			count++;
		}
		return count;
	}
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const DIRECTIVE_BEGIN = "*** Begin Patch";
const DIRECTIVE_END = "*** End Patch";
const DIRECTIVE_ADD = "*** Add File: ";
const DIRECTIVE_DELETE = "*** Delete File: ";
const DIRECTIVE_UPDATE = "*** Update File: ";
const DIRECTIVE_MOVE = "*** Move to: ";

const isBlank = (line: string): boolean => line.trim() === "";
const isDirective = (line: string): boolean => line.trimEnd().startsWith("*** ");

export function parsePatch(patchText: string): PatchOperation[] {
	const normalized = patchText.replace(/\r\n/g, "\n").trim();
	if (normalized.length === 0) {
		throw new Error("Patch is empty or invalid");
	}

	const lines = normalized.split("\n");
	if (lines[0].trim() !== DIRECTIVE_BEGIN) {
		throw new Error(`The first line of the patch must be '${DIRECTIVE_BEGIN}'`);
	}
	if (lines[lines.length - 1].trim() !== DIRECTIVE_END) {
		throw new Error(`The last line of the patch must be '${DIRECTIVE_END}'`);
	}

	// Cursor over the interior (strip Begin and End sentinels).
	const cursor = new LineCursor(lines.slice(1, -1));
	const operations: PatchOperation[] = [];

	while (cursor.hasMore()) {
		cursor.skipWhile(isBlank);
		if (!cursor.hasMore()) break;

		const header = cursor.next()!.trimEnd();

		if (header.startsWith(DIRECTIVE_ADD)) {
			operations.push(parseAddFile(header.slice(DIRECTIVE_ADD.length), cursor));
			continue;
		}
		if (header.startsWith(DIRECTIVE_DELETE)) {
			operations.push({ kind: "delete", path: header.slice(DIRECTIVE_DELETE.length) });
			continue;
		}
		if (header.startsWith(DIRECTIVE_UPDATE)) {
			operations.push(parseUpdateFile(header.slice(DIRECTIVE_UPDATE.length), cursor));
			continue;
		}

		throw new Error(
			`'${header}' is not a valid hunk header. Valid headers: '${DIRECTIVE_ADD.trim()}', '${DIRECTIVE_DELETE.trim()}', '${DIRECTIVE_UPDATE.trim()}'`,
		);
	}

	return operations;
}

function parseAddFile(path: string, cursor: LineCursor): PatchOperation {
	const bodyLines: string[] = [];

	while (cursor.hasMore()) {
		const line = cursor.peek()!;
		if (isDirective(line)) break;
		cursor.next();
		if (!line.startsWith("+")) {
			throw new Error(`Invalid add-file line '${line}'. Add-file lines must start with '+'`);
		}
		bodyLines.push(line.slice(1));
	}

	const contents = bodyLines.length > 0 ? `${bodyLines.join("\n")}\n` : "";
	return { kind: "add", path, contents };
}

function parseUpdateFile(path: string, cursor: LineCursor): PatchOperation {
	// Move-to is explicitly rejected — we only support in-place updates.
	const lookahead = cursor.peek();
	if (lookahead !== undefined && lookahead.trimEnd().startsWith(DIRECTIVE_MOVE)) {
		throw new Error("Patch move operations (*** Move to:) are not supported.");
	}

	const hunks: Hunk[] = [];

	while (cursor.hasMore()) {
		cursor.skipWhile(isBlank);
		if (!cursor.hasMore()) break;

		const line = cursor.peek()!;
		if (isDirective(line)) break;

		hunks.push(parseHunk(path, cursor));
	}

	if (hunks.length === 0) {
		throw new Error(`Update file hunk for path '${path}' is empty`);
	}

	return { kind: "update", path, hunks };
}

function parseHunk(path: string, cursor: LineCursor): Hunk {
	const header = cursor.next();
	if (header === undefined) {
		throw new Error(`Expected @@ hunk header in '${path}', got end of patch`);
	}

	const trimmed = header.trimEnd();
	let contextPrefix: string | undefined;
	if (trimmed === "@@") {
		contextPrefix = undefined;
	} else if (trimmed.startsWith("@@ ")) {
		contextPrefix = trimmed.slice(3);
	} else {
		throw new Error(`Expected update hunk to start with @@ context marker, got: '${header}'`);
	}

	const oldLines: string[] = [];
	const newLines: string[] = [];

	while (cursor.hasMore()) {
		const raw = cursor.peek()!;
		const trimEnd = raw.trimEnd();

		// Any directive or next hunk header ends the current hunk.
		if (trimEnd.startsWith("@@") || isDirective(raw)) break;

		cursor.next();

		if (raw.length === 0) {
			// Blank line inside a hunk is treated as an unchanged empty line.
			oldLines.push("");
			newLines.push("");
			continue;
		}

		const marker = raw[0];
		const body = raw.slice(1);

		if (marker === " ") {
			oldLines.push(body);
			newLines.push(body);
		} else if (marker === "-") {
			oldLines.push(body);
		} else if (marker === "+") {
			newLines.push(body);
		} else {
			throw new Error(
				`Unexpected line found in update hunk for '${path}': '${raw}'. Every line should start with ' ', '+', or '-'.`,
			);
		}
	}

	if (oldLines.length === 0 && newLines.length === 0) {
		throw new Error(`Update hunk for '${path}' does not contain any lines`);
	}

	return {
		contextPrefix,
		oldBlock: oldLines.join("\n"),
		newBlock: newLines.join("\n"),
	};
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

/**
 * Apply a list of hunks to a file's content. Operates directly on the raw
 * string via `indexOf` — no intermediate line-array reconstruction. A search
 * cursor advances after each hunk so repeated `oldBlock` strings are matched
 * in top-to-bottom order.
 */
function applyHunks(filePath: string, content: string, hunks: Hunk[]): string {
	let result = content;
	let cursor = 0;

	for (const hunk of hunks) {
		let searchFrom = cursor;

		if (hunk.contextPrefix !== undefined) {
			const ctx = result.indexOf(hunk.contextPrefix, searchFrom);
			if (ctx === -1) {
				throw new Error(`Failed to find context '${hunk.contextPrefix}' in ${filePath}`);
			}
			searchFrom = ctx + hunk.contextPrefix.length;
		}

		if (hunk.oldBlock === "") {
			// Pure insertion: append newBlock at the anchor (or end-of-file).
			const insertAt = hunk.contextPrefix !== undefined ? searchFrom : result.length;
			const needsNewline = insertAt > 0 && result[insertAt - 1] !== "\n";
			const prefix = needsNewline ? "\n" : "";
			result = result.slice(0, insertAt) + prefix + hunk.newBlock + result.slice(insertAt);
			cursor = insertAt + prefix.length + hunk.newBlock.length;
			continue;
		}

		const found = result.indexOf(hunk.oldBlock, searchFrom);
		if (found === -1) {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${hunk.oldBlock}`);
		}

		result = result.slice(0, found) + hunk.newBlock + result.slice(found + hunk.oldBlock.length);
		cursor = found + hunk.newBlock.length;
	}

	// Preserve the "file ends with newline" invariant upstream relies on.
	if (!result.endsWith("\n")) {
		result = `${result}\n`;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function resolvePatchPath(cwd: string, filePath: string): string {
	const trimmed = filePath.trim();
	if (!trimmed) {
		throw new Error("Patch path cannot be empty");
	}
	return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(cwd, trimmed);
}

function ensureTrailingNewline(content: string): string {
	return content.endsWith("\n") ? content : `${content}\n`;
}

export async function applyPatchOperations(
	ops: PatchOperation[],
	workspace: Workspace,
	cwd: string,
	signal?: AbortSignal,
	options?: { collectDiff?: boolean },
): Promise<PatchOpResult[]> {
	const results: PatchOpResult[] = [];
	const collectDiff = options?.collectDiff ?? false;

	for (const op of ops) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		switch (op.kind) {
			case "add": {
				const abs = resolvePatchPath(cwd, op.path);
				const oldText = collectDiff && (await workspace.exists(abs)) ? await workspace.readText(abs) : "";
				const newText = ensureTrailingNewline(op.contents);
				await workspace.writeText(abs, newText);
				results.push(buildOpResult(op.path, `Added file ${op.path}.`, oldText, newText, collectDiff));
				break;
			}

			case "delete": {
				const abs = resolvePatchPath(cwd, op.path);
				if (!(await workspace.exists(abs))) {
					throw new Error(`Failed to delete ${op.path}: file does not exist`);
				}
				const oldText = collectDiff ? await workspace.readText(abs) : "";
				await workspace.deleteFile(abs);
				results.push(buildOpResult(op.path, `Deleted file ${op.path}.`, oldText, "", collectDiff));
				break;
			}

			case "update": {
				const abs = resolvePatchPath(cwd, op.path);
				const sourceText = await workspace.readText(abs);
				const updated = applyHunks(op.path, sourceText, op.hunks);
				await workspace.writeText(abs, updated);
				results.push(buildOpResult(op.path, `Updated ${op.path}.`, sourceText, updated, collectDiff));
				break;
			}
		}
	}

	return results;
}

function buildOpResult(
	path: string,
	message: string,
	oldText: string,
	newText: string,
	collectDiff: boolean,
): PatchOpResult {
	const result: PatchOpResult = { path, message };
	if (collectDiff) {
		const { diff, firstChangedLine } = generateDiffString(oldText, newText);
		result.diff = diff;
		result.firstChangedLine = firstChangedLine;
	}
	return result;
}
