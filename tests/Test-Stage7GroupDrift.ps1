#Requires -Version 7.0
<#
.SYNOPSIS
    Offline tests for Stage 7 and group documents that differ from the configuration (council round 3, R3-2).
    By default Stage 7 stops with seed_documents_differ naming each group and its differing fields and the opt-in;
    with stage7.keepDifferingGroups true it keeps the console's version, prints a summary line and records the kept
    groups in its evidence. No Azure call: the seed function call is replaced by a fake.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:passed++ }

. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly

$g1 = '0000000a-0000-4000-8000-0000000000aa'; $g2 = '0000000b-0000-4000-8000-0000000000bb'
$groupDocs = @(
    [ordered]@{ id = $g1; kind = 'group'; displayName = 'Research team' },
    [ordered]@{ id = $g2; kind = 'group'; displayName = 'Data team' })
$ctx = @{ P = @{}; State = @{ completed = @{ '1' = @{ outputs = @{ classificationGroupDisplayNames = @{} } } } } }

# The fake seed: every group named in -KeepDiffering differs (as the real step reports it in kept); the call is recorded.
$script:SeedCalls = [Collections.Generic.List[object]]::new()
$script:Differing = @{}
function New-QsSeedDocuments { param($P, $ClassificationGroupDisplayNames) @{ projects = @(); backends = @() } }
function Invoke-QsSeedThroughFunction {
    param($Ctx, $Documents, [string[]]$KeepDiffering = @())
    $script:SeedCalls.Add(@{ documents = $Documents; keep = $KeepDiffering })
    $kept = @(foreach ($k in $KeepDiffering) { if ($script:Differing.ContainsKey($k)) { [ordered]@{ document = $k; fields = $script:Differing[$k] } } })
    return @{ mechanism = 'registrySeed'; seedId = 'fake'; documents = @(); kept = $kept }
}

# Default: a differing group stops Stage 7, naming each group, its fields and the opt-in.
$script:Differing = @{ "projects/$g1" = @('budget', 'displayName'); "projects/$g2" = @('surfaces') }
$message = try { $null = Invoke-StgSeed -Ctx $ctx -GroupDocuments $groupDocs; '' } catch { $_.Exception.Message }
Assert-Contract ($message -match '^seed_documents_differ') "A differing group must stop Stage 7 with seed_documents_differ by default: $message"
Assert-Contract ($message.Contains("Research team (projects/$g1): budget, displayName") -and $message.Contains("Data team (projects/$g2): surfaces")) "The error must list each group and its differing fields: $message"
Assert-Contract ($message.Contains('stage7.keepDifferingGroups') -and $message -match 'admin console') "The error must name the opt-in and the admin console: $message"
Assert-Contract ((@($script:SeedCalls[-1].keep) -join ',') -ceq "projects/$g1,projects/$g2") 'Stage 7 must ask the seed step to report differing groups, so it can name them.'

# Nothing differs: the seed passes with or without the opt-in.
$script:Differing = @{}
$seed = Invoke-StgSeed -Ctx $ctx -GroupDocuments $groupDocs
Assert-Contract (@($seed.kept).Count -eq 0 -and $null -eq (Format-StgKeptGroups -Kept $seed.kept -GroupDocuments $groupDocs)) 'Without differing groups Stage 7 passes and prints no kept line.'

