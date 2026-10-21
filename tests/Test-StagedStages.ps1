#Requires -Version 7.0
<#
.SYNOPSIS
    Offline contract tests for the staged deployment entry points (infra/staged/stage*.bicep and
    Invoke-StagedDeployment.ps1). No Azure call: Bicep compiles locally and the driver is dot-sourced.
#>
[CmdletBinding()]
param([string]$BicepPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $BicepPath) {
    $command = Get-Command bicep -ErrorAction SilentlyContinue
    if ($command) { $BicepPath = $command.Source }
    elseif (Test-Path (Join-Path $HOME '.azure\bin\bicep.exe')) { $BicepPath = Join-Path $HOME '.azure\bin\bicep.exe' }
    else { throw 'Offline Bicep CLI required. Supply -BicepPath; this test does not install tools or call Azure.' }
}
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:passed++ }
function Build-Arm([string]$Relative) {
    $out = & $BicepPath build (Join-Path $root $Relative) --stdout 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Bicep compilation failed: $Relative" }
    return ($out -join "`n") | ConvertFrom-Json -AsHashtable -Depth 100
}
function Get-Resources($Template) {
    foreach ($resource in $Template.resources) {
        $resource
        if ($resource.properties.template) { Get-Resources $resource.properties.template }
    }
}
function Test-StageBoundary($Arm, [string[]]$Allowed, [string]$Stage) {
    foreach ($r in @(Get-Resources $Arm)) {
        if ($r.type -notin $Allowed) { throw "$Stage declares a resource outside its boundary: $($r.type)" }
    }
}

