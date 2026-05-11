# pi-mono-linear

A pi extension and skill package that exposes native Linear GraphQL tools for issue, project, team, user, comment, file upload, cycle, label, workflow-state, and document workflows.

## Tools

### Workspace and users

- `linear_whoami`
- `linear_workspace_metadata`
- `linear_list_teams`
- `linear_get_team`
- `linear_list_users`
- `linear_get_user`

### Issues

- `linear_list_issues`
- `linear_get_issue`
- `linear_search_issues`
- `linear_list_my_issues`
- `linear_create_issue`
- `linear_update_issue`

### Metadata and related records

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

### Files

- `linear_upload_file`
- `linear_upload_file_to_issue_comment`

The package also bundles the `linear` skill under `skills/linear/SKILL.md`.

## Authentication

The extension looks for a Linear API key in this order:

1. in-memory key override created by `/linear-auth --force` or `linear_configure_auth`
2. `LINEAR_API_KEY` environment variable
3. `~/.pi/agent/auth.json` at `.linear.key`

If no key is found, or if Linear rejects the key as invalid/expired, the native tools can prompt you with a masked local dialog and store the replacement key without returning it to the model.

Do **not** paste API keys into an LLM chat.

### Recommended: native auth command

Run this in pi:

```text
/linear-auth --force
```

The command shows the Linear API-key URL and required permissions, prompts for the key with masked input, and writes it to `~/.pi/agent/auth.json` at `.linear.key`.

The same flow is available to the agent through the `linear_configure_auth` tool. That tool returns only metadata such as `stored: true`; it never returns the key.

If a normal `linear_*` request fails because the key is missing, invalid, or expired, the extension retries once after prompting you for a fresh key.

### Option A: environment variable

For the current shell session:

```bash
export LINEAR_API_KEY="lin_api_xxx"
```

To persist it, add that export to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) or your preferred secrets manager.

### Option B: pi auth file

Create or update `~/.pi/agent/auth.json`:

```json
{
  "linear": {
    "key": "lin_api_xxx"
  }
}
```

Recommended file permissions:

```bash
mkdir -p ~/.pi/agent
chmod 700 ~/.pi/agent
chmod 600 ~/.pi/agent/auth.json
```

If the file already contains other credentials, merge the `linear.key` entry instead of overwriting the file.

## Creating a Linear API key

1. Open Linear.
2. Go to **Settings → Account → Security & Access**.
3. Under **Personal API keys**, click **Create key**.
4. Name it something recognizable, for example `pi-agent`.
5. Choose the minimum access level needed for your workflow.
6. If your workspace supports team restrictions, restrict the key to only the teams pi needs.
7. Copy the key once and store it via `LINEAR_API_KEY` or `~/.pi/agent/auth.json`.

## Required scopes / permissions

Use the least privilege that supports the tools you need:

- **Read** is enough for read-only tools such as `linear_workspace_metadata`, `linear_search_issues`, `linear_get_issue`, list tools, and document/comment reads.
- **Write** is required for mutation tools: `linear_create_issue`, `linear_update_issue`, `linear_create_comment`, `linear_upload_file`, and `linear_upload_file_to_issue_comment`.
- **Admin** is not required for this extension's tools.

If you restrict the key to specific teams, the key must include the teams/projects/issues you want to query or mutate.

Linear API keys are sent in the `Authorization` header as the raw key value; do not prefix them with `Bearer`.

## Usage tips

- Use `linear_workspace_metadata` first when team/project/state/label/user IDs are unknown.
- `linear_create_issue` accepts either a team UUID or a team key; keys are resolved to UUIDs before the Linear mutation.
- Use `linear_search_issues` for keyword lookup.
- Use `linear_get_issue` before updating an issue or creating a comment.
- Use `linear_list_issues` for filtered issue lists by team, assignee, status, and limit.
- Use `linear_upload_file` to upload a local image, video, or generic file and return a Linear asset URL.
- Use `linear_upload_file_to_issue_comment` after `linear_get_issue` to upload a local file and post a Markdown comment. Images are rendered with image Markdown; other files use links.
- File upload tool results return sanitized metadata and the stable Linear asset URL. They do not return local file bytes, signed upload URLs, or upload headers.

## Troubleshooting

### Missing auth key

Set `LINEAR_API_KEY` or add `.linear.key` to `~/.pi/agent/auth.json`.

### Permission errors

Confirm the key has the right access level:

- Read-only workflows need **Read**.
- Create/update/comment workflows need **Write**.
- Team-restricted keys must include the relevant team.

### Custom Linear endpoint

By default, the extension uses `https://api.linear.app/graphql`. Override it with:

```bash
export LINEAR_GRAPHQL_URL="https://api.linear.app/graphql"
```
