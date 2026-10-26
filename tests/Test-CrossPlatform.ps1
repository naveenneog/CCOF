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

# 3. Claude Desktop setup and the installed-client inventory generate cmd.exe helpers and use Windows folders
#    (APPDATA, LOCALAPPDATA, registry policies). On macOS and Linux each stops first with one JSON line and exit
#    code 2, before it reads or writes anything, instead of failing half-way with a null-path error. The Claude Code
#    scripts run on macOS and Linux too (ADR-0048) and carry no such guard.
$clientDir = Join-Path $root 'scripts/client'
$probe = "`$ErrorActionPreference = 'Stop'; . '$((Join-Path $clientDir 'ClientGateway.Common.ps1').Replace("'", "''"))'; Assert-ClientWindows -Script 'Set-ClaudeDesktopGateway.ps1' -OnWindows:`$false; 'continued'"
$lines = @(pwsh -NoProfile -Command $probe 2>&1 | ForEach-Object { "$_" })
$code = $LASTEXITCODE
$event = try { $lines[0] | ConvertFrom-Json -AsHashtable } catch { @{} }
Assert-Contract ($code -eq 2 -and $lines.Count -eq 1 -and $event.event -ceq 'unsupported_platform' -and $event.script -ceq 'Set-ClaudeDesktopGateway.ps1' -and $event.docs -ceq 'docs/CLIENTS.md#macos-and-linux') "Off Windows the client scripts must stop with unsupported_platform and exit 2 (exit $code): $($lines -join ' | ')"
$lines = @(pwsh -NoProfile -Command ($probe -replace '-OnWindows:\$false', '-OnWindows:$true') 2>&1 | ForEach-Object { "$_" })
Assert-Contract ($LASTEXITCODE -eq 0 -and ($lines -join '') -ceq 'continued') "On Windows the client scripts must continue: $($lines -join ' | ')"
foreach ($name in 'Set-ClaudeDesktopGateway.ps1', 'Restore-ClaudeDesktopGateway.ps1', 'Test-InstalledClients.ps1') {
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $clientDir $name), [ref]$null, [ref]$null)
    $first = @($ast.EndBlock.Statements | Where-Object { $_.Extent.Text -notmatch '^\$ErrorActionPreference|^\. \(Join-Path \$PSScriptRoot' })[0]
    Assert-Contract ($first.Extent.Text -ceq "Assert-ClientWindows -Script '$name'") "$name must call Assert-ClientWindows -Script '$name' before anything else (first: $($first.Extent.Text))"
}
foreach ($name in 'Set-ClaudeCodeGateway.ps1', 'Restore-ClaudeCodeGateway.ps1', 'Test-ClientGatewayAccess.ps1') {
    Assert-Contract ((Get-Content -LiteralPath (Join-Path $clientDir $name) -Raw) -notmatch 'Assert-ClientWindows') "$name runs on macOS and Linux (ADR-0048) and must not stop with unsupported_platform"
}

# 4. The deployer's pages are followed in pwsh on macOS too. A native command (node, npm, az) gets its arguments
#    unchanged, so a .\ or backslash path fails there; Windows-only folders and drive letters do not exist.
#    05-developer-setup.md is Windows-only by statement and excluded.
$pages = @('README.md', 'docs/STAGED-DEPLOYMENT-GUIDE.md') + @(Get-ChildItem (Join-Path $root 'docs/get-started'), (Join-Path $root 'docs/operate') -Filter '*.md' |
    Where-Object Name -ne '05-developer-setup.md' | ForEach-Object { $_.FullName.Substring($root.Length + 1) })
$windowsOnly = foreach ($page in $pages) {
    $text = Get-Content -LiteralPath (Join-Path $root $page) -Raw
    foreach ($block in [regex]::Matches($text, '(?ms)^```(?:powershell|pwsh)\s*$(.*?)^```')) {
        foreach ($line in ($block.Groups[1].Value -split "`r?`n")) {
            if ($line -match '(^|[\s(''"])\.\\|\b[A-Za-z]:\\|\$env:(USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|ComSpec)\b|\bcmd(\.exe)? /c\b|\.cmd\b') { "${page}: $($line.Trim())" }
        }
    }
}
Assert-Contract (-not @($windowsOnly).Count) "Deployer pages hold Windows-only commands: $(@($windowsOnly) -join ' | ')"

"Cross-platform: $passed checks passed (Windows-only cmd.exe guards, hidden-file removal, client scripts stop off Windows). No Azure calls."
