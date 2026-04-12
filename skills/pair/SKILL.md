---
name: pair
description: Pair programming workflow for structured implementation. Creates or updates one implementation plan document, plans implementation phases, executes them, and amends plans when reality diverges.
allowed-tools: Bash(mkdir:*) Read
assets:
  - ./assets/implementation-plan.template.md
metadata:
  triggers:
    - /pair
    - /dev:pair
    - /dev:pair init
    - /dev:pair brainstorm
    - /dev:pair research
    - /dev:pair plan
    - /dev:pair act
    - /dev:pair amend
  argument-hint: <init|brainstorm|research|plan|act|amend> [plan_file] [extra_instructions]
---

# Pair Programming: Research-Plan-Act Workflow

A structured approach to software development that separates **specification** (what), **planning** (how), and **execution** (do), centered on a single implementation plan document.

## Mandatory Initialization

The workflow always operates on one implementation plan document.

1. Resolve the implementation plan path from explicit input or Path Defaulting Logic.
2. Read the implementation plan document at that path.
3. If the file does not exist, create it from the `./assets/implementation-plan.template.md` asset before any stage-specific work.
4. Initialization is mandatory for every entry point (`/dev:pair init`, `/dev:pair brainstorm`, `/dev:pair research`, `/dev:pair plan`, `/dev:pair act`, `/dev:pair amend`).
5. `/dev:pair research` and `/dev:pair brainstorm` are valid workflow entry points and must auto-initialize when starting from scratch.

## Stages

| Command                | Purpose                                              | Stage value  | Reference file                   |
| ---------------------- | ---------------------------------------------------- | ------------ | -------------------------------- |
| `/dev:pair init`       | Scaffold empty implementation plan (no research)     | `Init`       | `./references/010-init.md`       |
| `/dev:pair brainstorm` | Iteratively refine a vague idea into context + goals | `Brainstorm` | `./references/011-brainstorm.md` |
| `/dev:pair research`   | Initialize/enrich implementation plan context        | `Research`   | `./references/020-research.md`   |
| `/dev:pair plan`       | Add detailed phases/steps to implementation plan     | `Plan`       | `./references/020-plan.md`       |
| `/dev:pair act`        | Execute the implementation plan                      | `Act`→`Done` | `./references/030-act.md`        |
| `/dev:pair amend`      | Update implementation plan to match actual work      | `Amend`      | `./references/040-amend.md`      |

**Routing:**

Reference files are loaded on-demand — only the file for the active stage is read. Do **NOT** pre-load other stage files.

1. Resolve and initialize the implementation plan document (if missing).
2. Read **only** the reference file for the invoked stage (from the table above) using the `read` tool with the path from the table above, relative to this skill's directory.
3. Follow the reference file's instructions for that stage.

**Stage tracking:** The implementation plan document tracks its current stage via the `Stage:` header field. At the beginning of each stage, update both `Stage:` and `Last Updated:` before doing any other work. When `/dev:pair act` finishes all phases successfully, set stage to `Done`.

### Lifecycle

```
/dev:pair init
  → Init
  → Research      (/dev:pair research)
  → Plan            (/dev:pair plan)
  → Act & Validate    (/dev:pair act)
  → Done
/dev:pair brainstorm
  → Brainstorm (auto-init if missing)
  → Research / Plan (next step chosen by user)
Direct entry:
  /dev:pair research
  → (auto-init if plan is missing)
  → Research
Amend loop:
  Act → Amend (/dev:pair amend) → Act
```

**Transitions:**

- **Happy path:** Init → Research → Plan → Act → Done
- **Brainstorm entry path:** Brainstorm (auto-init if missing) → Research → Plan → Act → Done
- **Skip research via brainstorm:** Brainstorm → Plan (when solution is clear after ideation)
- **Research entry path:** Research (auto-init if missing) → Plan → Act → Done
- **Skip research:** Init → Plan (when context is already known)
- **Amend loop:** Done → Amend → Plan (when implementation diverged, re-plan and re-execute)
- **Re-plan:** Plan ↔ Act can cycle if phases need revision during execution

## Path Defaulting Logic

**Path Format**: `<domain-folder>/specs/<YYYY>/<MM>/<TICKET>/<NNN>-<title>.md`

Example: `services/billing/specs/2025/01/BILL-123/001-invoice-refactor.md`

### Domain Detection Heuristic (priority order)

1. **Explicit path**: User provides domain → use it directly
2. **Repository-specific patterns**: Apply known domain patterns by repository
3. **Git branch extraction**: Parse branch name for component
   - `feat/billing-invoices` → `services/billing`
   - `fix/ui-button-variant` → `packages/ui`
