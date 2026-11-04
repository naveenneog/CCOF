#Requires -Version 7.0
# Install-ClaudeCodeAzureCli.ps1 targets Windows PowerShell 5.1, so its suite runs under 5.1 and, for the parity
# checks against the Node-based setup, under PowerShell 7.
if (-not $IsWindows) { 'Azure CLI only setup suite: Windows only; not run on this host.'; exit 0 }
$suite = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\client\tests\Test-ClaudeCodeAzureCliOnly.ps1'
$result = 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $suite
if ($LASTEXITCODE -ne 0) { $result = 1 }
pwsh -NoProfile -File $suite
if ($LASTEXITCODE -ne 0) { $result = 1 }
exit $result