# Opt-in: the console's version is kept, a summary line names them, and the evidence records them with their fields.
$script:Differing = @{ "projects/$g1" = @('budget', 'displayName') }
$seed = Invoke-StgSeed -Ctx $ctx -GroupDocuments $groupDocs -KeepDifferingGroups $true
Assert-Contract (@($seed.kept).Count -eq 1 -and $seed.kept[0].document -ceq "projects/$g1" -and (@($seed.kept[0].fields) -join ',') -ceq 'budget,displayName') 'With stage7.keepDifferingGroups the differing group is kept and returned with its fields.'
$line = Format-StgKeptGroups -Kept $seed.kept -GroupDocuments $groupDocs
Assert-Contract ($line -ceq "kept 1 console-edited group(s): Research team (projects/$g1): budget, displayName") "The summary line must count and name the kept groups: $line"
$evidence = @{ seed = $seed } | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
Assert-Contract ($evidence.seed.kept[0].document -ceq "projects/$g1" -and (@($evidence.seed.kept[0].fields) -join ',') -ceq 'budget,displayName') 'The Stage 7 evidence must record the kept groups and their differing fields.'
$stage7 = (Get-Command Invoke-Stage7).ScriptBlock.ToString()
Assert-Contract ($stage7 -match 'Invoke-StgSeed -Ctx \$ctx -GroupDocuments \$groupDocs -KeepDifferingGroups \(\$Cfg\.stage7\.keepDifferingGroups -eq \$true\)') 'Stage 7 must pass stage7.keepDifferingGroups to the seed.'
$publishAt = $stage7.IndexOf('$code = Invoke-QsCode'); $seedAt = $stage7.IndexOf('$result.seed = Invoke-StgSeed')
Assert-Contract ($publishAt -ge 0 -and $seedAt -gt $publishAt) 'The post-publish seed check must remain after package publishing.'
$evidenceAt = $stage7.IndexOf("Write-StgEvidence 'stage7.verify.json' `$result"); $summaryAt = $stage7.IndexOf('Format-StgKeptGroups -Kept $result.seed.kept')
Assert-Contract ($evidenceAt -ge 0 -and $summaryAt -gt $evidenceAt) 'Stage 7 must write its evidence (with the kept groups) and print the kept line at the end.'

# Non-group documents always stop: only group documents are offered to -KeepDiffering.
Assert-Contract (-not (@($script:SeedCalls | ForEach-Object { $_.keep } | Where-Object { $_ -notmatch '^projects/0000000[ab]-' }).Count)) 'Only group documents may be kept.'

