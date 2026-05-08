# pi-mono-status-line

## 1.7.3

### Patch Changes

### Maintenance

- Update pi core imports and peer dependencies to the new `@earendil-works` package scope.

## 1.7.2

### Patch Changes

### Fixed: ask-user-question

- Remove unused `StringEnum` import from `@earendil-works/pi-ai`.


## 1.7.1

### Patch Changes

### Fixed: team-mode

- Widget no longer mislabels blocked or approval-pending teams as "running smoothly" — blockers and pending approvals are now detected via team summaries.
- Preserve in-flight work on re-emitted `session_start` events instead of tearing the runtime down and SIGTERM-ing live teammates.
- Auto-relaunch leaders for `running` teams after a session reset; surface failures as both a team signal and a UI notification.
- `createTeam` now defaults `repoRoots` to `[process.cwd()]` when the caller passes an empty array.
- Archive `process.json` into `history/` before a new task reuses the same role slot, so the prior task's final state is no longer silently clobbered.

### Enhanced: team-mode

- Durable intent queue for subprocess handoff: `team_spawn_teammate` calls made from a teammate subprocess are written to disk and executed by the main session's `LeaderRuntime` instead of spawning orphaned grand-children.
- New tool `team_task_create_batch` lets the leader emit the full initial task DAG in one call, removing per-task LLM round-trips during bootstrap.
- `team_create` / `launchLeader` accept an `awaitBootstrap` option so the user sees the task graph before the tool returns; leader launch retries up to 3 times on transient failures.
- Persist per-turn debug artifacts (prompt, invocation, stderr, raw event stream) for both leader and teammate subprocesses, exposed via `TeammateSummary.debugArtifacts`.
- Track `exitCode`, `exitSignal`, `terminationReason`, `stderrTail`, `toolExecutions`, `model` and `modelProvider` on every `TeammateProcess` record.
- Provider detection now consults pi's `settings.json` and `auth.json` in addition to env vars; default model IDs aligned with the provider/model scheme.
- `collectPiOutput` supports `AbortSignal` cancellation.

### Tests

- New `intent-queue` and `model-config` suites; expanded coverage across `leader-runtime`, `team-manager`, `team-query-tool` and `formatters`.


## 1.7.0

### Minor Changes

### Enhanced: status-line

- Improved progress rendering and colors in expert mode

### Enhanced: team-mode

- **LLM-driven leader** — replaced the hardcoded `research → synthesis → implementation → verification` state machine with a pi subprocess coordinator that authors the task graph via tool calls
- **New tool `team_task_create`** so the leader can author tasks at runtime
- **New tool `team_handoff`** for explicit teammate → teammate context handoffs (replaces regex-scraping of `Handoffs:` output sections)
- **File-based teammate specs** — drop `.claude/teammates/<role>.md` frontmatter files (`name`, `description`, `needsWorktree`, `hasMemory`, `modelTier`) to extend or override the seven built-in roles
- **Event-driven leader wakes** — mailbox messages addressed to the leader (or broadcast) trigger a debounced (~200ms) cycle instead of waiting for the 20s polling tick
- **Templates accept any string** — `fullstack` / `research` / `refactor` remain as built-ins, but unknown template keys are accepted and no-op gracefully
- **Provider config per team** — per-team model overrides via `/team models`
- Reduced leader overhead and parent-session token churn
- `spawnTeammate` now always appends the full runtime-built context (signals, mailbox, dependencies, team memory) so teammates get the richer snapshot even when the caller's `context` argument is brief

### Breaking changes: team-mode

- Removed `LeaderPhase` enum and `currentPhase` field from `TeamRecord` / `TeamSummary`
- Removed `parseExplicitHandoffs` export and the legacy `Handoffs:` output parser — peer handoffs must go through the `team_handoff` tool
- Removed the deterministic auto-spawn loop (`ensureBootstrapTasks`) — all task authoring and teammate spawning is now the LLM leader's responsibility
- Removed `StringEnum` gate on `team_create`'s `template` parameter (now plain string)

### Fixed: review

- Annotate diff lines so the model picks correct line numbers
- Fix slice chunk around lines for comments in the reviewer TUI

### Documentation

- Updated root README and sentinel extension README
- Documented the new file-based teammate spec format and event-driven leader wake in the team-mode README

## 1.6.0

### Minor Changes

### New Extension: sentinel

Replaced the `grep` extension with a new security-focused `sentinel` extension for monitoring and guarding sensitive operations.

### Enhanced: team-mode

- Added comprehensive test suite with integration tests
- New mock helpers for subprocess testing
- Improved signal manager with better error handling
- Leader runtime refactoring for stability
- Team query tool with dedicated tests

### Enhanced: status-line

- Added basic and expert mode displays
- Improved index.ts with better state management

### Enhanced: clear

- Updated keyboard shortcut to `Ctrl+Shift+L`
- Better busy-state handling for shortcuts
- Added warning/cancel handling and error notifications

### Enhanced: context-guard

- Improved read deduplication across sessions
- Added `context-guard:file-modified` event for cache eviction

### Documentation

- Added dedicated README for `clear` extension
- Added dedicated README for `context-guard` extension
- Updated main README with improved extension descriptions

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
