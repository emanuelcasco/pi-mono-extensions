# ^^/CONDITION:{{issue_code}}:^^/CONDITION^^ {{change_name}}

[[LLM: This is the canonical implementation plan document for all `/dev:pair` stages. Initialization is mandatory: if this file does not exist, create it from this template before any stage-specific logic runs. `/dev:pair research` is a valid workflow entry point and must auto-initialize when starting from scratch.]]

Stage: `{{stage}}`
Last Updated: {{date}}
^^/CONDITION: has_external_apis^^
Issue: {{issue_url}} or {{issue_code}}
^^/CONDITION^^

## High-Level Objective

[[LLM: Describe briefly the story and the context of the story.]]

<!-- FEEDBACK: high_level_objective
Questions or feedback about the main goal and context.
Status: OPEN
-->

## Mid-Level Objectives

[[LLM: List the requirements of the story in a checklist.]]

<!-- FEEDBACK: mid_level_objectives
Questions or feedback about the requirements and milestones.
Status: OPEN
-->

## Context

[[LLM: Explain the necessary context for the LLM to understand the implementation plan.]]

<!-- FEEDBACK: context
Questions or feedback about the technical context and background.
Status: OPEN
-->

## Proposed Solution

[[LLM: Describe in plain language the intended change and its scope. Focus on what will change from the user's perspective, the approach being taken, and the boundaries of the change. This section should help the reader quickly assess whether the plan aligns with expectations before reviewing the detailed implementation steps.]]

<!-- FEEDBACK: proposed_solution
Questions or feedback about the proposed approach and scope.
Status: OPEN
-->

## Implementation Notes

<!-- FEEDBACK: implementation_approach
Questions or feedback about the overall implementation approach before diving into phases.
Status: OPEN
-->

### Phase {{m}}: {{phase_name}}

[[LLM: List the steps to implement the story.]]

<!-- FEEDBACK: phase_{{m}}
Questions or feedback about this specific phase.
Status: OPEN
-->

- [ ] Step {{m.n}}: {{step_name}}
  - ADD | MODIFY | DELETE | RENAME | MOVE | COPY | OTHER {{file}} action description:
    ```diff
    // git diff block if necessary
    ```

**Verification**

[[LLM: Describe how to verify that this phase works correctly after completion. Include specific commands to run (tests, linter, build), expected outputs, and any manual checks needed. Each phase must leave the system in a working state.]]

<<REPEAT phase>>

## Success Criteria

[[LLM: List the success criteria for the story.]]

<!-- FEEDBACK: success_criteria
Questions or feedback about the completion criteria and validation approach.
Status: OPEN
-->

## Notes

Additional notes and considerations.

<!-- FEEDBACK: general
General questions, concerns, or suggestions for the entire implementation plan.
Status: OPEN
-->
