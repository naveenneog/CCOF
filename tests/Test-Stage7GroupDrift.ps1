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
$evidenceAt = $stage7.IndexOf("Write-StgEvidence 'stage7.verify.json' `$result"); $summaryAt = $stage7.IndexOf('Format-StgKeptGroups -Kept $result.seed.kept')
Assert-Contract ($evidenceAt -ge 0 -and $summaryAt -gt $evidenceAt) 'Stage 7 must write its evidence (with the kept groups) and print the kept line at the end.'

# Non-group documents always stop: only group documents are offered to -KeepDiffering.
Assert-Contract (-not (@($script:SeedCalls | ForEach-Object { $_.keep } | Where-Object { $_ -notmatch '^projects/0000000[ab]-' }).Count)) 'Only group documents may be kept.'

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
