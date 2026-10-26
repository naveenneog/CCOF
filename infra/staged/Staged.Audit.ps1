# Staged deployment: long-term audit archive (ADR-0043). Configuration audit.archive and audit.workspaceRetentionDays;
# Stage 5 deploys the archive (stage5-audit-archive.bicep, stage5-audit-diagnostic.bicep) and reads it back.
# Dot-sourced by Invoke-StagedDeployment.ps1; not run directly.

$script:AuditContainers = @('insights-logs-gatewaylogs', 'insights-logs-gatewayllmlogs')
$script:AuditSkus = @('Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS', 'Standard_GZRS', 'Standard_RAGZRS')

function Test-StgWholeNumber { param($Value, [long]$Min, [long]$Max) ($Value -is [int] -or $Value -is [long]) -and $Value -ge $Min -and $Value -le $Max }

function Get-StgAuditProblems {
    # audit.archive and audit.workspaceRetentionDays only; other audit.* keys belong to other features.
    param($Cfg)
    if (-not $Cfg.ContainsKey('audit') -or $null -eq $Cfg.audit) { return @() }
    if ($Cfg.audit -isnot [Collections.IDictionary]) { return @('audit must be an object') }
    $problems = @()
    $w = $Cfg.audit.workspaceRetentionDays
    if ($null -ne $w -and -not (Test-StgWholeNumber $w 30 730)) { $problems += 'audit.workspaceRetentionDays must be a whole number of days from 30 to 730, or absent' }
    $a = $Cfg.audit.archive
    if ($null -eq $a) { return $problems }
    if ($a -isnot [Collections.IDictionary]) { return $problems + 'audit.archive must be an object { enabled, retentionDays, immutabilityDays, storageSku }' }
    $tiering = @($a.Keys | Where-Object { $_ -in 'coolAfterDays', 'archiveAfterDays' })
    if ($tiering.Count) { $problems += "audit.archive.$($tiering -join ', ') not supported: diagnostic logs are append blobs, which lifecycle management cannot move to Cool or Archive (ADR-0043)" }
    $unknown = @($a.Keys | Where-Object { $_ -notin 'enabled', 'retentionDays', 'immutabilityDays', 'storageSku', 'coolAfterDays', 'archiveAfterDays' })
    if ($unknown.Count) { $problems += "audit.archive has unknown key(s): $($unknown -join ', ')" }
    if ($a.enabled -isnot [bool]) { $problems += 'audit.archive.enabled must be a JSON boolean' }
    if ($null -ne $a.retentionDays -and -not (Test-StgWholeNumber $a.retentionDays 1 36500)) { $problems += 'audit.archive.retentionDays must be a whole number of days from 1 to 36500, or null to keep blobs' }
    if ($null -ne $a.immutabilityDays -and -not (Test-StgWholeNumber $a.immutabilityDays 1 146000)) { $problems += 'audit.archive.immutabilityDays must be a whole number of days from 1 to 146000, or null' }
    elseif ($null -ne $a.immutabilityDays -and (Test-StgWholeNumber $a.retentionDays 1 36500) -and $a.immutabilityDays -gt $a.retentionDays) { $problems += 'audit.archive.immutabilityDays must not exceed retentionDays' }
    if ($a.ContainsKey('storageSku') -and $a.storageSku -cnotin $script:AuditSkus) { $problems += "audit.archive.storageSku must be one of $($script:AuditSkus -join ', ') (a Premium account is not a diagnostic destination)" }
    return $problems
}

function Get-StgAuditArchive {
    # The validated archive settings, or $null when the archive is off (absent section or enabled false).
    param($Cfg)
    $a = $Cfg.audit.archive
    if ($a -isnot [Collections.IDictionary] -or $a.enabled -ne $true) { return $null }
    return [ordered]@{ retentionDays = $a.retentionDays; immutabilityDays = $a.immutabilityDays; storageSku = ($a.storageSku ?? 'Standard_LRS') }
}

function Test-StgOffOnly {
    # { enabled: false } and nothing else: a feature switched off that hashes as if its section were absent.
    param($Value)
    return $Value -is [Collections.IDictionary] -and $Value.Count -eq 1 -and $Value.Contains('enabled') -and $Value.enabled -is [bool] -and -not $Value.enabled
}

