#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
$passed = 0
function Check([bool]$ok, [string]$message) { if (-not $ok) { throw $message }; $script:passed++ }
$sub = '00000000-0000-4000-8000-000000000002'
function New-Config {
    @{
        subscriptionId = $sub; resourceGroup = 'contoso-rg'; tenantId = $sub
        stage1 = @{ foundry = @{ create = $false } }; network = @{ mode = 'create' }
        backends = @(@{ id = 'claude'; subscriptionId = $sub; resourceGroup = 'contoso-rg'
            accountName = 'primary'; url = 'https://primary.services.ai.azure.com/anthropic'
            deploymentInferenceGeo = @{ 'claude-haiku-5-5' = 'global' }
            failover = @{ subscriptionId = $sub; resourceGroup = 'contoso-rg'; accountName = 'standby'
                url = 'https://standby.services.ai.azure.com/anthropic'; privateEndpoint = $true
                deploymentInferenceGeo = @{ 'claude-haiku-5-5' = 'global' } } })
    }
}
$c = New-Config
Check (@(Get-StgFailoverProblems $c).Count -eq 0) 'valid failover must be accepted'
$members = @(Get-StgFoundryMembers $c)
Check ($members.Count -eq 2 -and $members[0].id -ceq 'claude-primary' -and $members[1].id -ceq 'claude-failover') 'Stage 3 must grant both distinct pool members'
$plan = @(Get-StgApimBackendPlan $c)
Check ($plan.Count -eq 1 -and $plan[0].id -ceq 'claude' -and $plan[0].failover.id -ceq 'claude-failover') 'routing must retain the logical backend ID'
Check ($plan[0].circuitBreaker.rules[0].failureCondition.statusCodeRanges[0].min -eq 429) 'breaker must include backend 429'
Check ($plan[0].circuitBreaker.rules[0].failureCondition.statusCodeRanges[1].min -eq 500) 'breaker must include 5xx'
Check ($plan[0].circuitBreaker.rules[0].acceptRetryAfter -eq $true) 'breaker must honour Retry-After by default'
foreach ($key in 'count', 'intervalSeconds', 'tripDurationSeconds') {
    $c = New-Config; $c.backends[0].circuitBreaker = @{ $key = 0 }
    Check ((@(Get-StgFailoverProblems $c) -join ';') -match $key) "reject invalid breaker $key"
}
$c = New-Config; $c.backends[0].circuitBreaker = @{ acceptRetryAfter = 'false' }
Check ((@(Get-StgFailoverProblems $c) -join ';') -match 'acceptRetryAfter') 'reject non-boolean Retry-After'
$c = New-Config; $c.backends[0].failover.deploymentInferenceGeo = @{ 'other-model' = 'global' }
Check ((@(Get-StgFailoverProblems $c) -join ';') -match 'same deployment') 'refuse mismatched deployment names with a next step'
$c = New-Config; $c.backends[0].failover.deploymentInferenceGeo['claude-haiku-5-5'] = 'us'
Check ((@(Get-StgFailoverProblems $c) -join ';') -match 'geography') 'refuse silent inference-geography change'
$c = New-Config; $c.backends[0].failover.url = 'https://attacker.example/anthropic'
Check ((@(Get-StgFailoverProblems $c) -join ';') -match 'url') 'refuse sending gateway token to an unrelated host'
$c = New-Config; $c.backends += @{ id = 'claude-primary' }
Check ((@(Get-StgFailoverProblems $c) -join ';') -match 'collision') 'refuse generated member ID collision'
$c = New-Config; $c.backends[0].failover.subscriptionId = 'bad'
Check ((@(Get-StgFailoverProblems $c) -join ';') -match 'subscriptionId') 'refuse malformed standby subscription'
$c = New-Config; $c.backends[0].circuitBreaker = @{ statusCodeRanges = @(@{ min = 500; max = 429 }) }
Check ((@(Get-StgFailoverProblems $c) -join ';') -match 'statusCodeRanges') 'refuse inverted ranges'
foreach ($case in @(
    @{ key = 'failover-shape'; change = { param($x) $x.backends[0].failover = 'account' }; match = 'account object' },
    @{ key = 'backend-id'; change = { param($x) $x.backends[0].id = 'bad/id' }; match = 'safe characters' },
    @{ key = 'resource-group'; change = { param($x) $x.backends[0].failover.resourceGroup = 'bad/group' }; match = 'resourceGroup' },
    @{ key = 'account-name'; change = { param($x) $x.backends[0].failover.accountName = 'BAD' }; match = 'failover\.accountName is invalid' },
    @{ key = 'same-account'; change = { param($x) $x.backends[0].failover.accountName = 'primary' }; match = 'different account' },
    @{ key = 'private-type'; change = { param($x) $x.backends[0].failover.privateEndpoint = 'true' }; match = 'privateEndpoint must be a boolean' },
    @{ key = 'recursive'; change = { param($x) $x.backends[0].failover.failover = @{} }; match = 'recursive' },
    @{ key = 'breaker-shape'; change = { param($x) $x.backends[0].circuitBreaker = 'rule' }; match = 'must be an object' },
    @{ key = 'unknown-breaker-key'; change = { param($x) $x.backends[0].circuitBreaker = @{ typo = 1 } }; match = 'unknown key' },
    @{ key = 'fractional-count'; change = { param($x) $x.backends[0].circuitBreaker = @{ count = 1.5 } }; match = 'whole number' },
    @{ key = 'duration-limit'; change = { param($x) $x.backends[0].circuitBreaker = @{ tripDurationSeconds = 86401 } }; match = 'whole number' },
    @{ key = 'empty-ranges'; change = { param($x) $x.backends[0].circuitBreaker = @{ statusCodeRanges = @() } }; match = 'statusCodeRanges' }
)) {
    $c = New-Config; & $case.change $c
    Check ((@(Get-StgFailoverProblems $c) -join ';') -match $case.match) "refuse $($case.key)"
}
$c = New-Config
$legacy = New-Config; $legacy.backends[0].Remove('failover')
foreach ($n in 0..8) {
    Check ((Get-StgStageInput $c $n) -ceq (Get-StgStageInput $legacy $n) -or $n -in 0,3,5,6) "failover must not invalidate unrelated stage $n"
}
Check ((Get-StgStageInput $c 6) -cne (Get-StgStageInput $legacy 6)) 'Stage 6 must bind the failover endpoint'
$legacyPlan = @(Get-StgApimBackendPlan $legacy)
Check (-not $legacyPlan[0].Contains('circuitBreaker') -and -not $legacyPlan[0].Contains('failover')) 'legacy backend must not acquire a breaker or pool'
$c = New-Config
function Get-StgArm($Id, $Version) {
    if ($Id.EndsWith('/deployments')) { return @{ value = @(@{ name = 'claude-haiku-5-5'; properties = @{ provisioningState = 'Succeeded'; model = @{ name = 'claude-haiku-5-5'; version = '2' } }; sku = @{ name = 'GlobalStandard' } }) } }
    return @{ id = $Id; name = ($Id -split '/')[-1]; location = 'centralus'; properties = @{ publicNetworkAccess = 'Disabled' } }
}
$facts = @(Test-StgFoundryFailover $c)
Check ($facts.Count -eq 1 -and $facts[0].quotaNote -match 'shares') 'Stage 0 must explain shared quota'
function Get-StgArm($Id, $Version) {
    if ($Id.EndsWith('/deployments')) { return @{ value = @(@{ name = 'claude-haiku-5-5'; properties = @{ provisioningState = 'Failed'; model = @{ name = 'claude-haiku-5-5'; version = '2' } }; sku = @{ name = 'GlobalStandard' } }) } }
    return @{ id = $Id; name = 'standby'; location = 'centralus' }
}
$message = ''; try { $null = Test-StgFoundryFailover $c } catch { $message = $_.Exception.Message }
Check ($message -match 'Succeeded') 'Stage 0 must refuse an unready standby deployment'
$script:accountFault = ''
function Get-StgArm($Id, $Version) {
    if ($Id.EndsWith('/deployments')) {
        $standby = $Id -match '/standby/'
        return @{ value = @(@{ name = 'claude-haiku-5-5'; properties = @{ provisioningState = 'Succeeded'; model = @{
            name = 'claude-haiku-5-5'; version = $(if ($standby -and $script:accountFault -ceq 'version') { '1' } else { '2' })
        } }; sku = @{ name = $(if ($standby -and $script:accountFault -ceq 'sku') { 'DataZoneStandard' } else { 'GlobalStandard' }) } }) }
    }
    return @{ id = $Id; name = 'standby'; location = 'centralus'; properties = @{ publicNetworkAccess = 'Disabled' } }
}
foreach ($case in @(@{ fault = 'sku'; match = 'GlobalStandard' }, @{ fault = 'version'; match = 'model/version/SKU' })) {
    $script:accountFault = $case.fault; $message = ''
    try { $null = Test-StgFoundryFailover $c } catch { $message = $_.Exception.Message }
    Check ($message -match $case.match) "Stage 0 must refuse standby $($case.fault) mismatch"
}
$script:accountFault = ''; $c.backends[0].failover.privateEndpoint = $false
$message = ''; try { $null = Test-StgFoundryFailover $c } catch { $message = $_.Exception.Message }
Check ($message -match 'privateEndpoint true') 'Stage 0 must refuse a private account without a private route'
$c = New-Config
function Get-StgArm($Id, $Version) {
    if ($Id.EndsWith('/deployments')) { return @{ value = @() } }
    return @{ id = $Id; name = 'standby'; location = 'centralus' }
}
$errorText = ''
try { $null = Test-StgFoundryFailover $c } catch { $errorText = $_.Exception.Message }
Check ($errorText -match 'deployment' -and $errorText -match 'Create') 'Stage 0 must refuse missing live deployments with a next step'
$c = New-Config
$script:StateDir = Join-Path $root ".env.foundry-failover-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force $script:StateDir | Out-Null
$network = @{ privateEndpointSubnetId = "/subscriptions/$sub/resourceGroups/contoso-rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/private"
    vnetId = "/subscriptions/$sub/resourceGroups/contoso-rg/providers/Microsoft.Network/virtualNetworks/vnet"
    foundryPrivateDnsZoneIds = @("/subscriptions/$sub/resourceGroups/contoso-rg/providers/Microsoft.Network/privateDnsZones/privatelink.services.ai.azure.com") }
