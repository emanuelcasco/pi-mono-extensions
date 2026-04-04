# Multi-Edit Refactor — Implementation Plan

**Date:** 2026-04-04  
**File:** `extensions/multi-edit/index.ts`  
**Status:** Ready to implement

## Overview

Five concrete changes to `extensions/multi-edit/index.ts`, ordered by priority.
No schema changes, no new dependencies, no breaking API surface changes.

## Change Set

### Fix #1 — Real-pass Rollback (`applyClassicEdits`)

**Problem:** If file A writes successfully and file B fails (permissions flip, disk full, etc.),
file A is permanently modified. The header comment even admits this.

**Solution:** Collect `originalContent` snapshots before each write.  
On any thrown error during the real pass, restore all already-written files.

**Implementation:**

- Add `rollbackOnError?: boolean` to the `options` parameter of `applyClassicEdits`.
- Declare `const writtenSnapshots = new Map<string, string>()` before the file loop.
- Before `workspace.writeText(absPath, content)`, save `writtenSnapshots.set(absPath, originalContent)`.
- Wrap the file loop in `try { ... } catch (err) { /* restore snapshots, rethrow */ }`.
- Call site (real pass): pass `rollbackOnError: true`.

### Fix #2 — Write-access Check in Preflight (`createVirtualWorkspace`)

**Problem:** `checkWriteAccess` in the virtual workspace is a no-op. A read-only file passes preflight
and only fails on the real pass — partially defeating the "no files touched on failure" guarantee.

**Solution:** Replace the no-op with an actual `fsAccess(absolutePath, constants.W_OK)` call.

```ts
// Before
checkWriteAccess: async () => {
    // No-op for virtual workspace
},

// After
checkWriteAccess: async (absolutePath: string) => {
    await fsAccess(absolutePath, constants.W_OK);
},
```

### Fix #3 — Quote Normalization / `findActualString` (Port from upstream)

**Problem:** Raw `content.indexOf(edit.oldText, offset)` fails when the model uses curly/smart
quotes (`" " ' '`) vs straight ASCII quotes. This is the most frequent class of preflight failure.

**Solution:** Add a `findActualString` helper that tries exact match first, then retries after
normalizing curly quotes to straight ASCII. Use it everywhere `indexOf` is currently called
for `oldText` matching (both in position-sort and in the main apply loop).

```ts
function findActualString(
  content: string,
  oldText: string,
  offset: number,
): { pos: number; actualOldText: string } | undefined {
  // 1. Exact match
  const exact = content.indexOf(oldText, offset);
  if (exact !== -1) return { pos: exact, actualOldText: oldText };
  // 2. Normalize curly quotes → straight and retry
  const normalized = oldText
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  if (normalized !== oldText) {
    const norm = content.indexOf(normalized, offset);
    if (norm !== -1) return { pos: norm, actualOldText: normalized };
  }
  return undefined;
}
```

Key usages to update:

- **Sort positions** (`originalContent.indexOf(entry.edit.oldText)`) → `findActualString(originalContent, entry.edit.oldText, 0)?.pos`
- **Apply loop** (`content.indexOf(edit.oldText, searchOffset)`) → `findActualString(content, edit.oldText, searchOffset)`
- **Content splice** (`content.slice(pos + edit.oldText.length)`) → `content.slice(pos + actualOldText.length)`

### Fix #4 — Skip Unchanged Writes (`createRealWorkspace.writeText`)

**Problem:** `writeText` always calls `fsWriteFile` + emits `context-guard:file-modified`,
even when content is identical to what was last read (e.g., after dedup). This thrashes
file watchers and downstream consumers unnecessarily.

**Solution:** Read from `readCache` before writing; if content is identical, return early.

```ts
writeText: async (absolutePath: string, content: string) => {
    const existing = readCache.get(absolutePath);
    if (existing === content) return; // no-op — content unchanged
    readCache.delete(absolutePath);
    await fsWriteFile(absolutePath, content, "utf-8");
    pi.events.emit("context-guard:file-modified", { path: absolutePath });
},
```

### Fix #5 — `formatResults` Shows Pending Edits on Error

**Problem:** When an edit fails mid-group, the thrown error shows only processed results.
Remaining edits in the same file group are invisible (lumped as "N remaining edit(s) skipped").

**Solution:** Before throwing, iterate remaining entries in `group` (after the failing index)
and set them to `success: false` with a "Skipped (pending)" message. This surfaces their
path and position in the error output.

```ts
// After setting results[index] for the failing edit:
const currentGroupIdx = group.findIndex((e) => e.index === index);
for (let g = currentGroupIdx + 1; g < group.length; g++) {
  const pending = group[g];
  results[pending.index] = {
    path: pending.edit.path,
    success: false,
    message: `Skipped (pending — earlier edit in same file failed).`,
  };
}
```

## Implementation Order

1. Fix #3 (quote normalization) — standalone new function, no risk
2. Fix #4 (skip unchanged writes) — tiny, isolated to `createRealWorkspace`
3. Fix #2 (write-access in preflight) — isolated to `createVirtualWorkspace`
4. Fix #1 (rollback) — requires `applyClassicEdits` signature change + try/catch
5. Fix #5 (pending results) — small addition inside error path

## Files Changed

- `extensions/multi-edit/index.ts` — only file modified

## Files Not Changed

- Schema (no new parameters exposed)
- Test files (no existing multi-edit tests to update)
- Other extensions
