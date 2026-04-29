# sentinel

The `sentinel` extension adds content-aware security guards that intercept tool calls before they execute.

It addresses cross-cutting security gaps that pure command-based guardrails miss:

- **Content-in-location** — a file the agent is about to read contains secrets
- **Indirect execution** — a file the agent wrote earlier in the session is later executed via `bash`
- **Out-of-scope operations** — a raw `bash` command performs a system-level action (sudo, `curl | bash`, `brew install`, `rm -rf /Library/...`) or a `write`/`edit` targets a file outside the project root (shell config, system directory)
- **Credential safety** — the LLM never hardcodes API keys or secrets in tool calls

## Guards

### 1. output-scanner — secret detection on read

Pre-reads files before `read` tool calls execute and scans for credential patterns. If secrets are found, the user is asked before the read is allowed. The same guard also intercepts `bash` commands that read file content (`cat`, `head`, `tail`, `less`, `more`) and pre-scans their targets.

Detected patterns include:

- AWS access and secret keys
- GitHub personal access and OAuth tokens
- Anthropic, OpenAI, Slack, Stripe, Google OAuth keys
- PEM private keys
- Generic `secret/password/token/api_key = "..."` assignments
- High-entropy strings above a Shannon-entropy threshold

Scan results are cached per file by `mtime` and invalidated via `context-guard:file-modified` events.

### 2. execution-tracker — write/execute correlation

Two hooks working together:

- **Write-time tracking** — every `write` and `edit` tool call is recorded in a session write registry. The new content is scanned for dangerous patterns but the write is never blocked.
- **Execution-time correlation** — when `bash` runs a script, the path is extracted and checked against the registry. If the script was written in this session and contains dangerous patterns, execution is escalated to the user (or blocked when there is no UI).

Flagged patterns include `curl | bash`, `wget | bash`, `eval` against untrusted input, `curl -X POST` exfiltration, `rm -rf`, `chmod 777`, `sudo`, and persistence hooks (`crontab`, `systemctl enable`, `launchctl`).

If the target file was modified after the tracked write, it is re-read and re-scanned before the decision — avoiding false positives when the agent rewrote the dangerous content out.

### 3. permission-gate — proactive bash / write / edit gate

Where `execution-tracker` only fires for _session-written_ scripts, `permission-gate` intercepts every `bash` command and every `write` / `edit` and matches them against a fixed set of risk classes. It runs in addition to the other two guards.

**Bash risk classes**

| Risk class                | Example                                            |
| ------------------------- | -------------------------------------------------- |
| `remote-pipe-exec`        | `curl -Ls https://mise.run \| bash`                |
| `privilege-escalation`    | `sudo systemctl restart nginx`                     |
| `destructive-system-rm`   | `rm -rf /Library/Developer/CommandLineTools`       |
| `package-manager-install` | `brew install ripgrep`                             |
| `persistence`             | `crontab -l`, `systemctl enable`, `launchctl load` |
| `shell-config-write`      | `echo "export FOO=1" >> ~/.zshrc`                  |
| `system-binary-install`   | `cp ./mybin /usr/local/bin/mybin`                  |

`rm -rf` on project-local paths (e.g. `node_modules`, `dist`, `./build/cache`) is intentionally not flagged.

**Path categories for `write` / `edit`**

| Category           | Example                                    |
| ------------------ | ------------------------------------------ |
| `shell-config`     | `~/.zshrc`, `~/.bashrc`, `~/.profile`      |
| `system-directory` | `/usr/*`, `/Library/*`, `/opt/*`, `/etc/*` |
| `outside-project`  | any absolute path not under `ctx.cwd`      |

**Decision matrix**

```
UI available + user allows  → proceed
UI available + user denies  → block with reason
No UI + dangerous detected  → block with reason (fail-safe)
No risk classes matched     → proceed
```

When multiple risk classes match a single command, all matched labels are surfaced in one combined confirmation dialog instead of stacking prompts.

## Behavior

- **No UI available** — guards fail safe by blocking with a clear `reason`.
- **UI available** — the user sees a `confirm()` dialog with the matched labels, line numbers, and snippets, and can allow or deny.
- Session state (scan cache, write registry) is cleared on `session_start`.

## Install

```bash
pi install npm:pi-mono-sentinel
```
