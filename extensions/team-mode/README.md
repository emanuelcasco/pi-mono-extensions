# pi-mono-team-mode

A faithful port of **Claude Code's team-mode mode** to the pi coding agent. Named workers are spawned as pi subprocesses, the coordinator ends its turn after launching, and completion arrives as a `<task-notification>` user-role message that wakes the coordinator event-driven — no polling, no leader subprocess.

> **Sibling of `pi-mono-team-mode`.** `team-mode` is leader-driven (a coordinator subprocess runs on its own task graph). `team-mode` maps 1:1 to Claude Code's semantics instead.

## Parity with Claude Code

Everything below mirrors `claude-code/src/` behavior (`coordinator/coordinatorMode.ts`, `tools/AgentTool`, `tools/SendMessageTool`, `tools/Task*Tool`, `utils/swarm/teammatePromptAddendum.ts`).

| Claude Code | team-mode |
|---|---|
| `Agent({ description, prompt, name?, team_name?, subagent_type?, isolation?, run_in_background? })` | `agent(...)` — same schema |
| `SendMessage({ to, message })` | `send_message(...)` |
| `TaskStop({ task_id })` | `task_stop(...)` |
| `TaskOutput({ task_id })` | `task_output(...)` |
| `TaskCreate({ subject, description, activeForm?, metadata? })` | `task_create(...)` |
| `TaskUpdate({ task_id, status?, owner?, addBlocks?, addBlockedBy?, ... })` | `task_update(...)` |
| `TaskGet({ task_id })` | `task_get(...)` |
| `TaskList({ status?, owner? })` | `task_list(...)` |
| `TeamCreate / TeamDelete` | `team_create / team_delete` |
| `<task-notification>` XML wakes coordinator | Emitted via `pi.sendMessage({ triggerTurn: true })` on teammate end |
| Coordinator system prompt (`CLAUDE_CODE_COORDINATOR_MODE=1`) | `PI_TEAM_MATE_COORDINATOR=1` |
| Teammate prompt addendum (`TEAMMATE_SYSTEM_PROMPT_ADDENDUM`) | Prepended to every teammate's system prompt |
| Task ids namespaced `agent-*` | Same namespace; `task_stop` and `send_message` accept it |

## The execution model

Workers are **event-driven, not polled**. You don't write "spawn, wait, spawn the next" loops:

```
Turn 1 (coordinator):
  agent({ description: "research auth", prompt: "..." })   → task_id: agent-r-ab1
  agent({ description: "research billing", prompt: "..." })→ task_id: agent-b-c3d
  "Investigating both — I'll report back."  [turn ends]

  ...workers run in parallel; zero coordinator tokens burned...

Between turns:
  <task-notification>
    <task-id>agent-r-ab1</task-id>
    <status>completed</status>
    <summary>Agent "research auth" completed</summary>
    <result>Found null pointer in src/auth/validate.ts:42...</result>
    <usage><duration_ms>14230</duration_ms></usage>
  </task-notification>

Turn 2 (coordinator, woken by the notification):
  "Found the bug. I'll fix it."
  send_message({ to: "agent-r-ab1", message: "Fix src/auth/validate.ts:42..." })
  [turn ends]
```

For a DAG of dependent tasks, the coordinator:

1. Seeds the TODO list via `task_create` (each task with `blocks`/`blockedBy` set via `task_update`).
2. Spawns a worker for each immediately-unblocked task, setting `task_update({ owner })` on the matching TODO.
3. **Ends its turn.**
4. On each `<task-notification>`, marks the TODO completed, checks what's newly unblocked, spawns the next wave.

The coordinator never waits — it runs briefly, reactively, on each notification.

## Install

```bash
pi install npm:pi-mono-team-mode
# or load locally
pi -e /path/to/pi-extensions/extensions/team-mode/index.ts
```

## Coordinator mode

Set `PI_TEAM_MATE_COORDINATOR=1` on the pi session you want to act as coordinator:

```bash
PI_TEAM_MATE_COORDINATOR=1 pi
```

This injects the coordinator system prompt at every turn via the `before_agent_start` hook. The prompt teaches the LLM the `<task-notification>` flow, the delegation discipline, and the "synthesize — don't hand off understanding" rule lifted straight from Claude Code.

## Teammate specs

Drop a markdown file into `.pi/teammates/<role>.md` (or `.claude/teammates/<role>.md`):

```markdown
---
name: reviewer
description: reviews diffs for bugs and style violations
modelTier: deep
tools: read, bash, grep
---
You are a careful code reviewer. ...
```

Frontmatter fields: `name`, `description`, `needsWorktree`, `hasMemory`, `modelTier`, `tools` (comma-separated). The body becomes the teammate's system prompt. The Claude Code teammate addendum (`send_message` instructions) is prepended automatically.

## Storage

```
~/.pi/agent/extensions/team-mode/
├── model-config.json                            # provider/tier/role + taskCompletedHook
├── teammates/<agent-id>/record.json
├── teammates/<agent-id>/sessions/<id>.jsonl     # pi --session target
├── teams/<team-id>/record.json
├── tasks/<parent-session-id>/<task-id>.json     # shared TODO list
└── runtime/<parent-session-id>/index.json       # teammate name → agent-id
```

Override with `PI_TEAM_MATE_STORAGE_ROOT` for tests.

## Quality gates

Add to `model-config.json`:

```jsonc
{ "taskCompletedHook": "pnpm test --run" }
```

When a task transitions to `completed`, the hook runs in the task's cwd. Non-zero exit reverts the task to `failed` and attaches hook output (stdout + stderr, first 8 KB) to `result`. 2-minute timeout. Stale PID-based lock files are auto-recovered after 10 s.

## Concurrency model

- Each task is its own file under `tasks/<parent-session-id>/<task-id>.json`.
- `task_update` takes an exclusive filesystem lock (`<task-id>.lock` via `open(..., "wx")`) and bumps a CAS `version` counter.
- Stale locks (>10 s) are reclaimed automatically — safe across teammate subprocesses.

## Slash commands & keybinding

- `/teammate list | status <name> | stop <name>`
- `/team list | create <name> | delete <id>`
- `/tasks list | show <id> | clear`
- **Ctrl+Shift+T** — show the shared task list (pi's built-in Ctrl+T toggles thinking blocks)

## Differences from Claude Code (honest)

- **Broadcast `to: "*"`** is not implemented. Swarm/persistent teammate pattern with mailboxes isn't needed for the one-shot worker model; each `send_message` resumes a teammate via `pi --session`, but injecting into an actively-running worker turn is not supported.
- **Tool restriction in coordinator mode** is prompt-only, not enforced. Claude Code's coordinator mode actually strips Bash/Edit/Write from the tool pool; pi's extension API doesn't expose tool removal from the main session. The coordinator prompt tells the LLM not to use those tools, but the LLM could still call them.
- **`TaskOutput` on a running worker** returns the teammate's last-saved record, not live stdout streaming. Completed workers return their final message faithfully.

## Tests

```bash
cd extensions/team-mode
npm test    # 69 tests
```
