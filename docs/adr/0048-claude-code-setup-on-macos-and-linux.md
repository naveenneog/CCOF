# ADR-0048: Claude Code setup on macOS and Linux with the Azure CLI sign-in

Status: Accepted (2026-10-26).

## Context

Developers at the customer use Macs with PowerShell 7 (`pwsh`). The client setup scripts wrote Windows `.cmd`
helpers and used Windows folders, so G-MACOS made them stop off Windows with `unsupported_platform`
(UNKNOWNS MAC-1). ADR-0041 added the Azure CLI sign-in (`signInMethod: azure-cli`): a generated helper that runs
`az account get-access-token` in its own Azure CLI profile and is what Claude Code's `apiKeyHelper` runs.

Facts this decision rests on (UNKNOWNS MAC-4..MAC-9, with sources):

- Claude Code reads `~/.claude/settings.json` on every platform and runs `apiKeyHelper` through `/bin/sh` on macOS
  and Linux (MAC-4).
- The `/usage` skill's injected command runs through the Bash tool where bash exists, and only when `allowed-tools`
  pre-approves it (MAC-5); the status line command runs in a shell (MAC-6).
- `AZURE_CONFIG_DIR` selects the Azure CLI profile on macOS and Linux as on Windows; `az login` signs in through
  the browser there (MAC-7).

## Options

1. Keep Windows-only setup; Mac developers edit `settings.json` and write a helper by hand. No code; every
   developer repeats an error-prone, security-relevant step.
2. Port both sign-in methods (`msal` and `azure-cli`) with POSIX shims. `msal` on macOS needs the Node helper's
   Keychain cache and browser flow tested on a Mac; nothing here can test that.
3. Port the Claude Code setup for `azure-cli` only; refuse `msal` off Windows with a clear error; keep Claude
   Desktop setup Windows-only.

## Decision

Option 3.

- **Helper.** On macOS and Linux setup writes `~/.claude/ccof-token`, a POSIX `sh` script (mode 700) with the
  same verbs and exit codes as the Windows `ccof-token.cmd`: `token` (default; one interactive `az login` when no
  token), `silent-token` (never signs in), `login`, `status`, `logout`; 0 token, 2 usage, 3 Azure CLI missing,
  4 not signed in. Only `token`/`silent-token` print the token, on stdout; Azure CLI output goes to stderr. The
  `az` path found at setup is pinned by full path; the tenant must be a GUID and the scope matches
  `^[A-Za-z0-9:/._-]+$` (as on Windows); every value is written inside single quotes, paths with a quote or a line
  break are refused.
- **Settings.** `apiKeyHelper` is `'<home>/.claude/ccof-token' token` (an `sh` command line); `env`, models and
  backups are the same as on Windows. The Claude Code extension's VS Code settings are updated when the extension
  is installed (macOS `~/Library/Application Support/Code/User`, Linux `~/.config/Code/User`).
- **Configuration folder.** The default configuration path is `$XDG_CONFIG_HOME/ClaudeGateway/config.json`
  (when absolute), else `~/.config/ClaudeGateway/config.json`; `-ConfigPath` and `CCOF_CONFIG_FILE` still win. The
  helper's Azure CLI profile is `az` beside the configuration, as on Windows, kept at mode 700.
  Reconciled difference: the Node helper's own default (used by `msal`) is `~/Library/Application Support/ClaudeGateway`
  on macOS and `claude-gateway` under the XDG folder on Linux (CLIENTS.md section 2). Setup does not use that default:
  it pins the chosen path into `settings.json` (`CCOF_CONFIG_FILE`) and the `/usage` wrapper, and `msal` is not set
  up off Windows. One folder for macOS and Linux, without a space, keeps the documented commands identical.
- **`/usage` and the status line** run the same `ccof-usage.ps1` wrapper with
  `pwsh -NoProfile -File "<home>/.claude/ccof-usage.ps1"`; the skill pre-approves exactly
  `Bash(<that command>)`. The home path may not hold `` ` ``, `$` or `"`, which bash would expand inside the double
  quotes (as on Windows); PowerShell's `Join-Path` already turns a `\` into `/` on macOS and Linux.
- **File modes.** Every file setup writes is created 600 (the helper 700) and every folder it creates 700, at
  creation time (.NET `UnixCreateMode`), so no file is briefly readable by others. PowerShell 7.4 or later.
- **Refusals.** Off Windows, any `signInMethod` other than `azure-cli` stops setup with
  `unsupported_sign_in_method` before anything is written. `Set-ClaudeDesktopGateway.ps1`,
  `Restore-ClaudeDesktopGateway.ps1` and `Test-InstalledClients.ps1` keep `unsupported_platform`.
  `Set-ClaudeCodeGateway.ps1`, `Restore-ClaudeCodeGateway.ps1` and `Test-ClientGatewayAccess.ps1` run on all three.
- Windows behaviour does not change.

## Consequences

- A Mac developer runs the same three commands as on Windows, from `pwsh`, after placing the configuration in
  `~/.config/ClaudeGateway/config.json`.
- `msal` and Claude Desktop on macOS stay unsupported (ROADMAP G-MACOS-DESKTOP, G-MACOS-MSAL).
- Proved on Linux pwsh in WSL, not on a Mac (UNKNOWNS MAC-8). The helper's behaviour tests run under `sh` on
  Linux and macOS; on Windows the suite checks the generated text and the setup flow with the platform simulated.
