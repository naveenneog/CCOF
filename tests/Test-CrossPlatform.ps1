#Requires -Version 7.0
<#
.SYNOPSIS
    Offline cross-platform contract (G-MACOS): the deployer runs PowerShell 7 on Windows, macOS (Linux in Cloud
    Shell). Guards that exist because az on Windows is az.cmd (cmd.exe re-parses ( ) | & < > ^) apply on Windows
    only; files the deployer removes are removed on every platform. No Azure call.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAIL: $Message" }; $script:passed++ }

. (Join-Path $root 'infra/staged/Invoke-StagedDeployment.ps1') -DotSourceOnly

# A minimal valid configuration from the example (same values as tests/Test-StagedStages.ps1).
$example = Get-Content -LiteralPath (Join-Path $root 'infra/staged/staged.config.example.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100
$example.tenantId = '00000000-0000-4000-8000-000000000001'; $example.subscriptionId = '00000000-0000-4000-8000-000000000002'; $example.resourceGroup = 'rg-new'
$vnetPath = '/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet/subnets'
$example.network.existing = @{ functionsSubnetId = "$vnetPath/functions"; privateEndpointSubnetId = "$vnetPath/private"; apimSubnetId = "$vnetPath/apim" }
$example.apim.existing = @{ name = 'apim-existing'; subscriptionId = '00000000-0000-4000-8000-000000000002'; resourceGroup = 'rg-apim' }

$work = Join-Path ([IO.Path]::GetTempPath()) "ccof-xplat-$([guid]::NewGuid().ToString('N'))"
$savedOnWindows = $script:StgOnWindows
try {
    # 1. A config folder named with ( ) is valid on macOS and Linux, where az is a shell script that passes its
    #    arguments as they are; on Windows az.cmd re-parses them, so the guard stays there.
    $folder = Join-Path $work 'ccof (mac)'
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $cfgPath = Join-Path $folder 'staged.config.json'
    $example | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $cfgPath -Encoding utf8NoBOM
    $script:StgOnWindows = $false
    $accepted = $null; $message = ''
    try { $accepted = Read-StgConfig $cfgPath } catch { $message = $_.Exception.Message }
    Assert-Contract ($null -ne $accepted -and $accepted.__path -ceq [IO.Path]::GetFullPath($cfgPath)) "macOS/Linux must accept a config path with ( ): $message"
    $script:StgOnWindows = $true
    $refused = $false
    try { $null = Read-StgConfig $cfgPath } catch { $refused = $_.Exception.Message -match 'cmd\.exe metacharacter' }
    Assert-Contract $refused 'Windows must still refuse a config path with a cmd.exe metacharacter (az.cmd re-parses it).'
    $script:StgOnWindows = $savedOnWindows
    Assert-Contract ($script:StgOnWindows -eq [bool]$IsWindows) 'The driver must take the platform from $IsWindows.'
} finally {
    $script:StgOnWindows = $savedOnWindows
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

# 2. On macOS and Linux a dot-file is hidden, and Remove-Item without -Force leaves a hidden file in place (with
#    -ErrorAction SilentlyContinue, silently). Every Remove-Item in the deployer's code paths uses -Force.
$deployer = @('infra/staged', 'infra/quickstart', 'infra/sync', 'infra/reconciler', 'infra/gateway', 'infra/workbook', 'admin') |
    ForEach-Object { Get-ChildItem -LiteralPath (Join-Path $root $_) -Recurse -File -Include '*.ps1', '*.psm1' } |
    Where-Object { $_.FullName -notmatch '[\\/](node_modules|tests)[\\/]' }
$deployer += Get-ChildItem -LiteralPath (Join-Path $root 'scripts') -File -Filter '*.psm1'
$noForce = foreach ($file in $deployer) {
    $ast = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$null)
    foreach ($cmd in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -in 'Remove-Item', 'rm', 'del', 'ri' }, $true)) {
        if (-not @($cmd.CommandElements | Where-Object { $_ -is [Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -ieq 'Force' }).Count) {
            "$($file.FullName.Substring($root.Length + 1)):$($cmd.Extent.StartLineNumber)"
        }
    }
}
Assert-Contract (-not @($noForce).Count) "Remove-Item without -Force leaves dot-files on macOS/Linux: $(@($noForce) -join ', ')"

"Cross-platform: $passed checks passed (Windows-only cmd.exe guards, hidden-file removal). No Azure calls."
