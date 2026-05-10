# pi-mono-extensions

`pi-mono-extensions` is a pnpm workspace that collects installable extensions for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Each package under `extensions/` adds a focused capability to pi: new tools, slash commands, TUI panels, workflow automation, security guards, design/product integrations, or bundled skills.

You can install the full bundle with one command, or install only the extensions you need. This README is the top-level catalog; each extension section links to its own README for deeper usage, configuration, and development details.

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

Or install individual extensions by package name from the sections below.

Load an extension temporarily for local testing:

```bash
pi -e /path/to/pi-extensions/extensions/btw/index.ts
```

## Extensions

### ask-user-question

Full details: [extensions/ask-user-question/README.md](extensions/ask-user-question/README.md).

Registers the `ask_user_question` tool so agents can ask structured questions with interactive TUI controls — radio buttons, checkboxes, and multi-line text inputs — instead of plain-text follow-up questions.

#### Install

```bash
pi install npm:pi-mono-ask-user-question
```

#### Usage

Use the `ask_user_question` tool when a task needs structured user input:

```text
ask_user_question
- radio: choose one option
- checkbox: choose many options
- text: free-form input
```

Example prompts agents can satisfy with this tool:

- “Ask me which implementation option to use.”
- “Let me pick multiple files/features before continuing.”
- “Collect a short free-form requirement before editing code.”

### auto-fix

Full details: [extensions/auto-fix/README.md](extensions/auto-fix/README.md).

Runs language-appropriate fixers such as eslint, prettier, and black on files written during a turn. Fixes are applied silently and summarized once at `agent_end`.

#### Install

```bash
pi install npm:pi-mono-auto-fix
```

#### Usage

Install it and keep working normally. When the agent writes supported files, `auto-fix` queues and runs the matching fixer automatically.

Examples:

```text
Ask pi to edit TypeScript, JavaScript, Python, or formatted text files.
auto-fix applies available project fixers after writes.
```

#### Configuration

See the extension README for supported fixer rules and configuration examples.

### btw

Full details: [extensions/btw/README.md](extensions/btw/README.md).

Adds Claude Code-style `/btw` behavior for asking a quick side question while pi is busy with the main task. Answers appear in a passive widget and are kept out of the visible transcript and future LLM context.

#### Install

```bash
pi install npm:pi-mono-btw
```

#### Usage

```text
/btw What does this error mean?
/btw Give me a shorter name for this function
/btw Summarize the current approach in one paragraph
```

You can also press `Ctrl+Shift+B` to ask the current editor text as a side question.

#### Behavior

- Works while pi is idle or busy.
- Uses the active model and current session transcript as context.
- Stores question/answer metadata as hidden session entries.

### clear

Full details: [extensions/clear/README.md](extensions/clear/README.md).

Adds a `/clear` command that starts a fresh session, similar to the built-in `/new` command.

#### Install

```bash
pi install npm:pi-mono-clear
```

#### Usage

```text
/clear
```

Or press `Ctrl+Shift+L`.

#### Behavior

- If the agent is busy, `/clear` waits for it to finish before switching sessions.
- Creates a new session via `ctx.newSession()`.
- Shows a warning if the new-session request is cancelled and an error notification if clearing fails.

### context

Full details: [extensions/context/README.md](extensions/context/README.md).

Adds a Claude Code-style `/context` command that prints current context-window usage, estimated category breakdown, extension allocation, session stats, and active tool/command sections without adding the report to future LLM context.

#### Install

```bash
pi install npm:pi-mono-context
```

#### Usage

```text
/context
```

The printed report is display-only and filtered from future LLM context.

### context-guard

Full details: [extensions/context-guard/README.md](extensions/context-guard/README.md).

Keeps pi sessions lean by intercepting tool calls before they execute and reducing repeated or unbounded context-heavy output.

#### Install

```bash
pi install npm:pi-mono-context-guard
```

#### Usage

Install it and keep working normally. The extension automatically:

- injects a default `limit` of `120` on `read` calls that omit a limit
- blocks duplicate unchanged `read` calls with the same path, offset, and limit
- appends `| head -60` to unbounded `rg` usage inside `bash` commands

#### Notes

The read dedup cache is session-scoped and invalidates when file mtimes change.

### figma

Full details: [extensions/figma/README.md](extensions/figma/README.md).

