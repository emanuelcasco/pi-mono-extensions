# pi-mono-context-guard

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

### Minor Changes

- Add context-guard and grep extensions; improve multi-edit with dedup

  **New: `pi-mono-context-guard`**
  Extension that keeps the LLM context window lean with three guards:

  - `read` without `limit` → auto-injects `limit=120`
  - Read dedup → mtime-based stub for unchanged files (~20 tokens vs full content re-send)
  - `bash` with unbounded `rg` → appends `| head -60`

  Listens to `context-guard:file-modified` events to invalidate the dedup cache after edits.
  `/context-guard` command to inspect and toggle guards at runtime.

  **New: `pi-mono-grep`**
  Dedicated ripgrep wrapper tool. Replaces raw `rg` in bash with a structured tool that has
  `head_limit=60` built into the schema, `output_mode` (files_with_matches / content / count),
  pagination via `offset`, and automatic VCS directory exclusions.
  Prompt guidelines instruct the model to always use `grep` instead of bash+rg.

  **Updated: `pi-mono-multi-edit`**

  - Per-call read cache in `createRealWorkspace` deduplicates disk reads within a single `execute()` invocation (preflight + real-apply)
  - Emits `context-guard:file-modified` event after every real `writeText` and `deleteFile` so context-guard can evict stale dedup cache entries
