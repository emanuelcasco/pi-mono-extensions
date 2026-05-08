# usage extension

Adds a `/usage` slash command that reads your local pi session files, aggregates token spend, and renders an inline dashboard with three views.

## Install

```bash
pi install npm:pi-mono-usage
```

## Views

- **Summary** — totals, top providers, and an environmental footprint estimate (kWh, kg CO₂e, real-world equivalences) computed from [`impact-equivalences`](https://www.npmjs.com/package/impact-equivalences).
- **Providers** — per-provider table that expands into per-model rows. Includes session/call counts, cost, and token breakdown (input, output, cache).
- **Patterns** — cost-driver insights for the selected period: parallel sessions, oversized contexts, large uncached prompts, marathon sessions, and top-session concentration.

## Period selector

Tab between `Today`, `This Week`, `Last Week`, and `All Time`. Each period is computed once on open from the same parsed dataset, so cycling is instant.

## Keybindings

| Key               | Action                                 |
| ----------------- | -------------------------------------- |
| `Tab` / `←` / `→` | Cycle period                           |
| `v`               | Cycle view                             |
| `1` / `2` / `3`   | Jump to Summary / Providers / Patterns |
| `↑` / `↓`         | Move provider cursor (Providers view)  |
| `Enter` / `Space` | Expand / collapse a provider           |
| `q` / `Esc`       | Close the panel                        |

## Data source

Reads `~/.pi/agent/sessions/**/*.jsonl` (or `$PI_CODING_AGENT_DIR/sessions`). For each `assistant` message with a `usage` block, the extension records cost and token counts. Duplicate turns from branched session files are deduplicated by a fingerprint over timestamp + token counts.

## Sustainability estimate

The Summary view feeds the period's charged tokens (`input + output + cacheWrite`) into `impact-equivalences` `estimateAiImpact`, which returns electricity (kWh) and carbon (kg CO₂e) ranges along with formatted real-world equivalences (e.g. _"~X average US households for a day"_). Estimates are illustrative — see the package's source attribution for boundaries and assumptions.
