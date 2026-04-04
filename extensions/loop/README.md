# loop extension

Runs a prompt or slash command on a recurring interval.

Adapted from the [`/loop` skill in claude-code](https://github.com/emanuelcasco/claude-code/blob/main/src/skills/bundled/loop.ts). The original relied on Claude Code's Kairos cron system; this version uses JS timers and `pi.sendUserMessage()` instead.

## Usage

```
/loop [interval] <prompt>
```

Intervals use a number followed by a unit suffix: `s` (seconds), `m` (minutes), `h` (hours), `d` (days). If no interval is given, it defaults to `10m`.

## Subcommands

| Command | Description |
|---|---|
| `/loop list` | Show all active loops with their IDs and fire counts |
| `/loop stop` | Cancel all active loops |
| `/loop stop <id>` | Cancel a specific loop by ID |

## Examples

```
/loop 5m /review
/loop 30m check the deploy
/loop 1h run the tests and report failures
/loop check the deploy            # defaults to 10m
/loop check the deploy every 20m  # trailing "every" clause
/loop list
/loop stop loop-1
/loop stop
```

## Interval parsing

Arguments are parsed using this priority order:

1. **Leading token** — if the first word matches `\d+[smhd]` it is the interval (e.g. `5m /review`)
2. **Trailing "every" clause** — if the input ends with `every <N><unit>`, that is the interval (e.g. `check the deploy every 20m`)
3. **Default** — no interval found; uses `10m` and the full input is the prompt

## Behaviour

- The prompt is **executed immediately** on the first invocation, then repeated at the given interval
- If the agent is busy when a timer fires, the next prompt is queued as a follow-up rather than interrupting the current turn
- Minimum interval is **10 seconds**
- Loops **auto-expire after 7 days**
- All timers are cleaned up on session shutdown

## Files

- `index.ts` — extension entry point
