# Sentinel Extension — Permission Gate Guard

Stage: `Implemented`
Last Updated: 2026-04-25

## High-Level Objective

Add a proactive permission-gate guard to the `sentinel` extension that intercepts `bash`, `write`, and `edit` tool calls before they perform system-level or out-of-scope operations (e.g., `sudo`, `curl | bash`, modifying shell configs, writing to `/usr/local/bin`, `brew install`, `rm -rf` on system paths). This closes the gap where the current `execution-tracker` only guards *session-written scripts* and misses dangerous commands issued directly as raw `bash` strings or out-of-project writes.

<!-- FEEDBACK: high_level_objective
Status: OPEN
-->

## Mid-Level Objectives

- [ ] Create a new `permission-gate.ts` guard that subscribes to `tool_call` events for `bash`, `write`, and `edit`.
- [ ] Implement `bash` command pattern matching for high-risk operations (piped remote execution, sudo, privileged-path rm -rf, brew install, persistence hooks).
- [ ] Implement path classification logic to detect writes/edits targeting outside the current project root, system directories (`/usr/*`, `/Library/*`, `/System/*`, `/opt/*`), and shell config files (`~/.zshrc`, `~/.bashrc`, etc.).
- [ ] Provide a consistent escalation UX: `ctx.ui.confirm` when UI is available; fail-safe block with a descriptive `reason` when UI is unavailable.
- [ ] Register the new guard in `index.ts` alongside `output-scanner` and `execution-tracker`.
- [ ] Add unit tests for pattern matching and path classification helpers.
- [ ] Update the `sentinel` README to document the new guard and its behavior matrix.
- [ ] Bump the sentinel package version and update `CHANGELOG.md`.

<!-- FEEDBACK: mid_level_objectives
Questions or feedback about the requirements and milestones.
Status: OPEN
-->

## Context

The `sentinel` extension currently provides two guards:

1. **`output-scanner`** — Pre-reads files before `read` tool calls and scans them for secrets/credentials. Blocks or asks based on scan results.
2. **`execution-tracker`** — Tracks files written via `write`/`edit` and scans them for dangerous patterns; later correlates those files with `bash` executions. If a script written in the session is executed and contains dangerous patterns, it asks/denies.

**The gap:** `execution-tracker` does **not** intercept raw `bash` commands that themselves contain dangerous operations (e.g., `curl -Ls https://mise.run | bash`). It only acts when a *file written earlier in the session* is executed. Similarly, neither guard prevents writes to system paths or shell config files.

The incident report from 2026-04-24 documents seven classes of ungated operations that should have required explicit user confirmation:

| Operation | Current behavior |
|-----------|----------------|
| `curl … \| bash` raw command | **Not blocked** |
| `wget … \| bash` raw command | **Not blocked** |
| `sudo …` raw command | **Not blocked** |
| `brew install …` raw command | **Not blocked** |
| `rm -rf /Library/…` raw command | **Not blocked** by sentinel (only `rm -rf` in session-written scripts) |
| Write to `~/.zshrc`, `~/.bashrc` | **Not blocked** |
| Write to `/usr/local/bin`, `/usr/*`, `/Library/*`, `/opt/*` | **Not blocked** |

The pi extension API supports blocking via returning `{ block: true, reason: string }` from `pi.on("tool_call", …)` handlers, and user confirmation via `ctx.ui.confirm(title, message)` when `ctx.hasUI` is true.

There are already example extensions (`permission-gate.ts`, `confirm-destructive.ts`, `protected-paths.ts`) demonstrating this pattern.

<!-- FEEDBACK: context
Questions or feedback about the technical context and background.
Status: OPEN
-->

## Proposed Solution

Introduce a third sentinel guard named **`permission-gate`** (file: `guards/permission-gate.ts`).

### Bash permission gating

On every `bash` `tool_call`, scan `event.input.command` against a curated list of dangerous patterns grouped by risk class:

