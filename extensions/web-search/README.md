# pi-mono-web-search

Pi extension for web search and page reading using DuckDuckGo and Mozilla Readability extraction.

## Installation

This extension is part of the `pi-extensions` monorepo. It is auto-discovered when the monorepo is loaded.

### Prerequisites

No external system tools are required. Search and page fetching use the Node.js runtime built into pi.

## Tools

### `web_search`

Search the web using DuckDuckGo. Returns titles, URLs, and content snippets for each result.

| Parameter          | Type     | Required | Default | Description                      |
| ------------------ | -------- | -------- | ------- | -------------------------------- |
| `query`            | `string` | ✅       | —       | Search query string              |
| `maxResults`       | `number` | ❌       | `5`     | Maximum results (1–10)           |
| `maxResponseChars` | `number` | ❌       | —       | Truncate output before returning |

### `web_read`

Fetch a web page and extract its readable content.

| Parameter          | Type     | Required | Default | Description                            |
| ------------------ | -------- | -------- | ------- | -------------------------------------- |
| `url`              | `string` | ✅       | —       | Page URL (`http:` or `https:` only)    |
| `maxChars`         | `number` | ❌       | `8000`  | Maximum content characters (100–50000) |
| `maxResponseChars` | `number` | ❌       | —       | Truncate output before returning       |

## Security

- `web_read` validates URLs before fetching. Only `http:` and `https:` are allowed.
- Private/internal network addresses (`localhost`, `127.0.0.1`, `10.x.x.x`, `172.16.x.x`, `192.168.x.x`, `169.254.x.x`) are blocked.
- User input is never passed through a shell; the extension does not spawn subprocesses for search or page reads.

## Architecture

```
web-search/
├── index.ts                  # Extension entrypoint
├── package.json              # Package manifest
├── src/
│   ├── web-search-schemas.ts # TypeBox parameter schemas
│   ├── web-search-tools.ts   # Tool registration
│   └── web-search-client.ts  # Business logic, fetching, and parsing
├── skills/
│   └── web-search/
│       └── SKILL.md          # LLM skill instructions
└── __tests__/
    └── web-search.test.ts    # Unit tests
```

## Development

Run tests:

```bash
npm test
```

## Limitations

- No JavaScript execution — SPAs may return incomplete content.
- PDFs and other binary formats are not supported.
- DuckDuckGo may rate-limit aggressive querying.

## License

MIT
