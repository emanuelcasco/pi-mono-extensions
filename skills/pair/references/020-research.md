# Stage 1: Research (`/dev:pair research`)

**Purpose**: Create a specification document with high-level objectives, context, and success criteria. Leaves implementation details for planning phase.

## Usage

```
/dev:pair research [TOPIC_OR_TICKET] [--team-mode]
```

## Workflow

**0: Initialize Spec File**

1. Determine the spec file path (use `--path` if provided, otherwise follow [Path Defaulting Logic](#path-defaulting-logic) in SKILL.md).
2. If the spec file **does not exist**, read and execute the `./references/010-init.md` asset and follow its workflow to create the file first. THIS IS MANDATORY AND FUNDAMENTAL.
3. Update `Stage:` to `Research` and `Last Updated:` to today's date.

**1.1: Gather Requirements**

- If ticket/issue provided, extract requirements
- If topic provided, ask clarifying questions via `ask_user_question`
- Research codebase for relevant patterns, conventions, and similar implementations
- Locate existing specs, tests, and docs in the domain

**1.2: Write Context & Objectives**

Synthesize gathered data into the spec document:

- High-Level Objective: 2-3 sentence what/why
- Mid-Level Objectives: 5-6 single-sentence milestones
- Context: Technical background needed for implementation
- Success Criteria: Measurable completion outcomes
- If a related issue exists, fill the issue reference line with the issue code and URL. Otherwise, remove the conditional line.

**1.3: Propose Solution**

Draft the Proposed Solution section based on objectives + context from 1.2:

- Plain language description of the intended change and its scope
- Focus on what will change from the user's perspective
- Define approach and boundaries of the change

**1.4: Surface Questions & Present**

- Add OPEN feedback blocks for ambiguities
- Use `ask_user_question` for user decisions (2-4 per round)
- Answer AI-resolvable questions directly
- Present clean spec document with OPEN questions
- Pause for human review before planning

## Output

Spec file with feedback blocks ready for `/dev:pair plan`.

**Template**: Use the `./assets/implementation-plan.template.md` asset as the base structure.

## Next steps

Tool call for ask_user_question with options:

1. Proceed to `/dev:pair plan`
2. Wait and review
3. Other (leave open for user to complete)

## Team Mode (`--team-mode`)

See the `./references/100-team-mode.md` asset for full team mode details — shared setup, coordination, teardown, bias-free verification, and search limits.

**Research-specific sections:** The "Stage: Research" section in `100-team-mode.md` covers teammate tables and the dependency graph for this stage.
