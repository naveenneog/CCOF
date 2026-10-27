# Opt-in account failover. Logical backend IDs remain the accounting and routing boundary.
function Get-StgFoundryMembers {
    param($Cfg)
    foreach ($b in @($Cfg.backends)) {
        $primary = @{}; foreach ($k in $b.Keys) { if ($k -notin 'failover', 'circuitBreaker') { $primary[$k] = $b[$k] } }
        if ($b.failover) {
            $primary.id = "$($b.id)-primary"
            $standby = @{}; foreach ($k in $b.failover.Keys) { $standby[$k] = $b.failover[$k] }
            $standby.id = "$($b.id)-failover"
            $primary; $standby
        } else { $primary }
    }
}

function Get-StgBreaker {
    param($Backend)
    $r = $Backend.circuitBreaker ?? @{}
    return @{ rules = @(@{
        name = 'ccof-foundry'; acceptRetryAfter = ($r.acceptRetryAfter ?? $true)
        tripDuration = "PT$($r.tripDurationSeconds ?? 60)S"
        failureCondition = @{
            count = ($r.count ?? 1); interval = "PT$($r.intervalSeconds ?? 60)S"
            statusCodeRanges = @($r.statusCodeRanges ?? @(@{ min = 429; max = 429 }, @{ min = 500; max = 599 }))
        }
    }) }
}

function Get-StgApimBackendPlan {
    param($Cfg)
    foreach ($b in @($Cfg.backends)) {
        $p = @{ id = $b.id; url = $b.url; deployments = @($b.deploymentInferenceGeo.Keys | Sort-Object) }
        if ($b.failover) {
            $p.circuitBreaker = Get-StgBreaker $b
            $p.failover = @{ id = "$($b.id)-failover"; url = $b.failover.url }
        } elseif ($b.circuitBreaker) { $p.circuitBreaker = Get-StgBreaker $b }
        $p
    }
}

