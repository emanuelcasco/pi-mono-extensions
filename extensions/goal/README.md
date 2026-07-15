# pi-mono-goal

Codex-style session goals for pi.

The extension adds a persistent `/goal` command, model tools, hidden goal steering, bounded auto-continuation, usage accounting, and a small status/widget UI.

## Usage

```text
/goal migrate TargetTracking to features
/goal show
/goal edit migrate TargetTracking and update imports
/goal update moved components; next run tests
/goal pause
/goal resume
/goal auto on
/goal budget turns 10
/goal done implemented and tested
/goal clear
```

Modes:

- `manual`: persist and display the goal only.
- `assist`: inject hidden goal steering on user turns.
- `auto`: assist mode plus bounded automatic continuation after `agent_end`.

Auto mode defaults to 10 assistant turns and 30 minutes unless overridden.

## Tools

- `get_goal` — inspect current goal, progress, budgets, accounting, and optional history.
- `create_goal` — create/formalize a goal, optionally replacing an active goal.
- `update_goal` — update progress, next action, plan, blockers, status, mode, and budgets.

## Persistence

Goal state is append-only in Pi session custom entries (`goal-event`), so it survives reload/resume and follows the active conversation branch.
