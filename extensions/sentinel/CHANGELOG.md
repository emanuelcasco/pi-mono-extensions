# pi-mono-sentinel

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
