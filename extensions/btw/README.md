# btw extension

This extension adds Claude Code-style ` /btw ` behavior to pi.

## Behavior

- intercepts `/btw <question>` through the input pipeline instead of a normal extension command
- starts a separate model request immediately
- does not queue the question into the main agent loop
- does not interrupt the current task
- renders answers in a passive widget below the editor while pi keeps working
- stores hidden history as custom session entries (`btw-history`)

## Why it is implemented this way

In pi, normal extension commands are checked before input expansion and are not the same as prompt templates or skills. To make `/btw` work while pi is already busy, this extension handles raw input that starts with `/btw` and launches its own background completion.

## Extra shortcut

- `Ctrl+Shift+B` asks the current editor text as a side question

## Files

- `index.ts` — extension entry point