function Get-StgFailoverProblems {
    param($Cfg)
    $ids = @($Cfg.backends | ForEach-Object { $_.id })
    $generated = @($Cfg.backends | Where-Object failover | ForEach-Object { "$($_.id)-primary"; "$($_.id)-failover" })
    if (@($generated | Where-Object { $_ -in $ids }).Count -or @($generated | Select-Object -Unique).Count -ne $generated.Count) {
        'failover backend ID collision: rename the logical backend and group backendId to leave -primary and -failover unused'
    }
    foreach ($b in @($Cfg.backends)) {
        if ($b.failover) {
            $f = $b.failover
            if ($f -isnot [Collections.IDictionary]) { "backend $($b.id).failover must be an account object"; continue }
            if ($b.id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,69}$') { "backend $($b.id): use an ID up to 70 safe characters for failover member names" }
            if ($f.subscriptionId -notmatch $script:Guid) { "backend $($b.id).failover.subscriptionId must be a GUID" }
            if ($f.resourceGroup -notmatch '^[A-Za-z0-9_.-]{1,90}$') { "backend $($b.id).failover.resourceGroup is invalid" }
            if ($f.accountName -cnotmatch '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$') { "backend $($b.id).failover.accountName is invalid" }
            if ($f.url -cne "https://$($f.accountName).services.ai.azure.com/anthropic") { "backend $($b.id).failover.url must be https://<accountName>.services.ai.azure.com/anthropic; do not send managed-identity tokens to another host" }
            if ($f.accountName -ieq $b.accountName -and $f.resourceGroup -ieq $b.resourceGroup -and $f.subscriptionId -ieq $b.subscriptionId) { "backend $($b.id): failover must name a different account" }
            if ($f.Contains('privateEndpoint') -and $f.privateEndpoint -isnot [bool]) { "backend $($b.id).failover.privateEndpoint must be a boolean" }
            if ($f.failover -or $f.tenantId -or $f.auth -or $b.auth) { "backend $($b.id): recursive/cross-tenant failover is unsupported; use accounts in the gateway identity tenant" }
            $names = @($b.deploymentInferenceGeo.Keys | Sort-Object)
            $other = @($f.deploymentInferenceGeo.Keys | Sort-Object)
            if (-not $names.Count -or ($names -join '|') -cne ($other -join '|')) {
                "backend $($b.id): failover needs the same deployment names; Create the missing deployments and copy deploymentInferenceGeo"
            } else {
                foreach ($n in $names) { if ($b.deploymentInferenceGeo[$n] -cne $f.deploymentInferenceGeo[$n]) { "backend $($b.id): failover deployment $n changes inference geography; use the same geography and deployment type" } }
            }
        }
        if ($b.Contains('circuitBreaker')) {
            $r = $b.circuitBreaker
            if ($r -isnot [Collections.IDictionary]) { "backend $($b.id).circuitBreaker must be an object"; continue }
            foreach ($k in $r.Keys) { if ($k -notin 'count','intervalSeconds','tripDurationSeconds','acceptRetryAfter','statusCodeRanges') { "backend $($b.id).circuitBreaker unknown key $k" } }
            foreach ($k in 'count','intervalSeconds','tripDurationSeconds') {
                if ($r.Contains($k) -and (-not ($r[$k] -is [int] -or $r[$k] -is [long]) -or $r[$k] -lt 1 -or $r[$k] -gt 86400)) { "backend $($b.id).circuitBreaker.$k must be a whole number 1-86400" }
            }
            if ($r.Contains('acceptRetryAfter') -and $r.acceptRetryAfter -isnot [bool]) { "backend $($b.id).circuitBreaker.acceptRetryAfter must be a boolean" }
            if ($r.Contains('statusCodeRanges')) {
                $ranges = @($r.statusCodeRanges)
                $bad = @($ranges | Where-Object { $_ -isnot [Collections.IDictionary] -or $_.min -isnot [int] -or $_.max -isnot [int] -or $_.min -lt 400 -or $_.max -gt 599 -or $_.min -gt $_.max })
                if (-not $ranges.Count -or $bad.Count) { "backend $($b.id).circuitBreaker.statusCodeRanges needs nonempty integer min/max ranges within 400-599" }
            }
        }
    }
    $new = $Cfg.stage1.foundry.failover
    if ($new.create) {
        if ($new.accountName -cnotmatch '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$' -or $new.location -cnotmatch '^[a-z][a-z0-9]{2,39}$' -or $new.publicNetworkAccess -notin 'Enabled','Disabled') { 'stage1.foundry.failover needs a valid accountName, location and publicNetworkAccess' }
        if (-not @($new.deployments).Count -or -not $new.modelProviderData.organizationName -or $new.modelProviderData.countryCode -cnotmatch '^[A-Z]{2}$' -or -not $new.modelProviderData.industry) { 'stage1.foundry.failover needs deployments and real modelProviderData, just like stage1.foundry' }
        $owners = @($Cfg.backends | Where-Object { $_.failover.accountName -ceq $new.accountName -and $_.failover.subscriptionId -ieq $Cfg.subscriptionId -and $_.failover.resourceGroup -ieq $Cfg.resourceGroup })
        if (-not $owners.Count) { 'stage1.foundry.failover must match a backends[].failover account in this subscription/resource group' }
        if ($new.publicNetworkAccess -ceq 'Disabled' -and @($owners | Where-Object { -not $_.failover.privateEndpoint }).Count) { 'stage1.foundry.failover is private: set backends[].failover.privateEndpoint true' }
        foreach ($d in @($new.deployments)) { if (-not $d.name -or -not $d.model -or -not $d.version -or $d.sku -notin 'GlobalStandard','DataZoneStandard' -or $d.capacity -lt 1) { 'stage1.foundry.failover deployments need name, model, version, sku and positive capacity' } }
    }
}

