/**
 * Classic edit engine — (path, oldText, newText) triples applied against a
 * Workspace, with positional same-file ordering, curly-quote fallback, and
 * atomic multi-file rollback.
 *
 * The core loop groups edits by their absolute path so all hits against a
 * file happen in one read/mutate/write cycle. Within a group, entries are
 * sorted by the position of their `oldText` in the original content, so a
 * model that lists edits bottom-up still applies them top-down.
 */

import { isAbsolute, resolve as resolvePath } from "path";

import { generateDiffString } from "./diff.ts";
import type { EditItem, EditResult, Workspace } from "./types.ts";

// ---------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------

const normalizeCurlyQuotes = (s: string): string =>
  s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"');

const trimTrailingPerLine = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");

/**
 * Ordered list of passes `findActualString` tries when matching `oldText`
 * inside file content. Each pass applies a normalizer to *both* `oldText`
 * and `content`; the first one that locates the transformed string wins.
 *
 * The array is the extension point: add a new pass here to gain tolerance
 * for a new class of model/file mismatch (e.g. dash variants, NBSP).
 */
const MATCH_PASSES: readonly ((s: string) => string)[] = [
  (s) => s, // exact
  normalizeCurlyQuotes, // curly → straight quotes
  trimTrailingPerLine, // trailing-whitespace tolerance per line
];

/**
 * Locate `oldText` inside `content` starting at `offset`. Falls back through
 * `MATCH_PASSES` when the exact search fails — most commonly when the model
 * wrote curly quotes but the file has straight ASCII.
 *
 * Returns `{ pos, actualOldText }` on match, `undefined` otherwise. Callers
 * must use `actualOldText.length` (not the original oldText length) when
 * splicing, since the matched region may differ from the requested text
 * after normalization.
 */
export function findActualString(
  content: string,
  oldText: string,
  offset: number,
): { pos: number; actualOldText: string } | undefined {
  // Fast path: exact match with no normalization.
  const exact = content.indexOf(oldText, offset);
  if (exact !== -1) return { pos: exact, actualOldText: oldText };

  // Slower passes: normalize both sides and map the position back to the
  // original content. We search in the normalized content but return the
  // position and length in the *original* so the caller can splice correctly.
  const triedOld = new Set<string>([oldText]);
  const triedContent = new Set<string>([content]);

  for (let i = 1; i < MATCH_PASSES.length; i++) {
    const transform = MATCH_PASSES[i];
    const normOld = transform(oldText);
    const normContent = transform(content);

    if (triedOld.has(normOld) && triedContent.has(normContent)) continue;
    triedOld.add(normOld);
    triedContent.add(normContent);

    const pos = normContent.indexOf(normOld, offset);
    if (pos !== -1) {
      // Map back: the character at `pos` in normalised content corresponds
      // to the same index in the original (our normalizers preserve length
      // for all passes except trimTrailingPerLine). For trimEnd we need the
      // actual substring from original content that matches.
      const actualOld = content.slice(pos, pos + normOld.length);
      // Verify the mapped slice actually normalizes to the same thing.
      if (transform(actualOld) === normOld) {
        return { pos, actualOldText: actualOld };
      }
      // If the lengths shifted (trimEnd can shrink lines), fall back to a
      // line-aligned search: find the lines in the original content.
      const match = findByNormalizedLines(content, oldText, offset, transform);
      if (match) return match;
    }
  }
  return undefined;
}

/**
 * Line-by-line normalized search. Used when a normalizer changes string
 * length (e.g. trimEnd) so character offsets between original and normalized
 * content no longer align 1:1.
 */
