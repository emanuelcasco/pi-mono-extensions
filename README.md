# pi-mono-extensions

This repo is a pnpm workspace monorepo. Each extension under `extensions/` can be installed individually, or install the root to load all extensions and bundled skills at once.

## Table of Contents

- [Installation](#installation)
- [Extensions](#extensions)
  - [ask-user-question](#ask-user-question)
  - [auto-fix](#auto-fix)
  - [btw](#btw)
  - [clear](#clear)
  - [context](#context)
  - [context-guard](#context-guard)
  - [figma](#figma)
  - [linear](#linear)
  - [loop](#loop)
  - [multi-edit](#multi-edit)
  - [review](#review)
  - [sentinel](#sentinel)
  - [simplify](#simplify)
  - [status-line](#status-line)
  - [team-mode](#team-mode)
  - [usage](#usage)
  - [web-search](#web-search)

## Installation

Install all extensions and bundled skills at once:

```bash
pi install npm:pi-mono-all
```

Or install individual extensions by package name:

```bash
pi install npm:pi-mono-btw
pi install npm:pi-mono-team-mode
pi install npm:pi-mono-figma
pi install npm:pi-mono-linear
pi install npm:pi-mono-web-search
```

Load temporarily for testing (without installing):

```bash
pi -e /path/to/pi-extensions/extensions/btw/index.ts
```

## Extensions

### ask-user-question

The `ask-user-question` extension registers an `ask_user_question` tool that lets the LLM ask structured questions using interactive TUI form controls — radio buttons, checkboxes, and multi-line text inputs — instead of free-form text.

Full details: [extensions/ask-user-question/README.md](extensions/ask-user-question/README.md).

#### Install

```bash
pi install npm:pi-mono-ask-user-question
```

### auto-fix

The `auto-fix` extension runs language-appropriate fixers (eslint, black, prettier, …) on every file written during a turn, flushing once on `agent_end`. Fixes are silent; a single summary notification reports how many files were actually updated.

Full details: [extensions/auto-fix/README.md](extensions/auto-fix/README.md).

#### Install

```bash
pi install npm:pi-mono-auto-fix
```

### btw

The `btw` extension adds Claude Code-style `/btw` behavior to pi for asking a quick side question while pi is busy with the main task.

Full details: [extensions/btw/README.md](extensions/btw/README.md).

#### What it does

- asks a one-off side question with `/btw <question>`
- uses the active pi model and current session transcript as context
- runs independently from the main agent loop, so it works while pi is still busy
- shows the answer in a passive widget below the editor instead of interrupting the current UI
- keeps the answer out of the visible transcript and out of future LLM context
- persists the question/answer as hidden custom session metadata

#### Usage

```text
/btw What does this error mean?
/btw Give me a shorter name for this function
/btw Summarize the current approach in one paragraph
```

#### Behavior

- If pi is idle, `/btw` asks the side question immediately.
- If pi is busy, `/btw` still works because it makes a separate model call instead of waiting for the main agent turn to finish.
- The result appears in a passive widget below the editor while the main agent keeps running.
- Completed answers expire automatically after a short time.
- `Ctrl+Shift+B` asks the current editor text as a side question.

#### Notes

- `/btw` is implemented by intercepting raw input that starts with `/btw`, not by registering a normal extension command.
- This avoids pi's normal queued command behavior and makes it closer to Claude Code's side-question flow.
- Hidden history is stored through `pi.appendEntry()` using custom session entries, so it does not affect future model context.

#### Install

```bash
pi install npm:pi-mono-btw
```

### clear

The `clear` extension adds a `/clear` command that starts a fresh session, similar to the built-in `/new`.

Full details: [extensions/clear/README.md](extensions/clear/README.md).

#### Usage

```text
/clear
```

Or press `Ctrl+Shift+L` for the keyboard shortcut.

#### Behavior

- If the agent is busy, `/clear` waits for it to finish before switching sessions.
- The keyboard shortcut sends `/clear` as a follow-up when pi is busy so the current turn can finish first.
- Creates a brand new session via `ctx.newSession()`, same as `/new`.
- Shows a warning if the new-session request is cancelled.
- Shows an error notification if clearing fails.

#### Install

```bash
pi install npm:pi-mono-clear
```

### context

The `context` extension adds a Claude Code-style `/context` command that prints current context-window usage in the conversation without adding that report to future LLM context. It includes a grid, estimated category breakdown, extension allocation by source/package, session stats, and active tool/command sections.

Full details: [extensions/context/README.md](extensions/context/README.md).

#### Usage

```text
/context
```

The printed report is display-only and filtered from future LLM context.

#### Install

```bash
pi install npm:pi-mono-context
```

### context-guard

The `context-guard` extension keeps pi sessions lean by intercepting tool calls before they execute.

Full details: [extensions/context-guard/README.md](extensions/context-guard/README.md).

#### What it does

It applies three safeguards:

- auto-injects a default `limit` of `120` on `read` calls that do not specify one
- blocks duplicate `read` calls for unchanged files when the same path, `offset`, and `limit` are requested again
- appends `| head -60` to unbounded `rg` usage inside `bash` commands

#### Why it helps

These guards reduce unnecessary token usage and make it less likely that long sessions waste context on repeated or unbounded output.

#### Notes

- the read dedup cache is session-scoped
- dedup entries are invalidated when a file's mtime changes
- the extension also listens for `context-guard:file-modified` so companion extensions can evict stale cache entries immediately after writes

#### Install

```bash
pi install npm:pi-mono-context-guard
```

### figma

The `figma` package registers native Figma tools for LLM-ready design context (`figma_find_nodes_by_name/text`, `figma_get_node_summary`, `figma_explain_node`, `figma_extract_text`, enriched `figma_get_implementation_context`, `figma_extract_assets`, Code Connect/component hint helpers, `figma_render_nodes`, and related helpers) and bundles a Figma skill for design-to-code workflows. Rendered/generated image files default to OS temp directories unless `outputDir` is explicitly provided. Raw JSON tools (`figma_get_file`, `figma_get_nodes`) remain available as debugging escape hatches.

Full details: [extensions/figma/README.md](extensions/figma/README.md).

#### Usage

```text
/figma-auth --force
```

Typical tool workflows:

```text
figma_parse_url
figma_render_nodes
figma_explain_node
```

```text
figma_parse_url
figma_find_nodes_by_name or figma_find_nodes_by_text
figma_get_implementation_context
figma_extract_assets
```

#### Authentication

Auth is read from `FIGMA_TOKEN` or `~/.pi/agent/auth.json` at `.figma.token`. Use `/figma-auth --force` or `figma_configure_auth` for masked token setup/update.

#### Install

```bash
pi install npm:pi-mono-figma
```

### linear

The `linear` package registers native Linear tools (`linear_workspace_metadata`, `linear_search_issues`, `linear_get_issue`, create/update/comment tools, and metadata helpers) and bundles a Linear workflow skill.

Full details: [extensions/linear/README.md](extensions/linear/README.md).

#### Usage

```text
/linear-auth --force
```

Typical tool workflows:

```text
linear_workspace_metadata
linear_search_issues
linear_get_issue
```

```text
linear_get_issue
linear_update_issue
linear_create_comment
```

#### Authentication

Auth is read from `LINEAR_API_KEY` or `~/.pi/agent/auth.json` at `.linear.key`. Use `/linear-auth --force` or `linear_configure_auth` for masked key setup/update.

#### Install

```bash
pi install npm:pi-mono-linear
```

### loop

The `loop` extension adds a `/loop` command that runs a prompt or slash command on a recurring interval.

Adapted from the [`/loop` skill in claude-code](https://github.com/emanuelcasco/claude-code/blob/main/src/skills/bundled/loop.ts). The original relied on Claude Code's Kairos cron system; this version uses JS timers and `pi.sendUserMessage()` instead.

Full details: [extensions/loop/README.md](extensions/loop/README.md).

#### Usage

```text
/loop [interval] <prompt>
/loop list
/loop stop
/loop stop <id>
```

Intervals use a number followed by a unit suffix: `s` (seconds), `m` (minutes), `h` (hours), `d` (days). Defaults to `10m` when no interval is given.

#### Examples

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

#### Behavior

- The prompt is executed immediately on the first invocation, then repeated at the given interval.
- If the agent is busy when a timer fires, the next prompt is queued as a follow-up rather than interrupting the current turn.
- Minimum interval is 10 seconds.
- Loops auto-expire after 7 days.
- All timers are cleaned up on session shutdown.

#### Interval parsing

Arguments are parsed using this priority order:

1. **Leading token** — if the first word matches `\d+[smhd]` it is the interval (e.g. `5m /review`)
2. **Trailing "every" clause** — if the input ends with `every <N><unit>`, that is the interval (e.g. `check the deploy every 20m`)
3. **Default** — no interval found; uses `10m` and the full input is the prompt

#### Install

```bash
pi install npm:pi-mono-loop
```

### multi-edit

The `multi-edit` extension replaces the built-in `edit` tool with a version that supports batch edits across multiple files and Codex-style patch payloads, all validated against a virtual filesystem before any real changes are written. Modes: single (classic `oldText → newText`), multi (batch array), and patch (unified-diff style).

Full details: [extensions/multi-edit/README.md](extensions/multi-edit/README.md).

#### Install

```bash
pi install npm:pi-mono-multi-edit
```

### review

The `review` extension adds both `/review` and `/review-tui`.

Full details: [extensions/review/README.md](extensions/review/README.md).

#### Usage

```text
/review https://github.com/org/repo/pull/123
/review https://gitlab.com/group/project/-/merge_requests/45
/review-tui
```

#### Behavior

- `/review <url>` detects GitHub vs GitLab from the URL
- fetches the diff under the hood with the appropriate CLI
- runs the review with the active pi model using a scoped `report_finding` tool when supported, with JSON fallback
- prints a compact P0–P3 findings summary in the terminal
- stores the review for `/review-tui`
- `/review-tui` opens the saved review in a side pane
- lets you approve, dismiss, or edit each titled finding/comment
- submits approved comments directly to GitHub or GitLab based on the saved review URL

#### Install

```bash
pi install npm:pi-mono-review
```

### sentinel

The `sentinel` extension adds content-aware security guards that intercept tool calls before they execute. It pre-scans files being read for secret patterns (AWS, GitHub, Anthropic, OpenAI, Slack, Stripe, PEM keys, high-entropy strings, etc.), tracks files written during the session to block or confirm later indirect execution via `bash`, and provides a local token vault so LLMs can use stored credentials via `$TOKEN_name` placeholders without seeing secret values.

Full details: [extensions/sentinel/README.md](extensions/sentinel/README.md).

#### Install

```bash
pi install npm:pi-mono-sentinel
```

### simplify

The `simplify` extension adds a `/simplify` command that reviews all git-changed files for code reuse, quality, and efficiency — then fixes any issues found.

Full details: [extensions/simplify/README.md](extensions/simplify/README.md).

#### Usage

```text
/simplify
/simplify <additional focus>
```

#### Behavior

- Runs `git diff` (or `git diff HEAD` for staged changes) to identify what changed
- Launches three sub-agents **in parallel**, each receiving the full diff:
  - **Code Reuse** — flags duplicated logic and inline patterns that should use existing utilities
  - **Code Quality** — detects redundant state, copy-paste blocks, leaky abstractions, stringly-typed code, and unnecessary comments
  - **Efficiency** — catches N+1s, missed concurrency, hot-path bloat, memory leaks, and overly broad data fetches
- Aggregates findings, applies fixes directly, and summarizes what changed
- Passing extra text after `/simplify` appends an **Additional Focus** section to steer all three agents

#### Examples

```text
/simplify
/simplify focus on performance and memory usage
/simplify pay extra attention to React re-renders
```

#### Install

```bash
pi install npm:pi-mono-simplify
```

### status-line

The `status-line` extension adds a configurable footer with two modes: `basic` (default two-line layout with token stats) and `expert` (rich footer with visual context gauge, enhanced git status, session cost, and subscription usage indicators for Claude Max, Codex, Copilot, and Gemini). Mode is resolved from `PI_STATUS_LINE_MODE`, then `~/.pi/agent/status-line.json`, then defaults to `basic`.

Full details: [extensions/status-line/README.md](extensions/status-line/README.md).

#### Install

```bash
pi install npm:pi-mono-status-line
```

### team-mode

The `team-mode` extension adds flat peer-agent orchestration: named, addressable workers spawned as isolated pi subprocesses with resumable context, mirroring Claude Code's team-mate model.

A coordinator (the parent LLM session, or human) spawns workers via the `agent` tool, receives `<task-notification>` push messages when they complete, and continues them via `send_message` with full prior context. Workers are event-driven — no polling, no persistent leader subprocess. A shared TODO board with CAS version counters coordinates multi-step DAGs.

Full details: [extensions/team-mode/README.md](extensions/team-mode/README.md).

#### Install

```bash
pi install npm:pi-mono-team-mode
```

### usage

The `usage` extension adds a `/usage` command that aggregates local pi session files and renders an inline dashboard with three views:

- **Summary** — totals, top providers (with horizontal bars), and an environmental footprint estimate (kWh, kg CO₂e, real-world equivalences) computed from [`impact-equivalences`](https://www.npmjs.com/package/impact-equivalences).
- **Providers** — per-provider table that expands into per-model rows on `Enter`.
- **Patterns** — cost-driver insights for the selected period (parallel sessions, oversized contexts, large uncached prompts, marathon sessions, top-session concentration).

`Tab`/arrows cycle the period (Today / This Week / Last Week / All Time). `v` or `1`/`2`/`3` switch view. `q`/`Esc` close the panel.

Full details: [extensions/usage/README.md](extensions/usage/README.md).

#### Install

```bash
pi install npm:pi-mono-usage
```

### web-search

The `web-search` extension registers native `web_search` and `web_read` tools for online research. Search uses DuckDuckGo result pages, and page reading fetches a URL and extracts readable article text with Mozilla Readability plus a lightweight HTML fallback.

Full details: [extensions/web-search/README.md](extensions/web-search/README.md).

#### Tools

- `web_search` — search the web and return titles, URLs, and snippets.
- `web_read` — fetch a page URL and return cleaned readable content.

#### Install

```bash
pi install npm:pi-mono-web-search
```
