# Simplify Extension

Registers a `/simplify` command that reviews all git-changed files for code reuse, quality, and efficiency — then fixes any issues found.

Ported from the [`simplify` skill](https://github.com/emanuelcasco/claude-code/blob/main/src/skills/bundled/simplify.ts) for Claude Code.

## Usage

```
/simplify
/simplify <additional focus>
```

**Examples:**

```
/simplify
/simplify focus on performance and memory usage
/simplify pay extra attention to React re-renders
```

## Structure

- `index.ts` — extension entrypoint, registers the `/simplify` command

## How It Works

Running `/simplify` injects a structured prompt into the conversation that drives a three-phase review:

### Phase 1 — Identify Changes

Runs `git diff` (or `git diff HEAD` for staged changes) to get the full diff. Falls back to recently modified files if no git changes are present.

### Phase 2 — Parallel Review (3 agents)

Three sub-agents run concurrently, each receiving the full diff:

| Agent | Focus |
|-------|-------|
| **Code Reuse** | Flags duplicated logic, hand-rolled utilities that shadow existing helpers, and inline patterns that should use shared abstractions |
| **Code Quality** | Detects redundant state, parameter sprawl, copy-paste blocks, leaky abstractions, stringly-typed code, unnecessary JSX nesting, and low-value comments |
| **Efficiency** | Catches unnecessary work, missed concurrency, hot-path bloat, recurring no-op updates, TOCTOU existence checks, memory leaks, and overly broad data fetches |

### Phase 3 — Fix & Summarize

Aggregates findings from all three agents, applies fixes directly, skips false positives, and prints a brief summary of what changed (or confirms the code was already clean).

## Optional Focus

Pass extra instructions after the command to steer the review:

```
/simplify pay close attention to SQL query efficiency
```

This appends an **Additional Focus** section to the prompt, which all agents will take into account.
