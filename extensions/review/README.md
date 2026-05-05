# Review Extension

Single review extension containing both commands:

- `/review <github-pr-url|gitlab-mr-url>`
- `/review-tui`

## Structure

- `index.ts` — extension entrypoint
- `review.ts` — `/review` command
- `review-tui.ts` — `/review-tui` command
- `reviewer.ts` — TUI component
- `common.ts` — shared types, platform logic, persistence, and utilities

## Workflow

1. Run `/review <url>`
2. pi fetches the PR/MR diff under the hood
3. pi asks the active model to report findings through a scoped `report_finding` tool
4. pi prints a compact findings summary in the terminal and stores the review session
5. Run `/review-tui`
6. Review, toggle, edit, and submit the selected comments

Findings use P0–P3 priority, confidence, title, and body fields. The legacy JSON path is still used as a fallback for models/providers that do not support scoped tool calls, and legacy `severity` values are mapped to priorities.

Submission is automatic based on the URL:

- GitHub → `gh`
- GitLab → `glab`
