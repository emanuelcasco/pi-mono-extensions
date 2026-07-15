# pi-mono-provider-request-options

Pi extension that deep-merges provider-native request options from the active global `settings.json` into each serialized provider request.

## Installation

```bash
pi install npm:pi-mono-provider-request-options
```

## Configuration

Add `providerRequestOptions` to `~/.pi/agent/settings.json` (or the active agent directory):

```json
{
  "providerRequestOptions": {
    "openai-codex": {
      "text": {
        "verbosity": "low"
      }
    },
    "anthropic": {
      "metadata": {
        "user_id": "pi"
      }
    }
  }
}
```

Provider keys are exact and case-sensitive. Values are native wire-API fields; the extension does not validate or translate them. It reads the file for every provider request, so edits apply to the next request without `/reload`.

Plain objects merge recursively. Arrays, scalars, booleans, and `null` replace existing values. Configured values take precedence over Pi's serialized payload, while fields absent from the configuration remain unchanged.

Missing settings and missing, empty, or invalid provider entries are no-ops. Invalid JSON and an invalid top-level `providerRequestOptions` value produce one concise notification per distinct file content. Request payloads and configured values are never logged.

## Extension ordering

Pi runs `before_provider_request` handlers in extension load order. This extension sees changes from earlier handlers; later handlers see its merged payload and may override it.

## Development

```bash
pnpm --filter pi-mono-provider-request-options test
```
