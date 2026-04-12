# pi-mono-loop

## 2.0.0

### Major Changes

- ### Shared skills, theme, and grep removal

  - Add the shared `pair`, `recap`, and `ship` skills to the monorepo bundle.
  - Add the `catppuccin-mocha` theme.
  - Remove the deprecated `pi-mono-grep` extension in favor of Pi's built-in `grep` tool.

## 1.5.0

### Minor Changes

- ### `multi-edit` — diverge from upstream fork

  The extension was originally derived from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)'s `pi-extensions/multi-edit.ts`. This release rewrites the largest unmodified subsystems so the implementation is structurally distinct from upstream while keeping the public contract intact.

  - **Modularized layout** — the 953-line `index.ts` is split into purpose-scoped modules: `types.ts`, `workspace.ts`, `classic.ts`, `patch.ts`, `diff.ts`, and a slim `index.ts` (~180 lines of registration + dispatch wiring).
  - **New patch engine** — `patch.ts` is now a recursive-descent parser over a `LineCursor` class with `indexOf`-based hunk anchoring. Hunks are stored as `{ oldBlock, newBlock }` raw strings (previously `{ oldLines[], newLines[] }` arrays), letting the applier splice content directly instead of reconstructing line arrays per apply.
  - **Two-pass diff renderer** — `diff.ts` now walks `diffLines` parts into a typed `Entry[]` stream and makes all gutter / context-collapse decisions in a second pass, replacing the prior single-loop state-flag design.
  - **Polished classic edits** — extracted `groupEditsByPath`, `sortGroupByPosition`, `applyGroupToContent`, and `rollbackSnapshots` helpers; formalized the quote-fallback as an ordered `MATCH_PASSES` array so new normalizers (dashes, NBSP, etc.) can be added by appending one entry.
  - **First contract test suite** — 34 tests under `__tests__/` cover classic edits (positional reordering, redundant-pair skip, quote fallback, atomic rollback, read-only preflight), patch operations (Add/Delete/Update round-trips, move-rejection, multi-op batches), and diff rendering (line-number gutter, context collapse, add/remove-only cases). Runs via `npm test` (`tsx --test`).
  - **Dropped Codex apply_patch edge cases** (documented in `README.md` → "Codex apply_patch compatibility"): `*** End of File` sentinel hunks, 4-pass fuzzy `seekSequence` matching, implicit first hunk without `@@`, whitespace-tolerant anchoring. Common paths (Add/Delete/Update-single-chunk, Update with multiple hunks, Add+Update+Delete batches) are fully tested and preserved.
  - **README attribution** — new "Origins" section crediting `mitsuhiko/agent-stuff` as the original source.

## 1.4.0

### Minor Changes

- Add teammate progress heartbeats and widget refresh improvements to team mode.

## 1.3.0

### Minor Changes

- ### New Extensions

  #### `loop`

  New extension that runs a prompt or slash command on a recurring interval. Useful for periodic tasks, polling, and automated repeated actions within a pi session.

  #### `simplify`

  New extension that reviews changed code for reuse, quality, and efficiency, then automatically fixes any issues found. Integrates with `git diff` to scope the review to recent changes.

  ***

  ### Bug Fixes

  #### `multi-edit`

  - **Broader unicode normalization**: `findActualString` now handles the full range of Unicode single-quote variants (`\u2018\u2019\u201A\u201B`) and double-quote variants (`\u201C\u201D\u201E\u201F`) when falling back from exact match — fixes more curly-quote mismatch cases
  - **Parallel write-access preflight**: `checkWriteAccess` calls are now issued concurrently via `Promise.all` instead of sequentially — faster batch preflight on large edit sets
  - **Removed redundant `editOrder` array**: `Map` insertion order is now relied upon directly, simplifying the grouping loop

  #### `team-mode`

  - **Stall detection hardened**: introduced `STALL_BLOCKER_MARKER` / `STALL_BLOCKER_MESSAGE` constants so the marker used to detect and record abnormal process exits stays in sync — prevents duplicate stall reports
  - **Leader cycle guard comment clarified**: `cycleRunning` guard comment now explicitly calls out the race between the poll interval and teammate-completion handlers