function findByNormalizedLines(
  content: string,
  oldText: string,
  offset: number,
  normalize: (s: string) => string,
): { pos: number; actualOldText: string } | undefined {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  if (oldLines.length === 0) return undefined;

  const normOldLines = oldLines.map((l) => normalize(l));

  // Character offset → line index.
  let charCount = 0;
  let startLine = 0;
  for (let i = 0; i < contentLines.length; i++) {
    if (charCount + contentLines[i].length >= offset) {
      startLine = i;
      break;
    }
    charCount += contentLines[i].length + 1; // +1 for \n
  }

  for (let i = startLine; i <= contentLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < normOldLines.length; j++) {
      if (normalize(contentLines[i + j]) !== normOldLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Compute character position and actual substring from original.
      let pos = 0;
      for (let k = 0; k < i; k++) pos += contentLines[k].length + 1;
      const endLine = i + oldLines.length - 1;
      let endPos = 0;
      for (let k = 0; k <= endLine; k++) endPos += contentLines[k].length + 1;
      endPos--; // don't include the final \n after last matched line
      // If oldText ended with \n, include it.
      if (oldText.endsWith("\n") && endPos + 1 <= content.length) endPos++;
      const actualOldText = content.slice(pos, endPos);
      return { pos, actualOldText };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

interface IndexedEdit {
  index: number;
  edit: EditItem;
}

function toAbsolute(path: string, cwd: string): string {
  return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}

/**
 * Bucket a flat edit list by its resolved absolute path. The returned Map
 * preserves insertion order, which is the order files are processed in the
 * apply loop — making the first-seen file also the first to be mutated on
 * disk.
 */
function groupEditsByPath(
  edits: EditItem[],
  cwd: string,
): Map<string, IndexedEdit[]> {
  const groups = new Map<string, IndexedEdit[]>();
  for (let i = 0; i < edits.length; i++) {
    const abs = toAbsolute(edits[i].path, cwd);
    const bucket = groups.get(abs);
    if (bucket) {
      bucket.push({ index: i, edit: edits[i] });
    } else {
      groups.set(abs, [{ index: i, edit: edits[i] }]);
    }
  }
  return groups;
}

/**
 * Sort same-file edits by the position of their `oldText` inside the
 * original content. Edits whose oldText can't be located slide to the end
 * and surface the error through the regular apply loop.
 */
function sortGroupByPosition(
  group: IndexedEdit[],
  originalContent: string,
): void {
  if (group.length < 2) return;
  const positions = new Map<IndexedEdit, number>();
  for (const entry of group) {
    const match = findActualString(originalContent, entry.edit.oldText, 0);
    positions.set(
      entry,
      match === undefined ? Number.MAX_SAFE_INTEGER : match.pos,
    );
  }
  group.sort((a, b) => positions.get(a)! - positions.get(b)!);
}

// ---------------------------------------------------------------------------
// Core apply loop
// ---------------------------------------------------------------------------

interface ApplyOptions {
  collectDiff?: boolean;
  rollbackOnError?: boolean;
  /** When true, failed edits are recorded but the batch continues with the
   *  remaining edits instead of aborting the entire group. */
  continueOnError?: boolean;
}

/**
 * Apply a list of classic edits sequentially through a Workspace.
 *
 * Within each file the applier advances a `searchOffset` cursor after every
 * replacement so duplicate oldText snippets are disambiguated positionally.
 * Same-file edits are reordered by the position of their oldText in the
 * original content so the cursor always moves forward.
 *
 * When `rollbackOnError` is set, any file already written in this batch is
 * restored to its pre-edit snapshot if a later file fails — producing an
 * atomic multi-file edit on the real filesystem.
 */
export async function applyClassicEdits(
  edits: EditItem[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options: ApplyOptions = {},
): Promise<EditResult[]> {
  const {
    collectDiff = false,
    rollbackOnError = false,
    continueOnError = false,
  } = options;

  const fileGroups = groupEditsByPath(edits, cwd);
  const results: EditResult[] = new Array(edits.length);

  // Fail fast on any unwritable target so we don't partially mutate the FS.
  await Promise.all(
    Array.from(fileGroups.keys(), (absPath) =>
      workspace.checkWriteAccess(absPath),
    ),
  );

  // Pre-edit snapshots keyed by absolute path — populated as each file is
  // successfully written, consumed on failure for rollback.
  const snapshots = new Map<string, string>();

  try {
    for (const [absPath, group] of fileGroups) {
      throwIfAborted(signal);

      const originalContent = await workspace.readText(absPath);
      sortGroupByPosition(group, originalContent);

      let updatedContent: string;
      try {
        updatedContent = applyGroupToContent(
          group,
          originalContent,
          results,
          edits.length,
          signal,
          continueOnError,
        );
      } catch (err) {
        if (continueOnError) continue;
        throw err;
      }

      if (updatedContent === originalContent) continue;

      snapshots.set(absPath, originalContent);
      await workspace.writeText(absPath, updatedContent);

      if (collectDiff) {
        const { diff, firstChangedLine } = generateDiffString(
          originalContent,
          updatedContent,
        );
        const firstSuccessIdx = group.find(
          (e) => results[e.index]?.success,
        )?.index;
        if (firstSuccessIdx !== undefined) {
          results[firstSuccessIdx].diff = diff;
          results[firstSuccessIdx].firstChangedLine = firstChangedLine;
        }
      }
    }
  } catch (err) {
    if (rollbackOnError) {
      await rollbackSnapshots(snapshots, workspace);
    }
    throw err;
  }

  return results;
}

/**
 * Apply every edit in a same-file group against `originalContent`, writing
 * per-edit outcomes into the shared `results` slot array. Returns the final
 * mutated content for the file, or throws with a formatted error if a hunk
 * can't be located.
 */
function applyGroupToContent(
  group: IndexedEdit[],
  originalContent: string,
  results: EditResult[],
  totalEdits: number,
  signal: AbortSignal | undefined,
  continueOnError = false,
): string {
  let content = originalContent;
  let searchOffset = 0;

  // Track which oldText→newText pairs already landed in this file so we
  // can skip a redundant duplicate gracefully instead of failing the batch.
  const appliedPairs = new Set<string>();
  const pairKey = (edit: EditItem) => `${edit.oldText}\0${edit.newText}`;

  for (const { index, edit } of group) {
    throwIfAborted(signal);

    const match = findActualString(content, edit.oldText, searchOffset);

    if (match === undefined) {
      if (appliedPairs.has(pairKey(edit))) {
        results[index] = {
          path: edit.path,
          success: true,
          message: `Skipped redundant edit in ${edit.path} (already replaced all occurrences).`,
        };
        continue;
      }

      results[index] = {
        path: edit.path,
        success: false,
        message: `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
      };

      if (continueOnError) continue;

      markRemainingSkipped(group, index, results);
      throw new Error(formatResults(results.filter(Boolean), totalEdits));
    }

    const { pos, actualOldText } = match;
    content =
      content.slice(0, pos) +
      edit.newText +
      content.slice(pos + actualOldText.length);
    searchOffset = pos + edit.newText.length;
    appliedPairs.add(pairKey(edit));

    results[index] = {
      path: edit.path,
      success: true,
      message: `Edited ${edit.path}.`,
    };
  }

  return content;
}

function markRemainingSkipped(
  group: IndexedEdit[],
  failedIndex: number,
  results: EditResult[],
): void {
  const failedPos = group.findIndex((e) => e.index === failedIndex);
  for (let i = failedPos + 1; i < group.length; i++) {
    const pending = group[i];
    results[pending.index] = {
      path: pending.edit.path,
      success: false,
      message: `Skipped (earlier edit in ${pending.edit.path} failed).`,
    };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

async function rollbackSnapshots(
  snapshots: Map<string, string>,
  workspace: Workspace,
): Promise<void> {
  // Best-effort restore — surface the original failure regardless of per-file
  // rollback failures.
  await Promise.all(
    Array.from(snapshots, ([absPath, original]) =>
      workspace.writeText(absPath, original).catch(() => {}),
    ),
  );
}

export function formatResults(
  results: EditResult[],
  totalEdits: number,
): string {
  const lines: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.success ? "✓" : "✗";
    lines.push(
      `${status} Edit ${i + 1}/${totalEdits} (${r.path}): ${r.message}`,
    );
  }

  const remaining = totalEdits - results.length;
  if (remaining > 0) {
    lines.push(`⊘ ${remaining} remaining edit(s) skipped due to error.`);
  }

  return lines.join("\n");
}
