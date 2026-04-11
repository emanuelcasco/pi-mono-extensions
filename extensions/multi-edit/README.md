# Multi-Edit — Enhanced Edit Tool

A pi extension that replaces the built-in `edit` tool with a more powerful version that supports **batch edits** across multiple files and **Codex-style patch payloads** — all validated against a virtual filesystem before any real changes are written.

## Origins

Initially derived from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)'s `pi-extensions/multi-edit.ts`. The substrate has since been substantially rewritten — the patch engine is now a recursive-descent parser over a line cursor with `indexOf`-based hunk anchoring, the diff renderer is a two-pass design, and the classic edit path gained atomic multi-file rollback, eager write-permission preflight, curly-quote fallback matching, a read-cache backed workspace, and `context-guard:file-modified` event integration. Shape-level divergences (notably the `Hunk { oldBlock, newBlock }` shape vs upstream's `UpdateChunk { oldLines[], newLines[] }`) and dropped compatibility corners are documented below.

## Overview

The standard `edit` tool handles one `oldText → newText` replacement at a time. Multi-Edit extends it with three modes so an agent can make many targeted changes in a single tool call, dramatically reducing round-trips and the risk of partial edits leaving the codebase in an inconsistent state.

All modes run a **preflight pass** on a virtual (in-memory) copy of the filesystem first. If any replacement fails, no real files are touched.

## Modes

### 1. Single (classic)

Identical to the built-in `edit` tool. Provide `path`, `oldText`, and `newText`.

```jsonc
{
  "path": "src/index.ts",
  "oldText": "const foo = 1;",
  "newText": "const foo = 2;",
}
```

### 2. Multi (batch array)

Pass a `multi` array of edit objects. Each item has `path`, `oldText`, and `newText`. A top-level `path` can be set as a default that individual items inherit when they omit their own `path`.

```jsonc
{
  "path": "src/utils.ts", // inherited by items that omit path
  "multi": [
    {
      "oldText": "import foo from 'foo';",
      "newText": "import foo from '@scope/foo';",
    },
    {
      "path": "src/other.ts", // overrides the top-level path
      "oldText": "const bar = 0;",
      "newText": "const bar = 42;",
    },
  ],
}
```

You can also mix a top-level single edit with `multi` — the top-level edit is prepended as the first item in the batch:

```jsonc
{
  "path": "src/index.ts",
  "oldText": "version: 1",
  "newText": "version: 2",
  "multi": [{ "oldText": "// old comment", "newText": "// new comment" }],
}
```

### 3. Patch (Codex-style)

Pass a `patch` string delimited by `*** Begin Patch` / `*** End Patch`. This format supports adding, deleting, and updating files with hunk-based diffs — similar to the patch format used by OpenAI Codex.

```
*** Begin Patch
*** Add File: src/new-file.ts
+export const greeting = "hello";
*** Delete File: src/deprecated.ts
*** Update File: src/existing.ts
@@ function oldName() {
-function oldName() {
+function newName() {
*** End Patch
```

**Supported operations inside a patch:**

