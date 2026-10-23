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
    'infra\staged\stage6-network.bicep' = @('Microsoft.Resources/deployments', 'Microsoft.Network/networkSecurityGroups', 'Microsoft.Network/virtualNetworks',
        'Microsoft.Network/privateDnsZones', 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', 'Microsoft.Network/privateEndpoints',
        'Microsoft.Network/privateEndpoints/privateDnsZoneGroups')
    'infra\staged\stage2-schema.bicep' = @('Microsoft.DocumentDB/databaseAccounts/sqlDatabases', 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers')
    'infra\staged\stage3-grants.bicep' = @('Microsoft.Resources/deployments', 'Microsoft.Authorization/roleAssignments',
        'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions', 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments')
    'infra\staged\stage5-config.bicep' = @('Microsoft.Resources/deployments', 'Microsoft.Web/sites/config', 'Microsoft.ApiManagement/service/apis',
        'Microsoft.ApiManagement/service/backends', 'Microsoft.ApiManagement/service/apis/policies', 'Microsoft.ApiManagement/service/apis/operations', 'Microsoft.ApiManagement/service/apis/operations/policies', 'Microsoft.ApiManagement/service/loggers',
        'Microsoft.ApiManagement/service/apis/diagnostics', 'Microsoft.Insights/workbooks')
}
$arms = @{}
foreach ($path in $boundaries.Keys) {
    $arms[$path] = Build-Arm $path
    Test-StageBoundary $arms[$path] $boundaries[$path] $path
    $passed++
}

# Negative control: the same check rejects a role assignment injected into the network stage.
$mutated = $arms['infra\staged\stage6-network.bicep'] | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable -Depth 100
$mutated.resources += @{ type = 'Microsoft.Authorization/roleAssignments'; apiVersion = '2022-04-01'; name = 'injected' }
$caught = $false
try { Test-StageBoundary $mutated $boundaries['infra\staged\stage6-network.bicep'] 'mutated stage 6' } catch { $caught = $_.Exception.Message -match 'roleAssignments' }
Assert-Contract $caught 'Negative control: an injected role assignment was not rejected by the boundary check.'

# Stage 5 (configuration) must never grant: no Authorization resource anywhere, including the reused modules.
Assert-Contract (-not (@(Get-Resources $arms['infra\staged\stage5-config.bicep']) | Where-Object type -Match 'Authorization|sqlRole')) 'Stage 5 contains a grant.'
# Stage 5 must not repeat Stage 1's resource-log diagnostic settings (Azure Monitor refuses duplicates).
Assert-Contract (-not (@(Get-Resources $arms['infra\staged\stage5-config.bicep']) | Where-Object type -EQ 'Microsoft.Insights/diagnosticSettings')) 'Stage 5 repeats a diagnostic setting.'

# Stage 3 and Stage 4 keep the quickstart's Cosmos data contract.
$quick = Build-Arm 'infra\quickstart\modules\cosmos-data.bicep'
$schema = $arms['infra\staged\stage2-schema.bicep']; $grants = $arms['infra\staged\stage3-grants.bicep']
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
# Every client the admin API accepts (ADMIN_ALLOWED_CLIENT_IDS) is preauthorized by Stage 4 and read back.
$entraText = Get-Content -Raw (Join-Path $root 'infra\staged\Staged.Entra.ps1')
Assert-Contract ($entraText -match '\$adminClients = @\(\$adm\.appId\) \+ @\(\$Cfg\.admin\.extraAllowedClientIds' -and $entraText -match 'Merge-StgPreauthorized \$adm \$adminClients' -and $entraText -match 'foreach \(\$cid in \$adminClients\)') 'Stage 4 must preauthorize and verify admin.extraAllowedClientIds.'
$adminScopes = @($grants.variables.cosmosAssignments | Where-Object principal -EQ 'admin' | ForEach-Object { $_.container })
Assert-Contract ((($adminScopes | Sort-Object) -join ',') -ceq 'adminConfig,projects') 'Admin Cosmos access must be limited to projects and adminConfig.'
# The sync reads the admin console's removal-limit override: read-only, adminConfig only, and only with the admin app.
$syncConfig = @($grants.variables.cosmosAssignments | Where-Object { $_.principal -ceq 'sync' -and $_.container -ceq 'adminConfig' })
Assert-Contract ($syncConfig.Count -eq 1 -and $syncConfig[0].role -ceq '00000000-0000-0000-0000-000000000001') 'Sync access to adminConfig must be the built-in Data Reader only.'
Assert-Contract ($grants.variables.activeAssignments -match "not\(equals\(lambdaVariables\('a'\)\.container, 'adminConfig'\)\), not\(empty\(coalesce\(tryGet\(parameters\('principals'\), 'admin'\)") 'adminConfig assignments must require the admin principal.'
$settingsArm = Build-Arm 'infra\quickstart\modules\app-settings.bicep'
Assert-Contract (($settingsArm.parameters.syncLimitsContainer.defaultValue -ceq '') -and ((Get-Content -Raw 'infra\staged\stage5-config.bicep') -match "syncLimitsContainer: \(admin\.\?enabled \?\? false\) \? 'adminConfig' : ''")) 'Stage 5 must set SYNC_LIMITS_CONTAINER=adminConfig only with the admin app.'
# Group-centric onboarding (ADR-0034): Entra group search on the admin app and gateway surface clients.
$stage5Text = Get-Content -Raw (Join-Path $root 'infra\staged\stage5-config.bicep')
$appText = Get-Content -Raw (Join-Path $root 'infra\staged\Staged.Application.ps1')
$example = Get-Content -Raw (Join-Path $root 'infra\staged\staged.config.example.json') | ConvertFrom-Json -AsHashtable
Assert-Contract ($stage5Text -match "ADMIN_GROUP_SEARCH_ENABLED: \(admin\.\?groupSearchEnabled \?\? false\) \? 'true' : 'false'") 'Stage 5 must set ADMIN_GROUP_SEARCH_ENABLED from admin.groupSearchEnabled, off by default.'
Assert-Contract ($appText -match 'groupSearchEnabled = \(\$Cfg\.admin\.groupSearchEnabled -eq \$true\)') 'Stage 5 must pass admin.groupSearchEnabled to the template.'
# User names on the admin console (User tags page, Developers view): Graph User.Read.All, off by default.
Assert-Contract ($stage5Text -match "ADMIN_USER_NAMES_ENABLED: \(admin\.\?userNamesEnabled \?\? false\) \? 'true' : 'false'") 'Stage 5 must set ADMIN_USER_NAMES_ENABLED from admin.userNamesEnabled, off by default.'
Assert-Contract ($appText -match 'userNamesEnabled = \(\$Cfg\.admin\.userNamesEnabled -eq \$true\)' -and $example.admin.userNamesEnabled -eq $false) 'Stage 5 must pass admin.userNamesEnabled; the example shows it as false.'
# GET /ccof/me/usage (docs/USAGE.md): Stage 5 deploys the operation policy render.ts writes, and the resolver setting.
$apiModule = Get-Content -Raw (Join-Path $root 'infra\quickstart\modules\apim-api.bicep')
$settingsModule = Get-Content -Raw (Join-Path $root 'infra\quickstart\modules\app-settings.bicep')
Assert-Contract ($appText -match '\$usagePolicy = Get-Content -LiteralPath \(Join-Path \$ctx\.GeneratedDir "gateway/\$\(\$Cfg\.apim\.apiId\)\.usage\.policy\.xml"\) -Raw' -and $appText -match 'usagePolicyXml = \$usagePolicy') 'Stage 5 must pass the rendered usage policy to the template.'
Assert-Contract ($stage5Text -match 'usagePolicyXml: usagePolicyXml') 'stage5-config.bicep must hand usagePolicyXml to the API module.'
Assert-Contract ($apiModule -match "name: 'get-my-usage'" -and $apiModule -match "method: 'GET'" -and $apiModule -match "urlTemplate: '/ccof/me/usage'" -and $apiModule -match "operations/policies@[0-9-]+' = if \(!empty\(usagePolicyXml\)\)") 'The API module must create GET /ccof/me/usage with its operation policy when one is supplied.'
Assert-Contract ($appText -match "operations/get-my-usage" -and $appText -match "APIM operation get-my-usage is missing or differs" -and $appText -match "operations/get-my-usage/policies/policy" -and $appText -match "the deployed get-my-usage policy is not the rendered usage policy") 'Stage 5 must read the usage operation and its deployed policy back.'
Assert-Contract ($settingsModule -match "RESOLVER_USAGE_GROUP_TOTALS: \(resolver\.\?usageGroupTotals \?\? false\) \? 'true' : 'false'" -and $example.resolver.usageGroupTotals -eq $false) 'The resolver must get RESOLVER_USAGE_GROUP_TOTALS, off by default; the example shows false.'
Assert-Contract ($settingsModule -match "RESOLVER_REQUIRE_COMPLETE_USAGE: \(resolver\.\?requireCompleteUsage \?\? false\) \? 'true' : 'false'" -and $example.resolver.ContainsKey('requireCompleteUsage') -and $example.resolver.requireCompleteUsage -eq $false) 'Stage 5 must wire the explicit complete-usage guard, default false, into resolver settings.'
Assert-Contract ($example.gateway.admission.usage.calls -eq 10 -and $example.gateway.admission.usage.renewalPeriodSeconds -eq 60) 'The example must show the usage operation''s per-person limit.'
Assert-Contract ($appText -match '\$config\.entra\.surfaceClients = @\(\$Cfg\.gateway\.surfaceClients') 'Stage 5 must copy gateway.surfaceClients into the gateway configuration.'
Assert-Contract ($example.gateway.ContainsKey('surfaceClients') -and @($example.gateway.surfaceClients).Count -eq 0 -and $example.admin.groupSearchEnabled -eq $false) 'The example configuration must show gateway.surfaceClients (empty) and admin.groupSearchEnabled (false).'

# Stage 1 publishes the names later stages read.
$s1 = Build-Arm 'infra\staged\main.bicep'
Assert-Contract ($s1.outputs.ContainsKey('names') -and $s1.outputs.ContainsKey('apimName')) 'Stage 1 must output names and apimName.'
Assert-Contract (($s1.parameters.apimSku.allowedValues -join ',') -ceq 'BasicV2,StandardV2' -and $s1.parameters.apimSku.defaultValue -ceq 'StandardV2') 'APIM SKU choice changed.'

# Driver: parses, every stage has an entry function, no az argument holds a cmd.exe metacharacter,
# preview is the default, and later stages read earlier stage state.
$driverPath = Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1'
$driverFiles = @($driverPath) + @('Staged.Common.ps1', 'Staged.Groups.ps1', 'Staged.Cosmos.ps1', 'Staged.Resources.ps1', 'Staged.Entra.ps1', 'Staged.Application.ps1' | ForEach-Object { Join-Path $root "infra\staged\$_" })
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
$action = Get-StgNetworkAction -Mode 'create' -VnetExists $false -StageStateExists $false
Assert-Contract ($action -ceq 'deploy') 'First Stage 6 create-mode deployment must deploy the network.'
$action = Get-StgNetworkAction -Mode 'create' -VnetExists $true -StageStateExists $true
Assert-Contract ($action -ceq 'reuse') 'A saved Stage 6 create-mode retry must skip the authoritative network deployment.'
$action = Get-StgNetworkAction -Mode 'existing' -VnetExists $true -StageStateExists $false
Assert-Contract ($action -ceq 'deploy') 'Existing-network mode must not be blocked by a pre-existing VNet.'
$unsafeCreateRetry = $false
try { $null = Get-StgNetworkAction -Mode 'create' -VnetExists $true -StageStateExists $false } catch { $unsafeCreateRetry = $_.Exception.Message -match 'network_create_existing_vnet' }
Assert-Contract $unsafeCreateRetry 'Create mode without Stage 2 state must refuse to rewrite an existing VNet subnet list.'
$dnsConfig = @{ subscriptionId = '00000000-0000-4000-8000-000000000001'; resourceGroup = 'rg'; network = @{ mode = 'create' } }
$dnsOutputs = @{ functionsSubnetId = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/functions'; privateDnsZoneIds = @{ cosmos = 'cosmos-zone'; blob = 'blob-zone' } }
$dnsTargets = Get-StgNetworkDnsTargets -Cfg $dnsConfig -Outputs $dnsOutputs -HasFoundry $true
Assert-Contract ($dnsTargets.vnetId -ceq '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet' -and $dnsTargets.zoneIds.Count -eq 5) 'Stage 6 must derive DNS targets when earlier deployment outputs lack VNet and Foundry zone IDs.'
$headers = New-StgGatewayHeaders -Token 'token-placeholder' -Project 'PROJECT01' -ProjectHeader 'x-customer-project'
Assert-Contract ($headers['x-customer-project'] -ceq 'PROJECT01' -and -not $headers.ContainsKey('x-ccof-project')) 'Stage 8 must use the configured project selector header.'
# Cosmos DB resilience (ADR-0036): regions in failover order, zone redundancy, consistency; read back in Stage 1.
$haCfg = @{ location = 'eastus2'; stage1 = @{ cosmosCapacityMode = 'provisioned'
        cosmosLocations = @(@{ locationName = 'eastus2'; isZoneRedundant = $true }, @{ locationName = 'centralus'; isZoneRedundant = $true })
        cosmosConsistency = @{ defaultConsistencyLevel = 'Session' } }; cosmos = @{ capacityMode = 'provisioned-autoscale' } }
Assert-Contract (-not @(Get-StgCosmosProblems $haCfg).Count) 'A two-region, zone-redundant, provisioned Session account must be accepted.'
Assert-Contract ((Get-StgCosmosPreferredRegions $haCfg) -ceq 'eastus2,centralus') 'Preferred read regions follow the failover order.'
$single = @{ location = 'eastus2'; stage1 = @{ cosmosCapacityMode = 'serverless' }; cosmos = @{ capacityMode = 'serverless' } }
Assert-Contract (-not @(Get-StgCosmosProblems $single).Count -and (Get-StgCosmosPreferredRegions $single) -ceq '' -and @(Get-StgCosmosRegions $single).Count -eq 1 -and -not (Get-StgCosmosRegions $single)[0].isZoneRedundant) 'No cosmosLocations keeps one region, no zone redundancy, and no preferred-region setting.'
$zoneServerless = @{ location = 'eastus2'; stage1 = @{ cosmosCapacityMode = 'serverless'; cosmosLocations = @(@{ locationName = 'eastus2'; isZoneRedundant = $true }) }; cosmos = @{ capacityMode = 'serverless' } }
Assert-Contract (-not @(Get-StgCosmosProblems $zoneServerless).Count) 'Zone-redundant serverless in one region must be accepted.'
function Test-CosmosRefusal([scriptblock]$Mutate, [string]$Pattern, [string]$Why) {
    $c = $haCfg | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable; & $Mutate $c
    Assert-Contract (@(@(Get-StgCosmosProblems $c) -match $Pattern).Count -ge 1) $Why
}
Test-CosmosRefusal { param($c) $c.stage1.cosmosCapacityMode = 'serverless'; $c.cosmos.capacityMode = 'serverless' } 'serverless' 'Serverless with two regions must be refused (a serverless account runs in one region).'
Test-CosmosRefusal { param($c) $c.cosmos.capacityMode = 'serverless' } 'capacityMode' 'Stage 1 and Stage 2 capacity modes must agree.'
Test-CosmosRefusal { param($c) $c.stage1.cosmosLocations[0].locationName = 'centralus'; $c.stage1.cosmosLocations[1].locationName = 'eastus2' } 'first region' 'The first region (the write region) must be the deployment location.'
Test-CosmosRefusal { param($c) $c.stage1.cosmosLocations[1].locationName = 'eastus2' } 'duplicate' 'A region listed twice must be refused.'
Test-CosmosRefusal { param($c) $c.stage1.cosmosLocations[1].locationName = 'East US 2' } 'region name' 'Region names must be ARM names (lower-case letters and digits).'
Test-CosmosRefusal { param($c) $c.stage1.cosmosLocations[1].isZoneRedundant = 'yes' } 'isZoneRedundant' 'isZoneRedundant must be a boolean.'
Test-CosmosRefusal { param($c) $c.stage1.cosmosConsistency = @{ defaultConsistencyLevel = 'Sesion' } } 'consistency' 'An unknown consistency level must be refused.'
Test-CosmosRefusal { param($c) $c.stage1.cosmosConsistency = @{ defaultConsistencyLevel = 'BoundedStaleness'; maxStalenessPrefix = 1000; maxIntervalInSeconds = 300 } } 'maxStalenessPrefix' 'Bounded staleness across regions needs at least 100,000 writes.'
Test-CosmosRefusal { param($c) $c.stage1.cosmosConsistency = @{ defaultConsistencyLevel = 'BoundedStaleness'; maxStalenessPrefix = 100000; maxIntervalInSeconds = 60 } } 'maxIntervalInSeconds' 'Bounded staleness across regions needs at least 300 seconds.'
$bounded = $haCfg | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable; $bounded.stage1.cosmosConsistency = @{ defaultConsistencyLevel = 'BoundedStaleness'; maxStalenessPrefix = 100000; maxIntervalInSeconds = 300 }
Assert-Contract (-not @(Get-StgCosmosProblems $bounded).Count) 'Bounded staleness at the multi-region minimums must be accepted.'
# Read-back: az cosmosdb show reports display names ("East US 2") and the failover priority.
$shown = @{ enableAutomaticFailover = $true; consistencyPolicy = @{ defaultConsistencyLevel = 'Session' }
    locations = @(@{ locationName = 'Central US'; failoverPriority = 1; isZoneRedundant = $true }, @{ locationName = 'East US 2'; failoverPriority = 0; isZoneRedundant = $true }) }
Assert-Contract (-not @(Get-StgCosmosAccountProblems $haCfg $shown).Count) 'The deployed account matching the configuration must pass the read-back.'
foreach ($bad in @(
    @{ k = 'failover'; f = { param($s) $s.enableAutomaticFailover = $false } },
    @{ k = 'zone'; f = { param($s) $s.locations[0].isZoneRedundant = $false } },
    @{ k = 'order'; f = { param($s) $s.locations[0].failoverPriority = 0; $s.locations[1].failoverPriority = 1 } },
    @{ k = 'consistency'; f = { param($s) $s.consistencyPolicy.defaultConsistencyLevel = 'Eventual' } },
    @{ k = 'missing'; f = { param($s) $s.locations = @($s.locations[1]) } })) {
    $s = $shown | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable; & $bad.f $s
    Assert-Contract (@(Get-StgCosmosAccountProblems $haCfg $s).Count -ge 1) "The read-back must catch a deployed account that differs ($($bad.k))."
}
$s1Text = Get-Content -Raw (Join-Path $root 'infra\staged\main.bicep')
Assert-Contract ($s1Text -match 'param cosmosLocations array = \[\]' -and $s1Text -match 'locations: \[for \(r, i\) in cosmosRegions: \{ locationName: r\.locationName, failoverPriority: i, isZoneRedundant: r\.isZoneRedundant \}\]' -and $s1Text -match 'enableAutomaticFailover: length\(cosmosRegions\) > 1' -and $s1Text -match 'consistencyPolicy: cosmosConsistency') 'Stage 1 must deploy the configured regions in order, failover with two or more, and the configured consistency.'
$resText = Get-Content -Raw (Join-Path $root 'infra\staged\Staged.Resources.ps1')
# Council G-HA: private DNS names for every Cosmos region; bounded-staleness bounds read back; exact capacity pairs.
$fq = { param($n) "$n.privatelink.documents.azure.com" }
$okRecords = @((& $fq 'acct'), (& $fq 'acct-eastus2'), (& $fq 'acct-centralus'))
Assert-Contract (-not @(Get-StgCosmosDnsProblems -AccountName 'acct' -Regions @('eastus2', 'centralus') -Fqdns $okRecords).Count) 'A Cosmos endpoint with the global name and every region name must pass.'
Assert-Contract (@(Get-StgCosmosDnsProblems -AccountName 'acct' -Regions @('eastus2', 'centralus') -Fqdns @($okRecords[0], $okRecords[1])) -match 'acct-centralus').Count -eq 1 'A missing secondary-region DNS name must be reported by name.'
Assert-Contract (@(Get-StgCosmosDnsProblems -AccountName 'acct' -Regions @('eastus2') -Fqdns @((& $fq 'acct-eastus2'))) -match "'acct'").Count -eq 1 'A missing global DNS name must be reported.'
Assert-Contract (-not @(Get-StgCosmosDnsProblems -AccountName 'ACCT' -Regions @('eastus2') -Fqdns @('acct.privatelink.documents.azure.com.', 'Acct-EastUS2.privatelink.documents.azure.com')).Count) 'DNS names compare without case or a trailing dot.'
$verifyArgs = Get-StgNetworkVerifyArguments @{ subscriptionId = '00000000-0000-4000-8000-000000000002'; resourceGroup = 'rg'; location = 'eastus2'; stage1 = $haCfg.stage1; cosmos = $haCfg.cosmos
    network = @{ existing = @{ functionsSubnetId = '/subscriptions/s/resourceGroups/n/providers/Microsoft.Network/virtualNetworks/v/subnets/f'; privateEndpointSubnetId = '/subscriptions/s/resourceGroups/n/providers/Microsoft.Network/virtualNetworks/v/subnets/p' } }; backends = @() } @{ names = @{ apps = @{} }; cosmosAccountId = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.DocumentDB/databaseAccounts/acct' }
Assert-Contract ((@($verifyArgs.CosmosRegions) -join ',') -ceq 'eastus2,centralus') 'Stage 6 verify mode must pass every Cosmos region to the network check.'
$netText = Get-Content -Raw (Join-Path $root 'scripts\manual\Test-NetworkConfiguration.ps1')
Assert-Contract ($netText -match '\[string\[\]\]\$CosmosRegions = @\(\)' -and $netText -match "Add-Result 'PrivateDNS' 'Cosmos regional names' 'FAIL'") 'The network check must FAIL when a Cosmos region has no private DNS name.'
Assert-Contract ($resText -match 'Get-StgCosmosDnsProblems -AccountName \$s1\.names\.cosmosAccount') 'Stage 6 (existing/create) must check the Cosmos endpoint DNS names for every region.'
$bs = $bounded | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
$bsShown = $shown | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
$bsShown.consistencyPolicy = @{ defaultConsistencyLevel = 'BoundedStaleness'; maxStalenessPrefix = 100000; maxIntervalInSeconds = 300 }
Assert-Contract (-not @(Get-StgCosmosAccountProblems $bs $bsShown).Count) 'Bounded staleness with the configured bounds must pass the read-back.'
$bsShown.consistencyPolicy.maxIntervalInSeconds = 600
Assert-Contract (@(Get-StgCosmosAccountProblems $bs $bsShown) -match 'maxIntervalInSeconds').Count -eq 1 'A deployed bounded-staleness interval that differs must be caught.'
$bsShown.consistencyPolicy.maxIntervalInSeconds = 300; $bsShown.consistencyPolicy.maxStalenessPrefix = 200000
Assert-Contract (@(Get-StgCosmosAccountProblems $bs $bsShown) -match 'maxStalenessPrefix').Count -eq 1 'A deployed bounded-staleness prefix that differs must be caught.'
Test-CosmosRefusal { param($c) $c.cosmos.capacityMode = 'provisioned' } 'capacityMode' 'Only provisioned with provisioned-autoscale (or serverless with serverless) may be paired.'
$exampleHa = Get-Content -Raw (Join-Path $root 'infra\staged\staged.config.example.json') | ConvertFrom-Json -AsHashtable -Depth 100
Assert-Contract (@($exampleHa.stage1.cosmosLocations).Count -ge 2 -and @($exampleHa.stage1.cosmosLocations | Where-Object { -not $_.isZoneRedundant }).Count -eq 0 -and $exampleHa.stage1.cosmosLocations[0].locationName -ceq $exampleHa.location -and -not @(Get-StgCosmosProblems $exampleHa).Count) 'The example configuration must use two zone-redundant regions and pass the Cosmos checks.'
Assert-Contract ($resText -match 'Get-StgCosmosAccountProblems \$Cfg \$cosmos') 'Stage 1 must read back the Cosmos regions, failover and consistency.'
Assert-Contract ($settingsModule -match "COSMOS_PREFERRED_REGIONS: join\(resolver\.\?preferredRegions \?\? \[\], ','\)" -and $appText -match 'preferredRegions = @\(\(Get-StgCosmosPreferredRegions \$Cfg\)') 'Stage 5 must give the resolver the preferred read regions.'

# Group entries (ADR-0034, G-SEED): a staged group is its own entity, with no project or classification.
$exampleCfg = Get-Content -Raw (Join-Path $root 'infra\staged\staged.config.example.json') | ConvertFrom-Json -AsHashtable -Depth 100
$groupEntry = @($exampleCfg.groups | Where-Object { $_.kind -ceq 'group' })[0]
Assert-Contract ($null -ne $groupEntry -and -not @($exampleCfg.groups | Where-Object { $_.kind -cne 'group' }).Count) 'The example configuration must onboard its pilot as a group (kind group), with no classification entries.'
$baselineEntry = @{ projectId = 'P1'; classification = 'STD'; groupDisplayName = 'CCOF-P1-STD' }
$byId = @{ kind = 'group'; groupId = '0000000A-0000-4000-8000-0000000000AA' }
Assert-Contract ((Get-StgGroupKey $baselineEntry) -ceq 'P1/STD' -and (Get-StgGroupKey $groupEntry) -ceq "group/$($groupEntry.groupDisplayName)" -and (Get-StgGroupKey $byId) -ceq 'group/0000000a-0000-4000-8000-0000000000aa') 'Stage 4 keys: project/classification for baseline entries, group/<name or id> for group entries.'
Assert-Contract (-not @(Get-StgGroupEntryProblems $groupEntry).Count -and -not @(Get-StgGroupEntryProblems $baselineEntry).Count) 'A group entry without project/classification and a baseline entry must both be accepted.'
$mixed = $groupEntry | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable; $mixed.classification = 'STD'
Assert-Contract (@(@(Get-StgGroupEntryProblems $mixed) -match 'no projectId or classification').Count -eq 1) 'A group entry that also names a classification must be refused.'
Assert-Contract (@(@(Get-StgGroupEntryProblems @{ projectId = 'P1'; groupDisplayName = 'x' }) -match 'needs projectId and classification').Count -eq 1) 'A baseline entry without classification must still be refused.'
$nameless = $groupEntry | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable; $nameless.Remove('groupDisplayName')
Assert-Contract (@(@(Get-StgGroupEntryProblems $nameless) -match 'needs groupId or groupDisplayName').Count -eq 1) 'A group entry without groupId or groupDisplayName must be refused.'
Assert-Contract (@(Select-StgBaselineGroups @($baselineEntry, $groupEntry)).Count -eq 1 -and (@(Select-StgBaselineGroups @($baselineEntry, $groupEntry))[0].projectId -ceq 'P1')) 'Only baseline entries reach the quickstart functions.'
$entraGroups = @{ (Get-StgGroupKey $groupEntry) = @{ id = '0000000A-0000-4000-8000-0000000000AA'; displayName = $groupEntry.groupDisplayName } }
$groupDocs = @(New-StgGroupDocuments -Groups @($baselineEntry, $groupEntry) -EntraGroups $entraGroups)
$gd = $groupDocs[0]
Assert-Contract ($groupDocs.Count -eq 1 -and $gd.id -ceq '0000000a-0000-4000-8000-0000000000aa' -and $gd.groupId -ceq $gd.id -and $gd.projectId -ceq $gd.id -and $gd.kind -ceq 'group' -and $gd.status -ceq 'active' -and $null -eq $gd.retiredAt) 'A group document carries the lower-case Entra object ID as id, groupId and projectId, active.'
Assert-Contract (-not $gd.Contains('members') -and -not $gd.Contains('groupDisplayName') -and -not $gd.Contains('classification')) 'A group document must not carry configuration-only fields.'
$sparse = $groupEntry | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable; $sparse.Remove('restrictedFamiliesApproved'); $sparse.chargebackId = ''
$sd = @(New-StgGroupDocuments -Groups @($sparse) -EntraGroups $entraGroups)[0]
Assert-Contract ($sd.Contains('chargebackId') -and $null -eq $sd.chargebackId -and $sd.restrictedFamiliesApproved -is [bool] -and -not $sd.restrictedFamiliesApproved) 'An entry without chargebackId or approval yields chargebackId null and restrictedFamiliesApproved false (the contract requires both keys).'
$missingGroup = $false
try { $null = New-StgGroupDocuments -Groups @($groupEntry) -EntraGroups @{} } catch { $missingGroup = $_.Exception.Message -match 'group_not_resolved' }
Assert-Contract $missingGroup 'A group entry without its Stage 4 Entra group must be refused.'
$rows = @(Get-StgGroupWorkbookRows -Documents $groupDocs)
Assert-Contract ($rows.Count -eq 1 -and $rows[0].projectId -ceq $gd.id -and $rows[0].classification -ceq 'group' -and $rows[0].groupId -ceq $gd.id -and $rows[0].displayName -ceq $gd.displayName) 'Workbook rows for groups use the wire scope (projectId = group ID, code group).'
# Cross-language: the staged group document passes the group contract and the registry seed check.
$docFile = Join-Path ([IO.Path]::GetTempPath()) "staged-group-$([guid]::NewGuid().ToString('N')).json"
try {
    ConvertTo-Json -InputObject @($groupDocs) -Depth 50 | Set-Content -LiteralPath $docFile -Encoding utf8NoBOM
    $checker = Join-Path $root 'tests\helpers\check-group-documents.ts'
    $verdict = & node $checker $docFile 2>&1
    Assert-Contract ($LASTEXITCODE -eq 0) "The staged group document fails the group contract: $verdict"
    $bad = $groupDocs[0] | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable; $bad.surfaces = @()
    ConvertTo-Json -InputObject @($bad) -Depth 50 | Set-Content -LiteralPath $docFile -Encoding utf8NoBOM
    $null = & node $checker $docFile 2>&1
    Assert-Contract ($LASTEXITCODE -ne 0) 'Negative control: the contract checker must refuse a group document without surfaces.'
} finally { Remove-Item -LiteralPath $docFile -ErrorAction SilentlyContinue }
$noSelector = New-StgGatewayHeaders -Token 'token-placeholder' -Project $exampleCfg.acceptance.allowed[0].project -ProjectHeader 'x-ccof-project'
Assert-Contract (-not $exampleCfg.acceptance.allowed[0].Contains('project') -and -not $noSelector.ContainsKey('x-ccof-project')) 'Group acceptance requests must carry no project selector.'
# Stage 7 client file for a group: client.group selects the entry; the selector value is the group's object ID.
$realClientFiles = ${function:New-QsClientFiles}
try {
    Set-Item function:New-QsClientFiles { param($Ctx, $ProjectId, $FamilyPolicy, $BackendId, $Aliases) @{ projectId = $ProjectId; backendId = $BackendId; families = @($FamilyPolicy.families.Keys | Sort-Object); aliases = $Aliases } }
    $clientCfg = @{ client = $exampleCfg.client; groups = $exampleCfg.groups }
    $made = Invoke-StgClient -Ctx @{} -Cfg $clientCfg -EntraGroups $entraGroups
    Assert-Contract ($made.projectId -ceq '0000000a-0000-4000-8000-0000000000aa' -and $made.backendId -ceq $groupEntry.backendId -and ($made.families -join ',') -ceq 'haiku,sonnet' -and $made.aliases.haiku -ceq 'claude-haiku-4-5') 'client.group must build the client file from that group''s ID, backend, families and aliases.'
    foreach ($case in 'unknown-group', 'extra-key', 'unapproved-fable') {
        $badCfg = $clientCfg | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable -Depth 100
        switch ($case) {
            'unknown-group' { $badCfg.client.group = 'CCOF-ABSENT' }
            'extra-key' { $badCfg.client.classification = 'STD' }
            'unapproved-fable' { $badCfg.groups[0].familyPolicy.families.fable = @{ models = @('claude-fable-1') } }
        }
        $refusedClient = $false
        try { $null = Invoke-StgClient -Ctx @{} -Cfg $badCfg -EntraGroups $entraGroups } catch { $refusedClient = $_.Exception.Message -match 'client_selection_invalid' }
        Assert-Contract $refusedClient "client.group case $case must be refused."
    }
} finally { Set-Item function:New-QsClientFiles $realClientFiles }
$stage7Body = @($functionAsts | Where-Object Name -EQ 'Invoke-Stage7')[0].Body.Extent.Text
$stage5Body = @($functionAsts | Where-Object Name -EQ 'Invoke-Stage5')[0].Body.Extent.Text
$qsParamsBody = @($functionAsts | Where-Object Name -EQ 'Get-StgQuickstartParameters')[0].Body.Extent.Text
Assert-Contract ($stage7Body -match 'Invoke-StgSeed -Ctx \$ctx -GroupDocuments \$groupDocs' -and $stage7Body -match 'Invoke-StgClient -Ctx \$ctx -Cfg \$Cfg' -and $stage7Body -notmatch 'Invoke-QsSeed \$ctx') 'Stage 7 must seed group documents and build the client file through the group-aware functions.'
Assert-Contract ($stage5Body -match 'Get-StgGroupWorkbookRows' -and $qsParamsBody -match 'Select-StgBaselineGroups \$Cfg\.groups') 'Stage 5 must add group workbook rows; only baseline entries may reach the quickstart parameters.'
# Council G-SEED fixes: backend reference, Entra group still present before the seed, Stage 8 selected group.
Assert-Contract (@(@(Get-StgGroupEntryProblems $groupEntry -BackendIds @('other')) -match 'not in backends').Count -eq 1 -and -not @(Get-StgGroupEntryProblems $groupEntry -BackendIds @($groupEntry.backendId)).Count) 'A group entry naming an unconfigured backendId must be refused.'
$realGraph = ${function:Get-StgGraph}
try {
    Set-Item function:Get-StgGraph { param($Path) @{ id = '0000000a-0000-4000-8000-0000000000aa'; securityEnabled = $true } }
    Assert-StgGroupsExist $groupDocs
    $script:passed++
    foreach ($graph in @({ param($Path) throw 'Request_ResourceNotFound' }, { param($Path) @{ id = '0000000a-0000-4000-8000-0000000000aa'; securityEnabled = $false } })) {
        Set-Item function:Get-StgGraph $graph
        $gone = $false
        try { Assert-StgGroupsExist $groupDocs } catch { $gone = $_.Exception.Message -match 'group_missing' }
        Assert-Contract $gone 'A group deleted (or no longer a security group) since Stage 4 must stop Stage 7 before any seed.'
    }
} finally { Set-Item function:Get-StgGraph $realGraph }
$stage7Text = @($functionAsts | Where-Object Name -EQ 'Invoke-Stage7')[0].Body.Extent.Text
Assert-Contract ($stage7Text.IndexOf('Assert-StgGroupsExist $groupDocs') -gt 0 -and $stage7Text.IndexOf('Assert-StgGroupsExist $groupDocs') -lt $stage7Text.IndexOf('Invoke-QsCode $ctx')) 'Stage 7 must recheck the Entra groups before publishing or seeding.'
$expected = Get-StgExpectedGroupId -Cfg @{ acceptance = $exampleCfg.acceptance; groups = $exampleCfg.groups } -EntraGroups $entraGroups
Assert-Contract ($expected -ceq '0000000a-0000-4000-8000-0000000000aa') 'Stage 8 must expect the single group entry when requests carry no selector.'
Assert-Contract ($null -eq (Get-StgExpectedGroupId -Cfg @{ acceptance = @{ allowed = @(@{ project = 'P1'; model = 'm' }) }; groups = @($baselineEntry) } -EntraGroups @{})) 'Requests that name a project need no expected group.'
$mixedAcceptance = @{ allowed = @(@{ model = 'm' }, @{ project = 'P1'; model = 'm' }); denied = @() }
$mixedRefused = $false
try { $null = Get-StgExpectedGroupId -Cfg @{ acceptance = $mixedAcceptance; groups = $exampleCfg.groups } -EntraGroups $entraGroups } catch { $mixedRefused = $_.Exception.Message -match 'acceptance_mixed_selectors' }
Assert-Contract $mixedRefused 'Allowed requests mixing a project selector with none must be refused, not left unverified.'
$deniedNamed = @{ allowed = @(@{ model = 'm' }); denied = @(@{ project = 'P1'; model = 'x'; expectedStatus = 403 }) }
Assert-Contract ((Get-StgExpectedGroupId -Cfg @{ acceptance = $deniedNamed; groups = $exampleCfg.groups } -EntraGroups $entraGroups) -ceq '0000000a-0000-4000-8000-0000000000aa') 'A denied request naming a project must not switch off the selected-group check.'
$two = @($groupEntry, ($groupEntry | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable)); $two[1].groupDisplayName = 'CCOF-OTHER'
$ambiguous = $false
try { $null = Get-StgExpectedGroupId -Cfg @{ acceptance = $exampleCfg.acceptance; groups = $two } -EntraGroups $entraGroups } catch { $ambiguous = $_.Exception.Message -match 'acceptance_group_ambiguous' }
Assert-Contract $ambiguous 'Two group entries without acceptance.expectedGroup must be refused.'
$reqId = '11111111-2222-4333-8444-555555555555'
Assert-Contract ((New-StgSelectionQuery -RequestIds @($reqId)) -match "in \('$reqId'\)" -and (New-StgSelectionQuery -RequestIds @($reqId)) -match "ccof\.usage\.v1") 'The selection query must filter this run''s request IDs in the usage trace.'
$injection = $false
try { $null = New-StgSelectionQuery -RequestIds @("x') | take 1 //") } catch { $injection = $_.Exception.Message -match 'request_id_invalid' }
Assert-Contract $injection 'A non-GUID request ID must not reach the query text.'
Assert-StgSelectedGroup -Row @{ requests = 1; projectIds = @('0000000A-0000-4000-8000-0000000000AA') } -ExpectedGroupId $expected -Requests 1
$script:passed++
foreach ($row in @(@{ requests = 1; projectIds = @('0000000b-0000-4000-8000-0000000000bb') }, @{ requests = 2; projectIds = @($expected, '0000000b-0000-4000-8000-0000000000bb') }, @{ requests = 0; projectIds = @() })) {
    $wrong = $false
    try { Assert-StgSelectedGroup -Row $row -ExpectedGroupId $expected -Requests $row.requests } catch { $wrong = $_.Exception.Message -match 'verify_failed' }
    if ($row.requests -eq 0) { $wrong = $false; try { Assert-StgSelectedGroup -Row $row -ExpectedGroupId $expected -Requests 1 } catch { $wrong = $_.Exception.Message -match 'verify_failed' } }
    Assert-Contract $wrong "Stage 8 must refuse requests charged to another group or untraced ($($row.projectIds -join ','))."
}
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
    $vnetPath = '/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet/subnets'
    $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    $placeholderRefused = $false
    try { $null = Read-StgConfig $tmp } catch { $placeholderRefused = $_.Exception.Message -match 'network.mode verify requires' }
    Assert-Contract $placeholderRefused 'The example''s placeholder subnet IDs must be refused in verify mode.'
    $c.network.existing = @{ functionsSubnetId = "$vnetPath/functions"; privateEndpointSubnetId = "$vnetPath/private"; apimSubnetId = "$vnetPath/apim" }
    $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    $read = Read-StgConfig $tmp
    Assert-Contract ($read.network.mode -ceq 'verify') 'The example network mode must be verify: the customer builds the network.'
    foreach ($value in @('true', 1, $null)) {
        $c.resolver.requireCompleteUsage = $value
        $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
        $badComplete = $false
        try { $null = Read-StgConfig $tmp } catch { $badComplete = $_.Exception.Message -match 'resolver.requireCompleteUsage' }
        Assert-Contract $badComplete 'The complete-usage guard must be a JSON boolean, never coerced or silently disabled.'
    }
    $c.resolver.requireCompleteUsage = $true
    $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    $badComplete = $false
    try { $null = Read-StgConfig $tmp } catch { $badComplete = $_.Exception.Message -match 'requires budget-state' }
    Assert-Contract $badComplete 'The complete-usage guard must refuse token-limits-only mode before Azure calls.'
    $c.resolver.requireCompleteUsage = $false
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
    # Network-last order: 2 schema, 3 grants (needs 2), 4 Entra, 5 configuration, 6 network, 7 code (needs 6).
    Assert-Contract ((@(Get-StgStageDependencies 3) -join ',') -ceq '1,2') 'Grants (Stage 3) must depend on Stage 1 and the schema (Stage 2).'
    Assert-Contract ((@(Get-StgStageDependencies 6) -join ',') -ceq '1') 'The network (Stage 6) must need only Stage 1 resources.'
    Assert-Contract ((@(Get-StgStageDependencies 7) -join ',') -ceq '1,4,5,6') 'Publishing (Stage 7) must require Entra, configuration and the verified network.'
    foreach ($n in 2..5) { Assert-Contract (@(Get-StgStageDependencies $n) -notcontains 6) "Stage $n must not need the network: it runs before Stage 6." }
    Save-StgStage $cfgA 2 @{ marker = 'schema-a' }
    Save-StgStage $cfgA 3 @{ marker = 'grants-a' }
    Save-StgStage $cfgA 1 @{ marker = 'a'; durationSeconds = 999 }
    Assert-Contract ((Get-StgStage $cfgA 3).marker -ceq 'grants-a') 'A duration-only change must not invalidate dependent stages.'
    Save-StgStage $cfgA 2 @{ marker = 'schema-a'; verify = @{ containers = 9; readAt = 'later' } }
    Assert-Contract ((Get-StgStage $cfgA 3).marker -ceq 'grants-a') 'A changed read-back snapshot (verify) must not invalidate dependent stages.'
    $state = Read-StgState $cfgA
    $legacyOutput = ConvertTo-StgCanonical $state.stages['1'].outputs | ConvertTo-Json -Depth 100 -Compress
    $state.stages['3'].dependencyHashes['1'] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($legacyOutput))).ToLowerInvariant()
    $state | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Get-StgStatePath $cfgA) -Encoding utf8NoBOM
    $null = Get-StgStage $cfgA 3
    $state = Read-StgState $cfgA
    Assert-Contract ($state.stages['3'].dependencyHashes['1'] -ceq (Get-StgDependencyHashes $state 3)['1']) 'Legacy duration-inclusive dependency hashes must migrate only when the saved output matches exactly.'
    Save-StgStage $cfgA 2 @{ marker = 'schema-b' }
    $dependencyChanged = $false
    try { $null = Get-StgStage $cfgA 3 } catch { $dependencyChanged = $_.Exception.Message -match 'stage_dependency_changed' }
    Assert-Contract $dependencyChanged 'Downstream outputs must not be reused after a prerequisite stage is reapplied.'

    # Layout 1 state (network was Stage 2) moves to the network-last keys, hashes untouched, with a backup.
    $legacyDir = Join-Path $stateDir 'layout1'; New-Item -ItemType Directory -Path $legacyDir | Out-Null
    $script:StateDir = $legacyDir
    $layout1 = @{ schemaVersion = 1; target = (Get-StgTarget $cfgA); stages = @{
        '1' = @{ configHash = 'h1'; outputs = @{ marker = 'resources' } }
        '2' = @{ configHash = 'h2'; dependencyHashes = @{ '1' = 'd1' }; outputs = @{ marker = 'network' } }
        '3' = @{ configHash = 'h3'; dependencyHashes = @{ '1' = 'd1' }; outputs = @{ marker = 'schema' } }
        '4' = @{ configHash = 'h4'; dependencyHashes = @{ '1' = 'd1'; '3' = 'd3' }; outputs = @{ marker = 'grants' } }
        '6' = @{ configHash = 'h6'; dependencyHashes = @{ '1' = 'd1'; '4' = 'd4'; '5' = 'd5' }; outputs = @{ marker = 'config' } }
        '7' = @{ configHash = 'h7'; dependencyHashes = @{ '1' = 'd1'; '2' = 'd2'; '5' = 'd5'; '6' = 'd6' }; outputs = @{ marker = 'code' } } } }
    $layout1 | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $legacyDir 'state.json') -Encoding utf8NoBOM
    $moved = Read-StgState $cfgA
    Assert-Contract ($moved.stageLayout -eq 2 -and $moved.stages['6'].outputs.marker -ceq 'network' -and $moved.stages['2'].outputs.marker -ceq 'schema' -and
        $moved.stages['3'].outputs.marker -ceq 'grants' -and $moved.stages['5'].outputs.marker -ceq 'config' -and -not $moved.stages['4']) 'Layout 1 stage keys must move to the network-last numbers.'
    Assert-Contract ((($moved.stages['3'].dependencyHashes.Keys | Sort-Object) -join ',') -ceq '1,2' -and $moved.stages['3'].dependencyHashes['2'] -ceq 'd3') 'Moved dependency hashes must keep their values under the new keys.'
    Assert-Contract ((($moved.stages['7'].dependencyHashes.Keys | Sort-Object) -join ',') -ceq '1,4,5,6' -and $moved.stages['7'].dependencyHashes['6'] -ceq 'd2') 'Stage 7 must keep its network dependency under Stage 6.'
    Assert-Contract (Test-Path -LiteralPath (Join-Path $legacyDir 'state.layout1.json')) 'Layout migration must keep a backup of the original state.'
    Assert-Contract ((Read-StgState $cfgA).stages['6'].outputs.marker -ceq 'network') 'A migrated state must not be migrated twice.'

    # Stage 6 verify mode: the customer network check decides; a FAIL row stops the stage and nothing is created.
    $fakeRepo = Join-Path $stateDir 'repo'; New-Item -ItemType Directory -Path (Join-Path $fakeRepo 'scripts/manual') -Force | Out-Null
    $fakeCheck = Join-Path $fakeRepo 'scripts/manual/Test-NetworkConfiguration.ps1'
    $savedRepo = $script:Repo; $script:Repo = $fakeRepo; $script:StateDir = $stateDir
    try {
        $netCfg = @{ subscriptionId = '00000000-0000-4000-8000-00000000000b'; resourceGroup = 'rg-a'; stage1 = @{ apimSku = 'StandardV2' }
            network = @{ mode = 'verify'; existing = @{ functionsSubnetId = "$vnetPath/functions"; privateEndpointSubnetId = "$vnetPath/private"; apimSubnetId = "$vnetPath/apim" } }
            backends = @(@{ subscriptionId = 's2'; resourceGroup = 'rg-f'; accountName = 'fd1'; privateEndpoint = $true }, @{ subscriptionId = 's2'; resourceGroup = 'rg-f'; accountName = 'fd2'; privateEndpoint = $false }) }
        $stage1Out = @{ cosmosAccountId = '/x/cosmos'; apimName = 'apim1'; apimId = '/x/apim1'
            names = @{ apps = @{ sync = @{ functionApp = 'app-sync'; storageAccount = 'stsync' }; resolver = @{ functionApp = 'app-res'; storageAccount = 'stres' } } } }
        $verifyArgs = Get-StgNetworkVerifyArguments $netCfg $stage1Out
        Assert-Contract ($verifyArgs.VnetResourceId -ceq ($vnetPath -replace '/subnets$', '') -and $verifyArgs.FlexSubnet -ceq 'functions' -and $verifyArgs.PeSubnet -ceq 'private' -and $verifyArgs.ApimSubnet -ceq 'apim') 'Verify mode must check the configured VNet and subnets.'
        Assert-Contract (@($verifyArgs.FunctionAppIds).Count -eq 2 -and @($verifyArgs.StorageAccountIds).Count -eq 2 -and @($verifyArgs.FoundryResourceId).Count -eq 1 -and $verifyArgs.FoundryResourceId[0] -like '*/accounts/fd1') 'Verify mode must check every app, its storage and each private Foundry backend only.'
        $stage1Out.apimName = ''
        Assert-Contract (-not (Get-StgNetworkVerifyArguments $netCfg $stage1Out).Contains('ApimSubnet')) 'Without a Stage 1 Standard v2 APIM, the APIM subnet is not checked.'
        $stage1Out.apimName = 'apim1'
        $fakeBody = @(
            'param([string]$SubscriptionId, [string]$VnetResourceId, [string]$ApimSubnet, [string]$FlexSubnet, [string]$PeSubnet, [string]$CosmosResourceId, [string[]]$StorageAccountIds, [string[]]$FunctionAppIds, [string]$ApimResourceId, [string[]]$FoundryResourceId, [string]$ResultPath)'
            "ConvertTo-Json -InputObject @(@{ Area = 'Subnet'; Item = `$FlexSubnet; State = 'PASS'; Detail = '' }, @{ Area = 'PrivateEndpoint'; Item = 'cosmos [Sql]'; State = 'FAIL'; Detail = 'no private endpoint' }) | Set-Content -LiteralPath `$ResultPath"
            'exit 1')
        Set-Content -LiteralPath $fakeCheck -Encoding utf8NoBOM -Value $fakeBody
        $refused = $false
        try { $null = Invoke-StgNetworkVerify -Cfg $netCfg -Stage1 $stage1Out -Apply } catch { $refused = $_.Exception.Message -match 'verify_failed: the customer network check reported 1 FAIL rows: PrivateEndpoint cosmos' }
        Assert-Contract $refused 'Stage 6 verify must stop on a FAIL row from the network check.'
        Set-Content -LiteralPath $fakeCheck -Encoding utf8NoBOM -Value ($fakeBody -replace "State = 'FAIL'", "State = 'PASS'" -replace '^exit 1$', 'exit 0')
        $ok = Invoke-StgNetworkVerify -Cfg $netCfg -Stage1 $stage1Out -Apply
        Assert-Contract ($ok.mode -ceq 'verify' -and $ok.functionsSubnetId -ceq "$vnetPath/functions" -and $ok.verify.fail -eq 0 -and $ok.verify.pass -eq 2) 'Stage 6 verify must record the subnets and the check result when every row passes.'
    } finally { $script:Repo = $savedRepo }
    # The network check wraps the CLI in a function named Az; a bare `& az` resolves to that function
    # (names are case-insensitive) and recursed forever. Every CLI call must use the resolved executable.
    $checkAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts\manual\Test-NetworkConfiguration.ps1'), [ref]$null, [ref]$null)
    $bareAz = @($checkAst.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.InvocationOperator -eq 'Ampersand' -and $n.CommandElements[0].Extent.Text -ieq 'az' }, $true))
    Assert-Contract ($bareAz.Count -eq 0) "Test-NetworkConfiguration.ps1 calls the bare az name, which resolves to its own Az function: $($bareAz.Extent.Text -join '; ')"
    $badVnet = (Get-Content -LiteralPath $example -Raw | ConvertFrom-Json -AsHashtable -Depth 100)
    $badVnet.tenantId = '00000000-0000-4000-8000-000000000001'; $badVnet.subscriptionId = '00000000-0000-4000-8000-000000000002'
    $badVnet.network.existing = @{ functionsSubnetId = "$vnetPath/functions"; privateEndpointSubnetId = ($vnetPath -replace 'vnet/subnets', 'other/subnets') + '/private' }
    $badPath = Join-Path $stateDir 'bad-vnet.json'; $badVnet | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $badPath -Encoding utf8NoBOM
    $refused = $false; try { $null = Read-StgConfig $badPath } catch { $refused = $_.Exception.Message -match 'same VNet' }
    Assert-Contract $refused 'Verify mode must refuse subnets from different VNets.'

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

"Staged stages: $passed checks passed (4 stage boundaries, negative control, Cosmos contract, network-last order and layout migration, network verify mode, driver and configuration). No Azure calls."
