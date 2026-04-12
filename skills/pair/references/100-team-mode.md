# Team Mode Reference

Consolidated reference for all team mode logic across the Research-Plan-Act workflow. When `--team-mode` is passed to any stage, follow this document.

## Overview

Teams always persist across stages. On the first `--team-mode` invocation, a team named `dev-{TICKET}` (e.g., `pair-AUTH-456`) is created. Subsequent stages reuse the same team — they read `config.json`, spawn new role-specific teammates, and leverage completed tasks from prior stages as context. The team is cleaned up when the workflow reaches Done.

## Team Lifecycle

1. **First stage creates the team** with name `dev-{TICKET}` via `TeamCreate`.
2. **Subsequent stages reuse the team** — read `config.json`, spawn new role-specific teammates.
   - Previous stage's teammates are already shut down, but team/task infrastructure persists.
   - New teammates can READ completed tasks from prior stages for context (e.g., Plan teammates read completed Research tasks from `TaskList`).
3. **Final stage (Act -> Done) tears down** — after all teammates shut down, call `TeamDelete` to clean up.
4. **Amend loop** — if Act transitions to Amend instead of Done, the team stays alive. Amend loops back to Plan, so the team persists until Act finally reaches Done.

**Cross-stage context via task list:**

- Research tasks marked `completed` remain visible to Plan teammates.
- Plan teammates read task descriptions + completion notes for context.
- Act teammates can read completed research + plan tasks for context.
- This replaces message-based handoff with persistent, queryable history.

## Complexity Gate

Before spawning a team, assess task complexity to decide team size:

| Signal                     | Points |
| -------------------------- | ------ |
| Files affected > 5         | +2     |
| Multiple domains/packages  | +2     |
| New architectural patterns | +2     |
| External API integration   | +1     |
| Database schema changes    | +1     |
| Ticket has sub-tasks       | +1     |

**Scaling rules:**

- **Score 0-2 (Simple):** No team mode. Lead handles solo.
- **Score 3-4 (Moderate):** Spawn only critical teammates (2-3).
  - Research: `pattern-scout` + `file-locator` only
  - Plan: `codebase-analyst` only
  - Act: no parallel executors, just bias-free `code-reviewer`
  - Amend: `diff-analyst` only
- **Score 5+ (Complex):** Full team as defined in the stage-specific sections below.

## Model Selection for Teammates

Route teammate models by role complexity to optimize cost:

| Complexity        | Model  | Examples                                              |
| ----------------- | ------ | ----------------------------------------------------- |
| Search/locate     | haiku  | `file-locator`, `ticket-fetcher`, `pattern-scout`     |
| Synthesize/review | sonnet | `spec-drafter`, `plan-reviewer`, `diff-analyst`       |
| Architect/design  | opus   | `solution-designer`, `code-reviewer`, `arch-designer` |

Each stage's teammate tables include a `Model` column. Always pass the `model` parameter when spawning via the `Task` tool.

## Custom Agent Mapping

When the user has custom agents in `~/.claude/agents/`, prefer them over generic agent types:

| Skill Role       | Default Agent Type  | Custom Agent (if exists)   |
| ---------------- | ------------------- | -------------------------- |
| Plan reviewer    | `code-reviewer`     | `code-reviewer` (custom)   |
| Code reviewer    | `code-reviewer`     | `code-reviewer` (custom)   |
| Codebase analyst | `codebase-analyzer` | `code-analizer` (custom)   |
| Post-act cleanup | --                  | `code-simplifier` (custom) |

**Detection:** At team setup, check `~/.claude/agents/*.md`. If a matching custom agent exists, use it as the `subagent_type`. The `code-simplifier` agent can run as an optional post-Act pass to refine code for clarity without changing behavior.

## Teammate Handoff Format

When a teammate completes a task and messages the next teammate, use structured formats:

**Research/analysis outputs:**

```markdown
## Findings: {task_name}

### Key Discoveries

- [discovery with file:line references]

### Relevant Files

- `path/to/file.ts` — [why it matters]

### Patterns Found

- [pattern name]: [where used, how it works]

### Open Questions

- [anything unresolved that needs human input]
```

**Review outputs:**

```markdown
## Review: {artifact_name}

### Verdict: PASS | PASS_WITH_NOTES | BLOCK

### Issues (if any)

| Severity | File | Issue | Suggestion |
| -------- | ---- | ----- | ---------- |

### Strengths

- [what's good about the artifact]
```

## Setup

Shared across all stages. Three steps:

1. **TeamCreate** (or reuse existing) — on the first stage, create team `dev-{TICKET}` via `Teammate` tool (`spawnTeam`). On subsequent stages, reuse the existing team by reading `config.json`.
2. **TaskCreate** for work items — create tasks with `addBlockedBy` to express dependencies between work items.
3. **Spawn teammates** via `Task` tool with `team_name` and `model` parameters.

