# Staged deployment: Cosmos DB resilience (ADR-0036). Dot-sourced by Invoke-StagedDeployment.ps1; not run directly.
#   stage1.cosmosLocations    [{ locationName, isZoneRedundant }] in failover order; the first is the write region and
#                             must be the deployment location. Absent: one region, no zone redundancy (the earlier default).
#   stage1.cosmosConsistency  { defaultConsistencyLevel[, maxStalenessPrefix, maxIntervalInSeconds] }; absent: Session.
# Two or more regions turn on service-managed failover. Facts behind the checks (Microsoft Learn):
#   - a serverless account runs in a single Azure region (azure/cosmos-db/serverless);
#   - bounded staleness across regions needs at least 100,000 writes or 300 seconds (azure/cosmos-db/consistency-levels);
#   - during a region outage the SDK routes reads to the next preferred region (azure/reliability/reliability-cosmos-db).

$script:CosmosConsistencyLevels = @('Strong', 'BoundedStaleness', 'Session', 'ConsistentPrefix', 'Eventual')

function Get-StgCosmosRegions {
    param($Cfg)
    $configured = @($Cfg.stage1.cosmosLocations | Where-Object { $null -ne $_ })
    if (-not $configured.Count) { return @(@{ locationName = [string]$Cfg.location; isZoneRedundant = $false }) }
    return $configured
}

function Get-StgCosmosConsistency {
    param($Cfg)
    if ($Cfg.stage1.cosmosConsistency) { return $Cfg.stage1.cosmosConsistency }
    return @{ defaultConsistencyLevel = 'Session' }
}

# The resolver's preferred read regions, in failover order; empty for a single region (the SDK default then applies).
function Get-StgCosmosPreferredRegions {
    param($Cfg)
    $regions = @(Get-StgCosmosRegions $Cfg)
    if ($regions.Count -lt 2) { return '' }
    return (@($regions | ForEach-Object { [string]$_.locationName }) -join ',')
}

function Get-StgCosmosProblems {
    param($Cfg)
    $regions = @(Get-StgCosmosRegions $Cfg)
    $stage1Mode = if ($Cfg.stage1.cosmosCapacityMode) { [string]$Cfg.stage1.cosmosCapacityMode } else { 'serverless' }
    $dataMode = if ($Cfg.cosmos.capacityMode) { [string]$Cfg.cosmos.capacityMode } else { 'serverless' }
    if ("$stage1Mode/$dataMode" -cnotin 'serverless/serverless', 'provisioned/provisioned-autoscale') {
        'stage1.cosmosCapacityMode and cosmos.capacityMode must agree: serverless with serverless, provisioned with provisioned-autoscale'
    }
    if ($regions.Count -gt 1 -and $stage1Mode -ceq 'serverless') {
        'stage1.cosmosLocations: a serverless Cosmos DB account runs in one region; use cosmosCapacityMode provisioned (and cosmos.capacityMode provisioned-autoscale) for two or more'
    }
    $seen = @{}
    foreach ($r in $regions) {
        $name = [string]$r.locationName
        if ($name -cnotmatch '^[a-z][a-z0-9]{1,39}$') { "stage1.cosmosLocations: region name '$name' must be an ARM name such as eastus2" }
        elseif ($seen.ContainsKey($name)) { "stage1.cosmosLocations: duplicate region '$name'" }
        $seen[$name] = $true
        if ($r.isZoneRedundant -isnot [bool]) { "stage1.cosmosLocations: isZoneRedundant of '$name' must be true or false" }
    }
    if ([string]$regions[0].locationName -cne [string]$Cfg.location) { "stage1.cosmosLocations: the first region (the write region) must be the deployment location $($Cfg.location)" }
    $c = Get-StgCosmosConsistency $Cfg
    $level = [string]$c.defaultConsistencyLevel
    if ($script:CosmosConsistencyLevels -cnotcontains $level) { "stage1.cosmosConsistency: consistency level '$level' must be one of $($script:CosmosConsistencyLevels -join ', ')" }
    $extra = @($c.Keys | Where-Object { $_ -cnotin 'defaultConsistencyLevel', 'maxStalenessPrefix', 'maxIntervalInSeconds' })
    if ($extra.Count) { "stage1.cosmosConsistency: unknown key(s) $($extra -join ', ')" }
    if ($level -ceq 'BoundedStaleness') {
        $minPrefix = if ($regions.Count -gt 1) { 100000 } else { 10 }
        $minInterval = if ($regions.Count -gt 1) { 300 } else { 5 }
        if ($c.maxStalenessPrefix -isnot [long] -and $c.maxStalenessPrefix -isnot [int] -or $c.maxStalenessPrefix -lt $minPrefix -or $c.maxStalenessPrefix -gt 2147483647) {
            "stage1.cosmosConsistency: maxStalenessPrefix must be a whole number from $minPrefix to 2147483647 for this account"
        }
        if ($c.maxIntervalInSeconds -isnot [long] -and $c.maxIntervalInSeconds -isnot [int] -or $c.maxIntervalInSeconds -lt $minInterval -or $c.maxIntervalInSeconds -gt 86400) {
            "stage1.cosmosConsistency: maxIntervalInSeconds must be a whole number from $minInterval to 86400 for this account"
        }
    }
    elseif ($c.Contains('maxStalenessPrefix') -or $c.Contains('maxIntervalInSeconds')) {
        'stage1.cosmosConsistency: maxStalenessPrefix and maxIntervalInSeconds apply only to BoundedStaleness'
    }
    Get-StgChargebackHistoryProblems $Cfg
}

