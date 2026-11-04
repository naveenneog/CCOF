# Developer setup with the Azure CLI only (Windows)

**Who:** each developer, or the device management team · **Time:** about 5 minutes ·
**Needs:** Windows 10 1809 or later, Claude Code, the Azure CLI, membership of an onboarded group, and a
`client-config.json` with `"signInMethod": "azure-cli"` from the administrator.

**Not needed:** Node.js, npm, Git, Python, Visual Studio Build Tools, PowerShell 7 or Claude Desktop. The setup
script runs in the Windows PowerShell 5.1 included with Windows.

This route writes the same Claude Code files as [05-developer-setup.md](05-developer-setup.md) does for the Azure CLI
sign-in. The tests compare the two outputs (see [How it is tested](#how-it-is-tested)).

## Why this route exists

Observed on customer developer machines on 2026-11-04 with the Node-based route:

| Blocker | Cause | This route |
|---|---|---|
| `npm ci` failed on a certificate error until Visual Studio Build Tools and Python were installed | `@azure/msal-node-extensions` depends on `keytar`, whose install script is `prebuild-install \|\| npm run build` (`client/node_modules/keytar/package.json`). The prebuilt download fails behind TLS inspection, so npm compiles it, which needs Python and a C++ compiler | No npm install |
| `winget install` of Git and Python failed | Package source blocked by company policy | Git and Python are not used |
| Node.js, PowerShell 7 and Git were required | The setup scripts validate the configuration with Node (`Read-ClientConfiguration`, `scripts/client/ClientGateway.Common.ps1`) and need PowerShell 7 (`#Requires -Version 7.0`) | One script, Windows PowerShell 5.1, no Node |
| Claude Desktop install blocked by IT | Company policy | Not used; Claude Code only |
| Gateway URL wrong in `client-config.json` | `gatewayUrl` ended in `/v1/messages`; Claude Code adds `/v1/messages` itself | The script refuses such a URL and prints the corrected value |

The Azure CLI sign-in itself needs no Node: the token helper is a `.cmd` file that runs
`az account get-access-token` ([ADR-0041](../adr/0041-azure-cli-developer-sign-in.md)).

## 1. Install the two prerequisites

| Program | Install | Check |
|---|---|---|
| Claude Code | `irm https://claude.ai/install.ps1 \| iex` in PowerShell; no administrator rights needed ([Claude Code setup](https://code.claude.com/docs/en/setup#install-on-native-windows)). Or the company software portal | `claude --version` in a new window |
| Azure CLI | The MSI from the company software portal, or [aka.ms/installazurecliwindowsx64](https://aka.ms/installazurecliwindowsx64) ([Learn](https://learn.microsoft.com/cli/azure/install-azure-cli-windows)) | `az version` in a new window |

Git for Windows is optional for Claude Code. Without it, Claude Code runs commands through its PowerShell tool
([Claude Code setup, native Windows](https://code.claude.com/docs/en/setup#install-on-native-windows)).

## 2. Get the script and the configuration

Put these files in one folder, for example `C:\ccof`:

- `client-config.json` from the administrator (Stage 7 output), through the approved private channel.
- [`Install-ClaudeCodeAzureCli.ps1`](../../scripts/client/Install-ClaudeCodeAzureCli.ps1) and the double-click launcher
  [`Install-ClaudeCodeAzureCli.cmd`](../../scripts/client/Install-ClaudeCodeAzureCli.cmd), from the administrator or
  downloaded:

```powershell
New-Item -ItemType Directory -Force C:\ccof | Out-Null; cd C:\ccof
foreach ($f in 'Install-ClaudeCodeAzureCli.ps1', 'Install-ClaudeCodeAzureCli.cmd') {
  Invoke-WebRequest "https://raw.githubusercontent.com/naveenneog/CCOF/main/scripts/client/$f" -OutFile $f -UseBasicParsing
  Unblock-File .\$f
}
```

**Double-click option:** double-click `Install-ClaudeCodeAzureCli.cmd`. It runs the setup, sign-in and test request
of step 3 in one window and waits for a key at the end. It stops with a message if `client-config.json` or the script
is not in the same folder.

## 3. Check, then set up

Open **Windows PowerShell** (or PowerShell 7) in `C:\ccof`. First a check that writes nothing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeCodeAzureCli.ps1 -ConfigPath .\client-config.json
```

**Expected:** `Configuration ok`, the Azure CLI path, `Claude Code: found`, the files it would write, and
`Nothing was changed`. A configuration problem is listed with its fix; send that list to the administrator.

Then set up, sign in and send one test request:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeCodeAzureCli.ps1 -ConfigPath .\client-config.json -Confirmed -Login -Test
```

A Microsoft sign-in window opens once. **Expected** at the end:

```text
Claude Code is set up for the gateway.
  Default model: claude-sonnet-5-5
  Backup (undo with -Restore): C:\Users\<you>\AppData\Local\ClaudeGateway\backups\<id>
Signing in: a Microsoft sign-in window opens...
Signed in. Claude Code and Claude Desktop now use this sign-in.
Sending one test request to the gateway...
  HTTP 200. Reply: gateway OK
```

Files written (each backed up first, all rolled back if one write fails):

| File | Content |
|---|---|
| `%USERPROFILE%\.claude\ccof-token.cmd` | Token helper; runs `az` in its own profile, `%LOCALAPPDATA%\ClaudeGateway\az`, so an existing `az login` is not changed |
| `%USERPROFILE%\.claude\settings.json` | `apiKeyHelper`, `ANTHROPIC_BASE_URL`, models, group header (`x-ccof-project`); other settings are kept |
| `%LOCALAPPDATA%\ClaudeGateway\config.json` | Copy of the client configuration |
| `%APPDATA%\Code\User\settings.json` | Only when the Claude Code VS Code extension is installed: the same environment, other settings kept. Comments in that file are not kept, as with the PowerShell 7 setup |

`-ExecutionPolicy Bypass` applies to that one process. A Group Policy execution policy takes precedence over it
([about_Execution_Policies](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_execution_policies));
in that case the device management team runs or signs the script.

## 4. Use Claude Code

Open a new terminal and run `claude`. In VS Code, reload the window. Sign-in later:
`& "$env:USERPROFILE\.claude\ccof-token.cmd" login`; status: `... status`; sign-out: `... logout`.

## Undo

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeCodeAzureCli.ps1 -Restore "<backup folder printed by setup>" -Confirmed
```

Restore refuses when a file changed after setup; add `-AllowChangedFiles` to restore the original anyway. The backup
format is the one `Restore-ClaudeCodeGateway.ps1` reads.

## Not included

- The `/usage` budget command and status line: they run `client/bin/ccof-usage.mjs`, which needs Node.js. Budget
  figures stay available to administrators in the admin console.
- Claude Desktop: [CLIENTS.md, section 5](../CLIENTS.md#5-configure-claude-desktop).
- macOS and Linux: use [05-developer-setup.md](05-developer-setup.md).

## If something fails

| You see | Meaning and fix |
|---|---|
| `gatewayUrl '...' ends in /v1 or /v1/messages` | The configuration has the endpoint, not the base URL. The administrator corrects `gatewayUrl` to the printed value |
| `signInMethod is 'msal (default)'` | The configuration uses the Node sign-in. The administrator issues an `azure-cli` configuration (deployment setting `entra.allowAzureCliClient`) |
| `The Azure CLI is not installed` | Install it (step 1), open a new window, run again |
| `CERTIFICATE_VERIFY_FAILED` from `az` | TLS inspection. The Azure CLI uses its own CA bundle: set `REQUESTS_CA_BUNDLE` to a PEM file holding the public CAs plus the company inspection root ([Microsoft Q&A](https://learn.microsoft.com/answers/questions/6060855/certificate-installed-for-az-cli-is-not-getting-ac)), or ask IT to exempt `login.microsoftonline.com` from inspection |
| `AADSTSnnnnn` during sign-in | Microsoft Entra refused the sign-in, for example Conditional Access; give the code to the administrator |
| `HTTP 403: ... not an active member of Claude group` | Not yet in the onboarded group, or the sync has not admitted the person yet ([troubleshooting](../operate/troubleshooting.md)) |
| `HTTP 404` | Wrong gateway URL or path, or a private gateway reached from outside its network |
| `HTTP 0` with a connection error | The gateway host is not reachable from this machine (VPN, proxy or private endpoint) |

Claude Code trusts the Windows certificate store, so a TLS-inspection root installed there works without settings
([Claude Code network configuration](https://code.claude.com/docs/en/network-config#ca-certificate-store)). The
script's `-Test` request also uses the Windows store.

## How it is tested

`scripts/client/tests/Test-ClaudeCodeAzureCliOnly.ps1` runs under Windows PowerShell 5.1 and PowerShell 7 with a fake
`az.cmd` and a PATH that holds no Node:

- preview writes nothing; refusals for a `/v1/messages` URL, an `msal` configuration, mistyped values (`"schemaVersion": "1"`,
  a string `models.available`) and an invalid `settings.json`;
- settings merge, VS Code merge (including a commented `settings.json`), helper sign-in and token, a test request
  against a local stub (200 and 403);
- restore, including the changed-file refusal.

Under PowerShell 7 it also checks the following against the Node-based setup:
- the helper is byte-identical to `New-ClientAzureCliTokenShim`;
- the Claude Code environment is equal to `New-CcofCodeEnvironment`;
- 16 configurations are accepted or refused exactly as `client/bin/validate-config.mjs` does.

Four mutations of the script (helper TTL cap, a helper line, the `/v1` refusal, the group header in the test request)
were each caught by the intended test, with every test loading. A live sign-in on this route has not been run yet.
The helper is the one already proven live on 2026-10-25 ([UNKNOWNS.md](../UNKNOWNS.md) AZ-01).
