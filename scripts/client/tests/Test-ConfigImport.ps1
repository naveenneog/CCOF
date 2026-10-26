#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
. (Join-Path $repo 'scripts\client\ClaudeCodeGateway.ps1')
$work = Join-Path $repo ('client\.test-work\import-' + [guid]::NewGuid().ToString('N'))
$previousLocal = $env:LOCALAPPDATA
$previousConfig = $env:CCOF_CONFIG_FILE
$previousXdg = $env:XDG_CONFIG_HOME
try {
    New-ClientDirectory $work
    $env:LOCALAPPDATA = Join-Path $work 'local'
    $env:XDG_CONFIG_HOME = Join-Path $work 'xdg'
    $source = Join-Path $work 'Downloads\client-config.json'
    $config = (([IO.File]::ReadAllText((Join-Path $repo 'client\config.example.json'))).Replace('REPLACE-', '') | ConvertFrom-Json -AsHashtable)
    if (-not $IsWindows) { $config.signInMethod = 'azure-cli' }
    Write-ClientJson $source $config
    $env:CCOF_CONFIG_FILE = $source
    $installed = Install-ClientConfiguration $source
    $expected = if ($IsWindows) { Join-Path $env:LOCALAPPDATA 'ClaudeGateway\config.json' } else { Join-Path $env:XDG_CONFIG_HOME 'ClaudeGateway/config.json' }
    if ($installed -cne $expected) { throw 'Setup must use the per-user copy, not Downloads or CCOF_CONFIG_FILE' }
    Remove-Item -LiteralPath $source
    $loaded = Read-ClientConfiguration $installed
    if ($loaded.gatewayUrl -cne $config.gatewayUrl) { throw 'Installed configuration lost after download cleanup' }
    if ((Install-ClientConfiguration $installed) -cne $installed) { throw 'Rerun must accept the installed copy' }
    $before = [IO.File]::ReadAllText($installed)
    $bad = Join-Path $work 'bad.json'
    Write-ClientText $bad '{}'
    try { Install-ClientConfiguration $bad; throw 'Expected invalid configuration refusal' }
    catch { if ($_.Exception.Message -notmatch 'missing or invalid') { throw } }
    if ([IO.File]::ReadAllText($installed) -cne $before) { throw 'Invalid input replaced installed configuration' }
    $unsupported = Join-Path $work 'msal.json'
    $msal = $config.Clone(); $msal.Remove('signInMethod'); Write-ClientJson $unsupported $msal
    try { Install-ClientConfiguration $unsupported -OnWindows:$false; throw 'Expected unsupported sign-in refusal before import' }
    catch { if ($_.Exception.Message -notmatch 'unsupported_sign_in_method') { throw } }
    $posixDestination = Join-Path $env:XDG_CONFIG_HOME 'ClaudeGateway/config.json'
    if ($IsWindows -and (Test-Path $posixDestination)) { throw 'Unsupported sign-in imported a configuration' }
    try { Read-ClientConfiguration (Join-Path $work 'missing.json'); throw 'Expected missing configuration refusal' }
    catch {
        if ($_.Exception.Message -notmatch 'missing.json' -or $_.Exception.Message -notmatch '-ConfigPath') {
            throw "Missing configuration must name its path and -ConfigPath: $($_.Exception.Message)"
        }
    }
    Write-Host 'PASS: downloaded configuration is imported and missing configuration names its remedy'
} finally {
    $env:LOCALAPPDATA = $previousLocal
    $env:CCOF_CONFIG_FILE = $previousConfig
    $env:XDG_CONFIG_HOME = $previousXdg
    if (Test-Path $work) { Remove-Item $work -Recurse -Force }
}
exit 0