# Compares az cosmosdb show output with the configuration. Region names there are display names ("East US 2");
# they are compared without spaces or case, as the Cosmos SDK does (normalizeEndpoint in @azure/cosmos).
function Get-StgCosmosAccountProblems {
    param($Cfg, $Account)
    $norm = { param($s) ([string]$s -replace '\s', '').ToLowerInvariant() }
    $want = @(Get-StgCosmosRegions $Cfg)
    $have = @($Account.locations | Sort-Object { [int]$_.failoverPriority })
    if ($have.Count -ne $want.Count) { "Cosmos has $($have.Count) region(s); the configuration has $($want.Count)" }
    else {
        for ($i = 0; $i -lt $want.Count; $i++) {
            if ((& $norm $have[$i].locationName) -cne (& $norm $want[$i].locationName)) { "Cosmos failover priority $i is $($have[$i].locationName); the configuration has $($want[$i].locationName)" }
            if ([bool]$have[$i].isZoneRedundant -ne [bool]$want[$i].isZoneRedundant) { "Cosmos zone redundancy in $($have[$i].locationName) is $($have[$i].isZoneRedundant)" }
        }
    }
    if ([bool]$Account.enableAutomaticFailover -ne ($want.Count -gt 1)) { "Cosmos service-managed failover is $($Account.enableAutomaticFailover)" }
    $level = [string](Get-StgCosmosConsistency $Cfg).defaultConsistencyLevel
    if ([string]$Account.consistencyPolicy.defaultConsistencyLevel -cne $level) { "Cosmos consistency is $($Account.consistencyPolicy.defaultConsistencyLevel); the configuration has $level" }
    elseif ($level -ceq 'BoundedStaleness') {
        $c = Get-StgCosmosConsistency $Cfg
        foreach ($k in 'maxStalenessPrefix', 'maxIntervalInSeconds') {
            if ([long]$Account.consistencyPolicy[$k] -ne [long]$c[$k]) { "Cosmos $k is $($Account.consistencyPolicy[$k]); the configuration has $($c[$k])" }
        }
    }
}

# The private DNS names a Cosmos private endpoint must carry: the account's global name and one name per region,
# <account>-<region>, in privatelink.documents.azure.com (Learn, "Configure Azure Private Link for Azure Cosmos DB":
# one address "for each region where the Azure Cosmos DB account is deployed"). Without a region's name, private
# clients cannot reach that region after a failover.
function Get-StgCosmosDnsProblems {
    param([string]$AccountName, [string[]]$Regions, [string[]]$Fqdns)
    $have = @($Fqdns | ForEach-Object { ([string]$_).TrimEnd('.').ToLowerInvariant() })
    $account = $AccountName.ToLowerInvariant()
    foreach ($name in @($account) + @($Regions | ForEach-Object { "$account-$($_.ToLowerInvariant())" })) {
        if ($have -notcontains "$name.privatelink.documents.azure.com") { "Cosmos private endpoint has no DNS name '$name' in privatelink.documents.azure.com" }
    }
}