$script:captured = $null
function Invoke-StgBicep($Cfg, $Template, $Name, $Parameters, [switch]$Apply) {
    $script:captured = $Parameters
    return @{ id = "/subscriptions/$sub/resourceGroups/contoso-rg/providers/Microsoft.Network/privateEndpoints/claude-failover-pe" }
}
function Get-StgArm($Id, $Version) {
    if ($Id.EndsWith('/privateDnsZoneGroups')) { return @{ value = @(@{ properties = @{ privateDnsZoneConfigs = @(@{ properties = @{ privateDnsZoneId = $network.foundryPrivateDnsZoneIds[0] } }) } }) } }
    return @{ properties = @{ provisioningState = 'Succeeded'; privateLinkServiceConnections = @(@{ properties = @{
        privateLinkServiceId = "/subscriptions/$sub/resourceGroups/contoso-rg/providers/Microsoft.CognitiveServices/accounts/standby"
        privateLinkServiceConnectionState = @{ status = 'Approved' }
    } }) } }
}
$endpoints = @(Invoke-StgFailoverEndpoints -Cfg $c -Network $network -Apply)
Check ($endpoints.Count -eq 1 -and $captured.accountId.EndsWith('/accounts/standby')) 'Stage 6 must create and read back the standby endpoint'
$c.backends[0].failover.subscriptionId = '00000000-0000-4000-8000-000000000003'
$null = Invoke-StgFailoverEndpoints -Cfg $c -Network $network
Check ($captured.accountId -match '000000000003') 'Stage 6 endpoint must target the other subscription, not the gateway subscription'
function Get-StgArm($Id, $Version) { return @{ properties = @{ provisioningState = 'Succeeded'; privateLinkServiceConnections = @(@{ properties = @{ privateLinkServiceId = $captured.accountId; privateLinkServiceConnectionState = @{ status = 'Pending' } } }) } } }
$message = ''; try { $null = Invoke-StgFailoverEndpoints -Cfg $c -Network $network -Apply } catch { $message = $_.Exception.Message }
Check ($message -match 'approval') 'Stage 6 must refuse a pending or wrong-account endpoint'
function Get-StgArm($Id, $Version) { return @{ properties = @{ provisioningState = 'Failed' } } }
$message = ''; try { $null = Invoke-StgFailoverEndpoints -Cfg $c -Network $network -Apply } catch { $message = $_.Exception.Message }
Check ($message -match 'not Succeeded') 'Stage 6 must refuse an unready private endpoint'
function Get-StgArm($Id, $Version) {
    if ($Id.EndsWith('/privateDnsZoneGroups')) { return @{ value = @() } }
    return @{ properties = @{ provisioningState = 'Succeeded'; privateLinkServiceConnections = @(@{ properties = @{
        privateLinkServiceId = $captured.accountId; privateLinkServiceConnectionState = @{ status = 'Approved' }
    } }) } }
}
$message = ''; try { $null = Invoke-StgFailoverEndpoints -Cfg $c -Network $network -Apply } catch { $message = $_.Exception.Message }
Check ($message -match 'DNS zones differ') 'Stage 6 must refuse missing private DNS groups'
$bicep = Join-Path $HOME '.azure\bin\bicep.exe'
if (-not (Test-Path $bicep)) { $bicep = (Get-Command bicep -ErrorAction Stop).Source }
$arm = (& $bicep build (Join-Path $root 'infra\staged\stage5-config.bicep') --stdout 2>$null) -join "`n"
Check ($LASTEXITCODE -eq 0) 'Stage 5 priority pool must compile'
$template = $arm | ConvertFrom-Json -AsHashtable -Depth 100
$pool = @($template.resources | ForEach-Object { $_.properties.template.resources } | Where-Object { $_.type -ceq 'Microsoft.ApiManagement/service/backends' -and $_.properties.type -ceq 'Pool' })[0]
Check ($pool.properties.pool.services.Count -eq 2 -and $pool.properties.pool.services[0].priority -eq 1 -and $pool.properties.pool.services[1].priority -eq 2 -and $arm.Contains('circuitBreaker')) 'compiled deployment must carry priority pools and circuit breakers'
$privateArm = (& $bicep build (Join-Path $root 'infra\staged\stage6-foundry-failover.bicep') --stdout 2>$null) -join "`n"
Check ($LASTEXITCODE -eq 0 -and $privateArm.Contains('privateLinkServiceId')) 'standalone endpoint deployment must compile'
$c = New-Config
$c.stage1.foundry.failover = @{ create = $true; accountName = 'standby'; location = 'centralus'
    publicNetworkAccess = 'Disabled'; deployments = @(@{ name = 'claude-haiku-5-5'; model = 'claude-haiku-5-5'; version = '2'; sku = 'GlobalStandard'; capacity = 1 })
    modelProviderData = @{ organizationName = 'Contoso'; countryCode = 'US'; industry = 'technology' } }
