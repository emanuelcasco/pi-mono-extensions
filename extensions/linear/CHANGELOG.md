# pi-mono-linear

## 0.1.2

### Patch Changes

### Fixed: package extension entrypoint

- Added the package root `index.ts` extension entrypoint so pi can load the Linear tools from the published package manifest.

## 0.1.1

### Patch Changes

### Enhanced: auth setup

- Added `/linear-auth` command and `linear_configure_auth` tool for masked local API-key capture.
- Linear tools now prompt for a fresh key and retry once when auth is missing, invalid, or expired.
- Key setup writes to `~/.pi/agent/auth.json` without returning the key to the model.

## 0.1.0

### Minor Changes

### New Extension: linear

- Added native Linear GraphQL tools for workspace metadata, teams, issues, projects, workflow states, labels, users, comments, cycles, and documents.
- Added mutation tools for creating issues, updating issues, and creating comments.
- Added bundled `linear` skill that explains when and how to use the native `linear_*` tools.
- Added authentication support via `LINEAR_API_KEY` and `~/.pi/agent/auth.json` at `.linear.key`.
- Added README documentation for API key creation, required Linear read/write permissions, and setup/troubleshooting.
