# pi-mono-figma

## 0.2.0

### Minor Changes

### Added: LLM-ready Figma workflow

- Added `figma_get_node_summary`, `figma_extract_text`, `figma_explain_node`, and `figma_get_implementation_context` processed tools.
- Added compact node summarization that ignores hidden nodes, vector internals, and component instance internals by default.
- Changed `figma_get_design_context` to return compact top-level file context or target-node summaries instead of full recursive file structure.
- Updated tool descriptions, README, and skill guidance to prefer processed tools and keep raw JSON tools as debugging escape hatches.
- Added response caps, truncation metadata, and next-step suggestions for summarized node output.

### Added: Dev Mode parity helpers

- Added golden fixture tests for Figma summarization and design-to-code helper behavior.
- Added `figma_find_nodes_by_name` and `figma_find_nodes_by_text` for compact path-aware layer/text search.
- Enriched `figma_get_implementation_context` with CSS layout, responsive, accessibility, design token, framework, and starter snippet hints.
- Added `figma_extract_assets` for SVG/icon exports, node renders, image fill downloads, hashes, byte sizes, suggested names, and node-path manifests.
- Added `figma_find_code_connect_mapping` for bounded local Code Connect/Figma reference discovery.
- Added `figma_get_component_implementation_hints` for higher-level component implementation guidance.
- Documented live selection parity as future plugin/bridge work rather than a REST baseline feature.

## 0.1.2

### Patch Changes

### Fixed: package extension entrypoint

- Added the package root `index.ts` extension entrypoint so pi can load the Figma tools from the published package manifest.
- Documented the extension's benefits over Figma MCP in the package README.

## 0.1.1

### Patch Changes

### Enhanced: auth setup

- Added `/figma-auth` command and `figma_configure_auth` tool for masked local token capture.
- Figma tools now prompt for a fresh token and retry once when auth is missing, invalid, or expired.
- Token setup writes to `~/.pi/agent/auth.json` without returning the token to the model.

## 0.1.0

### Minor Changes

### New Extension: figma

- Added native Figma REST API tools for file, node, styles, variables, components, component sets, component search, design-context, URL parsing, metadata, and node rendering workflows.
- Added bundled `figma` skill that explains when and how to use the native `figma_*` tools.
- Added authentication support via `FIGMA_TOKEN` and `~/.pi/agent/auth.json` at `.figma.token`.
- Added README documentation for token creation, required Figma file-content read scope, and setup/troubleshooting.
