---
name: figma
description: Access Figma design files using native pi tools — read LLM-ready summaries, explanations, implementation context, screenshots, components, styles, variables, and design tokens. Requires a Figma personal access token.
---

# Figma Design Integration

Use the native `figma_*` tools to read Figma files and translate designs into code. Prefer processed, LLM-ready tools over raw Figma JSON.

## When to Use

- User provides a Figma file URL and asks you to explain or implement a design.
- User asks about Figma colors, typography, spacing, components, variables, or layout.
- You need screenshots/assets for visual validation.

## Authentication

The tools read the token from an in-memory override, `FIGMA_TOKEN`, or `~/.pi/agent/auth.json` at `.figma.token`.

If auth is missing, invalid, or expired, do **not** ask the user to paste the token in chat. Use the native `figma_configure_auth` tool or ask the user to run `/figma-auth --force`. The prompt is masked and the token is stored by the extension without returning it to the model.

## URL Parsing

Given:

```text
https://www.figma.com/design/ABC123def456/Project-Name?node-id=123-456
```

- File key: `ABC123def456`
- Node ID: `123-456` from the URL (`figma_*` tools also accept API format `123:456`)

Use `figma_parse_url` when you need to extract these values from a full URL.

## Default Tool Workflow

1. Use `figma_configure_auth` only when auth is missing, invalid, expired, or the user asks to update the token.
2. Use `figma_parse_url` for full Figma URLs.
3. Use `figma_render_nodes` for screenshots/assets when visual context helps.
4. Use `figma_explain_node` or `figma_get_node_summary` for the target frame/component.
5. Use `figma_get_implementation_context` when coding from a design.
6. Use `figma_get_design_context` for compact file/page/top-level context.
7. Use `figma_get_nodes` only for raw debugging.

**Do not call `figma_get_nodes` by default. Prefer processed tools.**

Prefer batch calls where supported: pass multiple node IDs to `figma_render_nodes`, `figma_get_node_metadata`, or raw `figma_get_nodes` instead of looping.

## Recommended Workflows

### Explaining a component

```text
figma_parse_url
figma_render_nodes
figma_explain_node
```

### Implementing a design

```text
figma_parse_url
figma_render_nodes
figma_get_implementation_context
figma_get_node_summary for specific subnodes if needed
```

### Debugging the extension or raw Figma data

```text
figma_get_nodes
```

## Processed Tools

- `figma_get_node_summary` returns compact structured summaries: name, type, size, layout, spacing/padding, fills/strokes/effects, visible text, component properties, and immediate child hierarchy.
- `figma_extract_text` returns visible text nodes only.
- `figma_explain_node` returns human-readable Markdown for questions like “Explain this component.”
- `figma_get_implementation_context` returns coding-ready context: purpose, sections, fields/buttons, measurements, typography, colors, spacing, assets, and React-friendly hierarchy.

Processed tools default to shallow, safe fetches:

```ts
{
  depth: 2,
  includeHidden: false,
  includeVectors: false,
  includeComponentInternals: false
}
```

Only increase `depth` (max 4) or enable internals/vectors for a specific child node when needed.

## Raw Escape Hatches

- `figma_get_file`
- `figma_get_nodes`

Use these only when raw Figma JSON is explicitly needed or when debugging the extension. They may return very large responses and reduce answer quality.

## Output Limits

Processed tools enforce compact defaults and may include `metadata.truncated: true` plus `nextSteps`, for example:

- Call `figma_get_node_summary` with a deeper `depth`.
- Inspect a specific child node by ID.
- Enable `includeComponentInternals=true` for a focused component instance.

## Notes

- Figma API is rate-limited; batch node IDs where supported.
- Large responses may be truncated; narrow to a specific child node when needed.
- This integration is read-only and cannot modify Figma files.
