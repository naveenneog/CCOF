#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }; $script:passed++
}
$script:StateDir = Join-Path $root '.env.staged-noop-test'
[void][IO.Directory]::CreateDirectory($script:StateDir)
$cfg = @{
    tenantId = 't'; subscriptionId = 's'; resourceGroup = 'noop-test'; stage1 = @{}
    cosmos = @{ databaseName = 'ccof' }; reconciler = @{ budgetGuard = @{ warnPercent = 80 } }
}
$script:fixtureState = @{ stages = @{} }
foreach ($n in 1, 3, 4) { $script:fixtureState.stages["$n"] = @{ outputs = @{ stable = "stage-$n" } } }
foreach ($n in 2, 5) {
    $script:fixtureState.stages["$n"] = @{
        configHash = Get-StgStageInput $cfg $n; dependencyHashes = Get-StgDependencyHashes $script:fixtureState $n
        outputs = @{ databaseName = 'ccof'; containers = @(@{ name = 'projects'; partitionKey = '/id' }); gatewayUrl = 'https://gateway.invalid/claude' }
    }
}
function Read-StgState { param($Cfg) $script:fixtureState }
function Write-StgEvidence { param($Name, $Value) '' }
function Invoke-QsAz { param([string[]]$Arguments)
    if (($Arguments -join ' ') -like 'deployment group create*') { $script:deploys++ }
    elseif (($Arguments -join ' ') -like 'deployment group what-if*') { $script:previews++; return @{ changes = @() } }
    else { throw "Unexpected Azure call: $($Arguments -join ' ')" }
    @{ properties = @{ provisioningState = 'Succeeded'; outputs = @{
        databaseName = @{ value = 'ccof' }; containers = @{ value = @(@{ name = 'projects'; partitionKey = '/id' }) }
        gatewayUrl = @{ value = 'https://gateway.invalid/claude' }
    } } }
}
try {
    foreach ($n in 2, 5) {
        $script:deploys = 0
        $null = Invoke-StgBicep -Cfg $cfg -Template 'unused.bicep' -Name "force-probe-$n" -StageNumber $n -Parameters @{} -Apply -ForceRedeploy
        Assert-Contract ($script:deploys -eq 1) "AO-3: forced unchanged apply must redeploy Stage $n."
    }
    $null = Write-StgParameters $cfg 'stage5-config' @{ reconciler = @{ budgetGuard = @{ warnPercent = 80 } }; tenantId = 't' }
    $changed = $cfg.Clone(); $changed.reconciler = @{ budgetGuard = @{ warnPercent = 79 } }
    $preview = Invoke-StgBicep -Cfg $changed -Template 'unused.bicep' -Name 'stage5-config' -StageNumber 5 -Parameters @{
        reconciler = $changed.reconciler; tenantId = 't'
    } 6>&1 | Out-String
    Assert-Contract ($preview -match 'changed parameters: reconciler' -and $preview -notmatch 'changed parameters:[^\r\n]*tenantId') 'AO-4: changed Stage 5 preview must name reconciler, not unchanged parameters or their values.'
    $null = Invoke-StgBicep -Cfg $cfg -Template 'unused.bicep' -Name 'stage5-config' -StageNumber 5 -Parameters @{ reconciler = $cfg.reconciler; tenantId = 't' } -Apply -ForceRedeploy
    foreach ($attempt in 1, 2) {
        $preview = Invoke-StgBicep -Cfg $changed -Template 'unused.bicep' -Name 'stage5-config' -StageNumber 5 -Parameters @{ reconciler = $changed.reconciler; tenantId = 't' } 6>&1 | Out-String
        Assert-Contract ($preview -match 'changed parameters: reconciler' -and $preview -match 'stage5-config.applied.parameters.json') 'AO-4: repeated previews must compare with the applied snapshot, not overwrite the comparison baseline.'
    }
    foreach ($n in 2, 5) {
        $script:deploys = 0
        $out = Invoke-StgBicep -Cfg $cfg -Template 'unused.bicep' -Name "stage$n" -StageNumber $n -Parameters @{} -Apply
        Assert-Contract ($script:deploys -eq 0 -and $out.databaseName -ceq 'ccof') "AO-3: unchanged Stage $n apply must return saved outputs without redeploying."
        $null = Invoke-StgBicep -Cfg $cfg -Template 'unused.bicep' -Name "stage$n" -StageNumber $n -Parameters @{} -Apply -ForceRedeploy
        Assert-Contract ($script:deploys -eq 1) "AO-3: explicit ForceRedeploy must redeploy unchanged Stage $n."
        $script:previews = 0
        $null = Invoke-StgBicep -Cfg $cfg -Template 'unused.bicep' -Name "stage$n" -StageNumber $n -Parameters @{} -ForceRedeploy
        Assert-Contract ($script:previews -eq 1) "AO-3: forced Stage $n preview must show ARM what-if, not promise no changes."
        $changed = $cfg.Clone()
        if ($n -eq 2) { $changed.cosmos = @{ databaseName = 'other' } }
        else { $changed.reconciler = @{ budgetGuard = @{ warnPercent = 79 } } }
        $null = Invoke-StgBicep -Cfg $changed -Template 'unused.bicep' -Name "stage$n" -StageNumber $n -Parameters @{} -Apply
        Assert-Contract ($script:deploys -eq 2) "AO-3: changed Stage $n inputs must redeploy."
        $script:fixtureState.stages['1'].outputs.stable = 'changed'
        $null = Invoke-StgBicep -Cfg $cfg -Template 'unused.bicep' -Name "stage$n" -StageNumber $n -Parameters @{} -Apply
        Assert-Contract ($script:deploys -eq 3) "AO-3: changed Stage $n prerequisites must redeploy."
        $script:fixtureState.stages['1'].outputs.stable = 'stage-1'
    }
    $script:deploys = 0; $script:containers = @(@{ name = 'projects'; resource = @{ partitionKey = @{ paths = @('/id') } } })
    $script:fixtureState.stages['1'].outputs.names = @{ cosmosAccount = 'owned' }
    $script:fixtureState.stages['2'].dependencyHashes = Get-StgDependencyHashes $script:fixtureState 2
    function Invoke-StgAzJson { param([string[]]$Arguments)
        switch -Wildcard ($Arguments -join ' ') {
            'cosmosdb sql role assignment list*' { return @() }
            'cosmosdb sql container list*' { return $script:containers }
            default { throw "Unexpected Azure read: $($Arguments -join ' ')" }
        }
    }
    $out = Invoke-Stage2 $cfg -Apply
    Assert-Contract ($script:deploys -eq 0 -and $out.containers.Count -eq 1) 'AO-3: Stage 2 must read back containers on a no-op apply.'
    $script:containers = @()
    $message = ''; try { $null = Invoke-Stage2 $cfg -Apply } catch { $message = $_.Exception.Message }
    Assert-Contract ($script:deploys -eq 0 -and $message -match 'container projects missing') 'AO-3: Stage 2 no-op must fail closed on missing containers, not redeploy silently.'
    $script:containers = @(@{ name = 'projects'; resource = @{ partitionKey = @{ paths = @('/id') } } })
    $null = Invoke-Stage2 $cfg -Apply -ForceRedeploy
    Assert-Contract ($script:deploys -eq 1) 'AO-3: Stage 2 caller must forward ForceRedeploy.'
    # Run the actual Stage 5 caller, including read-back and the retention writer boundary.
    $script:fixtureState.stages['1'].outputs.names = @{ apps = @{ resolver = @{ functionApp = 'resolver' } } }
    $script:fixtureState.stages['4'].outputs = @{ registrations = @{ resolverApi = @{ appId = 'resolver-api' } } }
    $script:fixtureState.stages['5'].dependencyHashes = Get-StgDependencyHashes $script:fixtureState 5
    $cfg.audit = @{ workspaceRetentionDays = 90 }
    $script:fixtureState.stages['5'].configHash = Get-StgStageInput $cfg 5
    $script:retention = 90; $script:authEnabled = $true; $script:retentionWrites = 0
    function npx { $global:LASTEXITCODE = 0 }
    function node { $global:LASTEXITCODE = 0 }
    function New-StgQsContext { param($Cfg)
        @{ P = @{ names = @{} }; GeneratedDir = $script:StateDir; State = @{ completed = @{ '1' = @{ outputs = @{} } } }; Apim = @{ principalId = 'apim' } }
    }
    function Get-StgGraph { param($Path) @{ appId = 'apim-app' } }
    function New-QsGatewayConfig { param($P, $Checks) @{ entra = @{} } }
    function Get-StgLogRetentionDays { param($Cfg) 90 }
    function Get-StgPreviousRetentionHeldFrom { param($Cfg, $Names) $null }
    function New-QsWorkbookAnswers { param($P, $ApimId, $Directory) '' }
    function New-StgGroupDocuments { param($Groups, $EntraGroups) @() }
    function Get-QsWorkbookGroups { param($P) @() }
    function Get-StgGroupWorkbookRows { param($Documents) @() }
    function Invoke-QsWorkbookBuild { param($AnswersPath, $GroupsPath, $Directory) @{ parametersPath = Join-Path $script:StateDir 'workbook.json' } }
    function Get-StgAuditDeployment { param($Cfg, $Names, $ApimLocation, $LockedContainers) @{} }
    function Get-StgStage5ApimInput { param($Cfg, $Stage1, $Apim) @{ gatewayLogs = @{}; reuseMonitorLogger = $true } }
    function Get-StgApim { param($Cfg) @{ apiId = 'claude'; apiPath = 'claude' } }
    function Set-StgWorkspaceRetention { param($Cfg, $Names) $script:retentionWrites++ }
    function Test-StgAuditArchive { param($Cfg, $Deployment, $Names, $Apim) @{} }
    function Invoke-StgAzJson { param([string[]]$Arguments)
        if (($Arguments -join ' ') -like 'functionapp config appsettings list*') {
            return @(1..5 | ForEach-Object { @{ name = "SETTING_$_" } })
        }
        throw "Unexpected Stage 5 Azure read: $($Arguments -join ' ')"
    }
    function Get-StgArm { param($Path, $ApiVersion)
        switch -Wildcard ($Path) {
            '*/workspaces/*' { return @{ properties = @{ retentionInDays = $script:retention } } }
            '*/config/authsettingsV2/list' { return @{ properties = @{ platform = @{ enabled = $script:authEnabled }; globalValidation = @{ unauthenticatedClientAction = 'Return401' } } } }
            '*/operations/get-my-usage/policies/policy' { return @{ properties = @{ value = 'ccof-usage-person /api/me/usage' } } }
            '*/operations/get-my-usage' { return @{ properties = @{ method = 'GET'; urlTemplate = '/ccof/me/usage' } } }
            '*/apis/claude' { return @{ properties = @{ path = 'claude' } } }
            default { throw "Unexpected Stage 5 ARM read: $Path" }
        }
    }
    $cfg.apim = @{ apiId = 'claude' }
    $script:fixtureState.stages['5'].configHash = Get-StgStageInput $cfg 5
    [void][IO.Directory]::CreateDirectory((Join-Path $script:StateDir 'gateway'))
    foreach ($name in 'claude.policy.xml', 'claude.usage.policy.xml') { Set-Content -LiteralPath (Join-Path $script:StateDir "gateway\$name") -Value '<policies />' }
    Set-Content -LiteralPath (Join-Path $script:StateDir 'gateway\claude.policy.deployment.json') -Value '{"apiPolicyXml":"<policies />","fragments":[]}'
    Set-Content -LiteralPath (Join-Path $script:StateDir 'workbook.json') -Value '{"parameters":{"workbookContent":{"value":""},"contentTags":{"value":{}}}}'
    $script:deploys = 0
    $out = Invoke-Stage5 $cfg -Apply
    Assert-Contract ($script:deploys -eq 0 -and $script:retentionWrites -eq 0 -and $out.verify.resolverAuth.enabled) 'AO-3: Stage 5 no-op must read back without ARM deploy or retention writes.'
    $script:authEnabled = $false
    $message = ''; try { $null = Invoke-Stage5 $cfg -Apply } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'resolver authentication is not enforced' -and $script:deploys -eq 0) 'AO-3: Stage 5 no-op must fail closed on auth drift.'
    $script:authEnabled = $true; $script:retention = 30
    $message = ''; try { $null = Invoke-Stage5 $cfg -Apply } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'workspace retention differs' -and $script:retentionWrites -eq 0) 'AO-3: Stage 5 no-op must detect retention drift without writing.'
    $script:retention = 90
    $null = Invoke-Stage5 $cfg -Apply -ForceRedeploy
    Assert-Contract ($script:deploys -eq 1 -and $script:retentionWrites -eq 1) 'AO-3: Stage 5 ForceRedeploy must reach both ARM and retention writers.'
    $message = & pwsh -NoProfile -File (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -Stage 1 -ConfigPath 'not-read.json' -ForceRedeploy 2>&1 | Out-String
    Assert-Contract ($LASTEXITCODE -ne 0 -and $message -match 'ForceRedeploy is supported only for Stages 2 and 5') 'AO-3: ForceRedeploy must refuse other stages before any config or Azure access.'
} finally { Remove-Item -LiteralPath $script:StateDir -Recurse -Force }
"Staged no-op: $passed checks passed. No Azure calls."
