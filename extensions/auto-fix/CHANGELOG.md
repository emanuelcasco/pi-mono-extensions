# pi-mono-auto-fix

## 0.3.0

### Added

- **ESLint version-aware dispatch with config detection**: Auto-fix now determines the project's ESLint version and config format before running.
  - Walks from the file's directory up to `package.json` to find the project root.
  - Detects flat (`eslint.config.*`) vs. legacy (`.eslintrc.*`) configs.
  - Reads the installed ESLint major version from `node_modules/eslint/package.json`.
    | Local ESLint | Config Format | Action |
    | --- | --- | --- |
    | v8 | Flat config | **Skip** — incompatible |
    | v9+ | Legacy config | Use local + `ESLINT_USE_FLAT_CONFIG=false` |
    | v8 | Legacy config | Use local binary directly |
    | v9+ | Flat config | Use local binary directly |
    | None | Legacy config | `npx --yes eslint@8` |
    | None | Flat config | `npx --yes eslint@9` |
    | None | No config | **Skip** — avoids injecting rules on projects that don't use ESLint |

### Changed

- `resolveSpawnTarget` now returns `{ command, spawnCwd, env? }` so fixers can pass environment overrides (e.g. `ESLINT_USE_FLAT_CONFIG`).
- `runFixer` branches labelled `"eslint"` through the new `resolveEslintCommand` resolver.

### Fixed

- Tightened `spawn` invocation typing for the release package without changing runtime behavior.

## 0.2.2

### Fixed

- **eslint failing on every file in projects pinned to v8**: The `0.2.1` neutral-cwd fix made `npx eslint` resolve from `/tmp`, which auto-installs the latest ESLint (v10+) and ignores the project's pinned version and config. Projects on ESLint v8 with `.eslintrc.*` then failed with "ESLint couldn't find an eslint.config.(js|mjs|cjs) file." on every file. Auto-fix now walks up from each file to find a project-local `node_modules/.bin/<tool>` and execs it directly with the project root as cwd, falling back to neutral-cwd npx only when no local install exists.

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
