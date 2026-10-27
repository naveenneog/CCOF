# Zone redundancy is opt-in and create-only (ADR-0052). Existing resource settings remain authoritative.
function Get-StgHaProblems {
    param($Cfg)
    if ($null -eq $Cfg.ha) { return }
    if ($Cfg.ha -isnot [Collections.IDictionary]) { 'ha must be an object'; return }
    foreach ($key in $Cfg.ha.Keys) {
        if ($key -notin 'apim', 'functions') { "ha has unknown component '$key'"; continue }
        $part = $Cfg.ha[$key]
        if ($part -isnot [Collections.IDictionary]) { "ha.$key must be an object"; continue }
        foreach ($setting in $part.Keys) { if ($setting -cne 'zoneRedundant') { "ha.$key has unknown setting '$setting'" } }
        if ($part.zoneRedundant -isnot [bool]) { "ha.$key.zoneRedundant must be a JSON boolean" }
    }
    if ($Cfg.ha.apim.zoneRedundant -eq $true) {
        if (-not $Cfg.stage1.approveNewPublicApimBootstrap -or $Cfg.apim.existing) { 'ha.apim applies only to a new APIM; an existing APIM stays owner-managed' }
        if ($Cfg.stage1.apimSku -cnotin 'StandardV2', 'PremiumV2') { 'ha.apim requires stage1.apimSku StandardV2 or PremiumV2' }
    }
    if ($Cfg.ha.functions.zoneRedundant -eq $true -and $Cfg.stage1.storageSku -cnotin 'Standard_ZRS', 'Standard_GZRS') {
        'zone-redundant Functions require stage1.storageSku Standard_ZRS or Standard_GZRS for host and deployment storage'
    }
}

function Get-StgHaCheck {
    param($Cfg)
    $regions = @(Invoke-StgAzJson @('account', 'list-locations', '--subscription', $Cfg.subscriptionId))
    $flexZones = @(Invoke-StgAzJson @('functionapp', 'list-flexconsumption-locations', '--subscription', $Cfg.subscriptionId, '--zone-redundant=true') |
        ForEach-Object { ([string]$_.name).Replace(' ', '').ToLowerInvariant() })
    $region = $regions | Where-Object { $_.name -ieq $Cfg.location } | Select-Object -First 1
    $available = @($region.availabilityZoneMappings).Count -gt 0
    $apimConfigured = $Cfg.ha.apim.zoneRedundant -eq $true
    $functionsConfigured = $Cfg.ha.functions.zoneRedundant -eq $true
    $storageConfigured = $Cfg.stage1.storageSku -in 'Standard_ZRS', 'Standard_GZRS'
    $r = [ordered]@{
        region = $Cfg.location
        apim = @{ available=$available; configured=$apimConfigured; units=$Cfg.stage1.apimUnits }
        functions = @{ available=($flexZones -contains $Cfg.location.ToLowerInvariant()); configured=$functionsConfigured }
        storage = @{ available=$available; configured=$storageConfigured; sku=$Cfg.stage1.storageSku }
        cosmos = @()
    }
    Write-Host "HA check: $($Cfg.location); regional zones available=$available (service capacity is not guaranteed)"
    foreach ($component in 'apim', 'functions', 'storage') {
        Write-Host "HA check: $component zones available=$($r[$component].available) configured=$($r[$component].configured)"
    }
    if ($apimConfigured -or $functionsConfigured -or $storageConfigured) {
        Assert-Stg $available "$($Cfg.location) has no availability zones; choose a zone-capable location or disable ha.apim/ha.functions and use stage1.storageSku Standard_LRS"
    }
    if ($functionsConfigured) {
        Assert-Stg $r.functions.available "Flex zone redundancy in $($Cfg.location) is not supported; choose a region from functionapp list-flexconsumption-locations --zone-redundant=true or disable ha.functions.zoneRedundant"
    }
    if (Test-StgApimExisting $Cfg) {
        Write-Host 'suggestion: apim zones: existing API Management is owner-managed; check its region and zone setting with the owner (no change by CCOF)'
    } elseif ($available -and -not $apimConfigured) {
        Write-Host "suggestion: apim zones: $($Cfg.location) has zones; set ha.apim.zoneRedundant true with stage1.apimSku StandardV2 or PremiumV2; recommend stage1.apimUnits 2 (cost +1 unit from 1)"
    } elseif ($apimConfigured -and $Cfg.stage1.apimUnits -lt 2) {
        Write-Host 'suggestion: apim capacity: recommend stage1.apimUnits 2 for surviving-zone capacity (cost +1 unit from 1)'
    }
    if ($r.functions.available -and -not $functionsConfigured) {
        Write-Host 'suggestion: functions zones: set ha.functions.zoneRedundant true and stage1.storageSku Standard_ZRS; Azure bills at least two always-ready instances per scaling function/group'
    }
    if ($available -and -not $storageConfigured) {
        Write-Host 'suggestion: storage zones: set stage1.storageSku Standard_ZRS or Standard_GZRS (higher storage cost)'
    }
    $cosmosRegions = @($Cfg.stage1.cosmosLocations)
    if (-not $cosmosRegions.Count) { $cosmosRegions = @(@{locationName=$Cfg.location;isZoneRedundant=$false}) }
    foreach ($c in $cosmosRegions) {
        $info = $regions | Where-Object { $_.name -ieq $c.locationName -or $_.displayName -ieq $c.locationName } | Select-Object -First 1
        $hasZones = @($info.availabilityZoneMappings).Count -gt 0
        $pairName = @($info.metadata.pairedRegion)[0].name
        $pair = $regions | Where-Object { $_.name -ieq $pairName } | Select-Object -First 1
        $pairZones = @($pair.availabilityZoneMappings).Count -gt 0
        $r.cosmos += @{region=$c.locationName; available=$hasZones; configured=[bool]$c.isZoneRedundant; pairedRegion=$pairName; pairedRegionHasZones=$pairZones}
        Write-Host "HA check: cosmos $($c.locationName) zones available=$hasZones configured=$($c.isZoneRedundant); paired region=$pairName zones=$pairZones"
        if ($c.isZoneRedundant) { Assert-Stg $hasZones "$($c.locationName) has no availability zones; set stage1.cosmosLocations[].isZoneRedundant false for that region or choose another region" }
        elseif ($hasZones) { Write-Host "suggestion: cosmos zones: set stage1.cosmosLocations isZoneRedundant true for $($c.locationName) if capacity permits; autoscale zone premium is waived" }
    }
    return $r
}

function Assert-StgHaApim {
    param($Cfg, $Apim)
    if ($null -eq $Cfg.ha.apim) { return }
    Assert-Stg ([bool]$Apim.properties.zoneRedundant -eq $Cfg.ha.apim.zoneRedundant) 'APIM zoneRedundant differs from ha.apim.zoneRedundant'
    Assert-Stg ($Apim.sku.capacity -eq $Cfg.stage1.apimUnits) 'APIM units differ from stage1.apimUnits'
}

function Assert-StgHaPlan {
    param($Cfg, $Plan)
    Assert-Stg ([bool]$Plan.properties.zoneRedundant -eq $Cfg.ha.functions.zoneRedundant) "$($Plan.name) plan zoneRedundant differs from ha.functions.zoneRedundant"
}

function Assert-StgHaStorage {
    param($Cfg, $Storage)
    Assert-Stg ($Storage.sku.name -ceq $Cfg.stage1.storageSku) "$($Storage.name) storage SKU differs from stage1.storageSku"
}
