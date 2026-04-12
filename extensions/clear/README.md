# clear extension

Adds a `/clear` command that starts a fresh pi session, similar to the built-in `/new` command.

## Usage

```text
/clear
```

## Keyboard shortcut

```text
Ctrl+Shift+L
```

The shortcut sends `/clear` as a command. If the agent is busy, it is delivered as a follow-up so the current turn can finish first.

## Behavior

When `/clear` runs, the extension:

1. waits for the agent to become idle if needed
2. starts a new session
3. shows a warning if the new-session request is cancelled
4. shows an error notification if clearing fails

This makes it a convenient "start fresh" action without manually typing `/new`.

## Notes

- `/clear` is intentionally lightweight and just wraps pi's session reset behavior
- if no UI is available, the keyboard shortcut does nothing
- the command itself works without needing the shortcut

## Files

- `index.ts` — extension entry point
- `package.json` — package metadata
- `CHANGELOG.md` — release history
