# pi-mono-auto-fix

End-of-turn formatter/linter dispatcher for pi. Collects every file written during a turn and applies language-appropriate fixers (eslint, black, prettier, …) in one batch once the agent stops talking.

## What it does

- Subscribes to `tool_result` for the built-in `edit` and `write` tools, plus the `context-guard:file-modified` event that `multi-edit` and other writers emit.
- Buffers absolute paths of touched files in a per-turn `Set`.
- On `agent_end`, groups paths by matching fixer, runs each fixer once per group (parallel up to `concurrency`).
- After each run, re-emits `context-guard:file-modified` for any file whose mtime actually changed, so downstream read caches evict.
- Emits a single notification at the end (`auto-fix: N/M files updated`).

Fixers are invoked silently — stdout/stderr are swallowed. Failures are reported in the summary notification but never surfaced into the LLM context.

## Built-in fixer rules

| Extensions                                        | Command                                                        |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `.ts .tsx .js .jsx .mjs .cjs`                     | `npx --no-install eslint --fix --no-error-on-unmatched-pattern {files}` |
| `.py`                                             | `black -q {files}`                                             |
| `.json .md .yml .yaml .css .scss .html`           | `npx --no-install prettier --write --log-level=warn {files}`   |

`{files}` is replaced with shell-quoted, space-separated absolute paths. If the token is missing, files are appended to the end of the command.

Commands run with `shell: true`, `cwd = ctx.cwd`, and a per-invocation timeout (default 60s).

## Configuration

Resolution order (first hit wins):

1. `PI_AUTO_FIX=0` → extension is fully disabled (no listeners registered)
2. `~/.pi/agent/auto-fix.json`
3. built-in defaults

Example `~/.pi/agent/auto-fix.json`:

```json
{
  "enabled": true,
  "timeoutMs": 90000,
  "concurrency": 2,
  "ignore": ["node_modules/", "dist/", ".git/", "vendor/"],
  "fixers": [
    {
      "label": "biome",
      "extensions": [".ts", ".tsx", ".js", ".jsx"],
      "command": "npx --no-install biome check --write --no-errors-on-unmatched {files}"
    },
    {
      "label": "ruff",
      "extensions": [".py"],
      "command": "ruff check --fix {files} && ruff format {files}"
    }
  ]
}
```

All fields are optional; anything omitted falls back to the built-in default.

## Install

```bash
pi install npm:pi-mono-auto-fix
```

Or load directly for testing:

```bash
pi -e /path/to/pi-extensions/extensions/auto-fix/index.ts
```

## Notes

- Paths outside `ctx.cwd` are skipped for safety.
- Paths matching any substring in `ignore` are skipped.
- Files deleted during the turn are skipped (existence is re-checked at flush time).
- The mtime diff catches fixers that are no-ops on already-clean files, so the summary reflects real changes rather than just invocations.
