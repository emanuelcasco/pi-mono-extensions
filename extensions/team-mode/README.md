# Pi Teams — Background Multi-Agent Team Extension

A pi extension that adds **team-based orchestration**: a lightweight control plane for running leader-driven, background multi-agent work.

A team has:

- a **Leader** — an LLM coordinator (pi subprocess) that authors the task graph and assigns work via tool calls
- one or more **Teammates** — isolated pi subprocesses that execute specific tasks
- a **Task board** — durable task state with dependencies
- a **Signal log** — append-only progress and milestone events
- a **Mailbox** — structured handoffs and guidance
- **Approval gates** — optional review before risky work continues
- **Watch mode** — live compact updates below the editor

## What It Does

This extension lets pi manage long-running work as a structured team instead of a single noisy session.

Current implementation includes:

- **Team creation and lifecycle management**
- **LLM leader** — a coordinator pi subprocess that authors the task graph and assigns work via tool calls (`team_task_create`, `team_spawn_teammate`, `team_handoff`, …). The runtime handles mechanical upkeep (dependency promotion, stall detection, completion) but never auto-spawns teammates — those decisions belong to the leader.
- **Event-driven wakes** — leader turns fire on teammate completion and on leader-bound mailbox traffic (~200ms debounced), not only on the 20s polling tick
- **File-based teammate specs** — drop `.claude/teammates/<role>.md` files with frontmatter (`description`, `needsWorktree`, `hasMemory`, `modelTier`) to extend or override the seven built-in roles
- **Teammate spawning** as isolated pi subprocesses with self-contained prompts
- **Explicit peer handoffs** via the `team_handoff` tool (teammates call it directly; no regex scraping of output)
- **Task creation, assignment, dependency resolution, and summaries**
- **Signals, mailbox, and approval tracking**
- **Watch mode** for live team updates in a widget below the editor
- **Persistent storage** under `~/.pi/agent/extensions/teams/`

## Core Concepts

### Team

A durable background run with an objective, roster, task board, signals, and artifacts.

### Leader

The orchestrator for a team.

The leader:

- creates and tracks tasks
- delegates execution to teammates
- emits summary signals
- never does implementation work directly

The leader is a pi subprocess that receives a team-state snapshot and decides what tasks to create and who to assign them to via tool calls (`team_task_create`, `team_spawn_teammate`, `team_handoff`, `team_message`, `team_memory`, `team_review`). It runs one "turn" at launch, then another whenever there's ready work or fresh user guidance — event-driven via mailbox subscriptions with a 20s polling tick as the safety net.

### Teammate

A specialized worker such as:

- `researcher`
- `planner`
- `backend`
- `frontend`
- `reviewer`
- `tester`
- `docs`

You can add or override roles by dropping a frontmatter markdown file into `.claude/teammates/<role>.md` in the repo root. Frontmatter fields: `name` (required), `description`, `needsWorktree`, `hasMemory`, `modelTier`. The body becomes the teammate's system prompt.

Each teammate receives a **fully self-contained prompt** and runs in its own isolated pi subprocess.

### Task

A durable unit of work with:

- owner
- status
- dependencies
- blockers
- artifacts
- risk/approval metadata

### Signal

An append-only event such as:

- task assigned
- task started
- task completed
- blocked
- approval requested
- approval granted/rejected
- team summary
- team completed

### Watch Mode

A live stream of compact updates shown below the editor while a team is running.

## Quick Start

### Create a team

```text
/team create build the billing settings API and UI
```

This:

1. creates a team record
2. creates the team directory structure
3. launches the leader runtime
4. bootstraps initial tasks from the team roster

### Inspect status

```text
/team status team-20260403-001
/team tasks team-20260403-001
/team signals team-20260403-001
```

### Watch live updates

```text
/team watch team-20260403-001
/team unwatch
```

### Stop or resume a team

```text
/team stop team-20260403-001
/team resume team-20260403-001
```

## Slash Commands