function Test-StgFoundryFailover {
    param($Cfg)
    foreach ($b in @($Cfg.backends | Where-Object failover)) {
        $f = $b.failover; $new = $Cfg.stage1.foundry.failover
        $created = $new.create -and $f.accountName -ceq $new.accountName -and $f.resourceGroup -ieq $Cfg.resourceGroup -and $f.subscriptionId -ieq $Cfg.subscriptionId
        $scope = "/subscriptions/$($f.subscriptionId)/resourceGroups/$($f.resourceGroup)/providers/Microsoft.CognitiveServices/accounts/$($f.accountName)"
        if ($created) {
            $deps = @($new.deployments | ForEach-Object { @{ name = $_.name; properties = @{ model = @{ name = $_.model; version = "$($_.version)" } }; sku = @{ name = $_.sku } } })
            $region = $new.location
            $models = @(Invoke-StgAzJson @('cognitiveservices', 'model', 'list', '--subscription', $f.subscriptionId, '--location', $region))
            foreach ($d in @($new.deployments)) {
                $offer = @($models | Where-Object { $_.model.format -ceq 'Anthropic' -and $_.model.name -ceq $d.model -and "$($_.model.version)" -ceq "$($d.version)" -and @($_.model.skus | ForEach-Object name) -contains $d.sku })
                Assert-Stg ($offer.Count -gt 0) "failover model $($d.model)@$($d.version) is not offered in $region; choose stage1.foundry.failover.location from az cognitiveservices model list"
            }
            $quotaCfg = $Cfg | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
            $quotaCfg.stage1.foundry = $new
            Assert-StgFoundryQuota -Cfg $quotaCfg -Deployments @($new.deployments)
        } else {
            try {
                $account = Get-StgArm $scope '2025-06-01'
                $deps = @((Get-StgArm "$scope/deployments" '2025-06-01').value)
            } catch { throw "failover_unreadable: cannot read $scope. Check the account and ask its owner for Reader and the gateway identity's tenant; rerun Stage 0. $($_.Exception.Message)" }
            $region = $account.location
            Assert-Stg ($account.properties.publicNetworkAccess -cne 'Disabled' -or $f.privateEndpoint) "failover account $($f.accountName) is private; set failover.privateEndpoint true and run Stage 6"
        }
        foreach ($n in $b.deploymentInferenceGeo.Keys) {
            $d = @($deps | Where-Object name -CEQ $n)[0]
            Assert-Stg ([bool]$d) "failover account $($f.accountName) lacks deployment $n. Create the same deployment names as the primary, then rerun Stage 0."
            if (-not $created) { Assert-Stg ($d.properties.provisioningState -ceq 'Succeeded') "failover deployment $n is not Succeeded; wait for its deployment or fix the failed deployment, then rerun Stage 0" }
            $expectedSku = if ($b.deploymentInferenceGeo[$n] -ceq 'us') { 'DataZoneStandard' } else { 'GlobalStandard' }
            Assert-Stg ($d.sku.name -ceq $expectedSku) "failover deployment $n must use $expectedSku to preserve inference geography"
        }
        $primaryNew = $Cfg.stage1.foundry
        $primaryDeps = if ($primaryNew.create -and $b.accountName -ceq $primaryNew.accountName) {
            @($primaryNew.deployments | ForEach-Object { @{ name = $_.name; properties = @{ model = @{ name = $_.model; version = "$($_.version)" } }; sku = @{ name = $_.sku } } })
        } else {
            @((Get-StgArm "/subscriptions/$($b.subscriptionId)/resourceGroups/$($b.resourceGroup)/providers/Microsoft.CognitiveServices/accounts/$($b.accountName)/deployments" '2025-06-01').value)
        }
        foreach ($n in $b.deploymentInferenceGeo.Keys) {
            $p = @($primaryDeps | Where-Object name -CEQ $n)[0]; $d = @($deps | Where-Object name -CEQ $n)[0]
            Assert-Stg ($p -and $p.properties.model.name -ceq $d.properties.model.name -and "$($p.properties.model.version)" -ceq "$($d.properties.model.version)" -and $p.sku.name -ceq $d.sku.name) "failover deployment $n differs from primary model/version/SKU. Create matching deployments before Stage 5."
        }
        $quota = if ($f.subscriptionId -ieq $b.subscriptionId) { 'shares the same subscription/model quota pool across regions; protects endpoint outages, not quota 429' } else { 'separate subscription quota; check model eligibility and available quota in that subscription' }
        Write-Host "Foundry HA: $($b.id) -> $($f.accountName) in $region; $quota"
        Write-Host "suggestion: preview/apply Stages 3, 5 and 6; run Stage 8 and inspect ApiManagementGatewayLogs.BackendUrl during a failover drill"
        @{ id = $b.id; account = $f.accountName; region = $region; quotaNote = $quota; deployments = @($b.deploymentInferenceGeo.Keys) }
    }
}

