---
name: ship
description: Commit, push, and open a PR/MR
metadata:
  triggers:
    - /ship
    - /dev:ship
  argument-hint: "[--branch <name>] [--issue <url>]"
  allowed-tools:
    - "Bash(git checkout --branch:*)"
    - "Bash(git add:*)"
    - "Bash(git status:*)"
    - "Bash(git push:*)"
    - "Bash(git commit:*)"
    - "Bash(gh pr create:*)"
    - "Bash(glab mr view:*)"
    - "Bash(glab mr list:*)"
    - "Bash(glab mr update:*)"
  model: claude-haiku-4-5
---

## Usage

`ship [--branch <name>] [--issue <url>]`

## Variables

- `--branch <name>`: (Optional) Branch name to use. Defaults to current branch, or if an issue was provided will use the issue id.
- `--issue <url>`: (Optional) Linear issue link to reference in commit and PR/MR.

## Workflow

1. Understand the context:
   a. Current git status: !`git status`
   b. Current git diff (staged and unstaged changes): !`git diff HEAD`
   c. Current branch: !`git branch --show-current`

2. (If `--branch` specified and different from current, or if `--issue` provided and branch doesn't match) Create or checkout the branch. NEVER commit nor push on `master` or `main`.

3. Stage all changes with `git add -A`

4. Generate commit message, branch name, and PR/MR details (unless overridden via flags)

5. Create commit following the Naming Conventions below

6. Push branch to origin with `-u` flag

7. Create PR/MR following the PR Description Template below

## Naming Conventions

### Branch Name Format

```
{ticket-id?}-{type}-{short-description}
```

- Use ticket ID from `--issue` if provided (e.g., `BLU-1234-feat-add-login`)
- Omit ticket if not specified (e.g., `wat-nnn-fix-resolve-timeout`)
- Use kebab-case for description
- Keep description short (3-5 words max)

### Commit Message Format

```
{type}({section?}): {ticket-id?} {description}
```

**Rules:**

- Always use conventional commits
- Omit `(section)` if unclear or not applicable
- Omit `ticket-id` if not specified via `--issue`
- Description: imperative mood, no trailing period, single line
- Commit body: detailed explanation, end with `Refs: <issue>` when issue provided

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

**Section Abbreviations** (derive from directory structure to avoid leaking domain info):

**Heuristic:**

1. Use the **top-level directory** name where most changes occur
2. Apply abbreviation rules:
   - Single word → first 2-4 chars (e.g., `auth`, `api`, `test`)
   - Compound words → initials (e.g., `user-management` → `um`)
   - Common terms keep standard abbrevs: `db`, `ui`, `infra`, `api`, `auth`, `test`
3. If unclear or spans multiple areas → omit section entirely

**Common mappings (generic):**
| Pattern | Abbreviation |
|---------|--------------|
| `src/auth/*`, `**/security/*` | auth |
| `src/api/*`, `**/routes/*` | api |
| `**/db/*`, `**/models/*`, `**/migrations/*` | db |
| `src/components/*`, `**/ui/*`, `**/views/*` | ui |
| `infra/*`, `**/deploy/*`, `**/k8s/*` | infra |
| `tests/*`, `**/*.test.*`, `**/*.spec.*` | test |
| Other directories | first initials of dir name |

**Examples:**

- `feat(tt): BLU-1234 add watershed filter`
- `fix(ub): resolve invoice parsing error`
- `refactor(api): simplify auth middleware`
- `chore: update dependencies`

### PR/MR Title Format

```
{type}: {ticket-id?} {description}
```

- Include ticket ID only if branch corresponds to a Linear issue
- Otherwise use: `{type}: {description}`
- Match the commit message type

**Examples:**

- `feat: BLU-1234 Add watershed filtering to target tracking`
- `fix: Resolve authentication timeout issue`

## PR Description Template

```markdown
## Summary

{1-2 sentence paragraph explaining what changed and why}

## Related Issues

- {Linear issue URL if provided, otherwise omit this section}

## Changes

- {Bullet point 1}
- {Bullet point 2}
- {Bullet point 3}

## Additional Notes

- {Optional notes, omit section if empty}

## Evidences

- {Screenshots, logs, or test results - omit section if empty}

## Checklist

- [x] Code follows guidelines
- [x] Documentation updated
- [x] Unit tests covered
```

**Description Rules:**

- Summary: high-level explanation of intent, not a list of files changed
- Changes: concrete bullet entries of functional changes
- Notes/Evidences: include only when relevant, omit sections otherwise
- Checklist: mark docs/tests as checked only when clearly covered

## Instructions

- Never commit nor push from master/main unless explicitly specified.
- If no staged changes detected, abort with error.
- If no remote 'origin' configured, create commit locally and skip push/PR creation.
- When generating branch name from issue, extract ticket ID (e.g., BLU-1234) and derive short description from issue title.

## Git Rules

- **NEVER** commit directly to `main` or `master`
- **NEVER** push to `main` or `master`
- Always create a feature branch before committing
- Always use PRs/MRs to merge changes into main

## Examples

- `/ship --branch BLU-2218-add-filter --issue https://linear.app/team/issue/BLU-2218`
  - Commits with `feat(tt): BLU-2218 add watershed filter`, pushes, creates PR titled `feat: BLU-2218 Add watershed filter`

- `/ship` (no flags, on branch `BLU-999-parsing-bug`)
  - Auto-generates: `fix(ub): BLU-999 resolve invoice parsing`

## Output

```plain
MR: <MR_LINK>
Title: <MR_TITLE>
```