function Get-StgAuditStageInput {
    # Stage 5 hash input: present only when an archive key is configured, so other configurations keep their hash.
    param($Cfg)
    if ($Cfg.audit -isnot [Collections.IDictionary]) { return $null }
    $in = [ordered]@{}
    foreach ($k in 'archive', 'workspaceRetentionDays') { if ($Cfg.audit.ContainsKey($k) -and -not (Test-StgOffOnly $Cfg.audit[$k])) { $in[$k] = $Cfg.audit[$k] } }
    if ($in.Count) { return $in } else { return $null }
}

function Get-StgLogRetentionDays {
    # The days the workspace keeps the ledger: audit.workspaceRetentionDays when set (Stage 5 applies it), otherwise
    # stage1.retentionInDays (30 when absent). Chargeback history (ADR-0044) uses this one value for the export
    # boundary (ADMIN_LOG_RETENTION_DAYS) and the ttlDays floor.
    param($Cfg)
    $w = if ($Cfg.audit -is [Collections.IDictionary]) { $Cfg.audit.workspaceRetentionDays } else { $null }
    if ($null -ne $w) { return [int]$w }
    if ($Cfg.stage1.retentionInDays) { return [int]$Cfg.stage1.retentionInDays }
    return 30
}

function Get-StgLogRetentionSettings {
    # The stage5-config.bicep logRetention parameter: the admin app's ADMIN_LOG_RETENTION_DAYS and, when Stage 5 raised
    # the retention, ADMIN_LOG_RETENTION_HELD_FROM. Written on every Stage 5 run, with chargeback history on or off.
    param($Cfg, [string]$HeldFrom)
    return [ordered]@{ days = (Get-StgLogRetentionDays $Cfg); heldFrom = $HeldFrom }
}

function Get-StgAuditArchiveName {
    # Stage 1 storage names are <prefix><uniqueString><app suffix> (main.bicep): the archive uses suffix aud.
    param($Names)
    $resolver = [string]$Names.apps.resolver.storageAccount
    if ($resolver -cnotmatch '^[a-z0-9]{3,21}res$') { throw "audit_archive_name: unexpected Stage 1 storage name '$resolver'" }
    return $resolver.Substring(0, $resolver.Length - 3) + 'aud'
}

function Get-StgAuditDeployment {
    # The stage5-config.bicep auditArchive parameter, or $null when the archive is off.
    param($Cfg, $Names, [string]$ApimLocation, [string[]]$LockedContainers = @())
    $a = Get-StgAuditArchive $Cfg
    if (-not $a) { return $null }
    return [ordered]@{ accountName = (Get-StgAuditArchiveName $Names); location = $ApimLocation; tags = ($Cfg.tags ?? @{}); storageSku = $a.storageSku
        retentionDays = $a.retentionDays; immutabilityDays = $a.immutabilityDays; lockedContainers = @($LockedContainers) }
}

function Format-StgAuditPreview {
    param($Deployment, $WorkspaceRetentionDays)
    $ws = if ($null -ne $WorkspaceRetentionDays) { "workspace retention $WorkspaceRetentionDays days" } else { 'workspace retention unchanged' }
    if (-not $Deployment) { return "audit archive: off; an existing ccof-gateway-archive diagnostic setting keeps exporting. Stop exports with: az monitor diagnostic-settings delete --name ccof-gateway-archive --resource <API Management resource ID>; this does not delete the archive account; $ws" }
    $keep = if ($null -ne $Deployment.retentionDays) { "deleted after $($Deployment.retentionDays) days" } else { 'kept (no deletion rule)' }
    $lock = if ($null -ne $Deployment.immutabilityDays) { "immutable $($Deployment.immutabilityDays) days" } else { 'no immutability' }
    return "audit archive: $($Deployment.accountName) in $($Deployment.location), blobs $keep, $lock, $($Deployment.storageSku); diagnostic setting ccof-gateway-archive (GatewayLogs, GatewayLlmLogs); $ws"
}

function Get-StgAuditLockedContainers {
    # Containers whose immutability policy the owner has locked; Stage 5 never rewrites those (ADR-0043).
    param([string]$AccountId)
    @(foreach ($c in $script:AuditContainers) {
        try { $p = Get-StgArm "$AccountId/blobServices/default/containers/$c/immutabilityPolicies/default" '2023-05-01' } catch { $p = $null }
        if ($p.properties.state -ceq 'Locked') { $c }
    })
}

