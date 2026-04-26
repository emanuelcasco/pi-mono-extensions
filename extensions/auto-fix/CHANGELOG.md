# pi-mono-auto-fix

## 0.2.0

### Fixed

- **Auto-install dependencies**: Fixers now use `npx` (without `--no-install`) for eslint/prettier and `uvx` for ruff, auto-installing if missing — no manual install required.
- **False failure reporting with eslint**: `eslint --fix` exits non-zero when it finds unfixable issues, even if it successfully fixed others in the same pass. Failure detection now checks mtime (file actually changed) instead of exit code, so successful fixes are no longer reported as failures.
- **npx broken in pnpm monorepos**: `npx` delegates to pnpm when `package.json` declares `"packageManager": "pnpm"`, but `pnpm exec` doesn't auto-install like npx does. Fixers now use a neutral cwd (`/tmp`) for npx commands to bypass project-level toolchain interference.

### Changed

- Python fixer swapped from `black` (global install required) to `uvx ruff check --fix && uvx ruff format` (auto-installs via PyPI, faster).

## 0.1.0

### Minor Changes

### New Extension: auto-fix

End-of-turn formatter/linter dispatcher. Subscribes to `tool_result` (for `edit` / `write`) and the `context-guard:file-modified` event bus to collect every path written during a turn, then on `agent_end` routes each path to a language-appropriate fixer (eslint / black / prettier by default) and runs them in parallel. Re-emits `context-guard:file-modified` for files whose mtime actually changed so downstream read caches evict.

- Configurable via `~/.pi/agent/auto-fix.json` (fixers, ignore patterns, timeout, concurrency)
- Disable with `PI_AUTO_FIX=0`
- Silent stdout/stderr; single summary notification per flush
- Paths outside `ctx.cwd` and deleted files are skipped automatically
