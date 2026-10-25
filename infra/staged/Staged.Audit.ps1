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
    if (-not $Deployment) { return "audit archive: off; $ws" }
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
    if ($p.publicNetworkAccess -cne 'Enabled' -or $acl.defaultAction -cne 'Deny' -or "$($acl.bypass)" -notmatch 'AzureServices') { $problems += "$n firewall is not Enabled/Deny with the trusted-services bypass Azure Monitor needs" }
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
    return [ordered]@{ enabled = [bool]$Deployment; account = $Deployment.accountName; location = $Deployment.location; retentionDays = $Deployment.retentionDays
        immutabilityDays = $Deployment.immutabilityDays; diagnosticSetting = $(if ($Deployment) { 'ccof-gateway-archive' }); workspaceRetentionDays = $ws }
}