Registers native Figma tools for design context, node summaries, rendered screenshots, implementation guidance, text extraction, asset extraction, component hints, Code Connect lookup, and raw JSON debugging escape hatches. It also bundles a Figma skill for design-to-code workflows.

#### Install

```bash
pi install npm:pi-mono-figma
```

#### Authentication

Auth is read from `FIGMA_TOKEN` or `~/.pi/agent/auth.json` at `.figma.token`.

For masked token setup or update, use:

```text
/figma-auth --force
```

Agents can also use the `figma_configure_auth` tool when authentication is missing, expired, invalid, or explicitly requested.

#### Usage

Explain a Figma node:

```text
figma_parse_url
figma_render_nodes
figma_explain_node
```

Implement a design:

```text
figma_parse_url
figma_find_nodes_by_name or figma_find_nodes_by_text
figma_get_implementation_context
figma_extract_assets
```

Useful tools include:

- `figma_get_design_context`
- `figma_get_node_summary`
- `figma_extract_text`
- `figma_get_component_implementation_hints`
- `figma_find_code_connect_mapping`

Rendered/generated image files default to OS temp directories unless `outputDir` is explicitly provided.

### linear

Full details: [extensions/linear/README.md](extensions/linear/README.md).

Registers native Linear tools for workspace metadata, issue search, issue details, create/update/comment operations, projects, cycles, labels, users, documents, and file uploads. It also bundles a Linear workflow skill.

#### Install

```bash
pi install npm:pi-mono-linear
```

#### Authentication

Auth is read from `LINEAR_API_KEY` or `~/.pi/agent/auth.json` at `.linear.key`.

For masked key setup or update, use:

```text
/linear-auth --force
```

Agents can also use the `linear_configure_auth` tool when authentication is missing, expired, invalid, or explicitly requested.

#### Usage

Find and inspect issues:

```text
linear_workspace_metadata
linear_search_issues
linear_get_issue
```

Update or comment on an issue:

```text
linear_get_issue
linear_update_issue
linear_create_comment
```

Upload a file to an issue comment:

```text
linear_get_issue
linear_upload_file_to_issue_comment
```

### loop

Full details: [extensions/loop/README.md](extensions/loop/README.md).

Adds a `/loop` command that runs a prompt or slash command immediately and then repeats it on a recurring interval.

#### Install

```bash
pi install npm:pi-mono-loop
```

#### Usage

```text
/loop [interval] <prompt>
/loop list
/loop stop
/loop stop <id>
```

Examples:

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

- Supports `s`, `m`, `h`, and `d` interval suffixes.
- Defaults to `10m` when no interval is given.
- Minimum interval is 10 seconds.
- Loops auto-expire after 7 days.
- If the agent is busy when a timer fires, the prompt is queued as a follow-up.

### multi-edit

Full details: [extensions/multi-edit/README.md](extensions/multi-edit/README.md).

Replaces the built-in `edit` tool with an enhanced version that supports classic single edits, batch edits across multiple files, and Codex-style patch payloads, all validated against a virtual filesystem before real writes occur.

#### Install

```bash
pi install npm:pi-mono-multi-edit
```

#### Usage

Classic edit:

```text
edit(path, oldText, newText)
```

Batch edit:

```text
edit(multi: [
  { path, oldText, newText },
  { path, oldText, newText }
])
```

Patch edit:

```text
edit(patch: "*** Begin Patch ... *** End Patch")
```

#### Features

- preflight validation
- atomic multi-file rollback
- same-file positional ordering
- quote-normalized matching for classic edits
- redundant edit detection
- diff generation

### review

Full details: [extensions/review/README.md](extensions/review/README.md).

Adds `/review` and `/review-tui` for reviewing GitHub pull requests or GitLab merge requests and submitting selected comments through an interactive review UI.

#### Install

```bash
pi install npm:pi-mono-review
```

#### Usage

```text
/review https://github.com/org/repo/pull/123
/review https://gitlab.com/group/project/-/merge_requests/45
/review-tui
```

#### Behavior

- Detects GitHub vs GitLab from the URL.
- Fetches the diff using the appropriate CLI.
- Runs review with a scoped `report_finding` tool when supported, with JSON fallback.
- Prints a compact P0–P3 findings summary.
- Stores the review for `/review-tui`, where findings can be approved, dismissed, edited, and submitted.

