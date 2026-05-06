---
name: linear
description: Access Linear project management data using native pi tools — issues, projects, teams, users, comments, cycles, labels, workflow states, and documents. Requires a Linear personal API key.
---

# Linear Integration

Use the native `linear_*` tools to read and write Linear data through the Linear GraphQL API.

## Critical Rules

- Never ask the user to paste a Linear API key in chat.
- Never expose the API key inline in shell commands.
- Before updating an issue or commenting, use `linear_get_issue` to verify the target.
- When IDs are unknown, use `linear_workspace_metadata` first.

## Authentication

The tools read the key from an in-memory override, `LINEAR_API_KEY`, or `~/.pi/agent/auth.json` at `.linear.key`.

If auth is missing, invalid, or expired, do **not** ask the user to paste the key in chat. Use the native `linear_configure_auth` tool or ask the user to run `/linear-auth --force`. The prompt is masked and the key is stored by the extension without returning it to the model.

## Tool Workflow

- Use `linear_configure_auth` only when auth is missing, invalid, expired, or the user asks to update the key.
- Use `linear_workspace_metadata` first when team/project/state/label/user IDs are unknown.
- Use `linear_search_issues` for keyword lookup.
- Use `linear_get_issue` before updating or commenting.
- Use `linear_list_issues` for filtered issue lists by team, assignee, status, or limit.
- Use `linear_create_issue` to create issues once the team ID is known.
- Use `linear_update_issue` to change title, description, priority, state, or assignee.
- Use `linear_create_comment` to add Markdown context to an issue.

## Available Tool Groups

### Workspace and users

- `linear_whoami`
- `linear_workspace_metadata`
- `linear_list_teams`
- `linear_get_team`
- `linear_list_users`
- `linear_get_user`

### Issues

- `linear_list_issues`
- `linear_search_issues`
- `linear_get_issue`
- `linear_list_my_issues`
- `linear_create_issue`
- `linear_update_issue`

### Projects, states, labels, cycles, documents

- `linear_list_projects`
- `linear_get_project`
- `linear_list_issue_statuses`
- `linear_get_issue_status`
- `linear_list_labels`
- `linear_list_cycles`
- `linear_list_documents`
- `linear_get_document`

### Comments

- `linear_list_comments`
- `linear_create_comment`
- `linear_configure_auth`

## Priority Values

| Value | Label       |
| ----- | ----------- |
| 0     | No priority |
| 1     | Urgent      |
| 2     | High        |
| 3     | Medium      |
| 4     | Low         |

## Issue Status Types

| Type        | Meaning                     |
| ----------- | --------------------------- |
| `backlog`   | Not yet started, in backlog |
| `triage`    | Needs triage                |
| `unstarted` | Not yet started             |
| `started`   | In progress                 |
| `completed` | Done                        |
| `canceled`  | Won't do                    |