function Test-StgCreatedFailover {
    param($Cfg)
    $f = $Cfg.stage1.foundry.failover
    if (-not $f.create) { return }
    $id = "/subscriptions/$($Cfg.subscriptionId)/resourceGroups/$($Cfg.resourceGroup)/providers/Microsoft.CognitiveServices/accounts/$($f.accountName)"
    $a = Get-StgArm $id '2025-06-01'
    Assert-Stg ($a.properties.disableLocalAuth -eq $true) 'Foundry failover local auth is enabled; disable local authentication before continuing'
    Assert-Stg ($a.properties.publicNetworkAccess -ceq $f.publicNetworkAccess -and $a.location -ieq $f.location) 'Foundry failover region or public network access differs'
    $deps = @((Get-StgArm "$id/deployments" '2025-06-01').value)
    foreach ($d in @($f.deployments)) {
        $actual = @($deps | Where-Object name -CEQ $d.name)[0]
        Assert-Stg ($actual -and $actual.properties.provisioningState -ceq 'Succeeded' -and $actual.properties.model.name -ceq $d.model -and "$($actual.properties.model.version)" -ceq "$($d.version)" -and $actual.sku.name -ceq $d.sku -and $actual.sku.capacity -eq $d.capacity) "Foundry failover deployment $($d.name) differs or is not Succeeded"
    }
    return @{ accountId = $id; region = $a.location; localAuthDisabled = $true; deployments = @($deps.name) }
}

function Get-StgFailoverBaseNetworkHash {
    param($Cfg)
    $base = $Cfg | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
    foreach ($b in $base.backends) { $b.Remove('failover') }
    return Get-StgStageInput $base 6
}

function Get-StgFailoverNetworkState {
    param($Cfg)
    $state = Read-StgState $Cfg
    $saved = $state.stages['6']
    if ($saved.configHash -and $saved.configHash -cne (Get-StgStageInput $Cfg 6)) {
        $recordedBase = $saved.outputs.verify.foundryFailoverBaseNetworkHash ?? $saved.configHash
        Assert-Stg ($recordedBase -ceq (Get-StgFailoverBaseNetworkHash $Cfg)) 'stage_config_changed: Stage 6 network changed beyond adding failover, or its base-network fingerprint is missing. Restore the last verified network/configuration and apply Stage 6 once to record it before changing standbys; do not redeploy an existing VNet.'
        return $saved.outputs
    }
    return Get-StgStage $Cfg 6
}

function Invoke-StgFailoverEndpoints {
    param($Cfg, $Network, [switch]$Apply)
    $targets = @($Cfg.backends | Where-Object { $_.failover.privateEndpoint })
    if (-not $targets.Count) { return }
    $subnetId = "$($Network.privateEndpointSubnetId)"
    if (-not $subnetId -and $Cfg.network.mode -ceq 'existing') { $subnetId = "$($Cfg.network.existing.privateEndpointSubnetId)" }
    $vnetId = "$($Network.vnetId)"
    if (-not $vnetId -and $subnetId -match '/subnets/[^/]+$') { $vnetId = $subnetId -replace '/subnets/[^/]+$', '' }
    if (-not $subnetId -or -not $vnetId) {
        if (-not $Apply -and $Cfg.network.mode -ceq 'create') {
            Write-Host 'preview: Foundry failover endpoints deferred until verified Stage 6 network outputs exist; -Apply provisions/verifies the network first, then the standby endpoints.'
            return
        }
        throw 'failover_network_unverified: private endpoint subnet/VNet IDs are missing. Set network.existing.privateEndpointSubnetId or apply the prerequisite Stage 6 network and rerun.'
    }
    $zoneIds = @($Network.foundryPrivateDnsZoneIds | Where-Object { -not [string]::IsNullOrWhiteSpace("$_") })
    $createZones = ($Cfg.network.mode -ceq 'create' -and -not $zoneIds.Count)
    if (-not $zoneIds.Count) {
        $zoneIds = if ($Cfg.network.mode -ceq 'create') {
            @('cognitiveservices.azure.com','openai.azure.com','services.ai.azure.com' | ForEach-Object { "/subscriptions/$($Cfg.subscriptionId)/resourceGroups/$($Cfg.resourceGroup)/providers/Microsoft.Network/privateDnsZones/privatelink.$_" })
        } else { @($Cfg.network.existing.privateDnsZoneIds.foundry.Values | Where-Object { -not [string]::IsNullOrWhiteSpace("$_") }) }
    }
    Assert-Stg ($zoneIds.Count -gt 0) 'Foundry failover DNS zone IDs are missing; configure network.existing.privateDnsZoneIds.foundry or verify the created network, then rerun Stage 6'
    foreach ($b in $targets) {
        $f = $b.failover
        $p = @{
            name = "$($b.id)-failover-pe"; location = $Cfg.location; tags = $Cfg.tags
            accountId = "/subscriptions/$($f.subscriptionId)/resourceGroups/$($f.resourceGroup)/providers/Microsoft.CognitiveServices/accounts/$($f.accountName)"
            subnetId = $subnetId
            zoneIds = $zoneIds
            createZones = $createZones
            vnetId = $vnetId
        }
        $out = Invoke-StgBicep -Cfg $Cfg -Template 'stage6-foundry-failover.bicep' -Name "stage6-$($b.id)-failover" -Parameters $p -Apply:$Apply
        if ($Apply) {
            $pe = Get-StgArm $out.id '2024-05-01'
            Assert-Stg ($pe.properties.provisioningState -ceq 'Succeeded') "failover private endpoint $($p.name) is not Succeeded"
            $connections = @($pe.properties.privateLinkServiceConnections)
            Assert-Stg ($connections.Count -eq 1 -and $connections[0].properties.privateLinkServiceId -ieq $p.accountId -and $connections[0].properties.privateLinkServiceConnectionState.status -ceq 'Approved') "failover private endpoint $($p.name) needs account-owner approval; approve it and rerun Stage 6"
            $groups = @((Get-StgArm "$($out.id)/privateDnsZoneGroups" '2024-05-01').value)
            $actual = @($groups | ForEach-Object { $_.properties.privateDnsZoneConfigs | ForEach-Object { $_.properties.privateDnsZoneId } })
            Assert-Stg ((($actual | Sort-Object) -join '|') -ieq (($p.zoneIds | Sort-Object) -join '|')) "failover private endpoint $($p.name) DNS zones differ"
            $out.id
        }
    }
}

