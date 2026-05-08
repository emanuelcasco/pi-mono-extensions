# pi-mono-context

`pi-mono-context` adds a Claude Code-style `/context` command to Pi for printing the current session's context-window usage in the conversation without adding that report to future LLM context.

## Install

```bash
pi install npm:pi-mono-context
```

Or load locally while developing:

```bash
pi -e /path/to/pi-extensions/extensions/context/index.ts
```

## Usage

```text
/context
```

The command prints a display-only custom message with:

- a dense colored grid representing used vs free context
- current model and total token usage
- estimated usage by category
- session stats such as turns, message count, cache read/write, and cost
- estimated extension allocation grouped by source/package
- active tool and slash-command sections when Pi exposes them cheaply

The printed report is filtered out by the extension's `context` hook before LLM calls, so it is visible in the transcript but does not consume future context window.

## Example

```text
Context Usage
     ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Opus 4.7 (1m context)
     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   claude-opus-4-7[1m]
     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   30.6k/1m tokens (3%)
     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶
     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Estimated usage by category
     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System prompts: 9k tokens (0.9%)
     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System tools: 13k tokens (1.3%)
                                               ⛁ Messages: 13 tokens (0.0%)
                                               ⛶ Free space: 969.4k tokens (96.9%)
```

## Extension allocation

The report includes an `Extension allocation · estimated` section when Pi exposes source metadata. Allocation is grouped from active tool definitions, extension/skill commands, and custom messages by `sourceInfo` or `customType`.

```text
     Extension allocation · estimated
     ├ figma: 4.8k tokens (0.5%) · tools 4.2k · commands 600 · custom 0
     ├ linear: 3.1k tokens (0.3%) · tools 2.7k · commands 400 · custom 0
     └ context: 0 tokens (0.0%) · tools 0 · commands 0 · custom 0
```

This is an estimate, not exact provider-tokenized accounting.

## Color palette

- `⛁ System prompts`: grey
- `⛁ System tools`: grey
- `⛁ Custom agents`: light blue
- `⛁ Memory files`: orange
- `⛁ Skills`: yellow
- `⛁ Messages`: purple
- `⛶ Free space`: grey

## Notes

Pi exposes the real total context usage via `ctx.getContextUsage()`. The category breakdown is a best-effort estimate based on session entries, system prompt text, active tool definitions, and simple token heuristics. Exact provider tokenization may differ.
