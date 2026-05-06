# Future live-selection bridge

The current Figma extension is REST/API-based and read-only. It operates on explicit `fileKey` and `nodeId` values and does not receive live selection events from the Figma app.

A future live-selection workflow should be implemented as a separate bridge/plugin layer:

1. A Figma plugin reads the current page and selected node IDs.
2. A local bridge exposes that selection through localhost or Pi extension IPC.
3. A Pi tool such as `figma_get_current_selection` returns file key, page, selected node IDs, and optional render metadata.
4. Existing processed tools (`figma_get_node_summary`, `figma_get_implementation_context`, search, and asset extraction) run against those selected node IDs.

Non-goals for the REST baseline:

- no Figma file edits,
- no private APIs,
- no claim of live selection support until a plugin/bridge exists.