| Header                    | Effect                                                              |
| ------------------------- | ------------------------------------------------------------------- |
| `*** Add File: <path>`    | Creates (or overwrites) the file with `+`-prefixed lines as content |
| `*** Delete File: <path>` | Removes the file (errors if it doesn't exist)                       |
| `*** Update File: <path>` | Applies one or more `@@`-delimited hunks to the file                |

> **Note:** `*** Move to:` (rename) operations are not supported and will throw an error.

#### Codex apply_patch compatibility

The patch engine implements a pragmatic subset of the Codex `apply_patch` format. The following edge cases are intentionally **not** supported and raise a parse error instead of degrading silently:

| Feature                           | Status    | Workaround                                                        |
| --------------------------------- | --------- | ----------------------------------------------------------------- |
| `@@` hunk header                  | Required  | Every hunk inside an `*** Update File:` block must start with `@@` |
| Whitespace-tolerant hunk matching | Dropped   | Hunks are matched via exact `indexOf` — emit clean context lines   |
| Unicode-normalized hunk matching  | Dropped   | Normalize curly quotes / dashes in the patch before sending       |
| `*** End of File` sentinel hunks  | Dropped   | Use a normal hunk anchored on the last real line                  |
| `*** Move to:` rename             | Rejected  | Emit an Add + Delete pair instead                                 |

These restrictions make the parser simpler and more predictable at the cost of tolerance for malformed or loosely-formatted patches. The classic `multi` mode remains fuzzier (see "Quote-Normalized Matching") and is the recommended path when you want forgiveness.

## Key Features

### Preflight Validation

Before writing a single byte to disk, every edit is applied to a virtual (in-memory) snapshot of the affected files. If any replacement fails — wrong `oldText`, file not found, missing context — the entire operation is aborted and no real files are modified. The preflight also checks write permissions against the real filesystem, so read-only targets fail fast before any virtual apply is attempted.

### Atomic Multi-File Rollback

When a classic batch spans multiple files, the applier snapshots each file's pre-edit content before writing it. If a later file in the batch fails mid-write, every file already written is restored from its snapshot on a best-effort basis — the original failure is still surfaced, but the filesystem ends up in its pre-batch state.

### Positional Ordering for Same-File Edits

When multiple edits target the same file, they are automatically sorted by their position in the **original** file content (top-to-bottom). This ensures the forward-search cursor works correctly regardless of the order the model listed the edits.

### Quote-Normalized Matching for Classic Edits

Classic `oldText` lookups escalate through an ordered list of normalizer passes. The first pass that locates the transformed text wins:

1. **Exact** — character-for-character match
2. **Curly → straight quotes** — `'` / `'` / `"` / `"` in the model's `oldText` are rewritten to ASCII before the second search

This catches the most frequent class of preflight failures, where a model was trained on prose that carries curly quotes but the target file contains plain ASCII. Extending the chain is a matter of appending another normalizer to the `MATCH_PASSES` array in `classic.ts`.

Patch `@@` hunks do **not** fall back through this chain — they require exact matches (see "Codex apply_patch compatibility" below).

### Redundant Edit Detection

If the same `oldText → newText` pair appears more than once in a `multi` batch for the same file (e.g. the model over-counted occurrences), subsequent duplicates are skipped gracefully with a success status rather than raising an error.

### Diff Generation

Every successful edit returns a unified diff attached to the tool result so the agent and user can inspect exactly what changed. For multi-file operations, per-file diffs are concatenated. The first changed line number is also surfaced for UI scrolling.

### Path Inheritance

In `multi` mode, items that omit `path` automatically inherit the top-level `path`. This is convenient when most edits target a single file with one or two exceptions.

## Parameters

| Parameter | Type                    | Description                                                                                                  |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `path`    | `string` (optional)     | Target file path (absolute or relative to cwd). Serves as default for `multi` items.                         |
| `oldText` | `string` (optional)     | Exact text to find and replace. Must match including all whitespace.                                         |
| `newText` | `string` (optional)     | Replacement text.                                                                                            |
| `multi`   | `EditItem[]` (optional) | Array of `{ path?, oldText, newText }` objects for batch mode.                                               |
| `patch`   | `string` (optional)     | Codex-style patch payload (`*** Begin Patch … *** End Patch`). Mutually exclusive with all other parameters. |

**`EditItem` shape:**

```ts
{
  path?: string;   // inherits top-level path if omitted
  oldText: string;
  newText: string;
}
```

## Dependencies

| Package                         | Role                                                |
| ------------------------------- | --------------------------------------------------- |
| `@mariozechner/pi-coding-agent` | `ExtensionAPI` type and tool registration           |
| `@sinclair/typebox`             | Runtime JSON Schema / TypeBox parameter definitions |
| `diff`                          | Line-level diff generation for result output        |

## Error Handling

| Situation                                                            | Behaviour                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| `patch` used together with `path`/`oldText`/`newText`/`multi`        | Throws immediately — parameters are mutually exclusive |
| Incomplete top-level edit (e.g. `path` + `oldText` but no `newText`) | Throws listing the missing fields                      |
| `multi` item missing `path` and no top-level `path` set              | Throws identifying which item is affected              |
| `oldText` not found in file                                          | Preflight throws; no files are modified                |
| `patch` context line not found                                       | Preflight throws; no files are modified                |
| File does not exist or is not writable                               | Throws before any mutations                            |
| Patch `*** Move to:` operation                                       | Throws — not supported                                 |
