# Context Management

**Status:** In progress  
**Last updated:** 2026-04-04

## Background

A single session analysing this repo hit **130k tokens / $2.25**. Breakdown:

- **72.9%** of context came from `read` tool results
- Largest single read: `extensions.md` — 50k chars (~12k tokens), read in full
- Secondary source: unbounded `bash` + `rg` calls piping unlimited grep output into context

Two tool usage patterns drive almost all the bloat:

1. `read` called without `limit` → entire large files enter context
2. `bash` with raw `rg` → unbounded grep output enters context

## How Claude Code Solves This

### GrepTool

A dedicated `grep` tool wraps ripgrep. The model is explicitly told **never** to invoke `rg` via bash. Key design points:

- `head_limit` param (default 250 lines) — enforced at tool level, not prompt level
- `output_mode`: `files_with_matches` (default, fewest tokens) | `content` | `count`
- `offset` for pagination
- VCS dirs (`.git`, `.svn`, `.hg`) auto-excluded
- Source comment: _"Unbounded content-mode greps can fill up to the 20KB persist threshold (~6–24K tokens/grep-heavy session)"_

### FileReadTool

- Hard cap: 25,000 output tokens / 256KB file size gate
- **Read deduplication**: if the same file + offset + limit was already read and `mtime` hasn't changed → returns a stub:

  > _"File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading."_

  ~20 tokens vs ~8k tokens for the full file.

- Source comment: _"BQ proxy shows ~18% of Read calls are same-file collisions (up to 2.64% of fleet cache_creation)"_

## Decisions

### ✅ Add `grep` tool extension

**Reason:** Changes model behaviour at the prompt level. With a `grep` tool present and a guideline of _"ALWAYS use grep, NEVER use rg via bash"_, the model reaches for the right tool. `head_limit=60` is baked into the schema so limits are enforced unconditionally — no reliance on prompt compliance alone.

### ✅ Add read deduplication to `context-guard`

**Reason:** ~18% of reads are repeat reads of unchanged files. Mtime-based dedup returns a 20-token stub instead of re-sending 8k tokens of unchanged content. Cache entries are invalidated when a `context-guard:file-modified` event is received from `multi-edit`.

### ❌ Do NOT override the built-in `read` tool

**Reason:** pi's built-in `read` already exposes `offset` + `limit` params. Overriding it means reimplementing the file mutation queue integration, image reading, and error handling. High risk, low payoff. Use `context-guard` as an interceptor instead.

### ✅ Keep `context-guard` as safety net

Even with the `grep` tool in place, the model occasionally falls back to `bash` + `rg`. `context-guard`'s bash guard catches those by appending `| head -60`. With dedup added, it also handles repeated reads transparently.

### Priority order (by ROI)

| Action                            | Effort | Impact                                       |
| --------------------------------- | ------ | -------------------------------------------- |
| Add `grep` tool                   | Low    | High — changes model behaviour at tool level |
| Add read dedup to `context-guard` | Medium | Medium — eliminates ~18% of read volume      |

## Architecture

```
Model wants to search
        │
        ▼
   Uses grep tool ──► head_limit=60 built-in, output_mode, pagination
        │
        │ (fallback: model uses bash with rg)
        ▼
   context-guard ──► appends | head -60


Model wants to read a file
        │
        ▼
   Uses read tool
        │
        ├─ context-guard injects limit=120 if missing
        │
        ├─ same file, same range, mtime unchanged
        │   └──► dedup stub returned (~20 tokens)
        │
        └─ new/changed file ──► full read (capped at 120 lines)


Multi-edit writes a file
        │
        └──► emits pi.events "context-guard:file-modified"
                └──► context-guard invalidates dedup cache entry
```

## Implementation Status

| Component                             | Status  | Location                    |
| ------------------------------------- | ------- | --------------------------- |
| context-guard — read limit + rg guard | ✅ Done | `extensions/context-guard/` |
| context-guard — read deduplication    | ✅ Done | `extensions/context-guard/` |
| grep tool                             | ❌ Removed     | Use Pi built-in `grep` tool |
| multi-edit — `file-modified` event    | ✅ Implemented | `extensions/multi-edit/`    |