### sentinel

Full details: [extensions/sentinel/README.md](extensions/sentinel/README.md).

Adds content-aware security guards that pre-scan reads for secret patterns, track write/execute correlation, gate risky bash/write/edit operations, and provide a local token vault for `$TOKEN_name` placeholders without exposing secret values to the LLM.

#### Install

```bash
pi install npm:pi-mono-sentinel
```

#### Usage

Install it and keep working normally. `sentinel` automatically guards supported tool calls.

Examples of guarded behavior:

- blocks or warns on reads that appear to contain secrets
- asks for confirmation before indirectly executing newly written files
- lets agents reference stored credentials by placeholder rather than raw secret value

### simplify

Full details: [extensions/simplify/README.md](extensions/simplify/README.md).

Adds a `/simplify` command that reviews git-changed files for code reuse, quality, and efficiency, then fixes any issues found.

#### Install

```bash
pi install npm:pi-mono-simplify
```

#### Usage

```text
/simplify
/simplify <additional focus>
```

Examples:

```text
/simplify
/simplify focus on performance and memory usage
/simplify pay extra attention to React re-renders
```

#### Behavior

- Runs `git diff` or `git diff HEAD` to identify changed files.
- Launches parallel review agents for code reuse, code quality, and efficiency.
- Aggregates findings, applies fixes directly, and summarizes changes.
- Appends any extra text after `/simplify` as additional review focus.

### status-line

Full details: [extensions/status-line/README.md](extensions/status-line/README.md).

Adds a configurable footer with `basic` and `expert` modes. Basic mode shows a compact two-line layout with token stats; expert mode adds a visual context gauge, enhanced git status, session cost, and subscription usage indicators.

#### Install

```bash
pi install npm:pi-mono-status-line
```

#### Usage

Install it and start pi normally. Configure the mode with `PI_STATUS_LINE_MODE` or `~/.pi/agent/status-line.json`.

Examples:

```bash
PI_STATUS_LINE_MODE=expert pi
```

```json
{
  "mode": "basic"
}
```

### team-mode

Full details: [extensions/team-mode/README.md](extensions/team-mode/README.md).

Adds flat peer-agent orchestration: named, addressable workers spawned as isolated pi subprocesses with resumable context, task notifications, continuation via `send_message`, and a shared TODO board with CAS version counters.

#### Install

```bash
pi install npm:pi-mono-team-mode
```

#### Usage

Agents can spawn and coordinate teammates with tools such as:

```text
agent
send_message
task_create
task_update
task_list
```

Typical workflow:

```text
agent(description: "Research API", name: "api-researcher", prompt: "...")
# wait for <task-notification>
send_message(to: "api-researcher", message: "Follow up with ...")
```

#### Extra

- Supports isolated worktrees for worker edits.
- Supports teammate role specs from `.pi/teammates/` or `.claude/teammates/`.
- Supports delegate groups and live progress.

### usage

Full details: [extensions/usage/README.md](extensions/usage/README.md).

Adds a `/usage` command that aggregates local pi session files and renders an inline dashboard for usage, cost drivers, provider/model breakdowns, and environmental footprint estimates.

#### Install

```bash
pi install npm:pi-mono-usage
```

#### Usage

```text
/usage
```

Inside the dashboard:

- `Tab` or arrows cycle the period: Today, This Week, Last Week, All Time.
- `v` or `1`/`2`/`3` switch views.
- `q` or `Esc` closes the panel.

#### Views

- **Summary** — totals, top providers, and footprint estimate.
- **Providers** — per-provider table with expandable per-model rows.
- **Patterns** — cost-driver insights.

### web-search

Full details: [extensions/web-search/README.md](extensions/web-search/README.md).

Registers native `web_search` and `web_read` tools for online research. Search uses DuckDuckGo result pages, and page reading extracts readable article text with Mozilla Readability plus a lightweight HTML fallback.

#### Install

```bash
pi install npm:pi-mono-web-search
```

#### Usage

Search the web:

```text
web_search(query: "pi coding agent extensions", maxResults: 5)
```

Read a result or known URL:

```text
web_read(url: "https://example.com/article")
```

Typical workflow:

```text
web_search
web_read
summarize or cite findings
```

#### Tools

- `web_search` — returns titles, URLs, and snippets.
- `web_read` — fetches a URL and returns cleaned readable content.