## Coordination

Shared across all stages:

- Teammates claim tasks from the shared `TaskList`.
- Teammates message each other directly via `SendMessage` using the Teammate Handoff Format when findings affect other tasks.
- Orchestrator monitors via `TaskList` and synthesizes results when all tasks complete.

## Bias-Free Verification

Shared across all stages. Verification teammates only see **artifacts** (spec, plan, code), not your reasoning:

- No "sunk cost" bias from having written it.
- Catches: missed requirements, architectural drift, over-engineering.
- Honest feedback without social pressure.

## Search Limits & Escalation

Teammates have **max search attempts** to prevent endless searching:

| Teammate Name      | Max Searches | On Limit Reached                 | Stage(s) |
| ------------------ | ------------ | -------------------------------- | -------- |
| `file-locator`     | 3            | Ask user for path hints          | Research |
| `pattern-scout`    | 5            | Ask user to clarify what to find | Research |
| `codebase-analyst` | 3            | Ask user which files to analyze  | Plan     |
| `diff-analyst`     | 3            | Ask user which files to analyze  | Amend    |

**Escalation template** (used by all teammates when limit is reached):

```markdown
## Search Limit Reached

Could not locate [target] after N search attempts.

**Searches tried:**

1. `glob: **/auth/**/*.ts` → 0 results
2. `grep: "authentication"` → 47 results (too broad)
3. `glob: **/middleware/auth*` → 0 results

**Please provide:**

- Specific file path or directory
- Different search term to try
- Or confirm this doesn't exist yet
```

## Teardown

Shared across all stages:

1. Shut down all teammates via `SendMessage` with `shutdown_request`.
2. **If more stages remain** (Research -> Plan, Plan -> Act, or Amend -> Plan): only shut down teammates, keep team alive for the next stage.
3. **If this is the final stage** (Act -> Done): call `TeamDelete` to clean up the team.

---

## Stage: Research

Only the unique teammate tables and dependency graph. For shared logic (setup, coordination, bias-free verification, teardown), see the sections above.

Use the language server protocol (LSP) whenever available to ground all code understanding, navigation, refactoring, and fixes in real symbols, types, diagnostics, and project structure rather than inferred text.

### Task Assignments

**1.1: Gather Requirements (parallel):**

| Teammate Name    | Agent Type         | Model | Task                                                | Output           |
| ---------------- | ------------------ | ----- | --------------------------------------------------- | ---------------- |
| `ticket-fetcher` | `general-purpose`  | haiku | Fetch ticket from Linear/GitHub (if ticket ID)      | Requirements     |
| `pattern-scout`  | `Explore`          | haiku | Find patterns, conventions, similar implementations | Codebase context |
| `file-locator`   | `codebase-locator` | haiku | Locate existing specs, tests, docs in domain        | Related files    |

**1.2: Write Context & Objectives:**

| Teammate Name  | Agent Type        | Model  | Task                                        | Output     |
| -------------- | ----------------- | ------ | ------------------------------------------- | ---------- |
| `spec-drafter` | `general-purpose` | sonnet | Synthesize gathered data into spec sections | Spec draft |

**1.3: Propose Solution:**

| Teammate Name       | Agent Type        | Model | Task                                                | Output         |
| ------------------- | ----------------- | ----- | --------------------------------------------------- | -------------- |
| `solution-designer` | `general-purpose` | opus  | Design approach for complex architectural decisions | Solution draft |

**1.4: Surface Questions & Present:**

Orchestrator only — no delegation.

### Dependency Graph

```
TaskCreate: "Fetch ticket requirements"       → task-1
TaskCreate: "Scout codebase patterns"         → task-2
TaskCreate: "Locate domain files"             → task-3
TaskCreate: "Draft spec sections"             → task-4, addBlockedBy: [task-1, task-2, task-3]
TaskCreate: "Design solution approach"        → task-5, addBlockedBy: [task-4]
```

Tasks 1-3 run in parallel. Task 4 (`spec-drafter`) blocks until all three complete. Task 5 (`solution-designer`) blocks until the draft is ready.

---

## Stage: Plan

Only the unique teammate tables and dependency graph. For shared logic, see the sections above.

### Task Assignments

**During planning:**

| Teammate Name      | Agent Type          | Model  | Task                                        | Output               |
| ------------------ | ------------------- | ------ | ------------------------------------------- | -------------------- |
| `codebase-analyst` | `codebase-analyzer` | sonnet | Analyze each affected file's implementation | File-level context   |
| `arch-designer`    | `general-purpose`   | opus   | Design architecture for complex decisions   | Architecture options |

**Post-planning verification (bias-free):**

| Teammate Name   | Agent Type      | Model  | Task                                          | Output   |
| --------------- | --------------- | ------ | --------------------------------------------- | -------- |
| `plan-reviewer` | `code-reviewer` | sonnet | Review plan for gaps, risks, over-engineering | Feedback |

