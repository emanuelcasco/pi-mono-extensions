# Stage: Brainstorm (`/dev:pair brainstorm`)

**Purpose**: Iteratively refine a vague idea into a clear problem definition — context, goals, and scope — without proposing any solution. Replaces `/dev:pair init` when the idea is underspecified.

## Usage

```
/dev:pair brainstorm <VAGUE_IDEA> [--path <spec_path>]
```

## Workflow

**Step 0 – Initialize Spec File**

1. Determine the spec file path (use `--path` if provided, otherwise follow [Path Defaulting Logic](#path-defaulting-logic) in SKILL.md).
2. If the spec file **does not exist**, read and execute the `./references/010-init.md` asset to scaffold it first. THIS IS MANDATORY.
3. Update `Stage:` to `Brainstorm` and `Last Updated:` to today's date.

**Step 1 – Light Exploration**

Gather minimal context to understand domain terminology — do **not** deep-dive into the codebase.

- Check the git branch name for domain/ticket context.
- Run `git log --oneline --name-only | grep specs` to find related prior specs.
- If domain terminology in the idea is unfamiliar, read ≤3 files to understand it.

**Do NOT:**
- Grep for implementation patterns across the codebase.
- Read source files extensively.
- Propose solutions, architectures, or approaches.

**Step 2 – Ask Clarifying Questions (iterative)**

Identify what's unclear about the idea: target users, scope, constraints, success criteria, current state, or definition of done.

- Use `ask_user_question` with **2–4 focused questions per round** — user-decision questions only.
- Answer AI-resolvable questions (e.g., "what does this module do?") via light exploration, not by asking the user.
- Do not ask about implementation approach — that is for Research/Plan.

**Step 3 – Write / Update Document Sections**

After each round of clarification, update the spec file:

- **Context**: Domain background, current state, and why this problem matters.
- **High-Level Objective**: Refined from the user's idea + answers (2–3 sentences, what/why).
- **Mid-Level Objectives**: 4–6 single-sentence milestones derived from the refined objective.
- Add `OPEN` feedback blocks for remaining ambiguities that couldn't be resolved yet.

**DO NOT write:**
- Proposed Solution
- Implementation Notes
- Phases or steps of any kind

**Step 4 – Check Completion**

- If **no `OPEN` feedback blocks remain** → proceed to Step 5.
- If `OPEN` blocks remain → loop back to Step 2 with the new information.

**Step 5 – Present and Confirm**

1. Present the finished spec document (Context, High-Level Objective, Mid-Level Objectives filled; Proposed Solution and Implementation Notes empty).
2. Use `ask_user_question` with options:
   1. Proceed to `/dev:pair research` _(recommended — deep codebase exploration + solution proposal)_
   2. Proceed to `/dev:pair plan` _(skip research — solution is already known after ideation)_
   3. Refine further — continue the brainstorm loop

## Key Constraint

Brainstorm stops at **problem definition**. It does **not** propose a solution.

If the user asks "how should we implement this?", redirect:

> "That's for `/dev:pair research` and `/dev:pair plan`. Let's first nail down what we want to build."

## Output

Spec file with:
- **Filled**: High-Level Objective, Mid-Level Objectives, Context
- **Empty**: Proposed Solution, Implementation Notes _(reserved for research/plan)_
- **No** `OPEN` feedback blocks remaining

## Next Steps

Tool call for `ask_user_question` with options:

1. Proceed to `/dev:pair research` — deep codebase exploration + solution proposal _(recommended)_
2. Proceed to `/dev:pair plan` — skip research, solution already known
3. Refine further — continue the brainstorm loop
