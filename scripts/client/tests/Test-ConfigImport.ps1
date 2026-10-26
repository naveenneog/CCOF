#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
. (Join-Path $repo 'scripts\client\ClaudeCodeGateway.ps1')
. (Join-Path $repo 'scripts\client\ClientProcess.ps1')
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
    $profile = Join-Path $work 'profile'
    $bin = Join-Path $work 'bin'
    if ($IsWindows) { Write-ClientText (Join-Path $bin 'claude.cmd') "@echo off`r`necho 2.1.272`r`n" }
    else {
        Write-ClientText (Join-Path $bin 'claude') "#!/bin/sh`necho 2.1.272`n" -UnixMode 448
        Write-ClientText (Join-Path $bin 'az') "#!/bin/sh`nexit 99`n" -UnixMode 448
    }
    Write-ClientJson $source $config
    $child = Invoke-CcofChild -FilePath (Join-Path $repo 'scripts\client\Set-ClaudeCodeGateway.ps1') `
        -Arguments @('-ConfigPath', $source, '-Confirmed') -WorkingDirectory $repo -TimeoutSeconds 120 `
        -Environment @{ HOME = $profile; USERPROFILE = $profile; APPDATA = (Join-Path $profile 'appdata')
            LOCALAPPDATA = $env:LOCALAPPDATA; XDG_CONFIG_HOME = $env:XDG_CONFIG_HOME
            PATH = "$bin$([IO.Path]::PathSeparator)$env:PATH" }
    if ($child.ExitCode -ne 0) { throw "Setup failed: $($child.Stderr)" }
    Remove-Item -LiteralPath $source
    $settings = Read-ClientJson (Join-Path $profile '.claude/settings.json')
    if ($settings.env.CCOF_CONFIG_FILE -cne $installed) { throw 'Installed settings still depend on the deleted download' }
    $wrapper = [IO.File]::ReadAllText((Join-Path $profile '.claude/ccof-usage.ps1'))
    if (-not $wrapper.Contains($installed.Replace("'", "''"))) { throw 'Usage wrapper still depends on the deleted download' }
    if (-not (Test-Path (Join-Path (Split-Path $installed -Parent) 'backups'))) { throw 'Default backups were not placed with the installed configuration' }
    $before = [IO.File]::ReadAllText($installed)
    $settingsBefore = [IO.File]::ReadAllText((Join-Path $profile '.claude\settings.json'))
    Write-ClientText (Join-Path $profile '.claude\settings.json') '{"env":"invalid"}'
    $other = $config.Clone(); $other.gatewayUrl = 'https://gateway-b.example.test/anthropic'
    Write-ClientJson $source $other
    $failed = Invoke-CcofChild -FilePath (Join-Path $repo 'scripts\client\Set-ClaudeCodeGateway.ps1') `
        -Arguments @('-ConfigPath', $source, '-Confirmed') -WorkingDirectory $repo -TimeoutSeconds 120 `
        -Environment @{ HOME = $profile; USERPROFILE = $profile; APPDATA = (Join-Path $profile 'appdata')
            LOCALAPPDATA = $env:LOCALAPPDATA; XDG_CONFIG_HOME = $env:XDG_CONFIG_HOME
            PATH = "$bin$([IO.Path]::PathSeparator)$env:PATH" }
    if ($failed.ExitCode -eq 0) { throw 'Invalid settings did not refuse setup' }
    if ([IO.File]::ReadAllText($installed) -cne $before) { throw 'Failed public setup replaced the previous live configuration' }
    Write-ClientText (Join-Path $profile '.claude\settings.json') $settingsBefore
    foreach ($entrypoint in @('Set-ClaudeCodeGateway.ps1', 'Set-ClaudeDesktopGateway.ps1')) {
        if (-not $IsWindows -and $entrypoint -like '*Desktop*') { continue }
        $scriptPath = (Join-Path $repo "scripts\client\$entrypoint").Replace("'", "''")
        $inputPath = $source.Replace("'", "''")
        $command = "function NoInstalledClients { @{ CliVersion = `$null; VSCodeVersion = `$null; DesktopVersion = `$null } }; Set-Alias Get-CcofClientInventory NoInstalledClients; & '$scriptPath' -ConfigPath '$inputPath' -Confirmed"
        $absent = Invoke-CcofChild -FilePath (Get-Command pwsh).Source -Arguments @('-NoProfile', '-Command', $command) `
            -WorkingDirectory $repo -TimeoutSeconds 120 `
            -Environment @{ HOME = $profile; USERPROFILE = $profile; APPDATA = (Join-Path $profile 'appdata')
                LOCALAPPDATA = $env:LOCALAPPDATA; XDG_CONFIG_HOME = $env:XDG_CONFIG_HOME
                PATH = "$bin$([IO.Path]::PathSeparator)$env:PATH" }
        if ($absent.ExitCode -ne 0 -or ($absent.Stdout | ConvertFrom-Json).event -cne 'not_installed') { throw "$entrypoint did not report not_installed: $($absent.Stderr)" }
        if ([IO.File]::ReadAllText($installed) -cne $before) { throw "$entrypoint not_installed replaced the previous live configuration" }
    }
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