function ConvertTo-StgBreakerCanonical {
    param($Breaker)
    if (-not $Breaker) { return '' }
    $copy = $Breaker | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
    try {
        foreach ($rule in @($copy.rules)) {
            $rule.tripDuration = [Xml.XmlConvert]::ToTimeSpan($rule.tripDuration).Ticks
            $rule.failureCondition.interval = [Xml.XmlConvert]::ToTimeSpan($rule.failureCondition.interval).Ticks
        }
    } catch { return 'invalid-duration' }
    return ConvertTo-StgCanonical $copy | ConvertTo-Json -Depth 20 -Compress
}

function Test-StgApimFailover {
    param($Cfg, $Apim)
    $root = "/subscriptions/$($Apim.subscriptionId)/resourceGroups/$($Apim.resourceGroup)/providers/Microsoft.ApiManagement/service/$($Apim.name)/backends"
    foreach ($b in @(Get-StgApimBackendPlan $Cfg | Where-Object { $_.failover -or $_.circuitBreaker })) {
        $pool = Get-StgArm "$root/$($b.id)" '2024-05-01'
        if ($b.failover) {
            $services = @($pool.properties.pool.services)
            Assert-Stg ($pool.properties.type -ceq 'Pool' -and $services.Count -eq 2) "APIM backend $($b.id) is not a two-member pool"
            foreach ($m in @(@{ id = "$($b.id)-primary"; url = $b.url; priority = 1 }, @{ id = $b.failover.id; url = $b.failover.url; priority = 2 })) {
                $member = Get-StgArm "$root/$($m.id)" '2024-05-01'
                Assert-Stg ($member.properties.url -ceq $m.url) "APIM failover member $($m.id) URL differs"
                $service = @($services | Where-Object { $_.id -ieq "$root/$($m.id)" })[0]
                Assert-Stg ($service -and $service.priority -eq $m.priority) "APIM failover member $($m.id) priority differs"
                Assert-Stg ((ConvertTo-StgBreakerCanonical $member.properties.circuitBreaker) -ceq (ConvertTo-StgBreakerCanonical $b.circuitBreaker)) "APIM failover member $($m.id) breaker differs"
            }
        } else {
            Assert-Stg ((ConvertTo-StgBreakerCanonical $pool.properties.circuitBreaker) -ceq (ConvertTo-StgBreakerCanonical $b.circuitBreaker)) "APIM backend $($b.id) breaker differs"
        }
        @{ id = $b.id; failover = [bool]$b.failover; verified = $true }
    }
}
