---
name: web-search
description: Search the web and read page content using native pi tools — DuckDuckGo search results, web page fetching, and Mozilla Readability extraction. No external system tools required.
---

# Web Search

Search the web and read page content using DuckDuckGo and Mozilla Readability extraction.

## Prerequisites

No external system tools are required. Search and page fetching use the Node.js runtime built into pi.

## Tools

### `web_search`

Search the web using DuckDuckGo. Returns titles, URLs, and content snippets.

**When to use:**

- The user asks to find information online
- Looking up documentation not available locally
- Verifying facts or looking up recent data

**Parameters:**

- `query` (string, required): Search query
- `maxResults` (number, optional, default 5, max 10): How many results to return
- `maxResponseChars` (number, optional): Truncate output to this many characters

**Guidelines:**

- Always follow up with `web_read` if the user needs full page content
- DuckDuckGo is used — no API key required
- Rate limits apply; avoid rapid repeated queries

### `web_read`

Fetch a web page and extract readable content.

**When to use:**

- You need the full content of a specific page
- Following up on a `web_search` result
- Reading documentation or articles

**Parameters:**

- `url` (string, required): Page URL (must be `http:` or `https:`)
- `maxChars` (number, optional, default 8000, max 50000): How many characters of content to return
- `maxResponseChars` (number, optional): Truncate output to this many characters

**Guidelines:**

- Works best on article/blog pages
- JavaScript-heavy SPAs may return limited content (no JS execution)
- Private/internal URLs (`localhost`, `127.0.0.1`, `169.254.x.x`, etc.) are blocked for security

## Limitations

- **No JavaScript rendering:** Pages that require JS to load content will return incomplete results.
- **HTML only:** PDFs or other binary formats are not supported.
- **DuckDuckGo rate limiting:** Aggressive querying may be throttled.
