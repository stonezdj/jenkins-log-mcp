# jenkins-log-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that fetches and analyzes Jenkins console logs.

## Features

- **Fetch** raw console logs from any Jenkins build URL
- **Analyze** logs for critical errors, exceptions, test failures, timeouts, and more
- **Highlight** important lines with surrounding context
- **Summarize** findings grouped by error category and severity

## Prerequisites

- Node.js 18+
- A Jenkins API token

## Installation

```bash
npm install
npm run build
```

## Configuration

Set `JENKINS_API_TOKEN` before starting the server. Optionally set `JENKINS_USERNAME` so the token can be stored alone (useful for MCP configs that keep secrets separate).

```bash
# Recommended: username and token as separate variables
export JENKINS_USERNAME="alice"
export JENKINS_API_TOKEN="11a2b3c4d5e6f7890abcdef1234567890a"

# Or combined in one variable
export JENKINS_API_TOKEN="alice:11a2b3c4d5e6f7890abcdef1234567890a"

# Token only (empty HTTP username — often rejected by Jenkins)
export JENKINS_API_TOKEN="11a2b3c4d5e6f7890abcdef1234567890a"
```

If `JENKINS_USERNAME` is set, it is always paired with `JENKINS_API_TOKEN` as the password (do not prefix the token with `user:` in that case).

Generate an API token in Jenkins → *User Settings → API Token → Add new Token*.

### Multiple Jenkins servers

The **build URL** already identifies which host to call (`https://jenkins-a/...` vs `https://jenkins-b/...`). You only need **different credentials per host**. Two supported approaches:

**1. Named profiles (one MCP process)** — Set several env groups and pass `jenkins_profile` on each fetch so the right user/token is used:

- Profile string `harbor-ci` maps to suffix `HARBOR_CI` (uppercase, non-alphanumerics → `_`).
- Env vars: `JENKINS_PROFILE_HARBOR_CI_USERNAME`, `JENKINS_PROFILE_HARBOR_CI_API_TOKEN` (or `_TOKEN` instead of `_API_TOKEN`).
- Another profile `vcf` → `JENKINS_PROFILE_VCF_USERNAME`, `JENKINS_PROFILE_VCF_API_TOKEN`.

Optional default (when `jenkins_profile` is omitted): keep `JENKINS_USERNAME` / `JENKINS_API_TOKEN` for your primary server.

**2. Multiple MCP entries (no code paths to choose)** — Register the same `dist/index.js` under different `mcpServers` keys, each with its own `env` block. In Cursor you pick the server that matches the Jenkins instance. No `jenkins_profile` argument needed.

## Running

```bash
# Production
node dist/index.js

# Development (no build step)
npx tsx src/index.ts
```

## MCP Client Configuration

Add the server to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jenkins-log-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/jenkins-log-mcp/dist/index.js"],
      "env": {
        "JENKINS_USERNAME": "alice",
        "JENKINS_API_TOKEN": "default-server-token",
        "JENKINS_PROFILE_HARBOR_CI_USERNAME": "bob",
        "JENKINS_PROFILE_HARBOR_CI_API_TOKEN": "other-server-token"
      }
    }
  }
}
```

Example tool call: `fetch_jenkins_log` with `console_url` pointing at Harbor Jenkins and `jenkins_profile` set to `"harbor-ci"`.

## Available Tools

### `fetch_jenkins_log`

Fetch the raw console log from a Jenkins build.

| Parameter          | Type   | Description |
|--------------------|--------|-------------|
| `console_url`      | string | Jenkins build URL or direct `/consoleText` URL |
| `jenkins_profile`  | string | Optional named profile (see *Multiple Jenkins servers*) |

### `analyze_jenkins_log`

Analyze raw log text for errors and warnings.

| Parameter     | Type   | Description                  |
|---------------|--------|------------------------------|
| `log_content` | string | Raw Jenkins console log text |

Returns a structured report with counts, a grouped summary, and a highlighted excerpt of notable lines.

### `fetch_and_analyze_jenkins_log`

Convenience tool — fetches and analyzes in one step.

| Parameter          | Type   | Description |
|--------------------|--------|-------------|
| `console_url`      | string | Jenkins build URL or direct `/consoleText` URL |
| `jenkins_profile`  | string | Optional named profile (same as `fetch_jenkins_log`) |

## Detected Patterns

| Severity | Patterns |
|----------|----------|
| 🔴 CRITICAL | BUILD FAILURE, BUILD FAILED, FATAL, OutOfMemoryError, Go panic, Segfault |
| 🟠 ERROR | Generic ERROR, Exception/Stack trace, NPE, Connection refused, Timeout, Permission denied, Missing file, Non-zero exit code, Test failures, Assertion errors |
| 🟡 WARNING | WARN/WARNING, Deprecation notices |

## License

MIT
