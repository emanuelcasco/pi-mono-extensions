# pi-mono-clear

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

## 1.2.0

### Minor Changes

- ### `multi-edit` — robustness improvements

  - **No-op write guard**: skip file write and `context-guard:file-modified` event when new content is identical to what was last read — prevents unnecessary watcher churn
  - **Early write-access check**: virtual workspace `checkWriteAccess` now validates real-filesystem permissions during the preflight pass so read-only files fail fast before any real file is touched
  - **Curly-quote normalization**: new `findActualString` helper falls back to normalized quote matching (`"` / `'` ↔ `"` / `'`) when exact `oldText` search fails — the most common class of preflight mismatch
  - **Atomic batch rollback**: `applyClassicEdits` gains a `rollbackOnError` option that restores all successfully written files when a later edit in the same batch fails

  ### `ask-user-question` — UX fixes

  - **Reliable text capture on submit**: answer is read directly from the editor before it clears itself, fixing a race where the stored value was always empty
  - **Unified advance logic**: `advanceTab()` and `saveOtherModeText()` helpers replace scattered single-question fast-paths — behaviour is now consistent regardless of form length
  - **Auto-advance on Enter / Tab**: pressing Enter or Tab in any question (text, radio with "Other", checkbox with "Other") advances to the next tab without requiring a separate click

  ### `team-mode` — stability fixes

  - **Infinite retry loop eliminated**: subprocess guard (`PI_TEAM_SUBPROCESS=1`) prevents spawned pi subprocesses from launching a ghost `LeaderRuntime` that immediately marks in-progress tasks as stalled
  - **Stall detection grace period**: tasks updated within the last 2 × `LEADER_POLL_MS` (10 s) are skipped by `detectStalledTasks` — eliminates false positives on the spawning cycle
  - **Circuit breaker**: tasks that stall more than `MAX_TASK_RETRIES` (3) times are permanently cancelled with a clear error signal instead of being silently re-queued
  - **Concurrent cycle guard**: `runLeaderCycle` returns early if a cycle is already in-flight for the same team, preventing overlapping read-modify-write from the poll interval and completion handlers
  - **Widget cleanup**: cancelled and completed teams are no longer shown in the team widget — only `initializing | running | paused | failed` states are displayed
  - **Shorter auto-generated names**: `objectiveToName` now splits on non-alphanumeric characters (handles path separators), filters stopwords and extreme-length tokens, and hard-caps at 32 characters

## 1.1.1

### Patch Changes

- chore: update all packages for consistency and include team-mode fixes

## 1.1.0

## 1.0.0

### Major Changes

- 199c367: First version of the extensions to upload to GitHub

### Patch Changes

- Bump all packages to 0.1.1
