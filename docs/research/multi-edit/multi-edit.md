# Multi-Edit Tool

**Status:** In progress
**Last updated:** 2026-04-04

## Background

The `multi-edit` extension (`extensions/multi-edit/index.ts`) replaces the built-in `edit` tool with a richer implementation supporting batched edits across one or more files and Codex-style apply_patch payloads.

A recent session surfaced a recurring failure mode:

```
Preflight failed before mutating files.
 ✗ Edit 1/1 (…/ask-user-question/index.ts): Could not find the exact text in …
 The old text must match exactly including all whitespace and newlines.
```

This triggered a comparison with the upstream Claude Code `FileEditTool` (from `emanuelcasco/claude-code`) to understand what our extension lacks and what correctness issues exist.

## Architecture Comparison

### Upstream Claude Code: `FileEditTool`

**Source:** `src/tools/FileEditTool/FileEditTool.ts`

Upstream exposes a **single-edit** interface — no public `MultiEdit` tool. Internal multi-edit infrastructure exists only for equivalence checking and patching.

**Input schema:**

```ts
{ file_path: string, old_string: string, new_string: string, replace_all?: boolean }
```

**Validation:**

- Requires prior `Read` (tracked via `readFileState`) — error code 6
- Rejects if `old_string === new_string`
- Rejects if `old_string` not found (after quote normalization via `findActualString`)
- Rejects if `old_string` matches multiple places with `replace_all: false` — error code 9
- Stale-write check via file mtime — error code 7
- Guards against >1 GiB files
- Blocks `.ipynb` (routes to `NotebookEditTool`)

**Application** (`utils.ts > getPatchForEdits`):

- Sequential in-memory edits
- Forward-pass check: each `old_string` must not be a substring of any previously applied `new_string`
- Atomic single write, no rollback needed
- `replace_all: false` → `String.replace` (first occurrence); `true` → `String.replaceAll`

**Quote normalization** (`findActualString`):

- Exact match first
- Fallback: normalizes curly quotes (`" " ' '`) to straight quotes
- `preserveQuoteStyle` re-applies the file's original quote style to `new_string`

**Deduplication** (`areFileEditsInputsEquivalent`):

- Fast path: literal equality of inputs
- Semantic path: applies both edit sets to current content, compares resulting text

### Our Extension: `multi-edit`

**Source:** `extensions/multi-edit/index.ts`

**Input schema:**

```ts
{
  path?: string,       // top-level (inherited by multi items)
  oldText?: string,
  newText?: string,
  multi?: Array<{ path?: string, oldText: string, newText: string }>,
  patch?: string       // Codex-style *** Begin Patch ... *** End Patch
}
```

**Three modes:**

1. **Classic** — `path + oldText + newText`
2. **Multi** — `multi[]` array with top-level `path` inheritance
3. **Patch** — Codex-style patch string (mutually exclusive)

**Application** (`applyClassicEdits`):

- Groups edits by resolved absolute path
- Sorts same-file edits by position in original content (top-to-bottom)
- Forward cursor (`searchOffset`) disambiguates duplicate `oldText` occurrences
- Dedup: silently skips redundant `oldText→newText` pairs in same file
- Writes full edited content per file once all its edits are applied

**Two-pass preflight:**

1. **Virtual workspace pass** — applies all edits to in-memory fs copy. If it fails, no real files touched.
2. **Real workspace pass** — applies to disk. No rollback on failures here.

**Patch mode** (`applyPatchOperations`):

- Supports `*** Add File`, `*** Delete File`, `*** Update File`
- Update hunks use `@@` context markers and `+`/`-`/` ` line prefixes
- Fuzzy line matching: exact → rstrip → trim → unicode normalization

## Feature Matrix

| Aspect | Upstream `FileEditTool` | `multi-edit` extension |
|---|---|---|
| Edits per call | 1 | N |
| Files per call | 1 | N |
| Core match algorithm | `findActualString` + `replace`/`replaceAll` | Raw `indexOf(oldText, searchOffset)` |
| Quote normalization | **Yes** (curly ↔ straight) | **No** (byte-exact only) |
| Fuzzy line matching | No | Only in patch mode |
| Ambiguity check | Yes (rejects unless `replace_all`) | No (takes first after cursor) |
| Duplicate handling | `replace_all` flag | Positional cursor + sort |
| "File must be read first" guard | Yes (`readFileState`) | **No** |
| Stale-write (mtime) check | Yes | **No** |
| Preflight | Validation only | **Virtual workspace two-pass** |
| Rollback | Atomic single write | **None on real pass** |
| Size guard (1 GiB) | Yes | No |
| `.ipynb` block | Yes | No |
| Dedup strategy | Semantic equivalence (final content) | String-based `appliedPairs` |
| Structured error codes | Yes (6, 7, 9, …) | No |

