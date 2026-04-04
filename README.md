# pi-mono-extensions

This repo is a pnpm workspace monorepo. Each extension under `extensions/` can be installed individually, or install the root to load all extensions at once.

## Installation

Install individual extensions by path:

```bash
pi install npm:pi-mono-btw
pi install npm:pi-mono-team-mode
```

Load temporarily for testing (without installing):

```bash
pi -e /path/to/pi-extensions/extensions/btw/index.ts
```

## Extensions

- **ask-user-question** — interactive forms for structured user input (`ask_user_question` tool)
- **btw** — side-question command (`/btw`)
- **clear** — fresh session command (`/clear`, `Ctrl+L`)
- **context-guard** — keeps context window lean by auto-limiting `read` calls and bounding `rg` output (`/context-guard`)
- **grep** — ripgrep wrapper with head_limit, output_mode, and pagination (replaces raw rg in bash)
- **loop** — run a prompt or slash command on a recurring interval (`/loop [interval] <prompt>`)
- **multi-edit** — enhanced `edit` tool with batch edits and patch support
- **review** — review a GitHub PR or GitLab MR URL and then inspect/submit it in a side pane (`/review <url>`, `/review-tui`)
- **simplify** — review changed code for reuse, quality, and efficiency, then fix any issues found (`/simplify`)
- **status-line** — shows git branch and richer runtime stats in the footer
- **team-mode** — background multi-agent team orchestration (`/team` commands)

## btw

The `btw` extension adds Claude Code-style `/btw` behavior to pi for asking a quick side question while pi is busy with the main task.

### What it does

- asks a one-off side question with `/btw <question>`
- uses the active pi model and current session transcript as context
- runs independently from the main agent loop, so it works while pi is still busy
- shows the answer in a passive widget below the editor instead of interrupting the current UI
- keeps the answer out of the visible transcript and out of future LLM context
- persists the question/answer as hidden custom session metadata

### Usage

```text
/btw What does this error mean?
/btw Give me a shorter name for this function
/btw Summarize the current approach in one paragraph
```

### Behavior

- If pi is idle, `/btw` asks the side question immediately.
- If pi is busy, `/btw` still works because it makes a separate model call instead of waiting for the main agent turn to finish.
- The result appears in a passive widget below the editor while the main agent keeps running.
- Completed answers expire automatically after a short time.
- `Ctrl+Shift+B` asks the current editor text as a side question.

### Notes

- `/btw` is implemented by intercepting raw input that starts with `/btw`, not by registering a normal extension command.
- This avoids pi's normal queued command behavior and makes it closer to Claude Code's side-question flow.
- Hidden history is stored through `pi.appendEntry()` using custom session entries, so it does not affect future model context.

## loop

The `loop` extension adds a `/loop` command that runs a prompt or slash command on a recurring interval.

Adapted from the [`/loop` skill in claude-code](https://github.com/emanuelcasco/claude-code/blob/main/src/skills/bundled/loop.ts). The original relied on Claude Code's Kairos cron system; this version uses JS timers and `pi.sendUserMessage()` instead.

### Usage

```text
/loop [interval] <prompt>
/loop list
/loop stop
/loop stop <id>
```

Intervals use a number followed by a unit suffix: `s` (seconds), `m` (minutes), `h` (hours), `d` (days). Defaults to `10m` when no interval is given.

### Examples

```text
/loop 5m /review
/loop 30m check the deploy
/loop 1h run the tests and report failures
/loop check the deploy            # defaults to 10m
/loop check the deploy every 20m  # trailing "every" clause
/loop list
/loop stop loop-1
/loop stop
```

### Behavior

- The prompt is executed immediately on the first invocation, then repeated at the given interval.
- If the agent is busy when a timer fires, the next prompt is queued as a follow-up rather than interrupting the current turn.
- Minimum interval is 10 seconds.
- Loops auto-expire after 7 days.
- All timers are cleaned up on session shutdown.

### Interval parsing

Arguments are parsed using this priority order:

1. **Leading token** — if the first word matches `\d+[smhd]` it is the interval (e.g. `5m /review`)
2. **Trailing "every" clause** — if the input ends with `every <N><unit>`, that is the interval (e.g. `check the deploy every 20m`)
3. **Default** — no interval found; uses `10m` and the full input is the prompt

## review

The `review` extension adds both `/review` and `/review-tui`.

### Usage

```text
/review https://github.com/org/repo/pull/123
/review https://gitlab.com/group/project/-/merge_requests/45
/review-tui
```

### Behavior

- `/review <url>` detects GitHub vs GitLab from the URL
- fetches the diff under the hood with the appropriate CLI
- runs the review with the active pi model
- prints the review summary in the terminal
- stores the review for `/review-tui`
- `/review-tui` opens the saved review in a side pane
- lets you approve, dismiss, or edit each comment
- submits approved comments directly to GitHub or GitLab based on the saved review URL

## simplify

The `simplify` extension adds a `/simplify` command that reviews all git-changed files for code reuse, quality, and efficiency — then fixes any issues found.

### Usage

```text
/simplify
/simplify <additional focus>
```

### Behavior

- Runs `git diff` (or `git diff HEAD` for staged changes) to identify what changed
- Launches three sub-agents **in parallel**, each receiving the full diff:
  - **Code Reuse** — flags duplicated logic and inline patterns that should use existing utilities
  - **Code Quality** — detects redundant state, copy-paste blocks, leaky abstractions, stringly-typed code, and unnecessary comments
  - **Efficiency** — catches N+1s, missed concurrency, hot-path bloat, memory leaks, and overly broad data fetches
- Aggregates findings, applies fixes directly, and summarizes what changed
- Passing extra text after `/simplify` appends an **Additional Focus** section to steer all three agents

### Examples

```text
/simplify
/simplify focus on performance and memory usage
/simplify pay extra attention to React re-renders
```

## clear

The `clear` extension adds a `/clear` command that starts a fresh session, similar to the built-in `/new`.

### Usage

```text
/clear
```

Or press `Ctrl+L` for the keyboard shortcut.

### Behavior

- If the agent is busy, `/clear` waits for it to finish before switching sessions.
- Creates a brand new session via `ctx.newSession()`, same as `/new`.
- Can be cancelled by other extensions via the `session_before_switch` event.
