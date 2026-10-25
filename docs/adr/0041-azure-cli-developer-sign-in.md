# ADR-0041: Azure CLI developer sign-in through the generated token helper

Status: Accepted (2026-10-25).

## Context

Developers sign in to the gateway through `ccof-token`, a Node helper that uses MSAL Node with the gateway
app as the OAuth client ([CLIENTS.md](../CLIENTS.md)). It needs Node.js and the MSAL packages on each
workstation. The owner asked for an interactive Entra sign-in through `az login`, started from the `.cmd`
helper, with the Claude Code `settings.json`, the Claude Desktop inference profile and the gateway set up for it.

Parts of this already exist:

| Part | Where |
| --- | --- |
| Gateway accepts the Azure CLI client (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) when `entra.allowAzureCliClient` is true | Stage 4 preauthorizes it on `access_as_user` ([Staged.Entra.ps1](../../infra/staged/Staged.Entra.ps1)); Stage 5 adds it to `entra.delegatedClientAppIds`, rendered into `DELEGATED_CLIENT_IDS` ([render.ts](../../infra/gateway/render.ts)) |
| A hand-made `.cmd` helper that tries a cached token, then one interactive `az login` | [az-gateway-token-auto-login.cmd](../examples/az-gateway-token-auto-login.cmd), workbook step 17.8d, tested with a mock `az` ([Test-AzGatewayAutoLogin.ps1](../../tests/Test-AzGatewayAutoLogin.ps1)) |
| Stage 8 acceptance gets its gateway token from `az account get-access-token` | [Staged.Application.ps1](../../infra/staged/Staged.Application.ps1) `Invoke-Stage8` |

What was missing: the setup scripts could not write that helper, the helper shared the developer's own Azure
CLI profile (a sign-in for the gateway could change the account used for Azure administration), Claude Desktop
and `/usage` had no Azure CLI route, and Stage 4 did not read back the Azure CLI preauthorization.

## Options

1. Keep the manual workbook route only. No code change; every developer edits files by hand.
2. Add an Azure CLI mode to the Node helper (`ccof-token.mjs` runs `az`). Node stays a requirement, and the
   helper would run `az.cmd` through `cmd.exe` from Node.
3. Generate a `.cmd` helper from the client configuration and select it with a configuration key.

## Decision

Option 3.

1. **Configuration.** The client configuration takes an optional `signInMethod`: `msal` (the default when
   absent) or `azure-cli`. Stage 7 writes `azure-cli` when the staged configuration sets
   `client.signInMethod` to `azure-cli`; it refuses this unless Stage 4 recorded `azureCliClientAllowed`.
   Stage 7 checks the value before its preview and before any deployment step.
2. **Helper.** With `azure-cli`, setup writes `ccof-token.cmd` from the tested example's control flow, with
   the tenant and scope filled in and these additions:
   - `AZURE_CONFIG_DIR` is set to an `az` folder beside the client configuration
     (`%LOCALAPPDATA%\ClaudeGateway\az` by default). The gateway sign-in has its own Azure CLI profile and
     does not change the developer's own `az` account or subscription.
   - Commands `login`, `status` and `logout`. `token` (or no argument) prints only the access token.
     `silent-token` prints only the access token and never opens a sign-in.
   - `az.cmd` is called by the full path that setup resolved (`Get-Command az.cmd`), with
     `NoDefaultCurrentDirectoryInExePath=1`. `cmd.exe` otherwise searches the current folder first, and
     Claude Code runs the helper in the project folder, so a planted `az.cmd` there would run instead.
     Setup stops with `azure_cli_missing` when the Azure CLI is not found.
   - Exit codes: 3 when the Azure CLI is not at the recorded path, 4 when not signed in or sign-in failed.
   - The tenant must be a GUID and the scope may hold only `A-Z a-z 0-9 : / . _ -`, checked before the file
     is written: `az.cmd` passes its arguments through `cmd.exe`.
   - `--query accessToken` has no parentheses or other `cmd.exe` metacharacters.
3. **Claude Code.** `settings.json` gets the same `env` and `apiKeyHelper` as the MSAL route.
   `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` is at most 240 000. The Azure CLI's MSAL Python returns a cached token
   until it has less than five minutes left (`msal/application.py`, `if expires_in < 5*60: # Then consider it
   expired`), so a 240 s cache leaves at least 60 s of validity on every use.
4. **Claude Desktop.** The profile uses `inferenceCredentialKind = helper-script` with the same helper, even
   when the installed Desktop supports `external-idp`. The external-idp flow signs in with the gateway app
   as the OAuth client and does not use the Azure CLI. The helper cache time is at most 240 s; the helper
   timeout covers one interactive sign-in (`loginTimeoutSeconds + 2 x tokenTimeoutSeconds`).
5. **`/usage`.** The usage wrapper sets `CCOF_TOKEN_HELPER` to the helper path; `ccof-usage` gets its token
   from that helper's `silent-token` command when `signInMethod` is `azure-cli`, run in the helper's own
   folder. `/usage` and its status line run unattended, so they never open a sign-in, as in the MSAL route.
   Failures map to `azure_cli_missing`, `sign_in_timeout` or `sign_in_required`, the last with any
   Microsoft Entra error code (`AADSTSnnnnn`) the Azure CLI reported and the helper path to run `login`.
6. **Gateway.** No policy change: `DELEGATED_CLIENT_IDS` already carries the Azure CLI when allowed. Stage 4
   now reads back the gateway app's preauthorized clients, the Azure CLI included when allowed, as it
   already did for the admin app.

## Consequences

- Workstations in `azure-cli` mode need Azure CLI, not Node.js, for gateway tokens. Setup scripts still run
  under PowerShell 7 and use Node.js to validate the configuration; `/usage` still uses Node.js.
- Any token the Azure CLI client obtains for `access_as_user` is accepted by the gateway. This is the
  same trust as Stage 8 acceptance already uses; it is opt-in through `entra.allowAzureCliClient`.
- A group with `surfaces` set refuses Azure CLI callers with `surface_not_allowed` when
  `gateway.surfaceClients` is configured but does not map the Azure CLI client. One client ID cannot
  distinguish Claude Code from Claude Desktop, so the mapping names one surface for both.
- Conditional Access policies that target all resources, or the gateway app as the resource, apply to the
  Azure CLI sign-in ([UNKNOWNS.md](../UNKNOWNS.md) AZ-05).
- Reinstalling the Azure CLI to another folder needs setup to run again; the helper reports exit code 3.
- `msal` remains the default. Existing configurations without `signInMethod` behave as before.

Sources: [Claude Code `apiKeyHelper`](https://code.claude.com/docs/en/llm-gateway-connect#rotate-credentials-with-apikeyhelper),
[Azure CLI interactive sign-in](https://learn.microsoft.com/cli/azure/authenticate-azure-cli-interactively),
[MSAL Python `application.py`](https://github.com/AzureAD/microsoft-authentication-library-for-python/blob/dev/msal/application.py).
