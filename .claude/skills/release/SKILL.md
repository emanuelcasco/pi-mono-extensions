---
name: release
description: |
  Release a new version of pi-extensions: bump individual package versions (independent mode), update CHANGELOGs and READMEs, create per-package git tags, publish a GitHub release, and publish packages to npm via `pnpm release`.
  Use when the user asks to "cut a release", "release vX.Y.Z", "publish a new version", "create a release", or runs `/release`.
---

# Release Skill — pi-extensions

Cut a new release for the pi-extensions monorepo. The repo uses **changesets** with **independent versioning** — each package under `extensions/*` versions independently based on its own unreleased changes. Releases are pushed **directly to `main`** — no PRs.

## Repo facts (load-bearing)

- Versioning tool: `@changesets/cli` (config in `.changeset/config.json`)
- Versioning mode: **independent** — `fixed` array is empty; each package tracks its own version
- Tag format: per-package tags like `pi-mono-team-mode@X.Y.Z` (created by changesets publish)
- GitHub repo: `emanuelcasco/pi-mono-extensions`
- Publish script: `pnpm release` (runs `changeset publish`)
- npm publish requires being logged in (`npm whoami` should return a username); if it fails with auth errors, stop and tell the user to run `npm login`

## Workflow

### 1. Gather context

Run in parallel:

```bash
git status -sb
git tag --sort=-v:refname | head -20
gh release list --limit 5
git log --oneline $(git tag --sort=-v:refname | head -1)..HEAD
ls extensions/
cat .changeset/config.json
```

For each extension, also collect its current version:

```bash
for d in extensions/*/; do echo "$(basename $d): $(cat $d/package.json | jq -r .version)"; done
```

From this, determine:

- **Per-package current versions** — read from each `extensions/*/package.json`
- **Latest tag** — first matching `pi-mono-*@X.Y.Z`
- **Unreleased commits** — what's landed since the last tag
- **Which packages have changes** — use `git log <last-tag>..HEAD --name-only` to identify which `extensions/*/` directories have unreleased commits
- **Per-package bump type** — for each package with changes, infer from commit messages touching that package:
  - `feat:` → minor
  - `fix:` / `chore:` / `refactor:` → patch
  - Breaking change (`!` or `BREAKING CHANGE`) → major
- **Working tree clean?** — if not, ask the user before proceeding

Display a summary table:

```
| Package              | Current | Bump     | New      | Unreleased |
|----------------------|---------|----------|----------|------------|
| pi-mono-team-mode    | 1.6.0   | minor    | 1.7.0    | 2 commits  |
| pi-mono-clear        | 0.3.1   | patch    | 0.3.2    | 1 commit   |
| pi-mono-loop         | 0.2.0   | —        | 0.2.0    | 0 commits  |
| pi-mono-status-line  | 0.1.4   | minor    | 0.1.5    | 3 commits  |
```

Only packages with unreleased changes need a version bump. Untouched packages stay at their current version.

Use `AskUserQuestion` to confirm the target versions per package before doing anything destructive.

### 2. Bump versions

In independent mode, only packages with changes get bumped. For each package that needs a bump:

1. Update `"version"` in its `extensions/<name>/package.json`
2. Create a changeset file if it doesn't already exist — OR bump directly (follow the convention of past releases; check `git show $(git tag --sort=-v:refname | head -1) --stat`)

Direct bump approach (matching past workflow):

```bash
# For each package that needs bumping, edit its package.json version field
```

Sanity check after editing:

```bash
grep -r '"version"' extensions/*/package.json
```

Each package should show its intended version.

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
2. **Only** update CHANGELOGs for packages that have unreleased changes. Packages with no changes retain their existing CHANGELOG (no new section added).
3. For each changed package, prepend a new `## X.Y.Z` section with grouped bullets matching the bump type.
4. Group bullets by sub-heading: `### New Extension`, `### Enhanced: <name>`, `### Bug Fixes`, `### Documentation`. Match the tone of recent entries — terse, technical, focused on user-visible impact, not commit-message regurgitation.