| Risk class | Patterns | Escalation |
|------------|----------|------------|
| **Remote pipe execution** | `curl \| (bash\|sh\|zsh)`, `wget \| (bash\|sh\|zsh)` | Confirm (or block if no UI) |
| **Privilege escalation** | `\bsudo\b` | Confirm (showing full command) |
| **Destructive recursive delete** | `rm\s+-[a-zA-Z]*rf?.*(/(usr\|Library\|System\|opt)\|~/)` | Double-confirm or block (system paths); confirm for project-local paths |
| **Package manager system install** | `\bbrew\s+(install\|upgrade\|update)\b` | Confirm |
| **Persistence** | `crontab`, `systemctl enable`, `launchctl load` | Confirm |
| **Shell config modification (via bash)** | Appending to `~/.zshrc`, `~/.bashrc`, etc. | Confirm |
| **Binary installation outside project** | `cp\s+.*\s+/usr/local/bin/`, `mv\s+.*\s+/usr/local/bin/` | Confirm |

### Write/Edit permission gating

On every `write` and `edit` `tool_call`, resolve the absolute target path and classify it:

| Path category | Example | Action |
|---------------|---------|--------|
| **Shell config files** | `~/.zshrc`, `~/.bashrc`, `~/.profile` | Confirm |
| **System directories** | `/usr/*`, `/Library/*`, `/System/*`, `/opt/*`, `/usr/local/bin` | Confirm |
| **Outside project root** | Any path not under `ctx.cwd` or the resolved project root | Confirm (with path shown) |

When a `write`/`edit` targets a shell config file, the confirmation dialog should show the target path and warn that this is a persistent system change.

### Decision matrix

```
UI available + user allows  → return undefined (proceed)
UI available + user denies    → return { block: true, reason }
No UI + dangerous detected    → return { block: true, reason }
No dangerous patterns         → return undefined (proceed)
```

### Scope boundaries

- This guard does **not** replace `output-scanner` or `execution-tracker`; it complements them.
- This guard does **not** block reads; only writes, edits, and bash executions.
- This guard intentionally does **not** block every `rm -rf` in the project directory (that would be overly restrictive); it only escalates `rm -rf` on known system/privileged paths.

<!-- FEEDBACK: proposed_solution
Questions or feedback about the proposed approach and scope.
Status: OPEN
-->

## Implementation Notes

_No phases defined yet. Use `/dev:pair plan extensions/sentinel/specs/2026/04/sentinel/001-permission-gate.md` to generate the implementation plan._

<!-- FEEDBACK: implementation_approach
Questions or feedback about the overall implementation approach before diving into phases.
Status: OPEN
-->

## Success Criteria

- [ ] A `bash` command containing `curl … | bash` is intercepted and escalated to the user (or blocked without UI).
- [ ] A `bash` command containing `sudo …` is intercepted and escalated.
- [ ] A `bash` command running `brew install` is intercepted and escalated.
- [ ] A `write` or `edit` targeting `~/.zshrc` is intercepted and escalated.
- [ ] A `write` or `edit` targeting `/usr/local/bin/` is intercepted and escalated.
- [ ] A `bash` command running `rm -rf /Library/Developer/CommandLineTools` is blocked or double-confirmed.
- [ ] When UI is unavailable, all matched dangerous operations fail-safe (block with a clear reason).
- [ ] Safe operations (e.g., `echo "hello"`, writing to project-local files) are not blocked and incur minimal overhead.
- [ ] The sentinel README and CHANGELOG are updated.

<!-- FEEDBACK: success_criteria
Questions or feedback about the completion criteria and validation approach.
Status: OPEN
-->

## Notes

- Consider whether `sudo rm -rf` should trigger a single combined confirmation for both the `sudo` and the `rm -rf` risk classes, or if they should stack. A single confirmation with all matched labels is simpler and less noisy.
- Path resolution must handle `~` expansion and `ctx.cwd`-relative paths correctly.
- The guard should share the same notification style as existing guards (`[sentinel] …` prefix).

<!-- FEEDBACK: general
General questions, concerns, or suggestions for the entire implementation plan.
Status: OPEN
-->
