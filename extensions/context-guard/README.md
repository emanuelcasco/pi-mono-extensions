# context-guard extension

Keeps pi sessions lean by preventing common context-window waste during tool use.

## What it does

This extension intercepts tool calls and applies three safeguards:

1. **Auto-limit `read` calls**  
   If the model calls `read` without a `limit`, `context-guard` injects a default limit of `120` lines and shows a notification. The model can continue with `offset` to paginate.

2. **Deduplicate unchanged `read` calls**  
   If the same file is read again with the same `offset` and `limit`, and the file has not changed on disk, the extension blocks the duplicate read and returns a short stub instead of sending the file content again.

3. **Bound raw `rg` output in `bash`**  
   If a `bash` command uses `rg` without an output-bounding operator such as `head`, `tail`, or `wc`, the extension appends `| head -60` automatically.

## Why it helps

These guards reduce unnecessary token usage and make it harder for long sessions to burn context on repeated or unbounded file output.

## Current defaults

- `read` auto-limit: `120`
- `rg` head limit: `60`
- read guard: enabled
- read dedup guard: enabled
- raw `rg` guard: enabled

## Read dedup behavior

The dedup cache is scoped to the current session.

A cached `read` entry is only reused when all of the following are true:

- the same file path is requested
- the same `offset` is requested
- the same `limit` is requested
- the file's modification time has not changed

When a file changes, the cache entry is invalidated. The extension also listens for the `context-guard:file-modified` event so companion extensions such as `multi-edit` can evict stale cache entries immediately after writes.

## Example behaviors

### `read` without a limit

Input:

```json
{ "path": "src/index.ts" }
```

Effective call:

```json
{ "path": "src/index.ts", "limit": 120 }
```

### Duplicate `read` of an unchanged file

Instead of re-sending the file contents, the extension returns a short message telling the agent to reuse the earlier `read` result.

### Raw `rg` inside `bash`

Input:

```bash
rg "TODO" src
```

Effective command:

```bash
rg "TODO" src | head -60
```

## Files

- `index.ts` — extension entry point
- `package.json` — package metadata
- `CHANGELOG.md` — release history
