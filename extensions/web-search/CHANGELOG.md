# pi-mono-web-search

## 0.1.0

### Added

- Initial release with `web_search` and `web_read` tools.
- DuckDuckGo search via native Node.js fetching and HTML parsing.
- Page reading with native Node.js fetching + Mozilla Readability (`@mozilla/readability`) extraction.
- Two-tier fallback for HTML extraction: Readability → regex strip.

### Changed

- Removed external `ddgr` and `curl` binary requirements.

### Fixed

- (Pre-release)
