# Stage 2: Plan (`/dev:pair plan`)

**Purpose**: Complete implementation plan with detailed phases and steps, processing feedback from specification phase.

## Usage

```
/dev:pair plan [PLAN_FILE] [--team-mode] [EXTRA_INSTRUCTIONS]
```

## Workflow

1. **Update Stage**
   - Update `Stage:` to `Plan` and `Last Updated:` to today's date in the spec file.

2. **Read Existing Spec** (if provided)
   - Load spec document from `PLAN_FILE`
   - Identify OPEN feedback blocks

3. **Process Feedback Blocks**
   - Classify questions: user-decision vs AI-resolvable
   - Use `ask_user_question` for user decisions (group 2-4 per round)
   - Answer AI-resolvable questions directly
   - Mark blocks as ADDRESSED after resolution

4. **Generate Implementation Phases**
   - Map milestones to self-contained phases
   - Each phase completes single task without breaking system
   - Break into actionable steps with file-level actions

5. **Step Format**

   ````markdown
   - [ ] Step {{n}}: {{step_name}}
     - ADD | MODIFY | DELETE | RENAME | MOVE | COPY {{file}} action description:
       ```diff
       // exact diff of changes
       ```
   ````

6. **Phase Verification**
   - Each phase MUST end with a **Verification** section
   - Include specific commands to run (tests, linter, build, type-check)
   - Describe expected outputs and any manual checks
   - The system must be in a working, error-free state after each phase

7. **Validate Plan**
   - Each phase is non-breaking and self-contained
   - Steps have clear action verbs and target files
   - Code snippets show exact changes
   - Every phase has a verification section

8. **Output Summary**
   - Phase summary table
   - Key decisions from resolved feedback
   - Prompt: "Ready to implement?"

## Output Summary Format

```markdown
## Plan Complete: {{spec_name}}

| Phase | Layer    | Change                |
| ----- | -------- | --------------------- |
| 1     | Backend  | Add repository method |
| 2     | Backend  | Update service layer  |
| 3     | Frontend | Add hook parameter    |

### Key Decisions

- [Decision 1 from feedback]
- [Decision 2 from feedback]

Ready to implement? Use `/dev:pair act {{plan_file}}`
```

## Next steps

Tool call for ask_user_question with options:

1. Proceed to `/dev:pair act`
2. Wait and review
3. Other (leave open for user to complete)

## Team Mode (`--team-mode`)

See the `./references/100-team-mode.md` asset for full team mode details — shared setup, coordination, teardown, bias-free verification, and search limits.

**Plan-specific sections:** The "Stage: Plan" section in `100-team-mode.md` covers teammate tables and the dependency graph for this stage.
