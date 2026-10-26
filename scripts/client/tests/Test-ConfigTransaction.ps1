#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
. (Join-Path $repo 'scripts\client\ClaudeCodeGateway.ps1')
. (Join-Path $repo 'scripts\client\ClaudeDesktopGateway.ps1')
$work = Join-Path $repo ('client\.test-work\transaction-' + [guid]::NewGuid().ToString('N'))
$savedComplete = ${function:Complete-ClientSnapshot}
try {
    $a = (([IO.File]::ReadAllText((Join-Path $repo 'client\config.example.json'))).Replace('REPLACE-', '') | ConvertFrom-Json -AsHashtable)
    $b = $a.Clone(); $b.gatewayUrl = 'https://gateway-b.example.test/anthropic'
    $source = Join-Path $work 'Downloads\b.json'; Write-ClientJson $source $b
    $live = Join-Path $work 'live\config.json'
    $node = (Get-Command node).Source
    $schema = @{ credentialKinds = @('helper-script'); keys = @('inferenceProvider', 'inferenceGatewayBaseUrl',
        'inferenceGatewayAuthScheme', 'inferenceModels', 'inferenceCredentialKind', 'inferenceCredentialHelper',
        'inferenceCredentialHelperArgs', 'inferenceCredentialHelperTtlSec', 'inferenceCredentialHelperTimeoutSec',
        'inferenceCredentialHelperSilentRefreshEnabled') }
    foreach ($kind in @('claude-code', 'claude-desktop')) {
        Write-ClientJson $live $a
        $before = [IO.File]::ReadAllText($live)
        $common = @{ ConfigPath = $source; InstalledConfigPath = $live; BackupRoot = (Join-Path $work "$kind-backups")
            NodePath = $node; TokenEntryPath = (Join-Path $repo 'client\bin\ccof-token.mjs'); Confirmed = $true }
        if ($kind -eq 'claude-code') {
            $command = 'Set-CcofClaudeCode'
            $options = $common + @{ ClaudeHome = (Join-Path $work '.claude'); OnWindows = $true
                UsageEntryPath = (Join-Path $repo 'client\bin\ccof-usage.mjs'); Inventory = @{ CliVersion = '2.1.272' } }
            $settings = Join-Path $options.ClaudeHome 'settings.json'
            Write-ClientText $settings '{"env":"invalid"}'
        } else {
            $command = 'Set-CcofClaudeDesktop'
            $options = $common + @{ LibraryPath = (Join-Path $work 'Desktop\configLibrary'); Schema = $schema
                Inventory = @{ DesktopVersion = '1.0.0' } }
            $settings = Join-Path $options.LibraryPath '_meta.json'
            Write-ClientText $settings '{"entries":"invalid"}'
        }
        try { & $command @options | Out-Null; throw 'Expected preflight refusal' }
        catch { if ($_.Exception.Message -notmatch 'must be (an object|an array)') { throw } }
        if ([IO.File]::ReadAllText($live) -cne $before) { throw "$kind preflight replaced the working configuration" }
        Write-ClientJson $settings @{}
        $settingsBefore = [IO.File]::ReadAllText($settings)
        $installedInventory = $options.Inventory
        $options.Inventory = @{}
        $absent = & $command @options | ConvertFrom-Json -AsHashtable
        if ($absent.event -cne 'not_installed' -or [IO.File]::ReadAllText($live) -cne $before) { throw "$kind not_installed replaced the working configuration" }
        $options.Inventory = $installedInventory
        function Complete-ClientSnapshot { param($Snapshot) throw 'Injected completion failure' }
        try { & $command @options | Out-Null; throw 'Expected transactional failure' }
        catch { if ($_.Exception.Message -notmatch 'Injected completion failure') { throw } }
        finally { ${function:Complete-ClientSnapshot} = $savedComplete }
        if ([IO.File]::ReadAllText($live) -cne $before) { throw "$kind failed setup replaced the working configuration" }
        if ([IO.File]::ReadAllText($settings) -cne $settingsBefore) { throw "$kind failed setup left changed client settings" }
        $result = & $command @options | ConvertFrom-Json -AsHashtable
        if ((Read-ClientJson $live).gatewayUrl -cne $b.gatewayUrl) { throw "$kind successful setup did not replace configuration" }
        $backup = Join-Path $common.BackupRoot $result.changeId
        $manifest = Read-ClientJson (Join-Path $backup 'snapshot.json')
        if (-not ($manifest.files | Where-Object { $_.path -ceq $live })) { throw "$kind snapshot omitted the shared configuration" }
        Restore-ClientSnapshot -BackupPath $backup -Kind $kind -Confirmed | Out-Null
        if ([IO.File]::ReadAllText($live) -cne $before) { throw "$kind Restore did not return the previous configuration" }
        if ([IO.File]::ReadAllText($settings) -cne $settingsBefore) { throw "$kind Restore did not return the previous settings" }
        Write-Host "PASS: $kind preflight, not_installed, rollback, publication and Restore"
    }
} finally {
    ${function:Complete-ClientSnapshot} = $savedComplete
    if (Test-Path $work) { Remove-Item $work -Recurse -Force }
}
exit 0
