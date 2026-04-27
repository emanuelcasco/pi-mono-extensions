# pi-mono-sentinel

## 1.9.2

### Patch Changes

### Enhanced: token vault

- Inject a system-prompt reminder via `before_agent_start` so the LLM always knows to use `resolve_token`/`list_tokens` for API keys instead of `ask_user_question`.
- Added `promptSnippet` and `promptGuidelines` to `resolve_token` and `list_tokens` tools for automatic discovery.

## 1.9.1

### Patch Changes

### Enhanced: token vault

- Added `promptSnippet` and `promptGuidelines` to `resolve_token` and `list_tokens` tools so the LLM automatically discovers and proactively uses them for authentication without user prompting.

## 1.9.0

### Minor Changes

### Added: token vault

- Added secure local token storage at `~/.pi/agent/tokens.json` with owner-only file permissions.
- New LLM-safe tools: `resolve_token({ name })` returns only a masked confirmation and `list_tokens({})` lists names without values.
- Resolved tokens can be used in bash via `$TOKEN_name` placeholder substitution and injected environment variables without exposing secrets to the model transcript.
- Direct `read` / `write` / `edit` access to `tokens.json` is blocked; bash and read results are sanitized if a stored token value appears.
- New `/token set|list|get|delete|env` command for user-side token management.

## 1.8.0

### Minor Changes

### Added: permission-gate guard

- New third guard `permission-gate` proactively intercepts raw `bash` commands and `write` / `edit` calls that perform out-of-scope or system-level operations — closing the gap left by `execution-tracker`, which only fires for files written earlier in the same session.
- Bash risk classes: `remote-pipe-exec` (`curl|wget … | bash|sh|zsh`), `privilege-escalation` (`sudo`), `destructive-system-rm` (`rm -rf` on `/usr`, `/Library`, `/System`, `/opt`, `/etc`, `/var`, `/bin`, `/sbin`, `/private`, or `~`), `package-manager-install` (`brew install/upgrade/update/reinstall`), `persistence` (`crontab`, `systemctl enable`, `launchctl load`), `shell-config-write` (redirects/`tee` into `~/.zshrc`, `~/.bashrc`, etc.), `system-binary-install` (`cp`/`mv`/`install`/`ln` into `/usr/local/bin`).
- Path categories for `write` / `edit`: `shell-config`, `system-directory`, `outside-project`. Path resolution handles `~` expansion and `cwd`-relative paths correctly.
- Project-local `rm -rf` (e.g. `node_modules`, `dist`) is intentionally not flagged — only system/home roots.
- Fail-safe behavior: when no UI is available, dangerous operations are blocked with a descriptive `reason`; when UI is present, the user gets a single combined `confirm()` showing all matched labels.

### Tests

- New `permissions` suite covering bash command classification, path resolution (`~` expansion, cwd-relative, absolute) and path category classification.

### Documentation

- Updated sentinel README with the new guard, risk-class table, path-category table and decision matrix.

## 1.7.2

### Patch Changes

### Fixed: ask-user-question

- Remove unused `StringEnum` import from `@mariozechner/pi-ai`.

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

Initial release of sentinel extension, replacing the previous `grep` extension with a security-focused monitoring and guarding system for sensitive operations.