The extension registers a single top-level command:

```text
/team
```

Supported subcommands:

| Command                    | Description                             |
| -------------------------- | --------------------------------------- |
| `/team`                    | Show the multi-team dashboard           |
| `/team create <objective>` | Create a new team                       |
| `/team status <id>`        | Show a concise team summary             |
| `/team tasks <id>`         | Show the task board                     |
| `/team signals <id>`       | Show recent signals                     |
| `/team stop <id>`          | Stop the leader and active teammates    |
| `/team resume <id>`        | Resume the team and relaunch the leader |
| `/team watch <id>`         | Start live watch mode                   |
| `/team unwatch`            | Stop watch mode                         |

## LLM Tools

The extension registers these tools for the model:

| Tool                  | Purpose                                |
| --------------------- | -------------------------------------- |
| `team_create`         | Create a team and launch the leader    |
| `team_status`         | Get a concise team summary             |
| `team_list`           | Show dashboard / active teams          |
| `team_tasks`          | Show the task board                    |
| `team_signals`        | Show team signals                      |
| `team_teammate`       | Show one teammate summary              |
| `team_message`        | Send guidance to leader or teammate    |
| `team_approve`        | Approve a pending task plan            |
| `team_reject`         | Reject a pending task plan             |
| `team_control`        | Stop or resume a team                  |
| `team_spawn_teammate` | Explicitly spawn a teammate for a task |
| `team_watch`          | Start live watch mode                  |

## Leader Runtime

The leader runtime is implemented in `runtime/leader-runtime.ts`.

### Operating loop

On each cycle the runtime:

1. loads team state
2. drains the leader mailbox (user guidance)
3. resolves task dependencies
4. detects team completion
5. fires an LLM leader turn when there's work to decide (ready task with idle owner, or fresh guidance)
6. detects stalled tasks and retries or blocks them
7. updates the team summary and emits a summary signal

Mechanical upkeep (dependency promotion, stall detection, completion) runs on every tick regardless. LLM turns only fire when there's something to decide.

### Leader turns

On launch, the runtime spawns a one-shot pi subprocess with a state snapshot and the full team toolbelt. The subprocess authors the task graph (via `team_task_create`), assigns work (via `team_spawn_teammate`), relays user guidance, and exits. Turns are serialised per team via an in-flight guard so overlapping triggers never spawn duplicate coordinators.

### Event-driven wake

The runtime responds to events without waiting for the 20s polling tick:
- teammate subprocess completion → immediate cycle (via `spawnTeammate`'s result handler)
- user guidance / broadcast message to the leader → debounced wake (~200ms) via a `MailboxManager` listener

Polling remains as a safety net (catches stalled tasks and any edge cases), but the common path is event-driven.

### Tool restriction model

The leader is **orchestration-only** in both modes:

- it creates/tracks tasks
- it delegates work
- it summarizes progress

Implementation work is performed by teammates, not the leader.

## Teammate Runtime

Teammates are spawned as separate pi subprocesses.

Each teammate gets:

- a **role-specific system prompt**
- a **self-contained task description**
- optional context from signals and mailbox messages
- a dedicated working directory when provided

### Mailbox handoff automation

When a teammate finishes work, the runtime automatically:

- sends mailbox handoffs to downstream teammates whose tasks depend on the completed task
- emits a `handoff` signal for each delivery
- includes the output artifact as an attachment when available

Teammates can also add explicit handoffs in their final response using:

```text
Handoffs:
- to: frontend | message: API is ready at /settings/billing
- to: reviewer | message: Focus on auth checks in billing-settings.ts
```

Those explicit handoffs are parsed and delivered through the same mailbox flow.

### Output handling

When a teammate completes:

- its output is saved under `teammates/<role>/outputs/`
- the task is marked `done`
- a `task_completed` signal is emitted
- dependencies are re-resolved

When a teammate fails:

- its process state is marked `failed`
- the task is marked `blocked`
- an `error` signal is emitted

## Watch Mode

Watch mode is implemented in `runtime/watch-mode.ts`.

It polls the team signal log and renders a compact widget below the editor.

Example output:

```text
📡 Watching Team team-20260403-001 — /team unwatch to stop
────────────────────────────────────────────────────────────
[18:35] ○ leader: Assigned task-003 to backend
[18:36] ⚙ backend: Started Implement Backend work for billing settings
[18:41] ✓ backend: Completed API validation and request handling
[18:42] ℹ leader: Summary — 2/5 done, 0 blocker(s), 0 approval(s) pending
```

Signals shown in watch mode include:

- `task_assigned`
- `task_started`
- `task_completed`
- `blocked`
- `approval_requested`
- `approval_granted`
- `approval_rejected`
- `handoff`
- `team_completed`
- `error`
- `team_summary`

## Persistence Layout

All runtime state is stored globally under the user's home directory (resolved
via `os.homedir()`), so team state is shared across projects:

