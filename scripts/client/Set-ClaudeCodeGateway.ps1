#Requires -Version 7.0
[CmdletBinding()]
param([string]$ConfigPath, [string]$BackupRoot, [switch]$UsageStatusLine, [switch]$Confirmed)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ClaudeCodeGateway.ps1')
. (Join-Path $PSScriptRoot 'ClientInventory.ps1')
Assert-ClientConfirmation -Confirmed:$Confirmed
if (-not $ConfigPath) { $ConfigPath = Get-ClientDefaultConfigPath }
$installedConfigPath = Get-ClientDefaultConfigPath -IgnoreEnvironment
if (-not $BackupRoot) { $BackupRoot = Join-Path (Split-Path $installedConfigPath -Parent) 'backups' }
# VS Code user settings per platform (code.visualstudio.com/docs/configure/settings#_settings-file-locations).
$vscodeSettings = if ($IsWindows) { Join-Path $env:APPDATA 'Code\User\settings.json' }
    elseif ($IsMacOS) { Join-Path $HOME 'Library/Application Support/Code/User/settings.json' }
    else { Join-Path $HOME '.config/Code/User/settings.json' }
$inventory = Get-CcofClientInventory
Set-CcofClaudeCode -ConfigPath $ConfigPath -InstalledConfigPath $installedConfigPath -BackupRoot $BackupRoot -Inventory $inventory `
    -ClaudeHome (Join-Path $HOME '.claude') -VSCodeSettingsPath $vscodeSettings `
    -NodePath (Get-Command node -ErrorAction Stop).Source `
    -TokenEntryPath (Join-Path $script:ClientRepoRoot 'client\bin\ccof-token.mjs') `
    -UsageEntryPath (Join-Path $script:ClientRepoRoot 'client\bin\ccof-usage.mjs') -UsageStatusLine:$UsageStatusLine -Confirmed
