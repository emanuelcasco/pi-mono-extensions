---
name: release
description: |
  Release a new version of pi-extensions: bump versions across all packages, update CHANGELOGs and READMEs, create and push the git tag, publish a GitHub release, and publish packages to npm via `pnpm release`.
  Use when the user asks to "cut a release", "release vX.Y.Z", "publish a new version", "create a release", or runs `/release`.
---

# Release Skill — pi-extensions

Cut a new release for the pi-extensions monorepo. The repo uses **changesets** with all extension packages **fixed-version** (they always bump together). Releases are pushed **directly to `main`** — no PRs.

## Repo facts (load-bearing)

- Versioning tool: `@changesets/cli` (config in `.changeset/config.json`)
- Fixed-version group: every `pi-mono-*` package under `extensions/*` shares the same version
- Tag format: `vX.Y.Z` (e.g., `v1.6.0`) — also auto-creates per-package tags like `pi-mono-team-mode@1.6.0`
- GitHub repo: `emanuelcasco/pi-mono-extensions`
- Publish script: `pnpm release` (runs `changeset publish`) — Claude runs it as the final step, gated by one confirmation since npm publish is irreversible
- npm publish requires being logged in (`npm whoami` should return a username); if it fails with auth errors, stop and tell the user to run `npm login`

## Workflow

### 1. Gather context

Run in parallel:

```bash
git status -sb
git tag --sort=-v:refname | head -10
gh release list --limit 5
git log --oneline $(git tag --sort=-v:refname | head -1)..HEAD
ls extensions/
cat .changeset/config.json
```

From this, determine:

- **Current version** — read from any `extensions/*/package.json` (they're all in sync via the fixed group)
- **Latest tag** — first entry of `git tag --sort=-v:refname` matching `vX.Y.Z`
- **Unreleased commits** — what's landed since the last tag
- **Bump type** — infer from commit messages:
  - `feat:` → minor
  - `fix:` / `chore:` / `refactor:` → patch
  - Breaking change (`!` or `BREAKING CHANGE`) → major
- **Working tree clean?** — if not, ask the user before proceeding

Display a summary table:

```
| Property        | Value                |
|-----------------|----------------------|
| Current version | 1.6.0                |
| Proposed bump   | minor → 1.7.0        |
| Unreleased      | 4 commits            |
| Tree clean      | yes                  |
```

Use `AskUserQuestion` to confirm the target version and bump type before doing anything destructive.

### 2. Bump versions

The fixed-version group means **every** `extensions/*/package.json` must move to the new version in one shot. Don't use `changeset version` here — past releases (see `git show 7ce1812`) bump the package.json files directly.

For each `extensions/*/package.json`, update the `"version"` field to the new version. Also update the root `package.json` if it tracks the version (it currently does **not** — root stays at `0.1.0`, leave it alone).

Sanity check after editing:

```bash
grep -r '"version"' extensions/*/package.json
```

All extension packages should show the new version.

### 3. Update CHANGELOGs

Each `extensions/*/CHANGELOG.md` follows this format (see `extensions/team-mode/CHANGELOG.md` for the canonical example):

```markdown
# pi-mono-<name>

## X.Y.Z

### Minor Changes (or "Patch Changes" / "Major Changes")

### Enhanced: <extension>

- bullet describing what changed in this extension

### New Extension: <name>

description if a brand-new extension was added

### Documentation

- doc-only changes
```

Strategy:

1. Read `git log <last-tag>..HEAD` and group commits by which `extensions/<name>/` paths they touched (use `git log --name-only` or `git diff --stat`).
2. For every extension that has changes since the last tag, prepend a new `## X.Y.Z` section to its CHANGELOG with grouped bullets.
3. For extensions with **no** changes, still prepend an empty `## X.Y.Z` section so the version history stays aligned across packages (this matches the fixed-group convention — check past changelogs to confirm before doing this; if past releases skipped untouched packages, follow that pattern instead).
4. Group bullets by sub-heading: `### New Extension`, `### Enhanced: <name>`, `### Bug Fixes`, `### Documentation`. Match the tone of recent entries — terse, technical, focused on user-visible impact, not commit-message regurgitation.

### 4. Update READMEs (only when needed)

READMEs only need updating when:

- A new extension was added → add it to the root `README.md` extension list
- An extension was removed → remove it from the root `README.md`
- A user-facing behavior changed (keyboard shortcut, command name, public API) → update that extension's `README.md`

Don't touch READMEs for normal feat/fix releases. When in doubt, grep for the changed symbol/shortcut in `README.md` files and only edit if there's a stale reference.

### 5. Commit, tag, push

The release commit goes **directly to `main`** (per project convention — see `memory/feedback_release_workflow.md`).

```bash
git add extensions/*/package.json extensions/*/CHANGELOG.md README.md extensions/*/README.md
git status   # sanity check before commit
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

If the working tree had unrelated changes at step 1, stage selectively — never `git add -A`.

### 6. Create the GitHub release

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
## What's Changed

- <feat/fix bullets pulled from commits between last tag and this one, with short SHAs>

**Full Changelog**: https://github.com/emanuelcasco/pi-mono-extensions/compare/v<prev>...vX.Y.Z
EOF
)"
```

Build the bullet list from `git log <prev-tag>..vX.Y.Z --oneline` — keep it concise, drop noise like `chore: release` commits.

### 7. Publish to npm

Before running, verify auth and show one final confirmation:

```bash
npm whoami    # should print a username; if not, stop and tell the user to `npm login`
```

Then use `AskUserQuestion` with the message:

```
About to publish vX.Y.Z to npm. This is irreversible — `npm unpublish` is heavily restricted within 72h and impossible after.

Packages to publish: <list of pi-mono-* package names from extensions/*>

Proceed?
```

Options: `Yes, publish` / `Cancel`.

On confirmation, run:

```bash
pnpm release
```

`pnpm release` invokes `changeset publish`, which:
- Reads each `extensions/*/package.json`
- Publishes any package whose version isn't already on the npm registry
- Creates per-package git tags like `pi-mono-team-mode@X.Y.Z` (the `vX.Y.Z` tag from step 5 is separate — both end up on the commit)

After publish succeeds, push the per-package tags too:

```bash
git push origin --tags
```

If publish fails partway (some packages published, others didn't), **do not retry blindly** — re-running `changeset publish` will skip already-published versions, but inspect the error first. Common failures:

- **401/403 from registry** → not logged in or no publish rights; run `npm login`
- **E409 / version exists** → a package was already published at this version; usually safe to ignore if it matches the intended version
- **Network/timeout** → safe to retry `pnpm release`

### 8. Final summary

Tell the user:

```
Release vX.Y.Z complete:

- GitHub release: https://github.com/emanuelcasco/pi-mono-extensions/releases/tag/vX.Y.Z
- npm: <list of published packages>
- Tags pushed: vX.Y.Z + per-package tags
```

## Safety guards

- **Never push `--force`** to `main`.
- **Always confirm before `pnpm release`** — npm publish is effectively irreversible. The version-bump confirmation in step 1 does NOT cover the publish step; ask again right before running it.
- **Never amend a release commit after pushing.** If you need to fix something, cut a follow-up patch release.
- **Confirm the version bump** with `AskUserQuestion` before editing any file — getting the version wrong is expensive to undo.
- **Don't open a PR** for the release commit. This repo pushes release commits straight to `main`.
- **Stage files explicitly** — never `git add -A` (could pick up unrelated WIP).
- **If the tag already exists locally but not on remote**, `gh release create` will fail with a clear message. Push the tag first with `git push origin vX.Y.Z`.

## Quick reference — past releases

```bash
# Inspect how the previous release was structured
git show $(git tag --sort=-v:refname | head -1) --stat
cat extensions/team-mode/CHANGELOG.md   # canonical changelog format
```
