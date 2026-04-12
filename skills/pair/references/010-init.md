# Stage 0: Init (`/dev:pair init`)

**Purpose**: Scaffold an empty implementation plan from the user's description. Improves wording and structure but **does NOT research the codebase**.

## Usage

```
/dev:pair init <DESCRIPTION> [--path <spec_path>]
```

## Workflow

1. **Parse Arguments**
   - Extract the description (everything that is not a flag).
   - Extract `--path <spec_path>` if provided.

2. **Determine Spec File Path**
   - If `--path` was provided, use it directly.
   - Otherwise, follow the [Path Defaulting Logic](#path-defaulting-logic) in SKILL.md.

3. **Improve the Description** (no research)
   - Rewrite the user's description into:
     - **High-Level Objective**: 2-3 sentences covering what and why.
     - **Mid-Level Objectives**: 3-6 single-sentence milestones (checklist).
     - **Success Criteria**: Measurable outcomes derived from the objectives.
   - **Rules:**
     - Keep the user's intent exactly — only improve wording, grammar, and structure.
     - Do NOT invent requirements or add scope.
     - Do NOT research the codebase for context.

4. **Write the Spec File**
   - Use the `./assets/implementation-plan.template.md` asset as the base structure.
   - Set `Stage: Init` and `Last Updated:` to today's date.
   - Fill: High-Level Objective, Mid-Level Objectives, Success Criteria.
   - If a related issue exists, fill the issue reference line with the issue code and URL. Otherwise, remove the conditional line.
   - Leave **Context**, **Proposed Solution**, **Implementation Notes**, and **Notes** sections empty with their OPEN feedback blocks.
   - Add placeholder in Implementation Notes: `_No phases defined yet. Use /dev:pair plan {{spec_path}} to generate the implementation plan._`

5. **Present Result**
   - Print the full spec content and file path.
   - Use `ask_user_question` with options:
     1. Proceed to `/dev:pair plan` — "Generate the implementation plan with phases and steps"
     2. Edit objectives — "Refine the objectives before planning"

## Output

Spec file with improved objectives and empty implementation sections, ready for `/dev:pair plan`.
