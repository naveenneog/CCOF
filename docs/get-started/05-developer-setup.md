# 5. Developer setup

**Who:** each developer (or the device management team, with the same files) · **Time:** about 5 minutes ·
**Needs:** Claude Code installed, Node.js 22, membership of an onboarded group, and the client configuration file
that Stage 7 generated (`client-config.json`), handed over through the approved private channel.

Full details, macOS and Linux paths, Claude Desktop and VS Code: [CLIENTS.md](../CLIENTS.md).

## 1. Install the helper and configure Claude Code

```powershell
npm ci --prefix .\client --no-audit --no-fund
$env:CCOF_CONFIG_FILE = (Resolve-Path '<client-config.json>').Path
pwsh -NoProfile -File .\scripts\client\Set-ClaudeCodeGateway.ps1 -ConfigPath $env:CCOF_CONFIG_FILE -Confirmed
```

Add `-UsageStatusLine` to show the budget continuously in Claude Code's status line.

**Expected:** one JSON line with `"event":"configured"`, `"usageSkill":true`, `"statusLine":"set"` (with
`-UsageStatusLine`) and a `changeId`. The previous settings are backed up under that `changeId`; to undo, see
[CLIENTS.md, Restore](../CLIENTS.md#restore). The settings file
then points Claude Code at the gateway (`ANTHROPIC_BASE_URL`) and the token helper (`apiKeyHelper`).

![Expected setup output](../evidence/2026-10-24-demo/terminal-client-setup.png)

## 2. Sign in once

```powershell
& .\client\bin\ccof-token.cmd login
```

Run this in the same shell so the helper uses `CCOF_CONFIG_FILE`, the absolute configuration path set above.
Windows uses the signed-in account (WAM); otherwise a browser window opens. No token is ever printed.

## 3. Use Claude Code

Start `claude` as usual. Requests go through the gateway with the models the group admits.

## 4. Check your own budget: `/usage`

In Claude Code, `/usage` prints each of your budgets, as of the last cost run (about a minute old):

![Expected /usage output: well within the budget](../evidence/2026-10-24-demo/usage-01-normal.png)

With the example guard, from 80% of projected spend the line adds a warning and requests are slowed to reduce
overshoot. The threshold is configurable; reporting lag means this is not a strict dollar cap.

![Expected /usage output at the warning](../evidence/2026-10-24-demo/usage-02-warning.png)

When recorded spend reaches the budget, new requests through that group are refused until next month or until the
budget is raised. Projected-spend refusal can clear earlier if the estimated in-flight spend falls.

![Expected /usage output when the budget is reached](../evidence/2026-10-24-demo/usage-03-refused.png)

This capture predates the status-line correction; the current client also adds `- budget used up, requests refused`
to the short status line.

What each figure means: [USAGE.md](../USAGE.md). `/cost` still shows the current session's own estimate.

## If something fails

| You see | Meaning |
| --- | --- |
| `401` | Sign in again: `ccof-token login` |
| `403 … not entitled` | Not (yet) a member of an onboarded group; ask the admin |
| `403 … model family is not available` | Choose an allowed model (`/model`) |
| `403 … budget … used up` | Budget reached; ask the budget owner |
| `429` | A limit is reached; Claude Code retries; `/usage` shows whether the budget warning applies |

More: [troubleshooting](../operate/troubleshooting.md).