function Get-StgArm($Id, $Version) { return @{ properties = @{ disableLocalAuth = $false; publicNetworkAccess = 'Disabled'; provisioningState = 'Succeeded' } } }
$message = ''; try { $null = Test-StgCreatedFailover $c } catch { $message = $_.Exception.Message }
Check ($message -match 'local auth') 'Stage 1 must read back keyless authentication for a created standby'
$script:createFault = ''
function Get-StgArm($Id, $Version) {
    if ($Id.EndsWith('/deployments')) { return @{ value = @(@{ name = 'claude-haiku-5-5'; properties = @{ provisioningState = 'Succeeded'; model = @{name='claude-haiku-5-5';version='2'} }; sku = @{name='GlobalStandard';capacity=$(if($script:createFault -ceq 'deployment'){2}else{1})} }) } }
    return @{ location = $(if($script:createFault -ceq 'region'){'eastus2'}else{'centralus'}); properties = @{ disableLocalAuth = $true; publicNetworkAccess = 'Disabled' } }
}
Check ((Test-StgCreatedFailover $c).localAuthDisabled -eq $true) 'Stage 1 must verify the created standby deployment'
foreach ($case in @(@{ fault='region';match='region or public network access' },@{ fault='deployment';match='differs or is not Succeeded' })) {
    $script:createFault = $case.fault; $message=''
    try { $null = Test-StgCreatedFailover $c } catch { $message=$_.Exception.Message }
    Check ($message -match $case.match) "Stage 1 must refuse created standby $($case.fault) mismatch"
}
$c = New-Config; $script:fault = ''
$script:backendPlan = @(Get-StgApimBackendPlan $c)[0]
function Get-StgArm($Id, $Version) {
    if ($Id.EndsWith('/claude')) {
        return @{ properties = @{ type = $(if ($script:fault -ceq 'pool') { 'Single' } else { 'Pool' }); pool = @{ services = @(
            @{ id = "$($Id)-primary"; priority = $(if ($script:fault -ceq 'priority') { 2 } else { 1 }) },
            @{ id = "$($Id)-failover"; priority = 2 }
        ) } } }
    }
    $url = if ($Id.EndsWith('-primary')) { $backendPlan.url } else { $backendPlan.failover.url }
    $breaker = $backendPlan.circuitBreaker | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
    if ($script:fault -ceq 'normalized-duration') { $breaker.rules[0].tripDuration = 'PT1M'; $breaker.rules[0].failureCondition.interval = 'PT1M' }
    return @{ properties = @{ url = $(if ($script:fault -ceq 'url') { 'https://wrong' } else { $url })
        circuitBreaker = $(if ($script:fault -ceq 'breaker') { @{ rules = @() } } else { $breaker }) } }
}
$apim = @{ subscriptionId = $sub; resourceGroup = 'contoso-rg'; name = 'gateway' }
Check (@(Test-StgApimFailover -Cfg $c -Apim $apim).Count -eq 1) 'Stage 5 must verify the live pool'
$script:fault = 'normalized-duration'
Check (@(Test-StgApimFailover -Cfg $c -Apim $apim).Count -eq 1) 'Stage 5 must accept equivalent ARM-normalized ISO durations'
foreach ($case in @(@{ fault = 'pool'; match = 'two-member pool' }, @{ fault = 'priority'; match = 'priority differs' }, @{ fault = 'url'; match = 'URL differs' }, @{ fault = 'breaker'; match = 'breaker differs' })) {
    $script:fault = $case.fault; $message = ''
    try { $null = Test-StgApimFailover -Cfg $c -Apim $apim } catch { $message = $_.Exception.Message }
    Check ($message -match $case.match) "Stage 5 must refuse incorrect $($case.fault)"
}
$c = New-Config
$legacy = New-Config; $legacy.backends[0].Remove('failover')
$script:networkState = @{ stages = @{ '6' = @{ configHash = (Get-StgStageInput $legacy 6); outputs = @{ vnetId = 'original-vnet' } } } }
function Read-StgState($Cfg) { return $script:networkState }
Check ((Get-StgFailoverNetworkState $c).vnetId -ceq 'original-vnet') 'Stage 6 upgrade must reuse the original VNet without redeployment'
$c.network.mode = 'existing'; $message = ''
try { $null = Get-StgFailoverNetworkState $c } catch { $message = $_.Exception.Message }
Check ($message -match 'changed beyond adding failover') 'Stage 6 must reject unrelated network changes during upgrade'
$c = New-Config; $c.network.mode = 'existing'
$script:originalNetwork = @{ vnetId = 'vnet'; functionsSubnetId = 'subnet'; privateEndpointSubnetId = 'private'
    storagePrivateEndpointIds = @(); cosmosPrivateEndpointId = 'cosmos-pe'; foundryPrivateEndpointIds = @() }
