#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }; $script:passed++
}
$script:StateDir = Join-Path $root '.env.staged-redeployment-test'
[void][IO.Directory]::CreateDirectory($script:StateDir)
$cfg = @{
    tenantId = 't'; subscriptionId = 's'; resourceGroup = 'redeploy-test'; stage1 = @{}
    cosmos = @{ databaseName = 'ccof' }; reconciler = @{ budgetGuard = @{ warnPercent = 80 } }
}
$script:fixtureState = @{ stages = @{} }
foreach ($n in 1, 3, 4) { $script:fixtureState.stages["$n"] = @{ outputs = @{ stable = "stage-$n" } } }
foreach ($n in 2, 5) {
    $script:fixtureState.stages["$n"] = @{
        configHash = Get-StgStageInput $cfg $n; dependencyHashes = Get-StgDependencyHashes $script:fixtureState $n
        outputs = @{ marker = 'old-completion' }
    }
}
$script:deploys = 0; $script:previews = 0; $script:failDeployment = $false
function Read-StgState { param($Cfg) $script:fixtureState }
function Write-StgEvidence { param($Name, $Value) '' }
function Invoke-QsAz { param([string[]]$Arguments)
    if (($Arguments -join ' ') -like 'deployment group create*') {
        $script:deploys++; $script:lastDeployment = $Arguments
    } elseif (($Arguments -join ' ') -like 'deployment group what-if*') {
        $script:previews++; return @{ changes = @() }
    } else { throw "Unexpected Azure call: $($Arguments -join ' ')" }
    @{ properties = @{
        provisioningState = if ($script:failDeployment) { 'Failed' } else { 'Succeeded' }
        outputs = @{ marker = @{ value = "deployment-$script:deploys" } }
    } }
}
try {
    foreach ($n in 2, 5) {
        $script:previews = 0
        $preview = Invoke-StgBicep -Cfg $cfg -Template 'unused.bicep' -Name "stage$n" -StageNumber $n -Parameters @{} 6>&1 | Out-String
        Assert-Contract ($preview.Contains('no configuration change; -Apply redeploys the same template (idempotent; Stage 5 restarts the Function Apps)') -and
            $preview -notmatch 'verify-only|no change will be planned') "AO-3 review: Stage $n unchanged preview must disclose redeployment and Stage 5 restarts, not promise verify-only."
        Assert-Contract ($script:previews -eq 0 -and $script:deploys -eq 0) "AO-3 review: Stage $n unchanged preview remains read-only."
    }
    foreach ($n in 2, 5) {
        $script:deploys = 0
        foreach ($case in @(
            @{ template = 'unused.bicep'; parameters = @{ databaseName = 'ccof' } },
            @{ template = 'updated-template.bicep'; parameters = @{ databaseName = 'ccof' } },
            @{ template = 'updated-template.bicep'; parameters = @{ databaseName = 'CHANGED_EFFECTIVE_PARAMETER' } }
        )) {
            $before = $script:deploys
            $out = Invoke-StgBicep -Cfg $cfg -Template $case.template -Name "stage$n" -StageNumber $n -Parameters $case.parameters -Apply
            Assert-Contract ($script:deploys -eq ($before + 1) -and $out.marker -ceq "deployment-$script:deploys") "AO-3 review: Stage $n apply must deploy current templates/effective parameters even with unchanged saved config."
            Assert-Contract ($script:lastDeployment -contains (Join-Path $script:StagedDir $case.template)) "AO-3 review: Stage $n must send the current template to ARM."
        }
        $changed = $cfg.Clone(); $changed.cosmos = @{ databaseName = 'failed-B' }; $changed.reconciler = @{ budgetGuard = @{ warnPercent = 79 } }
        $script:failDeployment = $true
        $message = ''; try { $null = Invoke-StgBicep -Cfg $changed -Template 'unused.bicep' -Name "stage$n" -StageNumber $n -Parameters @{} -Apply } catch { $message = $_.Exception.Message }
        Assert-Contract ($message -match 'provisioning state is Failed') "AO-3 review: Stage $n failed apply must remain a failure."
        $script:failDeployment = $false
        $before = $script:deploys
        $null = Invoke-StgBicep -Cfg $cfg -Template 'unused.bicep' -Name "stage$n" -StageNumber $n -Parameters @{} -Apply
        Assert-Contract ($script:deploys -eq ($before + 1)) "AO-3 review: Stage $n A -> failed B -> A must redeploy despite the old A completion record."
    }
    # AO-4 remains independent of the withdrawn no-op apply behavior.
    $null = Write-StgParameters $cfg 'stage5-config' @{ reconciler = @{ budgetGuard = @{ warnPercent = 80 } }; tenantId = 't' }
    $changed = $cfg.Clone(); $changed.reconciler = @{ budgetGuard = @{ warnPercent = 79 } }
    $preview = Invoke-StgBicep -Cfg $changed -Template 'unused.bicep' -Name 'stage5-config' -StageNumber 5 -Parameters @{
        reconciler = $changed.reconciler; tenantId = 't'
    } 6>&1 | Out-String
    Assert-Contract ($preview -match 'changed parameters: reconciler' -and $preview -notmatch 'changed parameters:[^\r\n]*tenantId') 'AO-4: changed Stage 5 preview must name reconciler, not unchanged parameters or their values.'
    $null = Invoke-StgBicep -Cfg $cfg -Template 'unused.bicep' -Name 'stage5-config' -StageNumber 5 -Parameters @{ reconciler = $cfg.reconciler; tenantId = 't' } -Apply
    foreach ($attempt in 1, 2) {
        $preview = Invoke-StgBicep -Cfg $changed -Template 'unused.bicep' -Name 'stage5-config' -StageNumber 5 -Parameters @{ reconciler = $changed.reconciler; tenantId = 't' } 6>&1 | Out-String
        Assert-Contract ($preview -match 'changed parameters: reconciler' -and $preview -match 'stage5-config.applied.parameters.json') 'AO-4: repeated previews must compare with the applied snapshot, not overwrite the comparison baseline.'
    }
} finally { Remove-Item -LiteralPath $script:StateDir -Recurse -Force }
"Staged redeployment: $passed checks passed. No Azure calls."