### 4. Update READMEs (only when needed)

READMEs only need updating when:

- A new extension was added → add it to the root `README.md` extension list
- An extension was removed → remove it from the root `README.md`
- A user-facing behavior changed (keyboard shortcut, command name, public API) → update that extension's `README.md`

Don't touch READMEs for normal feat/fix releases. When in doubt, grep for the changed symbol/shortcut in `README.md` files and only edit if there's a stale reference.

### 5. Commit, tag, push

The release commit goes **directly to `main`** (per project convention).

Stage only the changed files:

```bash
git status   # sanity check before commit
git add extensions/*/package.json extensions/*/CHANGELOG.md README.md extensions/*/README.md
git commit -m "release: <summary of package bumps>"
```

Do **not** create a combined `vX.Y.Z` tag — publish (step 7) will create per-package tags automatically.

Push to main:

```bash
git push origin main
```

### 6. Create the GitHub release

Create a single release summarizing all package bumps:

```bash
gh release create "$(date +%Y%m%d%H%M)" --title "Release $(date +%Y-%m-%d)" --notes "$(cat <<'EOF'
## Packages

### pi-mono-team-mode — 1.6.0 → 1.7.0
- feat: description
- fix: description

### pi-mono-clear — 0.3.1 → 0.3.2
- fix: description

**Full Changelog**: https://github.com/emanuelcasco/pi-mono-extensions/compare/<prev-tag>...<new-tag>
EOF
)"
```

Build the notes from `git log <prev-tag>..HEAD --oneline` grouped by package. Use a timestamp-based tag since there's no combined `vX.Y.Z` — or use a monorepo release tag like `release-YYYYMMDD-N`. Check prior releases with `gh release list` to match the established convention.

### 7. Publish to npm

Before running, verify auth and show one final confirmation:

```bash
npm whoami    # should print a username; if not, stop and tell the user to `npm login`
```

Then use `AskUserQuestion` with the message:

```
About to publish the following packages to npm. This is irreversible — `npm unpublish` is heavily restricted within 72h and impossible after.

Packages to publish:
- pi-mono-team-mode@1.7.0
- pi-mono-clear@0.3.2
- pi-mono-status-line@0.1.5

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
- Creates per-package git tags like `pi-mono-team-mode@X.Y.Z`

After publish succeeds, push the per-package tags:

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
Release complete — packages published:

- pi-mono-team-mode → 1.7.0
  https://www.npmjs.com/package/pi-mono-team-mode

- pi-mono-clear → 0.3.2
  https://www.npmjs.com/package/pi-mono-clear

GitHub release: https://github.com/emanuelcasco/pi-mono-extensions/releases/tag/<tag>
Per-package tags pushed.
```

## Safety guards

- **Never push `--force`** to `main`.
- **Always confirm before `pnpm release`** — npm publish is effectively irreversible. The version-bump confirmation in step 1 does NOT cover the publish step; ask again right before running it.
- **Never amend a release commit after pushing.** If you need to fix something, cut a follow-up patch release.
- **Confirm the version bumps** with `AskUserQuestion` before editing any file — getting versions wrong is expensive to undo.
- **Don't open a PR** for the release commit. This repo pushes release commits straight to `main`.
- **Stage files explicitly** — never `git add -A` (could pick up unrelated WIP).
- **Untouched packages stay at their current version** — only bump packages with unreleased changes.
- **No combined `vX.Y.Z` tag** — per-package tags are created by `changeset publish`. Use a date-based or summary tag for the GitHub release.

## Quick reference — past releases

```bash
# Inspect how the previous release was structured
git show $(git tag --sort=-v:refname | head -1) --stat
cat extensions/team-mode/CHANGELOG.md   # canonical changelog format
```
