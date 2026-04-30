# pi-mono-team-mode

A faithful port of **Claude Code's team-mode mode** to the pi coding agent. Named workers are spawned as pi subprocesses by default, the coordinator ends its turn after launching, and completion arrives as a `<task-notification>` user-role message that wakes the coordinator event-driven — no polling, no leader subprocess.

> **Sibling of `pi-mono-team-mode`.** `team-mode` is leader-driven (a coordinator subprocess runs on its own task graph). `team-mode` maps 1:1 to Claude Code's semantics instead.

## Parity with Claude Code

Everything below mirrors `claude-code/src/` behavior (`coordinator/coordinatorMode.ts`, `tools/AgentTool`, `tools/SendMessageTool`, `tools/Task*Tool`, `utils/swarm/teammatePromptAddendum.ts`).

| Claude Code                                                                                         | team-mode                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Agent({ description, prompt, name?, team_name?, subagent_type?, isolation?, run_in_background? })` | `agent(...)` — same schema plus optional `runtime` selector         |
| `subagent({ tasks })`-style fan-out                                                                 | `delegate({ tasks: [...] })`                                        |
| `subagent({ chain })`-style sequencing                                                              | `delegate({ task, chain: [...] })`                                  |
| `SendMessage({ to, message })`                                                                      | `send_message(...)`                                                 |
| `TaskStop({ task_id })`                                                                             | `task_stop(...)`                                                    |
| `TaskOutput({ task_id })`                                                                           | `task_output(...)`                                                  |
| `TaskCreate({ subject, description, activeForm?, metadata? })`                                      | `task_create(...)`                                                  |
| `TaskUpdate({ task_id, status?, owner?, addBlocks?, addBlockedBy?, ... })`                          | `task_update(...)`                                                  |
| `TaskGet({ task_id })`                                                                              | `task_get(...)`                                                     |
| `TaskList({ status?, owner? })`                                                                     | `task_list(...)`                                                    |
| `TeamCreate / TeamDelete`                                                                           | `team_create / team_delete`                                         |
| `<task-notification>` XML wakes coordinator                                                         | Emitted via `pi.sendMessage({ triggerTurn: true })` on teammate end |
| Coordinator system prompt (`CLAUDE_CODE_COORDINATOR_MODE=1`)                                        | `PI_TEAM_MATE_COORDINATOR=1`                                        |
| Teammate prompt addendum (`TEAMMATE_SYSTEM_PROMPT_ADDENDUM`)                                        | Prepended to every teammate's system prompt                         |
| Task ids namespaced `agent-*`                                                                       | Same namespace; `task_stop` and `send_message` accept it            |

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
thinkingLevel: high
tools: read, bash, grep
---

You are a careful code reviewer. ...
```

Frontmatter fields: `name`, `description`, `needsWorktree`, `hasMemory`, `modelTier`, `thinkingLevel`, `tools` (comma-separated). The body becomes the teammate's system prompt. The Claude Code teammate addendum (`send_message` instructions) is prepended automatically.

## Model and thinking selection

`agent(...)` and each `delegate` task accept both `model` and `thinking` (`thinking_level` is accepted as an alias):

```ts
agent({
  description: "review diff",
  prompt: "Review the current branch",
  subagent_type: "reviewer",
  model: "deep",
  thinking: "high",
});
```

Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Team-mode passes the selected level to the teammate subprocess as `pi --thinking <level>`. Token budgets remain pi's responsibility via `~/.pi/agent/settings.json` `thinkingBudgets`.

`model-config.json` can define compact role/tier defaults:

```jsonc
{
  "defaultTier": "md",
  "tiers": {
    "sm": {
      "name": "Small",
      "thinkingLevel": "low",
      "description": "Simple tasks, deterministic outputs. Use for formatting, rewriting, classification",
    },
    "md": {
      "name": "Medium",
      "thinkingLevel": "medium",
      "description": "Handles moderate complexity. Use for workflows, APIs, structured tasks",
    },
    "lg": {
      "name": "Large",
      "thinkingLevel": "high",
      "description": "Strong reasoning, multi-step tasks. Use for reasoning, planning, debugging, decision support",
    },
    "xl": {
      "name": "Deep",
      "thinkingLevel": "xhigh",
      "description": "Near-frontier capability, complex domains. Complex planning, abstraction, ambiguous problems",
    },
  },
  "roles": {
    "researcher": "sm",
    "docs": "xs",
    "backend": "md",
    "frontend": "md",
    "tester": "md",
    "planner": "lg",
    "reviewer": "md",
  },
}
```

Built-in provider catalogs map `xs`/`sm` to small models, `md` to default models, and `lg`/`xl` to large models. You can still override `providers` if you want exact model IDs per tier. Legacy `roleTiers`, `tierThinkingLevels`, and `roleThinkingLevels` remain supported.

Thinking resolution order is: explicit tool `thinking`, teammate spec `thinkingLevel`, `roles`/`roleTiers` tier metadata (`tiers[tier].thinkingLevel`), a legacy `:<thinking>` model suffix such as `gpt-5.4:high`, legacy `tierThinkingLevels`, then `defaultThinkingLevel`. If none applies, pi inherits its normal default.

## Execution runtimes

`agent` and `delegate` accept an explicit `runtime` selector:

```ts
agent({
  description: "quick summary",
  prompt: "Summarize README.md",
  runtime: "transient",
});

delegate({
  runtime: "transient",
  tasks: [
    { description: "scan docs", prompt: "Find docs gaps" },
    { description: "scan tests", prompt: "Find missing coverage" },
  ],
});
```

- `runtime: "subprocess"` (default): durable, resumable workers backed by `pi --session`; supports `send_message`, names, teams, worktree isolation, background notifications, transcripts, and persistent records.
- `runtime: "transient"`: fast one-shot in-process `createAgentSession()` runs; returns output directly to the current tool call; does not create teammate records, cannot be resumed, and does not share the parent LLM context window.

Transient prompts must be fully self-contained. They only share the parent Node.js process/runtime infrastructure, not the coordinator conversation. Initial transient mode rejects `isolation: "worktree"`, `run_in_background: true`, `team_name`, and `name` because those imply durable teammate semantics.

Use transient mode for quick disposable research/summarization fan-out. Use subprocess mode for implementation work, resumable teammates, background work, worktrees, or anything that needs a stable `task_id` for later `send_message`.

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

## Delegate groups + live progress

- `delegate({ tasks: [...] })` runs bounded parallel workers and returns aggregated output blocks.
- `delegate({ task, chain: [...] })` runs sequential chains with `{task}`, `{previous}`, `{chain_dir}` substitution and optional inner `parallel` fan-out.
- Per-step `output` and `reads` let chain steps exchange large artifacts through files in `{chain_dir}`.
- Parallel caps: `PI_TEAM_MATE_MAX_PARALLEL` (default `8`) and `PI_TEAM_MATE_PARALLEL_CONCURRENCY` (default `4`).
- Live TUI widget now renders a multi-line **● Agents** panel (spinner, turns/tool-uses/tokens/elapsed, activity hint, queued tail).
- `<task-notification>` messages are rendered as styled completion boxes (status glyph, counters, duration, transcript path).

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
npm test
```
