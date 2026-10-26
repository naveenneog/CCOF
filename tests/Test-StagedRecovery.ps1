#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
$passed = 0
$realReadState = ${function:Read-StgState}
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
        'cosmosdb sql container list*' { return @() }
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

# Start with a genuinely empty state directory and retain the real persistence/order checks.
$script:StateDir = Join-Path $root '.env.staged-recovery-test'
[void][IO.Directory]::CreateDirectory($script:StateDir)
try {
    ${function:Read-StgState} = $realReadState
    $script:fixtureSettings = @(@{ name = 'LATER_STAGE_SETTING' })
    $script:fixtureDatabases = @(@{ name = 'ccof' })
    $script:fixtureGrants = @(@{ properties = @{ scope = '/owned/resource'; principalId = 'runtime' } })
    $script:fixtureCosmosRoles = @(@{ id = 'runtime-data-role' })
    Assert-Contract ((Read-StgState $cfg).stages.Count -eq 0) 'AO-2: recovery must start with empty local state.'
    $null = Invoke-Stage1 $cfg
    $result = Invoke-Stage1 $cfg -Apply
    Save-StgStage $cfg 1 $result
    $recovered = Read-StgState $cfg
    Assert-Contract ($recovered.stages.Count -eq 1 -and $recovered.stages.ContainsKey('1')) 'AO-2: Stage 1 recovery must record only Stage 1, not infer later completion.'
    $script:previewCalls = 0
    function Invoke-StgBicep { param($Cfg, $Template, $Name, $Parameters, [switch]$Apply, $StageNumber)
        Assert-Contract (-not $Apply -and $StageNumber -eq 2) 'AO-2: Stage 2 recovery preview must remain read-only.'
        $script:previewCalls++
    }
    $null = Invoke-Stage2 $cfg
    Assert-Contract ($script:previewCalls -eq 1) 'AO-2: recovered Stage 1 must unlock Stage 2 preview.'
    # Initial deployment verification must retain its no-later-resources checks.
    $message = ''; try { $null = Test-Stage1 -Cfg $cfg -Out $script:fixtureOut } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'Cosmos database exists before Stage 2') 'AO-2: a fresh deployment still rejects unexpected later resources.'
    function Invoke-StgBicep { param($Cfg, $Template, $Name, $Parameters, [switch]$Apply, $StageNumber)
        @{ databaseName = 'ccof'; containers = @() }
    }
    $schema = Invoke-Stage2 $cfg -Apply
    Save-StgStage $cfg 2 $schema
    Assert-Contract ((Read-StgState $cfg).stages.Count -eq 2) 'AO-2: recovering Stage 2 must not require or infer Stage 3 completion.'
    function Invoke-StgBicep { param($Cfg, $Template, $Name, $Parameters, [switch]$Apply, $StageNumber)
        $script:fixtureCosmosRoles += @{ id = 'unexpected-new-role' }
        @{ databaseName = 'ccof'; containers = @() }
    }
    $message = ''; try { $null = Invoke-Stage2 $cfg -Apply } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'Stage 2 changed Cosmos data-role assignments') 'AO-2: Stage 2 must still detect an added grant during schema deployment.'
    $null = Invoke-Stage1 $cfg -Apply
    $grantsOut = @{ verify = @{ rgScopedAssignments = 1; cosmos = @(@{}, @{}) } }
    Save-StgStage $cfg 3 $grantsOut
    $null = Invoke-Stage1 $cfg -Apply
    $grantsOut.verify.rgScopedAssignments = 2
    Save-StgStage $cfg 3 $grantsOut
    $message = ''; try { $null = Invoke-Stage1 $cfg -Apply } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'Azure role assignments.*completed Stage 3 records 2') 'AO-2: recovery must still enforce a recorded Stage 3 Azure grant count.'
    $grantsOut.verify.rgScopedAssignments = 1; $grantsOut.verify.cosmos = @(@{})
    Save-StgStage $cfg 3 $grantsOut
    $message = ''; try { $null = Invoke-Stage1 $cfg -Apply } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'Cosmos data assignments.*completed Stage 3 records 1') 'AO-2: recovery must still enforce a recorded Stage 3 Cosmos grant count.'
} finally {
    Remove-Item -LiteralPath $script:StateDir -Recurse -Force
}

"Staged recovery: $passed checks passed. No Azure calls."