## Bug Fixes (Current Correctness Issues)

### High priority

1. **Real-pass partial failures leave files half-written**
   *Header comment already admits this: "Failures here are not rolled back."*
   If file A succeeds and file B fails (race, permissions flip, disk full), A is modified. Snapshot original content per file and restore on any real-pass failure.

2. **`checkWriteAccess` not enforced during preflight** (`index.ts:533-535`)
   Virtual workspace's `checkWriteAccess` is a no-op. A read-only file passes preflight and only fails on the real pass — partially defeating the "no files touched on failure" guarantee. Run `fsAccess(W_OK)` before the virtual pass.

3. **Position-based sort is unstable for duplicate `oldText`** (`index.ts:662-669`)
   Two edits sharing the same `oldText` but different `newText` both resolve to the same `indexOf` position. Sort is nondeterministic; the second edit's cursor is past the match after the first runs. Add occurrence numbering or a stable index tiebreaker.

4. **Empty-path edits crash before clear error** (`index.ts:634`)
   `resolvePath` is called on `edits[i].path` before the empty-path validation loop at `index.ts:821`. Reorder validation.

### Medium priority

5. **`formatResults` loses pending edits on throw** (`index.ts:707-708`)
   When the first edit fails, the thrown error shows only processed edits. User loses visibility of what was queued. Include remaining edits as "pending" in the output.

6. **`searchOffset` edge case with shrinking replacements** (`index.ts:712`)
   If `newText` is shorter than `oldText` and the next edit's `oldText` actually appeared after the previous cursor but before the current position, it's skipped. Positional sort mitigates in practice — edge cases with overlapping regions can still break.

7. **`writeText` always emits `context-guard:file-modified`** (`index.ts:478`)
   If content is unchanged (e.g., after dedup), the event still fires, thrashing downstream consumers. Skip writes when `content === originalContent`.

8. **Patch mode always appends trailing newline** (`index.ts:294-296`)
   Files originally without trailing newline get silently "fixed." May not match user intent.

## Port from Upstream

### High value

1. **Quote normalization** — `findActualString` + `preserveQuoteStyle`. Fixes the most common class of preflight failure (curly vs straight quotes). Try exact match first, fallback to normalized.

2. **"File must be read first" guard via `readFileState`** — biggest safety win; prevents editing files the model hasn't seen. Requires wiring into `pi`'s read-tracking.

3. **Stale-write timestamp check** — track `mtime` at read time; reject if file changed between read and edit. Critical when watchers, formatters, or users can touch files concurrently.

4. **Ambiguity rejection** — when `oldText` matches >1 place without explicit disambiguator, fail with "add more context." Our positional cursor silently picks the wrong match when edits are reordered.

5. **Semantic equivalence dedup** (`areFileEditsInputsEquivalent`) — compare final-content outcomes, not just input strings. More robust than our `appliedPairs` set.

### Medium value

6. **1 GiB size guard** — cheap `stat` check before reading huge files into memory.

7. **`.ipynb` block** — refuse raw text edits on Jupyter notebooks (cell JSON corrupts silently).

8. **Forward-pass substring check** — verify each `oldText` isn't a substring of any previously applied `newText` in the same batch. Prevents cascading match bugs where edit 2 matches content edit 1 inserted.

9. **Structured error codes** — upstream returns codes 6, 7, 9, etc. Enables better harness-side handling (retry strategy, user messaging) than string matching.

### Low value / not applicable

- `replace_all` flag — our positional cursor is arguably cleaner.
- Atomic single-write — already done per-file.
- `NotebookEditTool` delegation — only if notebook support is added.

## Unique Advantages of Our Extension

Worth preserving during any port from upstream:

- **Multi-file, multi-edit per call** — not available upstream
- **Codex-style `*** Begin Patch` support** — not available upstream
- **Virtual workspace preflight** — stronger guarantee than upstream's validation-only
- **Positional cursor + position sort** — more robust than `replace_all` when edits can arrive in any order

## Priority Order

**Ship soon:**

- Port #1 quote normalization
- Port #3 stale-write check
- Fix #1 real-pass rollback
- Fix #2 write-access in preflight

**Next:**

- Port #2 read-first guard
- Port #4 ambiguity rejection
- Port #8 forward-pass substring check
- Fix #3 unstable sort

**Nice-to-have:**

- Structured errors
- Size/notebook guards
- Remaining bug fixes

## Source References

- Upstream: `github.com/emanuelcasco/claude-code` → `src/tools/FileEditTool/FileEditTool.ts`, `src/tools/FileEditTool/utils.ts`, `src/tools/FileEditTool/types.ts`
- Local: `extensions/multi-edit/index.ts`