# Chargeback history (ADR-0044): audit.chargebackHistory { enabled, closeAfterDays, ttlDays }. Absent, or enabled false
# with no other key: off, and no stage input changes. closeAfterDays 1-7 matches RECONCILER_HISTORY_CLOSE_AFTER_DAYS;
# ttlDays is null (no expiry) or more days than the workspace keeps the ledger (Get-StgLogRetentionDays), at most 24855
# (defaultTtl is a 32-bit number of seconds). History is written only by the reconciler's timer run, so enabled history
# needs reconciler.timerEnabled.
$script:ChargebackTtlMaxDays = 24855
function Get-StgChargebackHistoryProblems {
    param($Cfg)
    $audit = $Cfg.audit
    if ($audit -isnot [Collections.IDictionary] -or -not $audit.Contains('chargebackHistory') -or $null -eq $audit.chargebackHistory) { return }
    $h = $audit.chargebackHistory
    $whole = { param($v) $v -is [int] -or $v -is [long] }
    $retention = Get-StgLogRetentionDays $Cfg
    $usage = "audit.chargebackHistory needs enabled (true or false), closeAfterDays (1-7) and ttlDays (null, or $($retention + 1)-$($script:ChargebackTtlMaxDays) whole days: more than the $retention days the workspace keeps the ledger, audit.workspaceRetentionDays or else stage1.retentionInDays, and at most the 32-bit defaultTtl) (ADR-0044)"
    if ($h -isnot [Collections.IDictionary] -or $h.enabled -isnot [bool] -or @($h.Keys | Where-Object { $_ -cnotin 'enabled', 'closeAfterDays', 'ttlDays' }).Count) { return $usage }
    if (-not $h.enabled) { return }
    if (-not (& $whole $h.closeAfterDays) -or $h.closeAfterDays -lt 1 -or $h.closeAfterDays -gt 7) { return $usage }
    if (-not $h.Contains('ttlDays') -or ($null -ne $h.ttlDays -and (-not (& $whole $h.ttlDays) -or $h.ttlDays -le $retention -or $h.ttlDays -gt $script:ChargebackTtlMaxDays))) { return $usage }
    if ($Cfg.reconciler.timerEnabled -ne $true) { return 'audit.chargebackHistory.enabled is true but reconciler.timerEnabled is not: history is written only by the reconciler timer run; set reconciler.timerEnabled to true or audit.chargebackHistory.enabled to false (ADR-0044)' }
}

# What Stages 2, 3 and 5 receive: $null when history is off.
function Get-StgChargebackHistory {
    param($Cfg)
    $h = if ($Cfg.audit -is [Collections.IDictionary]) { $Cfg.audit.chargebackHistory } else { $null }
    if ($h -isnot [Collections.IDictionary] -or $h.enabled -ne $true) { return $null }
    return @{ enabled = $true; closeAfterDays = [int]$h.closeAfterDays; ttlDays = $h.ttlDays; logRetentionDays = (Get-StgLogRetentionDays $Cfg) }
}

# Stage 2 read-back: the container's defaultTtl is ttlDays in seconds, or absent when ttlDays is null.
function Test-StgChargebackTtl {
    param($Cfg, $DefaultTtl)
    $ttl = (Get-StgChargebackHistory $Cfg).ttlDays
    return $(if ($null -eq $ttl) { $null -eq $DefaultTtl } else { $DefaultTtl -eq [long]$ttl * 86400 })
}

# ADR-0044 decision 10 (council round 3): ttlDays between null and a number on an existing chargebackDaily is refused.
# Without defaultTtl the documents carry no ttl and the coverage records say they never expire, so a new defaultTtl
# would let Cosmos DB delete documents the export still reports as covered; removing defaultTtl stops all expiry
# (item ttl is ignored without it) while the coverage records still say the months expire, so the export would refuse
# them. $Containers: az cosmosdb sql container list. Returns the refusal, or $null.
function Get-StgChargebackTtlTransitionProblem {
    param($Cfg, $Containers)
    $h = Get-StgChargebackHistory $Cfg
    $existing = @($Containers | Where-Object { $_.name -ceq 'chargebackDaily' })[0]
    if (-not $h -or -not $existing) { return $null }
    $had = $existing.resource.defaultTtl
    if (($null -eq $had) -eq ($null -eq $h.ttlDays)) { return $null }
    $procedure = "See 'Changing ttlDays between null and a number' in docs/operate/chargeback-history.md (ADR-0044 decision 10)."
    if ($null -eq $had) { return "chargeback_history_ttl_transition: chargebackDaily has no time to live, so its months are recorded as never expiring; ttlDays $($h.ttlDays) would let Cosmos DB delete documents the export reports as covered. Keep audit.chargebackHistory.ttlDays null, or start the history again. $procedure" }
    return "chargeback_history_ttl_transition: chargebackDaily has a time to live of $([long]$had / 86400) days; ttlDays null would stop expiry while the months are recorded as expiring, and the export would refuse them. To keep history longer, raise ttlDays (at most $($script:ChargebackTtlMaxDays)). $procedure"
}
