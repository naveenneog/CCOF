#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }; $script:passed++
}
$cfg = @{
    tenantId = 't'; subscriptionId = 's'; resourceGroup = 'recovery-test'; location = 'eastus2'
    stage1 = @{ functionsPublicNetworkAccess = 'Enabled'; cosmosPublicNetworkAccess = 'Disabled'; foundry = @{ create = $false } }
    cosmos = @{ databaseName = 'ccof' }; network = @{ mode = 'verify'; existing = @{ functionsSubnetId = '/configured/subnet' } }
}
$script:fixtureState = @{ stages = @{} }
$script:fixtureSettings = @(@{ name = 'EXPECTED_SETTING' })
$script:fixtureDatabases = @()
$script:fixtureGrants = @()
$script:fixtureCosmosRoles = @()
$script:fixtureOut = @{
    names = @{ apps = @{}; cosmosAccount = 'owned-cosmos' }
    functionApps = @(@{ key = 'resolver'; service = @{ name = 'resolver'; principalId = '00000000-0000-4000-8000-000000000001' } })
    apimName = ''; apimStatus = 'existing'
}
function Read-StgState { param($Cfg) $script:fixtureState }
function Get-StgSite { param($Cfg, $Name)
    @{ publicNetworkAccess = 'Enabled'; virtualNetworkSubnetId = '/configured/subnet'; httpsOnly = $true
       runtimeName = 'node'; runtimeVersion = '22'; ftpsState = 'Disabled' }
}
function Invoke-StgAzJson { param([string[]]$Arguments)
    switch -Wildcard ($Arguments -join ' ') {
        'functionapp config appsettings list*' { return $script:fixtureSettings }
        'storage account list*' { return @() }
        'cosmosdb list*' { return @(@{ name = 'owned-cosmos'; publicNetworkAccess = 'Disabled'; disableLocalAuth = $true }) }
        'cosmosdb sql database list*' { return $script:fixtureDatabases }
        'cosmosdb sql role assignment list*' { return $script:fixtureCosmosRoles }
        'resource list*' { return @(@{ name = 'owned-cosmos' }) }
        default { throw "Unexpected Azure read: $($Arguments -join ' ')" }
    }
}
function Get-StgCosmosAccountProblems { param($Cfg, $Account) @() }
function Get-StgStage1TargetIds { param($Cfg) @('/owned/resource') }
function Get-StgArm { param($Path, $ApiVersion)
    if ($Path -like '*/Microsoft.Authorization/roleAssignments') { return @{ value = $script:fixtureGrants } }
    throw "Unexpected ARM read: $Path"
}
function Write-StgEvidence { param($Name, $Value) '' }
function Invoke-QsAz { param([string[]]$Arguments)
    if (($Arguments -join ' ') -like 'group exists*') { return 'true' }
    throw "Unexpected Azure write: $($Arguments -join ' ')"
}
function Get-StgStage1Deployment { param($Cfg) @{ properties = @{ provisioningState = 'Succeeded' } } }
function Assert-StgStage1Parameters { param($Deployment, $Cfg) }
function Get-StgStage1Outputs { param($Deployment) $script:fixtureOut }

# Reproduce the real caller, not only the leaf settings assertion.
$script:fixtureState.stages['1'] = @{ configHash = Get-StgStageInput $cfg 1; dependencyHashes = @{}; outputs = @{} }
$script:fixtureState.stages['5'] = @{
    configHash = Get-StgStageInput $cfg 5
    outputs = @{ verify = @{ settings = @{ resolver = @('EXPECTED_SETTING') } } }
}
$result = Invoke-Stage1 $cfg -Apply
Assert-Contract ($result.verify.apps.Count -eq 1) 'AO-1: a Stage 1 apply rerun after Stage 5 must verify the saved settings record.'
$script:fixtureSettings = @(@{ name = 'WRONG_SETTING' })
$message = ''; try { $null = Invoke-Stage1 $cfg -Apply } catch { $message = $_.Exception.Message }
Assert-Contract ($message -match 'application setting names differ') 'AO-1: a saved Stage 5 settings mismatch must remain a verification failure.'

"Staged recovery: $passed checks passed. No Azure calls."