function Set-StgWorkspaceRetention {
    # audit.workspaceRetentionDays: the workspace default retention, set outside create-only Stage 1 (AUD-A8).
    param($Cfg, $Names)
    $days = $Cfg.audit.workspaceRetentionDays
    if ($null -eq $days) { return }
    $null = Invoke-StgAzJson @('monitor', 'log-analytics', 'workspace', 'update', '--subscription', $Cfg.subscriptionId, '--resource-group', $Cfg.resourceGroup,
        '--workspace-name', $Names.logAnalyticsWorkspace, '--retention-time', "$days")
}

function Get-StgRetentionHeldFrom {
    # ADR-0043: raising the workspace retention does not bring back rows already deleted. The workspace then holds rows
    # from the later of now - the new retention and now - the retention it had (or the instant recorded at an earlier
    # raise). Returns that instant as ISO 8601 while it is later than now - DesiredDays, else $null. CurrentDays is the
    # workspace retention before this Stage 5 changes it ($null: Stage 5 does not change it); Previous is the instant
    # recorded by the last Stage 5. After a lowered retention now - CurrentDays is before now - DesiredDays, so nothing is kept.
    param($CurrentDays, [int]$DesiredDays, [string]$Previous, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
    $held = if ($Previous) { [DateTimeOffset]::Parse($Previous, [Globalization.CultureInfo]::InvariantCulture) } else { $null }
    if ($null -ne $CurrentDays) {
        $before = $Now.AddDays(-[int]$CurrentDays)
        if ($null -eq $held -or $before -gt $held) { $held = $before }
    }
    if ($null -eq $held -or $held -le $Now.AddDays(-$DesiredDays)) { return $null }
    return $held.UtcDateTime.ToString('yyyy-MM-dd''T''HH:mm:ss.fff''Z''', [Globalization.CultureInfo]::InvariantCulture)
}

function Get-StgRecordedRetentionHeldFrom {
    # The instant the last Stage 5 apply recorded in evidence/stage5.retention.json, written before it deploys or
    # changes the retention, so a run that fails afterwards does not lose it. Not a stage output: later stages are not
    # asked to rerun because of it.
    param([string]$Path = (Join-Path $script:StateDir 'evidence/stage5.retention.json'))
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    # Read as text: ConvertFrom-Json would turn the ISO 8601 string into a local DateTime.
    $doc = [Text.Json.JsonDocument]::Parse((Get-Content -LiteralPath $Path -Raw))
    try {
        $element = [Text.Json.JsonElement]::new()
        if ($doc.RootElement.TryGetProperty('heldFrom', [ref]$element) -and $element.ValueKind -eq [Text.Json.JsonValueKind]::String) { return $element.GetString() }
        return $null
    } finally { $doc.Dispose() }
}

function Get-StgPreviousRetentionHeldFrom {
    # The instant the last Stage 5 recorded. Without evidence/stage5.retention.json (the state folder was lost, R3-4),
    # the instant the deployment carries now, so a later Stage 5 does not drop it. A present file is used as it is,
    # even with no instant. A read failure other than a missing workbook stops Stage 5.
    param($Cfg, $Names, [string]$Path = (Join-Path $script:StateDir 'evidence/stage5.retention.json'))
    if (Test-Path -LiteralPath $Path) { return Get-StgRecordedRetentionHeldFrom $Path }
    $settings = if ($Cfg.stage1.includeAdmin) {
        Invoke-StgAzJson @('functionapp', 'config', 'appsettings', 'list', '--subscription', $Cfg.subscriptionId, '--resource-group', $Cfg.resourceGroup, '--name', $Names.apps.admin.functionApp)
    } else { @() }
    $content = $null
    if ($Cfg.workbook.resourceName) {
        # serializedData is returned only with canFetchContent=true (Microsoft.Insights/workbooks GET); az rest adds it,
        # as Invoke-QsAz refuses & in an argument.
        $url = "https://management.azure.com/subscriptions/$($Cfg.subscriptionId)/resourceGroups/$($Cfg.resourceGroup)/providers/Microsoft.Insights/workbooks/$($Cfg.workbook.resourceName)?api-version=2023-06-01"
        try { $content = [string](Invoke-StgAzJson @('rest', '--method', 'get', '--url', $url, '--url-parameters', 'canFetchContent=true', '--headers', 'Accept=application/json')).properties.serializedData }
        catch { if ("$_" -notmatch 'NotFound') { throw } }
    }
    return Get-StgDeployedRetentionHeldFrom -AdminSettings $settings -WorkbookContent $content
}

function Get-StgDeployedRetentionHeldFrom {
    # The later of ADMIN_LOG_RETENTION_HELD_FROM (az functionapp config appsettings list) and the instant in the
    # workbook's retention cut (analytics/workbooks/queries.ts retentionCut); $null when neither holds one.
    param($AdminSettings, [string]$WorkbookContent)
    $found = @(@($AdminSettings | Where-Object { $_.name -ceq 'ADMIN_LOG_RETENTION_HELD_FROM' -and $_.value } | ForEach-Object { [string]$_.value }) +
        @([regex]::Matches([string]$WorkbookContent, 'max_of\(ReportNow - \d+ \* 1d, datetime\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\)\)') | ForEach-Object { $_.Groups[1].Value }))
    if (-not $found.Count) { return $null }
    return @($found | Sort-Object { [DateTimeOffset]::Parse($_, [Globalization.CultureInfo]::InvariantCulture) })[-1]
}

function Get-StgAuditArchiveNetworkMode {
    # The archive's accepted network modes: firewall default Deny with the trusted-services bypass (which Azure Monitor
    # writes through) and public network access Enabled (as deployed) or Disabled (set by a storage policy, or for
    # private endpoints; delivery seen live 2026-10-26). $null for anything else.
    param($Account)
    $p = $Account.properties; $acl = $p.networkAcls
    if ($acl.defaultAction -cne 'Deny' -or "$($acl.bypass)" -notmatch '\bAzureServices\b') { return $null }
    switch -CaseSensitive ($p.publicNetworkAccess) { 'Enabled' { return 'public-enabled' } 'Disabled' { return 'public-disabled' } }
    return $null
}

function Format-StgAuditNetwork {
    param([string]$AccountName, [string]$Mode)
    $how = if ($Mode -ceq 'public-disabled') { 'policy or private' } else { 'firewall Deny, no rules' }
    return "audit archive: $AccountName network $Mode ($how), trusted services allowed"
}

function Get-StgAuditArchiveProblems {
    # Read-back of the archive from ARM objects; returns what differs from the deployed intent.
    param($Deployment, $Account, $ManagementPolicy, $Immutability, $Diagnostic, $Workspace, $WorkspaceRetentionDays)
    $problems = @()
    if ($null -ne $WorkspaceRetentionDays -and $Workspace.properties.retentionInDays -ne $WorkspaceRetentionDays) { $problems += "workspace retention is $($Workspace.properties.retentionInDays) days, expected $WorkspaceRetentionDays" }
    if (-not $Deployment) { return $problems }
    $n = $Deployment.accountName; $p = $Account.properties; $acl = $p.networkAcls
    if (-not $Account) { return $problems + "archive account $n is missing" }
    if ($Account.kind -cne 'StorageV2' -or $Account.sku.name -cne $Deployment.storageSku) { $problems += "$n is $($Account.kind) $($Account.sku.name), expected StorageV2 $($Deployment.storageSku)" }
    if (($Account.location -replace ' ', '') -ine ($Deployment.location -replace ' ', '')) { $problems += "$n is in $($Account.location), expected the gateway region $($Deployment.location)" }
    if ($p.supportsHttpsTrafficOnly -ne $true -or $p.minimumTlsVersion -cne 'TLS1_2') { $problems += "$n does not require HTTPS with TLS 1.2" }
    if ($p.allowBlobPublicAccess -ne $false -or $p.allowSharedKeyAccess -ne $false) { $problems += "$n allows blob public access or Shared Key" }
    if (-not (Get-StgAuditArchiveNetworkMode $Account)) { $problems += "$n firewall is not default Deny with the trusted-services bypass Azure Monitor needs, with public network access Enabled or Disabled" }
    if (@($acl.ipRules).Where({ $_ }).Count -or @($acl.virtualNetworkRules).Where({ $_ }).Count) { $problems += "$n firewall has IP or VNet rules" }
    $rule = @($ManagementPolicy.properties.policy.rules | Where-Object { $_.name -ceq 'ccof-audit-retention' })[0]
    $days = $rule.definition.actions.baseBlob.delete.daysAfterModificationGreaterThan
    if (-not $rule -or (@($rule.definition.filters.blobTypes) -join ',') -cne 'appendBlob') { $problems += "$n lifecycle rule ccof-audit-retention is missing" }
    elseif ($null -eq $Deployment.retentionDays) { if ($rule.enabled -ne $false) { $problems += "$n lifecycle rule deletes blobs but retentionDays is null" } }
    elseif ($rule.enabled -ne $true -or $days -ne $Deployment.retentionDays) { $problems += "$n lifecycle deletion is $(if ($rule.enabled) { "$days days" } else { 'disabled' }), expected $($Deployment.retentionDays) days" }
    if ($null -ne $Deployment.immutabilityDays) {
        foreach ($c in $script:AuditContainers) {
            $ip = $Immutability[$c].properties
            $shortOk = if ($ip.state -ceq 'Locked') { $ip.immutabilityPeriodSinceCreationInDays -ge $Deployment.immutabilityDays } else { $ip.immutabilityPeriodSinceCreationInDays -eq $Deployment.immutabilityDays }
            if (-not $ip -or -not $shortOk -or $ip.allowProtectedAppendWrites -ne $true) { $problems += "$c immutability is $(if ($ip) { "$($ip.state) $($ip.immutabilityPeriodSinceCreationInDays) days, append writes $($ip.allowProtectedAppendWrites)" } else { 'missing' }), expected $($Deployment.immutabilityDays) days with protected append writes" }
        }
    }
    $d = $Diagnostic.properties
    $categories = @($d.logs | Where-Object { $_.enabled -eq $true } | ForEach-Object { $_.category } | Sort-Object) -join ','
    if (-not $Diagnostic -or $d.storageAccountId -ine $Account.id -or $categories -cne 'GatewayLlmLogs,GatewayLogs') { $problems += "diagnostic setting ccof-gateway-archive is missing, targets another account or lacks GatewayLogs/GatewayLlmLogs" }
    return $problems
}

function Test-StgAuditArchive {
    # Stage 5 read-back (apply only): ARM reads, then Get-StgAuditArchiveProblems.
    param($Cfg, $Deployment, $Names, $Apim)
    $ws = $Cfg.audit.workspaceRetentionDays
    $rg = "/subscriptions/$($Cfg.subscriptionId)/resourceGroups/$($Cfg.resourceGroup)"
    $workspace = if ($null -ne $ws) { Get-StgArm "$rg/providers/Microsoft.OperationalInsights/workspaces/$($Names.logAnalyticsWorkspace)" '2023-09-01' }
    $account = $null; $policy = $null; $immutability = @{}; $diagnostic = $null
    if ($Deployment) {
        $id = "$rg/providers/Microsoft.Storage/storageAccounts/$($Deployment.accountName)"
        $account = Get-StgArm $id '2023-05-01'
        try { $policy = Get-StgArm "$id/managementPolicies/default" '2023-05-01' } catch { $policy = $null }
        if ($null -ne $Deployment.immutabilityDays) {
            foreach ($c in $script:AuditContainers) { $immutability[$c] = Get-StgArm "$id/blobServices/default/containers/$c/immutabilityPolicies/default" '2023-05-01' }
        }
        $diagnostic = @((Get-StgArm "$($Apim.id)/providers/Microsoft.Insights/diagnosticSettings" '2021-05-01-preview').value | Where-Object { $_.name -ceq 'ccof-gateway-archive' })[0]
    }
    $problems = @(Get-StgAuditArchiveProblems -Deployment $Deployment -Account $account -ManagementPolicy $policy -Immutability $immutability -Diagnostic $diagnostic -Workspace $workspace -WorkspaceRetentionDays $ws)
    Assert-Stg (-not $problems.Count) ($problems -join '; ')
    return [ordered]@{ enabled = [bool]$Deployment; account = $Deployment.accountName; location = $Deployment.location; network = $(if ($Deployment) { Get-StgAuditArchiveNetworkMode $account }); retentionDays = $Deployment.retentionDays
        immutabilityDays = $Deployment.immutabilityDays; diagnosticSetting = $(if ($Deployment) { 'ccof-gateway-archive' }); workspaceRetentionDays = $ws }
}
