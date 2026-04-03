# Extensions workspace

Each folder in this directory is now its own installable pi package.

This is a pnpm workspace monorepo (see `pnpm-workspace.yaml`).

## Install all extensions

```bash
pi install /Users/emanuelcasco/Projects/waterplan/pi-extensions
```

## Install a single extension

```bash
pi install /Users/emanuelcasco/Projects/waterplan/pi-extensions/extensions/btw
pi install /Users/emanuelcasco/Projects/waterplan/pi-extensions/extensions/multi-edit
pi install /Users/emanuelcasco/Projects/waterplan/pi-extensions/extensions/team-mode
```

You can also test one extension without installing it permanently:

```bash
pi -e /Users/emanuelcasco/Projects/waterplan/pi-extensions/extensions/btw/index.ts
```

## Packages

- `ask-user-question`
- `btw`
- `clear`
- `loop`
- `multi-edit`
- `review`
- `status-line`
- `team-mode`

## Workspace model

- The repository root remains an aggregate pi package that loads everything under `./extensions`.
- Each `extensions/<name>/` folder has its own `package.json` and can be installed independently.
- Uses pnpm workspaces (see `pnpm-workspace.yaml`), so run `pnpm install` at the root to install all dependencies.
