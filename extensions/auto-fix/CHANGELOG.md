# pi-mono-auto-fix

## 0.1.0

### Minor Changes

### New Extension: auto-fix

End-of-turn formatter/linter dispatcher. Subscribes to `tool_result` (for `edit` / `write`) and the `context-guard:file-modified` event bus to collect every path written during a turn, then on `agent_end` routes each path to a language-appropriate fixer (eslint / black / prettier by default) and runs them in parallel. Re-emits `context-guard:file-modified` for files whose mtime actually changed so downstream read caches evict.

- Configurable via `~/.pi/agent/auto-fix.json` (fixers, ignore patterns, timeout, concurrency)
- Disable with `PI_AUTO_FIX=0`
- Silent stdout/stderr; single summary notification per flush
- Paths outside `ctx.cwd` and deleted files are skipped automatically