function Get-StgStage($Cfg, $Number) { return @{ names = @{ apps = @{} }; apimName = '' } }
function Invoke-StgBicep { return $script:originalNetwork | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable }
function Invoke-StgFailoverEndpoints { return 'standby-pe' }
function Get-StgNetworkDnsTargets { return @{ zoneIds = @() } }
function Get-StgCosmosDnsProblems { return @() }
function Write-StgEvidence { return '' }
function Get-StgArm($Id, $Version) {
    if ($Id.EndsWith('/privateDnsZoneGroups/default')) { return @{ properties = @{ privateDnsZoneConfigs = @(@{ properties = @{ recordSets = @(@{fqdn='private.example';ipAddresses=@('10.0.0.1')}) } }) } } }
    return @{ name = $Id; properties = @{ privateLinkServiceConnections = @(@{ properties = @{ privateLinkServiceConnectionState = @{ status = 'Approved' } } }) } }
}
$result = Invoke-Stage6 -Cfg $c -Apply
Check ((Get-StgOutputHash $result) -ceq (Get-StgOutputHash $originalNetwork)) 'Adding a standby endpoint must not invalidate published app state or reseed groups'
Write-Host "Foundry failover: $passed passed"
Remove-Item -LiteralPath $script:StateDir -Recurse -Force
