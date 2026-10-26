#Requires -Version 7.0
# This suite exercises the Windows client (cmd.exe helpers, Windows folders, Claude Desktop). The macOS and Linux
# Claude Code setup is covered by tests/Test-ClaudeCodePosix.ps1 (ADR-0048); unsupported_platform by Test-CrossPlatform.ps1.
if (-not $IsWindows) { 'Windows client suite: not run on this host (macOS/Linux Claude Code setup: tests/Test-ClaudeCodePosix.ps1).'; exit 0 }
& (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/client/tests/Test-GatewayClients.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
