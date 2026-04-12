# status-line extension

Configurable footer with two modes: **basic** (default) and **expert**.

## Modes

### Basic (default)

Original two-line layout with token stats.

```
~/my-project (main)
↑582k ↓44k R7.0M W470k $6.918 24.0%/1.0M         claude-opus-4-6 • high
```

### Expert

Rich footer with visual context gauge, enhanced git status, and subscription usage indicators.

Layout:

```
gpt-5.4 (high) - ◔ 14% (38k/272k $0.33)
🗀 ~/my-project  ⎇ main * ↑2
Codex > 5h ◑ 46% 2h38m > Week ○ 12%
```

Features:

- **Git status** — branch name, dirty indicator (`*`), ahead/behind arrows (`↑2 ↓1`)
- **Context gauge** — pie icon (`○ ◔ ◑ ◕ ●`) with color thresholds (green → yellow → red)
- **Session cost** — running `$` total next to the gauge
- **Subscription usage** — rate-limit progress icons for Claude Max, Codex, Copilot, and Gemini (auto-detected from the active provider, refreshed every 5 min)
- **Status-first layout** — model, current status, and context appear on the first line; cwd/git move to their own line for visibility

## Configuration

Mode is resolved in this order (first hit wins):

1. `PI_STATUS_LINE_MODE` environment variable
2. `~/.pi/agent/status-line.json` → `{ "mode": "basic" | "expert" }`
3. default: `basic`

### Use cases

#### 1. Persistent mode across all sessions (config file)

Best for: setting your preferred mode once and forgetting about it.

```bash
echo '{ "mode": "expert" }' > ~/.pi/agent/status-line.json
```

Lives alongside pi's other config files (`auth.json`, `keybindings.json`, `models.json`). Survives shell restarts, applies to every terminal, and is independent of your shell profile.

#### 2. One-off override for a single session (env var inline)

Best for: trying out expert mode without committing, or temporarily switching back to basic while debugging.

```bash
PI_STATUS_LINE_MODE=expert pi
```

Only affects the pi invocation on that line. Your config file default stays untouched.

#### 3. Shell-scoped default (env var in shell profile)

Best for: per-machine or per-shell preferences, or sharing dotfiles across machines where you don't want to manage `~/.pi/agent/` on each.

```bash
# ~/.zshrc or ~/.bashrc
export PI_STATUS_LINE_MODE=expert
```

Takes precedence over the config file, so it's useful on a shared machine where you want your shell to override whatever is in `~/.pi/agent/`.

#### 4. Revert to basic mode

Either delete the config file, unset the env var, or explicitly set basic:

```bash
# remove persistent config
rm ~/.pi/agent/status-line.json

# or explicitly write basic
echo '{ "mode": "basic" }' > ~/.pi/agent/status-line.json

# or one-off
PI_STATUS_LINE_MODE=basic pi
```

## Files

- `index.ts` — entry point (mode selector)
- `basic.ts` — basic mode implementation
- `expert.ts` — expert mode implementation
