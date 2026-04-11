/**
 * Two-pass diff renderer on top of `diff.diffLines`.
 *
 * Pass 1 — `expand`: flatten the `diffLines` change parts into a typed
 * `Entry[]` stream where every entry carries its own 1-indexed old/new line
 * numbers. No rendering decisions happen here.
 *
 * Pass 2 — `render`: walk the entries, buffer each unchanged run, and decide
 * per run whether to show it whole, collapse it with a `...` marker, or
 * discard it (when the run sits outside any change's context window).
 *
 * Output contract (stable, tested in __tests__/diff.test.ts):
 * - Added lines:   `+NN text`
 * - Removed lines: `-NN text`
 * - Context lines: ` NN text`
 * - Collapsed run: ` __ ...`   (blank gutter + ellipsis)
 *
 * Line numbers are right-padded to the width of the longest 1-indexed line
 * number across both files so the gutter stays aligned.
 */

import * as Diff from "diff";

type ContextEntry = { kind: "context"; oldLine: number; newLine: number; text: string };
type AddedEntry = { kind: "added"; newLine: number; text: string };
type RemovedEntry = { kind: "removed"; oldLine: number; text: string };
type Entry = ContextEntry | AddedEntry | RemovedEntry;

/**
 * Walk `diff.diffLines` parts and yield a flat entry list plus the 1-indexed
 * new-file line number of the first change. `firstChangedLine` is captured
 * eagerly during expansion so callers don't have to re-scan the entries.
 */
function expand(parts: Diff.Change[]): { entries: Entry[]; firstChangedLine: number | undefined } {
	const entries: Entry[] = [];
	let oldNum = 1;
	let newNum = 1;
	let firstChangedLine: number | undefined;

	for (const part of parts) {
		const lines = part.value.split("\n");
		// `diff.diffLines` always terminates with an empty string from the trailing
		// newline — drop it so we don't emit a ghost row per part.
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		for (const text of lines) {
			if (part.added) {
				if (firstChangedLine === undefined) firstChangedLine = newNum;
				entries.push({ kind: "added", newLine: newNum, text });
				newNum++;
			} else if (part.removed) {
				if (firstChangedLine === undefined) firstChangedLine = newNum;
				entries.push({ kind: "removed", oldLine: oldNum, text });
				oldNum++;
			} else {
				entries.push({ kind: "context", oldLine: oldNum, newLine: newNum, text });
				oldNum++;
				newNum++;
			}
		}
	}

	return { entries, firstChangedLine };
}

/**
 * Render an expanded entry stream into gutter-formatted output lines. Context
 * runs are collapsed when their length exceeds the visible head + tail window.
 */
function render(entries: Entry[], contextLines: number, lineNumWidth: number): string[] {
	const pad = (n: number) => String(n).padStart(lineNumWidth, " ");
	const blankGutter = " ".repeat(lineNumWidth);
	const out: string[] = [];

	let i = 0;
	while (i < entries.length) {
		const entry = entries[i];

		if (entry.kind === "added") {
			out.push(`+${pad(entry.newLine)} ${entry.text}`);
			i++;
			continue;
		}
		if (entry.kind === "removed") {
			out.push(`-${pad(entry.oldLine)} ${entry.text}`);
			i++;
			continue;
		}

		// entry.kind === "context" — buffer the whole run before deciding.
		const runStart = i;
		while (i < entries.length && entries[i].kind === "context") {
			i++;
		}
		const runEnd = i;
		const runLen = runEnd - runStart;

		const hasChangeBefore = runStart > 0;
		const hasChangeAfter = runEnd < entries.length;

		// Context that isn't adjacent to any change is dead weight — drop it.
		if (!hasChangeBefore && !hasChangeAfter) continue;

		const head = hasChangeBefore ? contextLines : 0;
		const tail = hasChangeAfter ? contextLines : 0;

		const writeAt = (idx: number) => {
			const e = entries[idx] as ContextEntry;
			out.push(` ${pad(e.oldLine)} ${e.text}`);
		};

		if (runLen <= head + tail) {
			for (let j = runStart; j < runEnd; j++) writeAt(j);
			continue;
		}

		for (let j = 0; j < head; j++) writeAt(runStart + j);
		out.push(` ${blankGutter} ...`);
		for (let j = tail; j > 0; j--) writeAt(runEnd - j);
	}

	return out;
}

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const { entries, firstChangedLine } = expand(parts);

	// Gutter width: pad to the widest 1-indexed line number that can appear.
	const oldLineCount = oldContent.split("\n").length;
	const newLineCount = newContent.split("\n").length;
	const lineNumWidth = String(Math.max(oldLineCount, newLineCount)).length;

	const lines = render(entries, contextLines, lineNumWidth);

	return { diff: lines.join("\n"), firstChangedLine };
}