4. **Affected files analysis**: Find common ancestor of files being modified
   - Working on `services/billing/src/*.ts` → domain = `services/billing`
5. **Recent spec history**: Check git log for spec paths on current branch
   ```bash
   git log --oneline --all --name-only | grep -E "specs/.*\.md$" | head -5
   ```
6. **Root fallback**: Use `specs/` at project root if:
   - Domain is unclear or generic
   - Cross-cutting concern (affects multiple domains)
   - Infrastructure/config changes

### Filename Components

| Component | Source                         | Example       |
| --------- | ------------------------------ | ------------- |
| `YYYY`    | Current year                   | `2025`        |
| `MM`      | Current month                  | `01`          |
| `TICKET`  | Ticket ID from branch/input    | `BILL-123`    |
| `NNN`     | Sequence number (001, 002...)  | `001`         |
| `title`   | Kebab-case summary (≤30 chars) | `invoice-fix` |

## Feedback Block System

Feedback blocks enable iterative refinement between stages.

### Syntax

```markdown
<!-- FEEDBACK: section_name
[Questions, concerns, or feedback]
Status: OPEN | ADDRESSED | RESOLVED
-->
```

### Status Definitions

| Status      | Meaning                             | Next Action                |
| ----------- | ----------------------------------- | -------------------------- |
| `OPEN`      | New feedback requiring attention    | Process in next stage      |
| `ADDRESSED` | Response provided, awaiting confirm | User reviews response      |
| `RESOLVED`  | Incorporated and closed             | Remove from final document |

### Processing Guidelines

- **Research stage**: Create OPEN blocks for ambiguities
- **Plan stage**: Process OPEN blocks, mark ADDRESSED
- **Act stage**: Reference decisions, mark RESOLVED after implementation
- **Remove** RESOLVED blocks from final document

## Best Practices

1. **Initialization is never optional** - Always read/create the implementation plan document before stage work
2. **Don't skip core stages** - Research → Plan → Act is the happy path (use `/dev:pair init` to skip research when context is already known)
3. **Use amend liberally** - Reality always diverges; document it
4. **Surface questions early** - Use `ask_user_question` in research/plan stages
5. **Keep phases self-contained** - Each phase should leave system working
6. **Track progress live** - Update checkboxes as you complete steps

## Team Mode

All `/dev:pair` stages support a `--team-mode` flag for parallelization, specialization, and bias-free verification.

When `--team-mode` is passed, read `./references/100-team-mode.md` using the `read` tool and follow the instructions for the current stage. Do **NOT** read it unless `--team-mode` is explicitly present in the invocation.

Teams always persist across stages — created on the first `--team-mode` invocation and cleaned up when the workflow reaches `Done`.

## Examples

```bash
# Quick-start: scaffold empty implementation plan without research
/dev:pair init "Add retry logic to the payment webhook handler"
# → creates implementation plan with improved objectives, empty phases → ready for /dev:pair plan

# Quick-start with explicit path
/dev:pair init "Migrate user table to new schema" --path services/users/specs/2025/01/USR-789/001-schema-migration.md

# Start with a vague idea — iterate until context and goals are clear
/dev:pair brainstorm "Users are complaining about the dashboard being slow"
# → asks: which dashboard? which users? what counts as slow? what's acceptable?
# → produces: context + refined objectives, no solution yet
# → suggests: /dev:pair research or /dev:pair plan

# With explicit path
/dev:pair brainstorm "Something about improving water alerts" --path services/alerts/specs/2026/02/ALERT-99/001-improve-alerts.md

# Start workflow directly from research (auto-initializes plan if missing)
/dev:pair research "Add user authentication with OAuth"
# → creates: services/auth/specs/2025/01/AUTH-456/001-oauth-login.md

# With team mode: parallel ticket fetch + codebase exploration via shared task list
/dev:pair research AUTH-456 --team-mode

# Complete the plan after review
/dev:pair plan services/auth/specs/2025/01/AUTH-456/001-oauth-login.md

# With team mode: get architecture review before implementing
/dev:pair plan services/auth/specs/2025/01/AUTH-456/001-oauth-login.md --team-mode

# Execute implementation
/dev:pair act services/auth/specs/2025/01/AUTH-456/001-oauth-login.md

# With team mode: parallel steps + bias-free code review
/dev:pair act services/auth/specs/2025/01/AUTH-456/001-oauth-login.md --team-mode

# Update plan after implementation diverged
/dev:pair amend services/auth/specs/2025/01/AUTH-456/001-oauth-login.md --hint "Switched to JWT"
```