# The Stage 7 preflight is read-only and returns the same document/field shape used by seed refusal.
$script:restReads = [Collections.Generic.List[object]]::new()
$script:storedGroup = $groupDocs[0] | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable
$script:storedGroup.displayName = 'Edited team'
$script:readMode = 'success'
$script:tokenFailure = $false
$savedAzForDrift = ${function:Invoke-QsAz}
$savedRestForDrift = if (Test-Path function:Invoke-RestMethod) { (Get-Item function:Invoke-RestMethod).ScriptBlock } else { $null }
try {
    Set-Item function:Invoke-QsAz { param([string[]]$Arguments) if ($Arguments -join ' ' -match 'get-access-token') { if ($script:tokenFailure) { throw 'CLI token unavailable' }; return 'fake-cosmos-token' }; throw 'unexpected az write' }
    Set-Item function:Invoke-RestMethod {
        param($Method, $Uri, $Headers, $TimeoutSec)
        $script:restReads.Add(@{ method = $Method; uri = $Uri; headers = $Headers; timeoutSec = $TimeoutSec })
        if ($script:readMode -ceq 'http403') { throw [Exception]::new('HTTP 403') }
        if ($script:readMode -ceq 'http404') { throw [Exception]::new('HTTP 404') }
        if ($script:readMode -ceq 'network') { throw [Net.WebException]::new('network unreachable') }
        if ($script:readMode -ceq 'timeout') { throw [TimeoutException]::new('request timed out') }
        return $script:storedGroup
    }
    $drift = @(Get-StgGroupSeedDrift -Endpoint 'https://account.documents.azure.com:443/' -DatabaseName 'ccof' -Documents @($groupDocs[0]))
    Assert-Contract ($drift.Count -eq 1 -and $drift[0].document -ceq "projects/$g1" -and (@($drift[0].fields) -join ',') -ceq 'displayName') 'Read-only preflight must name the existing group and differing seeded fields.'
    Assert-Contract ($script:restReads.Count -eq 1 -and $script:restReads[0].method -ceq 'Get' -and $script:restReads[0].headers.Authorization -match '^type=aad&ver=1\.0&sig=fake-cosmos-token$' -and $script:restReads[0].headers.'x-ms-documentdb-partitionkey' -ceq "[`"$g1`"]" -and $script:restReads[0].timeoutSec -eq 10) 'Preflight must use a bounded authenticated Cosmos point-read with the group ID partition key.'
    $script:storedGroup = $groupDocs[0]
    Assert-Contract (-not @(Get-StgGroupSeedDrift -Endpoint 'https://account.documents.azure.com/' -DatabaseName 'ccof' -Documents @($groupDocs[0])).Count) 'An equal stored group document is not drift.'
    $warningCases = @(
        @{ mode = 'http403'; reason = 'HTTP 403' },
        @{ mode = 'network'; reason = 'network error' },
        @{ mode = 'timeout'; reason = 'timeout' })
    foreach ($case in $warningCases) {
        $script:readMode = $case.mode
        $before = $script:restReads.Count
        $warning = Get-StgGroupSeedDrift -Endpoint 'https://account.documents.azure.com/' -DatabaseName 'ccof' -Documents @($groupDocs[0]) *>&1 | Out-String
        $warningLines = @($warning -split "`r?`n" | Where-Object { $_ -match '^preview/preflight:' })
        Assert-Contract ($warningLines.Count -eq 1 -and $warningLines[0].Contains("($($case.reason)); the seed step checks them after publishing") -and $script:restReads.Count -eq ($before + 1) -and $script:restReads[-1].timeoutSec -eq 10) "A $($case.mode) read failure must warn once and continue without drift."
        Assert-Contract ($warningLines[0] -match 'admin console.*Groups' -and $warningLines[0] -match 'stage7.keepDifferingGroups' -and $warningLines[0] -match 'private endpoint') 'AO-5: the one-line unreachable-Cosmos warning must name the admin Groups page, private endpoint possibility, and keepDifferingGroups next step.'
    }
    $script:readMode = 'http404'
    $before = $script:restReads.Count
    $notFound = Get-StgGroupSeedDrift -Endpoint 'https://account.documents.azure.com/' -DatabaseName 'ccof' -Documents @($groupDocs[0]) *>&1 | Out-String
    Assert-Contract (-not $notFound.Contains('preview/preflight:') -and $script:restReads.Count -eq ($before + 1)) 'A missing group document remains no drift and does not warn.'
    $script:readMode = 'success'; $script:tokenFailure = $true
    $tokenWarning = Get-StgGroupSeedDrift -Endpoint 'https://account.documents.azure.com/' -DatabaseName 'ccof' -Documents @($groupDocs[0]) *>&1 | Out-String
    Assert-Contract ($tokenWarning.Contains('preview/preflight: could not read group documents before publishing (token unavailable); the seed step checks them after publishing')) 'A missing token must warn and continue rather than block Stage 7.'
} finally {
    ${function:Invoke-QsAz} = $savedAzForDrift
    if ($savedRestForDrift) { Set-Item function:Invoke-RestMethod $savedRestForDrift } else { Remove-Item function:Invoke-RestMethod -ErrorAction SilentlyContinue }
}

# Drift refusal must precede any package build/publish; keepDifferingGroups may pass the same guard.
$savedFunctions = @{}
foreach ($name in 'Get-StgStage', 'New-StgQsContext', 'New-StgGroupDocuments', 'Assert-StgClientSignInMethod', 'Assert-StgClientAliases', 'Assert-StgGroupsExist', 'Get-StgGroupSeedDrift', 'Invoke-QsCode', 'Invoke-QsAz') {
    $savedFunctions[$name] = (Get-Item "function:$name").ScriptBlock
}
$script:preflightDrift = @([ordered]@{ document = "projects/$g1"; fields = @('budget', 'displayName') })
$script:publishCalls = 0
try {
    Set-Item function:Get-StgStage { param($Cfg, [int]$Number) if ($Number -eq 4) { return @{ groups = @{}; azureCliClientAllowed = $false } }; return @{} }
    Set-Item function:New-StgQsContext { param($Cfg) $ctx }
    Set-Item function:New-StgGroupDocuments { param($Groups, $EntraGroups) $groupDocs }
    Set-Item function:Assert-StgClientSignInMethod { param($Cfg, [bool]$AzureCliAllowed) }
    Set-Item function:Assert-StgClientAliases { param($Cfg) }
    Set-Item function:Assert-StgGroupsExist { param($Documents) }
    Set-Item function:Get-StgGroupSeedDrift { param($Endpoint, $DatabaseName, $Documents) $script:preflightDrift }
    Set-Item function:Invoke-QsCode { param($Ctx) $script:publishCalls++; throw 'test_stop_after_publish' }
    $stage7Cfg = @{ stage1 = @{ includeAdmin = $false }; groups = @(); client = @{}; stage7 = @{} }
    $refused = try { $null = Invoke-Stage7 -Cfg $stage7Cfg -Apply; '' } catch { $_.Exception.Message }
    Assert-Contract ($refused -match '^seed_documents_differ' -and $refused.Contains('Research team') -and $refused.Contains('budget, displayName') -and $script:publishCalls -eq 0) 'Drift refusal must name the group/fields before build or publish.'
    $preview = Invoke-Stage7 -Cfg $stage7Cfg *>&1 | Out-String
    Assert-Contract ($preview.Contains('would be refused') -and $preview.Contains('Research team') -and $preview.Contains('budget, displayName') -and $script:publishCalls -eq 0) 'Preview must identify which group/fields will be refused without publishing.'
    $stage7Cfg.stage7.keepDifferingGroups = $true
    $preview = Invoke-Stage7 -Cfg $stage7Cfg *>&1 | Out-String
    Assert-Contract ($preview.Contains('will be kept') -and $preview.Contains('Research team') -and $preview.Contains('budget, displayName') -and $script:publishCalls -eq 0) 'Opt-in preview must identify which group/fields will be kept without publishing.'
    $kept = try { $null = Invoke-Stage7 -Cfg $stage7Cfg -Apply; '' } catch { $_.Exception.Message }
    Assert-Contract ($kept -ceq 'test_stop_after_publish' -and $script:publishCalls -eq 1) 'keepDifferingGroups must allow the Stage 7 apply to continue after read-only drift detection.'
    Set-Item function:Get-StgGroupSeedDrift $savedFunctions['Get-StgGroupSeedDrift']
    Set-Item function:Invoke-QsAz { param([string[]]$Arguments) throw 'missing private Cosmos route' }
    $stage7Cfg.stage7.keepDifferingGroups = $false
    $fallbackLines = [Collections.Generic.List[string]]::new()
    $script:publishCalls = 0
    $fallback = try { Invoke-Stage7 -Cfg $stage7Cfg -Apply *>&1 | ForEach-Object { $fallbackLines.Add("$_") }; '' } catch { $_.Exception.Message }
    Assert-Contract ($fallback -ceq 'test_stop_after_publish' -and $script:publishCalls -eq 1 -and @($fallbackLines | Where-Object { $_ -match '^preview/preflight: could not read group documents before publishing \(token unavailable\); the seed step checks them after publishing; check the admin console Groups page before republishing' }).Count -eq 1) 'A failed preflight token lookup must warn once and still reach the post-publish seed step.'
} finally {
    foreach ($name in $savedFunctions.Keys) { Set-Item "function:$name" $savedFunctions[$name] }
}

# Validation and hash: stage7 holds only keepDifferingGroups, a JSON boolean; present only when configured.
Assert-Contract (-not @(Get-StgStage7Problems @{}).Count -and -not @(Get-StgStage7Problems @{ stage7 = @{ keepDifferingGroups = $true } }).Count -and -not @(Get-StgStage7Problems @{ stage7 = @{ keepDifferingGroups = $false } }).Count) 'An absent stage7 or a boolean keepDifferingGroups is valid.'
foreach ($bad in @(@{ keepDifferingGroups = 'true' }, @{ keepDifferingGroups = $true; other = 1 }, 'yes')) {
    Assert-Contract (@(Get-StgStage7Problems @{ stage7 = $bad }) -match 'stage7\.keepDifferingGroups').Count "stage7 must be refused: $($bad | ConvertTo-Json -Compress)"
}
$validate = Get-Content -Raw (Join-Path $root 'infra\staged\Staged.Common.ps1')
Assert-Contract ($validate -match 'Get-StgStage7Problems \$c') 'The driver must validate stage7.'
$base = @{ tenantId = 't'; subscriptionId = 's'; resourceGroup = 'r'; stage1 = @{}; groups = @() }
$with = $base.Clone(); $with.stage7 = @{ keepDifferingGroups = $true }
foreach ($stage in 0..8) {
    $changed = (Get-StgStageInput $base $stage) -cne (Get-StgStageInput $with $stage)
    Assert-Contract ($changed -eq ($stage -eq 7)) "stage7.keepDifferingGroups must change only the Stage 7 hash (stage $stage)."
}

Write-Host "Stage 7 group drift: $passed assertions passed."
