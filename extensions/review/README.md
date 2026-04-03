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
3. pi generates structured review comments and prints the summary in the terminal
4. Run `/review-tui`
5. Review, toggle, edit, and submit the selected comments

Submission is automatic based on the URL:
- GitHub → `gh`
- GitLab → `glab`
