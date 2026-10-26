#Requires -Version 7.0
# The workstation setup scripts are Windows-only (cmd.exe helpers, Windows folders); off Windows they stop with
# unsupported_platform, which tests/Test-CrossPlatform.ps1 covers.
if (-not $IsWindows) { 'Client setup scripts are Windows-only: suite not run on this host (see tests/Test-CrossPlatform.ps1).'; exit 0 }
& (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/client/tests/Test-GatewayClients.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
