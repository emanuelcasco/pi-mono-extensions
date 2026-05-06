# pi-mono-figma

A pi extension and skill package that exposes native Figma tools for design exploration and design-to-code workflows. The default tools return compact, LLM-ready design context instead of raw Figma JSON.

## Benefits over Figma MCP

This package is Pi-native and uses Figma's REST API directly, with tools designed specifically for LLM-friendly design exploration and design-to-code workflows.

- **No hosted Figma MCP quota path:** the extension calls Figma's REST API directly instead of using a hosted Claude/Figma connector quota path. It is still subject to Figma API limits, and the client smooths calls with a fixed 1s limiter plus a 5-minute TTL cache.
- **Better LLM-shaped output:** `figma_get_node_summary`, `figma_explain_node`, and `figma_get_implementation_context` avoid raw Figma JSON by default. They cap depth, skip hidden nodes, vector internals, and component internals unless requested, and return `metadata.nextSteps` when follow-up inspection would help.
- **Design-to-code specialization:** `figma_get_implementation_context` extracts fields, buttons, layout measurements, typography, colors, spacing, assets, and a React-friendly component hierarchy instead of simply relaying generic server output.
- **Safer local auth UX:** `figma_configure_auth` uses masked local prompting and stores the token in Pi auth storage. The model never sees the token.
- **Good raw escape hatches:** raw `figma_get_file` and `figma_get_nodes` tools are available for debugging, while tool descriptions steer agents toward processed tools first.
- **Local asset handling:** `figma_render_nodes` can download rendered images into an OS temp directory or a user-provided directory, which is useful for implementation and visual QA.
- **Broader inspection surface:** styles, variables, components, component sets, component search, metadata, text extraction, rendering, summaries, explanations, and implementation context are exposed as separate native tools.

## Tools

### Processed, LLM-ready tools (preferred)

- `figma_parse_url` — parse a Figma URL into `fileKey` and `nodeId`.
- `figma_render_nodes` — render node image URLs and optionally download assets locally. Downloads use an OS temp directory by default unless `outputDir` is provided.
- `figma_get_node_summary` — fetch a compact structured summary of a node: name, type, size, layout, spacing, visual style, visible text, component properties, and shallow child hierarchy.
- `figma_extract_text` — return visible text nodes only.
- `figma_explain_node` — explain a node in Markdown using summary, visible text, hierarchy, and optional rendered asset.
- `figma_get_implementation_context` — return coding-ready design context: purpose, sections, fields/buttons, measurements, typography, colors, spacing, assets, and component hierarchy.
- `figma_get_design_context` — fetch compact file context. With `nodeId`, returns target node summary plus location/sibling context; without `nodeId`, returns canvases and top-level frames only.
- `figma_get_node_metadata` — fetch compact spatial/layout metadata for one or more nodes.
- `figma_get_styles` — fetch named styles.
- `figma_get_variables` — fetch local variables/collections for design tokens.
- `figma_get_components` — fetch component metadata.
- `figma_get_component_sets` — fetch component set metadata.
- `figma_search_components` — search components by name or description.
- `figma_configure_auth` — securely prompt for and store a Figma token without exposing it to the model.

### Raw escape hatches

- `figma_get_file` — fetch raw Figma file JSON. Use only when raw Figma JSON is explicitly needed or when debugging the extension.
- `figma_get_nodes` — fetch raw node JSON. Use only when raw Figma JSON is explicitly needed or when debugging the extension.

The package also bundles the `figma` skill under `skills/figma/SKILL.md`.

## Recommended workflows

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

### Debugging raw Figma data

```text
figma_get_nodes
```

## Processed node options

Processed tools fetch nodes with compact depth limits and summarize safely:

```ts
{
  depth?: number; // default 2, capped at 4
  includeHidden?: boolean; // default false
  includeVectors?: boolean; // default false
  includeComponentInternals?: boolean; // default false
}
```

Defaults intentionally avoid hidden layers, vector internals, and huge component instance trees. Increase depth or include internals only for a focused child node.

## Output limits and truncation

Processed tools default to compact responses (~20k chars unless overridden by `maxResponseChars`) and cap common large arrays:

- visible text: 200 entries
- children: 100 entries
- depth: 4 max

When data is capped, responses include `metadata.truncated: true`, `truncatedReasons`, and `nextSteps` such as inspecting a child node or increasing depth.

## Authentication

The extension looks for a Figma token in this order:

1. in-memory token override created by `/figma-auth --force` or `figma_configure_auth`
2. `FIGMA_TOKEN` environment variable
3. `~/.pi/agent/auth.json` at `.figma.token`

If no token is found, or if Figma rejects the token as invalid/expired, the native tools can prompt you with a masked local dialog and store the replacement token without returning it to the model.

Do **not** paste tokens into an LLM chat.

### Recommended: native auth command

Run this in pi:

```text
/figma-auth --force
```

The command shows the Figma token URL and required scopes, prompts for the token with masked input, and writes it to `~/.pi/agent/auth.json` at `.figma.token`.

The same flow is available to the agent through the `figma_configure_auth` tool. That tool returns only metadata such as `stored: true`; it never returns the token.

### Option A: environment variable

For the current shell session:

```bash
export FIGMA_TOKEN="figd_xxx"
```

To persist it, add that export to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) or your preferred secrets manager.

### Option B: pi auth file

Create or update `~/.pi/agent/auth.json`:

```json
{
  "figma": {
    "token": "figd_xxx"
  }
}
```

Recommended file permissions:

```bash
mkdir -p ~/.pi/agent
chmod 700 ~/.pi/agent
chmod 600 ~/.pi/agent/auth.json
```

If the file already contains other credentials, merge the `figma.token` entry instead of overwriting the file.

## Creating a Figma token

1. Open Figma.
2. Go to **Settings → Security → Personal access tokens**.
3. Click **Generate new token**.
4. Name it something recognizable, for example `pi-agent`.
5. Enable the required scopes/permissions below.
6. Copy the token once and store it via `FIGMA_TOKEN` or `~/.pi/agent/auth.json`.

## Required scopes / permissions

This extension is read-only. It needs permission to read file content and render nodes.

Enable:

- **File content** / read access to files

Also make sure the token has access to the specific Figma file, project, or team you want to inspect. If your Figma organization supports resource scoping, grant access only to the minimum projects/files needed.

No write/admin scopes are required.

## Troubleshooting

### `Token expired`

Generate a new Figma personal access token and update `FIGMA_TOKEN` or `~/.pi/agent/auth.json`.

### Missing or inaccessible file

Confirm that:

- the file key is correct,
- the token has file-content read permission,
- the token owner can access the file in Figma,
- the node ID uses either URL format (`27399-4245`) or API format (`27399:4245`).
