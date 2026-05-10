# pi-mono-usage

## 0.1.1

### Patch Changes

- Add a Tools view grouped by currently registered extension ownership, with expandable per-tool breakdowns sorted by usage.
- Replace Last Week with This Month and show the active period date range in the header.
- Tighten sustainability copy, show a single random equivalence, and simplify the grid/profile label.

## 0.1.0

### Initial release

- `/usage` command renders an inline dashboard over local pi session files.
- Three views: Summary (with sustainability impact), Providers (table with model expansion), Patterns (cost-driver insights).
- Period selector for Today / This Week / Last Week / All Time.
- Sustainability impact powered by `impact-equivalences` (electricity, carbon, real-world equivalences).
- Tabular layout adapts to terminal width (full → compact → minimal).