```text
~/.pi/agent/extensions/
  teams/
    <team-id>/
      team.json
      tasks.json
      signals.ndjson
      mailbox.ndjson
      approvals.json
      summary.md
      memory/
        discoveries.md
        decisions.md
        contracts.md
      leader/
        process.json
        prompt.md
      teammates/
        <role>/
          process.json
          outputs/
            <timestamp>-<task>.md
```

## Team Templates

Built-in templates:

| Template    | Roles                                      |
| ----------- | ------------------------------------------ |
| `fullstack` | `backend`, `frontend`, `reviewer`          |
| `research`  | `researcher`, `docs`, `reviewer`           |
| `refactor`  | `planner`, `backend`, `tester`, `reviewer` |

## Notes and Current Limitations

This is an MVP-oriented implementation.

Notable characteristics:

- The **leader runtime is in-process orchestration logic** plus teammate subprocess spawning.
- Teammates run as real isolated pi subprocesses.
- Watch mode is **polling-based**, not push-stream based.
- Approval state exists and can be user-controlled, but the runtime does not yet drive a full approval-request workflow automatically.
- Worktree isolation is not yet fully automated for every teammate role.
- The leader bootstraps tasks from the team roster using generic task patterns.
- Mailbox messages can store attachment paths, but attachment references are not yet injected into downstream teammate prompt context.
- Multi-repo execution is still biased toward `repoRoots[0]` in several runtime paths.
- Stop/resume semantics are not fully aligned yet: `TeamStatus` includes `paused`, but `stopTeam()` currently marks teams as `cancelled`.

For a full implementation-vs-vision review, see [TEAM_MODE_VISION_REVIEW.md](./TEAM_MODE_VISION_REVIEW.md).

## File Layout

```text
extensions/team-mode/
├── core/
│   ├── store.ts
│   └── types.ts
├── index.ts
├── managers/
│   ├── approval-manager.ts
│   ├── mailbox-manager.ts
│   ├── signal-manager.ts
│   ├── task-manager.ts
│   └── team-manager.ts
├── README.md
├── runtime/
│   ├── leader-runtime.ts
│   └── watch-mode.ts
└── ui/
    ├── formatters.ts
    └── widget.ts
```

## Main Files

- `index.ts` — extension entry point, tools, commands, lifecycle hooks
- `runtime/leader-runtime.ts` — leader orchestration loop and teammate spawning
- `runtime/watch-mode.ts` — live signal polling widget
- `core/store.ts` — persistent file-backed storage
- `managers/team-manager.ts` — team summaries and dashboard views
- `managers/task-manager.ts` — task lifecycle and dependency resolution
- `managers/signal-manager.ts` — signal emission and filtering
- `managers/mailbox-manager.ts` — structured teammate messaging
- `managers/approval-manager.ts` — approval workflow
- `ui/formatters.ts` — compact user-facing text formatting
- `ui/widget.ts` — single-line team status widget
- `core/types.ts` — central type definitions and constants
