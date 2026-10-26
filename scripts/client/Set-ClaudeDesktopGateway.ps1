#Requires -Version 7.0
[CmdletBinding()]
param([string]$ConfigPath, [string]$BackupRoot, [switch]$Confirmed)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ClaudeDesktopGateway.ps1')
. (Join-Path $PSScriptRoot 'ClientInventory.ps1')
Assert-ClientWindows -Script 'Set-ClaudeDesktopGateway.ps1'
Assert-ClientConfirmation -Confirmed:$Confirmed
if (-not $ConfigPath) { $ConfigPath = Get-ClientDefaultConfigPath }
$installedConfigPath = Get-ClientDefaultConfigPath -IgnoreEnvironment
if (-not $BackupRoot) { $BackupRoot = Join-Path (Split-Path $installedConfigPath -Parent) 'backups' }
$inventory = Get-CcofClientInventory
if (-not $inventory.DesktopVersion) {
    @{ event = 'not_installed'; component = 'claude-desktop' } | ConvertTo-Json -Compress
    exit 0
}
Assert-NoCcofManagedDesktopPolicy
$schema = Get-CcofInstalledDesktopSchema $inventory
Set-CcofClaudeDesktop -ConfigPath $ConfigPath -InstalledConfigPath $installedConfigPath -BackupRoot $BackupRoot -Inventory $inventory -Schema $schema `
    -LibraryPath (Join-Path $env:LOCALAPPDATA 'Claude-3p\configLibrary') `
    -NodePath (Get-Command node -ErrorAction Stop).Source `
    -TokenEntryPath (Join-Path $script:ClientRepoRoot 'client\bin\ccof-token.mjs') -Confirmed