# Stage boundaries: each entry point declares only its own kind of resource.
$boundaries = [ordered]@{
    'infra\staged\stage2-network.bicep' = @('Microsoft.Resources/deployments', 'Microsoft.Network/networkSecurityGroups', 'Microsoft.Network/virtualNetworks',
        'Microsoft.Network/privateDnsZones', 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', 'Microsoft.Network/privateEndpoints',
        'Microsoft.Network/privateEndpoints/privateDnsZoneGroups')
    'infra\staged\stage3-schema.bicep' = @('Microsoft.DocumentDB/databaseAccounts/sqlDatabases', 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers')
    'infra\staged\stage4-grants.bicep' = @('Microsoft.Resources/deployments', 'Microsoft.Authorization/roleAssignments',
        'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions', 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments')
    'infra\staged\stage6-config.bicep' = @('Microsoft.Resources/deployments', 'Microsoft.Web/sites/config', 'Microsoft.ApiManagement/service/apis',
        'Microsoft.ApiManagement/service/backends', 'Microsoft.ApiManagement/service/apis/policies', 'Microsoft.ApiManagement/service/apis/operations', 'Microsoft.ApiManagement/service/loggers',
        'Microsoft.ApiManagement/service/apis/diagnostics', 'Microsoft.Insights/workbooks')
}
$arms = @{}
foreach ($path in $boundaries.Keys) {
    $arms[$path] = Build-Arm $path
    Test-StageBoundary $arms[$path] $boundaries[$path] $path
    $passed++
}

# Negative control: the same check rejects a role assignment injected into the network stage.
$mutated = $arms['infra\staged\stage2-network.bicep'] | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable -Depth 100
$mutated.resources += @{ type = 'Microsoft.Authorization/roleAssignments'; apiVersion = '2022-04-01'; name = 'injected' }
$caught = $false
try { Test-StageBoundary $mutated $boundaries['infra\staged\stage2-network.bicep'] 'mutated stage 2' } catch { $caught = $_.Exception.Message -match 'roleAssignments' }
Assert-Contract $caught 'Negative control: an injected role assignment was not rejected by the boundary check.'

# Stage 6 must never grant: no Authorization resource anywhere, including the reused modules.
Assert-Contract (-not (@(Get-Resources $arms['infra\staged\stage6-config.bicep']) | Where-Object type -Match 'Authorization|sqlRole')) 'Stage 6 contains a grant.'
# Stage 6 must not repeat Stage 1's resource-log diagnostic settings (Azure Monitor refuses duplicates).
Assert-Contract (-not (@(Get-Resources $arms['infra\staged\stage6-config.bicep']) | Where-Object type -EQ 'Microsoft.Insights/diagnosticSettings')) 'Stage 6 repeats a diagnostic setting.'

# Stage 3 and Stage 4 keep the quickstart's Cosmos data contract.
$quick = Build-Arm 'infra\quickstart\modules\cosmos-data.bicep'
$schema = $arms['infra\staged\stage3-schema.bicep']; $grants = $arms['infra\staged\stage4-grants.bicep']
$quickContainers = $quick.variables.cosmosContainers | ConvertTo-Json -Compress
$stagedContainers = $schema.variables.cosmosContainers | ConvertTo-Json -Compress
Assert-Contract ($quickContainers -ceq $stagedContainers) 'Stage 3 containers differ from the quickstart.'
foreach ($d in $quick.variables.cosmosRoleDefinitions) {
    $m = @($grants.variables.cosmosRoleDefinitions | Where-Object { $_.key -ceq $d.key })
    Assert-Contract ($m.Count -eq 1 -and (($m[0].dataActions | ConvertTo-Json -Compress) -ceq ($d.dataActions | ConvertTo-Json -Compress))) "Stage 4 role definition $($d.key) differs from the quickstart."
}
$admin = @($grants.variables.cosmosRoleDefinitions | Where-Object key -CEQ 'adminProjectEditor')[0]
Assert-Contract (-not ($admin.dataActions -match '/delete$|/upsert$')) 'Admin editor role must not delete or upsert.'
foreach ($a in $quick.variables.cosmosAssignments | Where-Object principal -NE 'runner') {
    $m = @($grants.variables.cosmosAssignments | Where-Object { $_.id -ceq $a.id })
    Assert-Contract ($m.Count -eq 1 -and $m[0].role -ceq $a.role -and $m[0].container -ceq $a.container -and $m[0].principal -ceq $a.principal) "Stage 4 assignment $($a.id) differs from the quickstart."
}
$adminScopes = @($grants.variables.cosmosAssignments | Where-Object principal -EQ 'admin' | ForEach-Object { $_.container })
Assert-Contract ((($adminScopes | Sort-Object) -join ',') -ceq 'adminConfig,projects') 'Admin Cosmos access must be limited to projects and adminConfig.'

# Stage 1 publishes the names later stages read.
$s1 = Build-Arm 'infra\staged\main.bicep'
Assert-Contract ($s1.outputs.ContainsKey('names') -and $s1.outputs.ContainsKey('apimName')) 'Stage 1 must output names and apimName.'
Assert-Contract (($s1.parameters.apimSku.allowedValues -join ',') -ceq 'BasicV2,StandardV2' -and $s1.parameters.apimSku.defaultValue -ceq 'StandardV2') 'APIM SKU choice changed.'

# Driver: parses, every stage has an entry function, no az argument holds a cmd.exe metacharacter,
# preview is the default, and later stages read earlier stage state.
$driverPath = Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1'
$driverFiles = @($driverPath) + @('Staged.Common.ps1', 'Staged.Resources.ps1', 'Staged.Entra.ps1', 'Staged.Application.ps1' | ForEach-Object { Join-Path $root "infra\staged\$_" })
$functionAsts = @()
foreach ($file in $driverFiles) {
    $tokens = $null; $errors = $null
    $fileAst = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    Assert-Contract (-not $errors.Count) "Driver file $file does not parse: $($errors.Message -join '; ')"
    $functionAsts += @($fileAst.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))
}
$functions = @($functionAsts | ForEach-Object Name)
foreach ($n in 0..8) { Assert-Contract ($functions -contains "Invoke-Stage$n") "Driver lacks Invoke-Stage$n." }
$driver = ($driverFiles | ForEach-Object { Get-Content -LiteralPath $_ -Raw }) -join "`n"
Assert-Contract (-not $driver.Contains('}`n} finally')) 'Driver must not contain a literal escaped newline after its Stage 7 lock try block.'
foreach ($line in ($driver -split "`n" | Where-Object { $_ -match "Invoke-Qs(Az|AzJson)|Invoke-StgAzJson|Get-StgGraph|Get-StgArm" })) {
    foreach ($literal in [regex]::Matches($line, "'[^']*'")) {
        Assert-Contract ($literal.Value -notmatch '[&|<>^]') "Driver passes a cmd.exe metacharacter to az: $($literal.Value)"
    }
}
Assert-Contract ($driver -match '\[switch\]\$Apply' -and $driver -match "what-if") 'Driver must preview by default.'
foreach ($n in 2..8) {
    $body = @($functionAsts | Where-Object Name -EQ "Invoke-Stage$n")[0].Body.Extent.Text
    Assert-Contract ($body -match 'Get-StgStage \$Cfg 1') "Invoke-Stage$n does not require Stage 1 state."
}

# Configuration: the committed example is refused until its placeholders are replaced; a filled copy passes.
. $driverPath -DotSourceOnly
$action = Get-StgStage2NetworkAction -Mode 'create' -VnetExists $false -StageStateExists $false
Assert-Contract ($action -ceq 'deploy') 'First Stage 2 create-mode deployment must deploy the network.'
$action = Get-StgStage2NetworkAction -Mode 'create' -VnetExists $true -StageStateExists $true
Assert-Contract ($action -ceq 'reuse') 'A saved Stage 2 create-mode retry must skip the authoritative network deployment.'
$action = Get-StgStage2NetworkAction -Mode 'existing' -VnetExists $true -StageStateExists $false
Assert-Contract ($action -ceq 'deploy') 'Existing-network mode must not be blocked by a pre-existing VNet.'
$unsafeCreateRetry = $false
try { $null = Get-StgStage2NetworkAction -Mode 'create' -VnetExists $true -StageStateExists $false } catch { $unsafeCreateRetry = $_.Exception.Message -match 'stage2_create_existing_vnet' }
Assert-Contract $unsafeCreateRetry 'Create mode without Stage 2 state must refuse to rewrite an existing VNet subnet list.'
$dnsConfig = @{ subscriptionId = '00000000-0000-4000-8000-000000000001'; resourceGroup = 'rg'; network = @{ mode = 'create' } }
$dnsOutputs = @{ functionsSubnetId = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/functions'; privateDnsZoneIds = @{ cosmos = 'cosmos-zone'; blob = 'blob-zone' } }
$dnsTargets = Get-StgStage2DnsTargets -Cfg $dnsConfig -Outputs $dnsOutputs -HasFoundry $true
Assert-Contract ($dnsTargets.vnetId -ceq '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet' -and $dnsTargets.zoneIds.Count -eq 5) 'Stage 2 must derive DNS targets when earlier deployment outputs lack VNet and Foundry zone IDs.'
$headers = New-StgGatewayHeaders -Token 'token-placeholder' -Project 'PROJECT01' -ProjectHeader 'x-customer-project'
Assert-Contract ($headers['x-customer-project'] -ceq 'PROJECT01' -and -not $headers.ContainsKey('x-ccof-project')) 'Stage 8 must use the configured project selector header.'
$priorResourceId = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/shared/providers/Microsoft.Storage/storageAccounts/prefix-owned/blobServices/default'
$changes = @(
    @{ changeType = 'Create'; resourceId = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/prefix-new' }
    @{ changeType = 'Modify'; resourceId = $priorResourceId }
    @{ changeType = 'Modify'; resourceId = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ApiManagement/service/prefix-unrelated' }
)
$unsafe = @(Get-StgUnsafeSharedChanges -Changes $changes -PriorStage1TargetIds @($priorResourceId))
Assert-Contract ($unsafe.Count -eq 1 -and $unsafe[0].resourceId -like '*prefix-unrelated') 'Shared Stage 1 must use exact prior operation IDs, not a colliding prefix.'
Assert-Contract ((Test-StgExactResourceScope $priorResourceId @($priorResourceId)) -and -not (Test-StgExactResourceScope '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ApiManagement/service/prefix-unrelated' @($priorResourceId))) 'Stage 1 and Stage 4 grant inventory must use exact resource IDs, not matching names.'
$delete = @(Get-StgUnsafeSharedChanges -Changes @(@{ changeType = 'Delete'; resourceId = $priorResourceId }) -PriorStage1TargetIds @($priorResourceId))
Assert-Contract ($delete.Count -eq 1) 'Shared Stage 1 must always refuse Delete, even for a prior target.'
$example = Join-Path $root 'infra\staged\staged.config.example.json'
$refused = $false
try { $null = Read-StgConfig $example } catch { $refused = $_.Exception.Message -match 'tenantId must be a GUID' }
Assert-Contract $refused 'Example configuration with placeholders must be refused.'
$tmp = Join-Path ([IO.Path]::GetTempPath()) "staged-config-$([guid]::NewGuid().ToString('N')).json"
try {
    $c = Get-Content -LiteralPath $example -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    $c.tenantId = '00000000-0000-4000-8000-000000000001'; $c.subscriptionId = '00000000-0000-4000-8000-000000000002'; $c.resourceGroup = 'rg-new'
    $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    $read = Read-StgConfig $tmp
    Assert-Contract ($read.stage1.prefix -ceq 'ccofstg' -and $read.stage1.functionsPublicNetworkAccess -ceq 'Disabled' -and $read.stage1.approveNewPublicApimBootstrap -eq $false) 'Example defaults must stay private and defer APIM.'
    $stage1Parameters = Get-Stage1Parameters $read
    $recordedParameters = @{ properties = @{ parameters = @{} } }
    foreach ($key in $stage1Parameters.Keys) { $recordedParameters.properties.parameters[$key] = @{ value = $stage1Parameters[$key] } }
    Assert-StgStage1Parameters $recordedParameters $read
    $recordedParameters.properties.parameters.storagePublicNetworkAccess.value = 'Enabled'
    $mismatch = $false
    try { Assert-StgStage1Parameters $recordedParameters $read } catch { $mismatch = $_.Exception.Message -match 'stage1_parameters_changed' }
    Assert-Contract $mismatch 'A completed Stage 1 deployment with different parameters must not be adopted.'
    $c.stage1.prefix = 'BAD_PREFIX'; $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    $bad = $false; try { $null = Read-StgConfig $tmp } catch { $bad = $_.Exception.Message -match 'prefix' }
    Assert-Contract $bad 'An invalid prefix must be refused.'
    $c.stage1.prefix = 'ccofstg'
    $c.stage1.foundry.create = $true
    $c.stage1.foundry.modelProviderData = @{ organizationName = 'Example Corp'; countryCode = 'US'; industry = 'Technology' }
    $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    $bad = $false; try { $null = Read-StgConfig $tmp } catch { $bad = $_.Exception.Message -match 'industry' }
    Assert-Contract $bad 'Anthropic model-provider industry must use a supported lowercase value.'
    $c.stage1.foundry.modelProviderData.industry = 'technology'
    $c.stage1.foundry.deployments[1].name = $c.stage1.foundry.deployments[0].name
    $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    $bad = $false; try { $null = Read-StgConfig $tmp } catch { $bad = $_.Exception.Message -match 'unique' }
    Assert-Contract $bad 'Duplicate Foundry deployment names must be refused.'
    $c.stage1.foundry.deployments[1].name = 'claude-sonnet-5'
    if (-not $c.entra.existing) { $c.entra.existing = @{} }
    $c.entra.existing.Remove('adminAppId')
    $c.entra.adminEditors = @()
    $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    $bad = $false; try { $null = Read-StgConfig $tmp } catch { $bad = $_.Exception.Message -match 'adminEditors' }
    Assert-Contract $bad 'A new assignment-required admin app must have at least one editor.'
    $c.entra.existing.adminAppId = '00000000-0000-4000-8000-000000000003'
    $c.entra.adminEditors = @()
    $c.stage1.foundry.create = $false
    $c.network.mode = 'existing'
    $c.network.existing = @{
        privateEndpointSubnetId = '/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/private'
        functionsSubnetId = '/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/functions'
        apimSubnetId = '/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/apim'
        privateDnsZoneIds = @{ cosmos = '/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg/providers/Microsoft.Network/privateDnsZones/privatelink.documents.azure.com'; blob = '/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net' }
    }
    $c.backends[0].privateEndpoint = $true
    $c.backends[0].subscriptionId = $c.subscriptionId
    $c.backends[0].resourceGroup = $c.resourceGroup
    $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    $bad = $false; try { $null = Read-StgConfig $tmp } catch { $bad = $_.Exception.Message -match 'private Foundry.*requires' }
    Assert-Contract $bad 'Existing-network private Foundry configuration must require all three zone IDs.'
} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
# State is bound to its tenant/subscription/RG: another target's outputs are refused, not reused.
$stateDir = Join-Path ([IO.Path]::GetTempPath()) "staged-state-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stateDir | Out-Null
try {
    $script:StateDir = $stateDir
    $cfgA = @{
        tenantId = '00000000-0000-4000-8000-00000000000a'
        subscriptionId = '00000000-0000-4000-8000-00000000000b'
        resourceGroup = 'rg-a'
        location = 'eastus2'
        tags = @{}
        sharedResourceGroup = $false
        stage1 = @{ prefix = 'abc123'; includeAdmin = $true }
        cosmos = @{ databaseName = 'ccof'; capacityMode = 'serverless' }
        sync = @{ mode = 'delegated-snapshot' }
        backends = @()
    }
    Save-StgStage $cfgA 1 @{ marker = 'a'; durationSeconds = 1 }
    Assert-Contract ((Get-StgStage $cfgA 1).marker -ceq 'a') 'State must return its own target outputs.'
    $cfgB = $cfgA.Clone()
    $cfgB.subscriptionId = '00000000-0000-4000-8000-00000000000c'
    $mismatch = $false
    try { $null = Get-StgStage $cfgB 1 } catch { $mismatch = $_.Exception.Message -match 'state_target_mismatch' }
    Assert-Contract $mismatch 'State of another subscription must be refused.'
    $cfgA.stage1.prefix = 'xyz789'
    $changed = $false
    try { $null = Get-StgStage $cfgA 1 } catch { $changed = $_.Exception.Message -match 'stage_config_changed' }
    Assert-Contract $changed 'Stage outputs must not be reused after that stage config changes.'
    $cfgA.stage1.prefix = 'abc123'
    Save-StgStage $cfgA 3 @{ marker = 'schema-a' }
    Save-StgStage $cfgA 4 @{ marker = 'grants-a' }
    Save-StgStage $cfgA 1 @{ marker = 'a'; durationSeconds = 999 }
    Assert-Contract ((Get-StgStage $cfgA 4).marker -ceq 'grants-a') 'A duration-only change must not invalidate dependent stages.'
    $state = Read-StgState $cfgA
    $legacyOutput = ConvertTo-StgCanonical $state.stages['1'].outputs | ConvertTo-Json -Depth 100 -Compress
    $state.stages['4'].dependencyHashes['1'] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($legacyOutput))).ToLowerInvariant()
    $state | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Get-StgStatePath $cfgA) -Encoding utf8NoBOM
    $null = Get-StgStage $cfgA 4
    $state = Read-StgState $cfgA
    Assert-Contract ($state.stages['4'].dependencyHashes['1'] -ceq (Get-StgDependencyHashes $state 4)['1']) 'Legacy duration-inclusive dependency hashes must migrate only when the saved output matches exactly.'
    Save-StgStage $cfgA 3 @{ marker = 'schema-b' }
    $dependencyChanged = $false
    try { $null = Get-StgStage $cfgA 4 } catch { $dependencyChanged = $_.Exception.Message -match 'stage_dependency_changed' }
    Assert-Contract $dependencyChanged 'Downstream outputs must not be reused after a prerequisite stage is reapplied.'
    $lockPath = Join-Path $stateDir 'stage7.lock'
    $lock = Enter-StgStage7Lock $lockPath
    $busy = $false
    try { $second = Enter-StgStage7Lock $lockPath; $second.Dispose() } catch { $busy = $_.Exception.Message -match 'stage7_busy' }
    Assert-Contract $busy 'Concurrent Stage 7 package builds must fail fast.'
    $lock.Dispose()
    $reacquired = Enter-StgStage7Lock $lockPath
    Assert-Contract ($null -ne $reacquired) 'Stage 7 lock must be released for a later retry.'
    $reacquired.Dispose()
} finally { Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue }
$s1Params = @($s1.parameters.Keys)
foreach ($k in $c.stage1.Keys) { Assert-Contract ($s1Params -contains $k) "Example stage1.$k is not a Stage 1 template parameter." }

"Staged stages: $passed checks passed (4 stage boundaries, negative control, Cosmos contract, driver and configuration). No Azure calls."
