# Stage 4: Amend (`/dev:pair amend`)

**Purpose**: Update plan to document what was **actually implemented** when reality diverged from the original plan.

## Usage

```
/dev:pair amend [PLAN_FILE] [--base <branch>] [--hint <text>] [--team-mode]
```

**Options:**

- `--base <branch>` - Base branch for diff (default: main/master)
- `--hint <text>` - Context about why changes were made

## Workflow

1. **Gather Context**

   ```bash
   git diff BASE...HEAD              # Actual diff
   git diff --name-only BASE...HEAD  # Changed files
   git log BASE..HEAD --oneline      # Commit history
   ```

2. **Analyze Divergence**
   - Map planned changes → actual changes
   - Classify each step:
     - **Completed as planned**: Diff matches plan
     - **Modified**: Changed differently than planned
     - **Skipped**: Planned change not made
   - Identify unplanned changes

3. **Preview Changes**
   Present summary before modifying:

   ```markdown
   ## Amend Preview

   | Category             | Count |
   | -------------------- | ----- |
   | Completed as planned | X     |
   | Modified from plan   | X     |
   | Added (unplanned)    | X     |
   | Skipped              | X     |

   ### Significant Modifications

   - Phase X, Step Y: Changed from X to Y because Z
   ```

4. **Apply Changes** (after user approval)
   - Replace planned diffs with actual diffs
   - Update step descriptions
   - Add History section documenting changes

## History Section Format

```markdown
## History

### Amended: {{date}}

**Original Approach:**
[Summary of original plan]

**What Changed:**

- Phase 1, Step 2: Planned X → Actually did Y
- Phase 2: Added unplanned step for Z
- Phase 3, Step 1: Skipped (reason)

**Rationale:**
[Why implementation changed]
```

## Team Mode (`--team-mode`)

When `--team-mode` flag is passed, read the `./references/100-team-mode.md` asset and follow the instructions for the **Amend** stage.