### Dependency Graph

```
TaskCreate: "Analyze affected files"          → task-1
TaskCreate: "Design architecture"             → task-2, addBlockedBy: [task-1]
TaskCreate: "Review plan (bias-free)"         → task-3, addBlockedBy: [task-2]
```

`codebase-analyst` runs first. `arch-designer` uses its file-level context. `plan-reviewer` sees the final plan only — no reasoning context (bias-free).

---

## Stage: Act

Only the unique teammate tables, dependency graph, and file ownership logic. For shared logic, see the sections above.

### Task Assignments

**During execution:**

| Teammate Name     | Agent Type        | Model  | Task                                  | Output                |
| ----------------- | ----------------- | ------ | ------------------------------------- | --------------------- |
| `step-executor-N` | `general-purpose` | sonnet | Execute independent steps in parallel | Faster implementation |

Each executor updates the spec file's checkboxes for their own steps only.

**Post-implementation verification (bias-free):**

| Teammate Name   | Agent Type      | Model | Task                                  | Output        |
| --------------- | --------------- | ----- | ------------------------------------- | ------------- |
| `code-reviewer` | `code-reviewer` | opus  | Review code against spec requirements | Issues to fix |

**Post-act cleanup (optional):**

| Teammate Name     | Agent Type        | Model  | Task                                            | Output       |
| ----------------- | ----------------- | ------ | ----------------------------------------------- | ------------ |
| `code-simplifier` | `code-simplifier` | sonnet | Refine implemented code for clarity/consistency | Cleaner code |

The `code-simplifier` pass is optional — spawn only when the Act stage involved multiple executors or significant new code. It refines without changing behavior.

### File Ownership (Conflict Prevention)

Before spawning `step-executor-N` teammates, partition steps by **file ownership** to prevent conflicts:

1. Build file -> step mapping from the plan.
2. Merge groups that share ANY file.
3. Each merged group = one executor's task list.

**Partitioning algorithm:**

```
For each step in current phase:
  Extract target files from ADD/MODIFY/DELETE actions
  If any file already assigned to an executor → assign step to same executor
  Otherwise → create new executor group

Result: N executor groups with zero file overlap
```

**Example:**

Phase 2 has 4 steps:

- Step 2.1: MODIFY `src/auth/middleware.ts`
- Step 2.2: ADD `src/auth/tokens.ts`
- Step 2.3: MODIFY `src/auth/middleware.ts` (same file as 2.1 -> same executor)
- Step 2.4: ADD `tests/auth.test.ts`

Result:

- `step-executor-1`: Steps 2.1 + 2.3 (sequential, shared file)
- `step-executor-2`: Step 2.2
- `step-executor-3`: Step 2.4

**Rule:** If ALL steps in a phase share files, do NOT parallelize — run sequentially with a single executor.

### Dependency Graph

```
TaskCreate: "Execute step group A"            → task-1 (step-executor-1)
TaskCreate: "Execute step group B"            → task-2 (step-executor-2)
TaskCreate: "Execute step group C"            → task-3 (step-executor-3)
TaskCreate: "Review code (bias-free)"         → task-4, addBlockedBy: [task-1, task-2, task-3]
TaskCreate: "Simplify code (optional)"        → task-5, addBlockedBy: [task-4]
```

Executors run in parallel (no shared files). Reviewer blocks until all executors complete. Simplifier runs last.

---

## Stage: Amend

Only the unique teammate tables and dependency graph. For shared logic, see the sections above.

### Task Assignments

**Diff analysis:**

| Teammate Name    | Agent Type          | Model  | Task                                       | Output            |
| ---------------- | ------------------- | ------ | ------------------------------------------ | ----------------- |
| `diff-analyst`   | `codebase-analyzer` | sonnet | Map git diff to planned steps              | Divergence report |
| `test-validator` | `Bash`              | haiku  | Run test suite, report failures from drift | Test results      |

The `test-validator` catches cases where implementation diverged AND tests broke — the most dangerous amend scenario.

**Post-amend verification (bias-free):**

| Teammate Name    | Agent Type          | Model  | Task                                        | Output     |
| ---------------- | ------------------- | ------ | ------------------------------------------- | ---------- |
| `amend-verifier` | `codebase-analyzer` | sonnet | Verify diff-to-plan mapping + test coverage | Validation |

### Dependency Graph

```
TaskCreate: "Analyze git diff vs plan"        → task-1 (diff-analyst)
TaskCreate: "Run test suite"                  → task-2 (test-validator)
TaskCreate: "Verify mapping + test coverage"  → task-3, addBlockedBy: [task-1, task-2]
```

`diff-analyst` and `test-validator` run in parallel. `amend-verifier` blocks until both complete, then cross-references divergence report with test results.
