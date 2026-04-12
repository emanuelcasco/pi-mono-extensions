---
name: recap
description: Understand current context by analyzing git status, branch diff, and spec progress. Shows suggested next actions.
metadata:
  triggers:
    - /recap
    - /dev:recap
  argument-hint: "[spec_path?]"
---

# /recap - Context Recovery and Progress Summary

GOAL: Understand the current state of work by analyzing git status, branch diff, and spec progress.

## Variables

SPEC_PATH=$ARGUMENTS OR last used spec path (optional)

## Workflow

### 1. Git Context

```bash
# Current branch
git rev-parse --abbrev-ref HEAD

# Recent commits on this branch (vs main)
git log --oneline main..HEAD 2>/dev/null || git log --oneline -5

# Working tree status
git status --short

# Staged changes summary
git diff --cached --stat

# Unstaged changes summary
git diff --stat
```

### 2. Branch Diff Summary

```bash
# Files changed vs main
git diff --name-only main...HEAD 2>/dev/null | head -20

# Insertions/deletions summary
git diff --stat main...HEAD 2>/dev/null | tail -1
```

### 3. Find Active Spec

```
IF SPEC_PATH argument provided:
  → USE provided path

ELIF remembered spec path exists:
  → USE remembered path

ELSE:
  → SEARCH for recent specs:
    1. Check git log for spec commits on current branch
    2. Look for specs/ directory changes
    3. Search for .md files with spec template structure
  → IF found: USE most recent
  → IF not found: REPORT "No active spec detected"
```

### 4. Spec Progress (if spec found)

READ spec file and analyze:

```
## Spec Progress

**File**: {SPEC_PATH}
**Objective**: {First line of ## High-Level Objective}

### Stage Status
- [ ] CREATE - {check if file exists}
- [ ] RESEARCH - {check if ## Research has content}
- [ ] PLAN - {check if ## Plan > ### Tasks has tasks}
- [ ] IMPLEMENT - {check if ## Implement has content}
- [ ] TEST - {check if ## Test Evidence has content}
- [ ] REVIEW - {check if ## Post-Implement Review has content}

### Pending Work
{List uncompleted tasks from ## Plan if IMPLEMENT not done}
{List [ ] FEEDBACK: blocks if any}
```

### 5. Present Summary

```
## Current Context

### Git Status
**Branch**: {branch_name}
**Commits ahead of main**: {count}
**Working tree**: {clean/dirty}

### Recent Commits
{list of recent commits}

### Uncommitted Changes
{summary of staged + unstaged changes}

---

### Spec Progress
{spec progress section if spec found, or "No active spec"}

---

### Suggested Actions
{Based on current state, suggest next steps}

**Commands**:
- `/dev:pair research <description>` - Start new spec
- `/dev:pair plan` - Generate plan for current spec
- `/dev:pair act` - Execute current plan
```

## Behavior

- Local analysis only - no external API calls
- Keep output concise but comprehensive
- Highlight blocking issues (uncommitted changes, failing tests, pending feedback)
- Suggest logical next action based on current state
- If no spec active, focus on git status and suggest starting new spec if appropriate
