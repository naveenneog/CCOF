#Requires -Version 7.0
<#
.SYNOPSIS
    Offline tests for the long-term audit archive (ADR-0043): audit.* validation, Stage 5 template contents,
    Stage 5 read-back and configuration hash. No Azure call: Bicep compiles locally, ARM answers are fakes.
#>
[CmdletBinding()]
param([string]$BicepPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $BicepPath) {
    $command = Get-Command bicep -ErrorAction SilentlyContinue
    if ($command) { $BicepPath = $command.Source }
    elseif ($installed = @('bicep.exe', 'bicep' | ForEach-Object { Join-Path $HOME '.azure' 'bin' $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })[0]) { $BicepPath = $installed }
    else { throw 'Offline Bicep CLI required. Supply -BicepPath; this test does not install tools or call Azure.' }
}
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:passed++ }
function Get-Resources($Template) {
    # languageVersion 2.0 templates hold resources in an object keyed by symbolic name.
    $items = if ($Template.resources -is [Collections.IDictionary]) { $Template.resources.Values } else { $Template.resources }
    foreach ($resource in $items) {
        $resource
        if ($resource.properties.template) { Get-Resources $resource.properties.template }
    }
}

. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly

# ---------------------------------------------------------------- configuration validation
$scratch = Join-Path ([IO.Path]::GetTempPath()) "audit-archive-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $scratch | Out-Null
$example = Get-Content -Raw (Join-Path $root 'infra\staged\staged.config.example.json') | ConvertFrom-Json -AsHashtable -Depth 100
function New-ValidConfig {
    $c = $example | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable -Depth 100
    $c.tenantId = '00000000-0000-4000-8000-000000000001'; $c.subscriptionId = '00000000-0000-4000-8000-000000000002'; $c.resourceGroup = 'rg-ccoflab'
    $vnet = '/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet/subnets'
    $c.network.existing = @{ functionsSubnetId = "$vnet/functions"; privateEndpointSubnetId = "$vnet/private"; apimSubnetId = "$vnet/apim" }
    $c.apim.existing = @{ name = 'apim-contoso'; subscriptionId = '00000000-0000-4000-8000-000000000002'; resourceGroup = 'rg-apim' }
    return $c
}
function Read-Config($Cfg) {
    $path = Join-Path $scratch "config-$([guid]::NewGuid().ToString('N')).json"
    $Cfg | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $path -Encoding utf8NoBOM
    return Read-StgConfig $path
}
function Test-Refused([scriptblock]$Mutate, [string]$Pattern, [string]$Why) {
    $c = New-ValidConfig; & $Mutate $c
    $message = ''
    try { $null = Read-Config $c } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match $Pattern) "$Why (got: $message)"
}

try {
    # The committed example enables the archive for new deployments and passes validation.
    Assert-Contract ($example.audit.archive.enabled -eq $true) 'The example configuration must enable audit.archive for new deployments.'
    $read = Read-Config (New-ValidConfig)
    Assert-Contract ($null -ne (Get-StgAuditArchive $read)) 'The example audit.archive must turn the archive on.'
    # Absent section: feature off, configuration still valid.
    $c = New-ValidConfig; $c.Remove('audit')
    $read = Read-Config $c
    Assert-Contract ($null -eq (Get-StgAuditArchive $read)) 'An absent audit section must leave the archive off.'
    $c = New-ValidConfig; $c.audit.archive.enabled = $false
    Assert-Contract ($null -eq (Get-StgAuditArchive (Read-Config $c))) 'audit.archive.enabled false must leave the archive off.'
    # Another feature's key under audit (ADR-0044 owns audit.chargebackHistory and validates it) is not refused
    # by the archive validation.
    $c = New-ValidConfig; $c.audit.chargebackHistory = @{ enabled = $true; closeAfterDays = 2; ttlDays = $null }; $c.reconciler.timerEnabled = $true
    $null = Read-Config $c; $passed++

    Test-Refused { param($c) $c.audit.archive.enabled = 'true' } 'audit\.archive\.enabled' 'enabled must be a JSON boolean.'
    Test-Refused { param($c) $c.audit.archive.retentionDays = 0 } 'audit\.archive\.retentionDays' 'retentionDays below 1 must be refused.'
    Test-Refused { param($c) $c.audit.archive.retentionDays = 36501 } 'audit\.archive\.retentionDays' 'retentionDays above 36500 must be refused.'
    Test-Refused { param($c) $c.audit.archive.retentionDays = 1.5 } 'audit\.archive\.retentionDays' 'retentionDays must be a whole number.'
    Test-Refused { param($c) $c.audit.archive.retentionDays = '365' } 'audit\.archive\.retentionDays' 'retentionDays must not be a string.'
    Test-Refused { param($c) $c.audit.archive.immutabilityDays = 0 } 'audit\.archive\.immutabilityDays' 'immutabilityDays below 1 must be refused.'
    Test-Refused { param($c) $c.audit.archive.retentionDays = 30; $c.audit.archive.immutabilityDays = 31 } 'immutabilityDays.*retentionDays' 'immutabilityDays longer than retentionDays must be refused.'
    Test-Refused { param($c) $c.audit.archive.storageSku = 'Premium_LRS' } 'audit\.archive\.storageSku' 'A Premium SKU is not a diagnostic destination and must be refused.'
    Test-Refused { param($c) $c.audit.archive.coolAfterDays = 30 } 'append blobs' 'coolAfterDays must be refused with the append-blob reason.'
    Test-Refused { param($c) $c.audit.archive.archiveAfterDays = 180 } 'append blobs' 'archiveAfterDays must be refused with the append-blob reason.'
    Test-Refused { param($c) $c.audit.archive.retentionDay = 30 } 'unknown key.*retentionDay' 'A misspelt key must be refused, not ignored.'
    Test-Refused { param($c) $c.audit.archive = 'on' } 'audit\.archive must be an object' 'A non-object archive must be refused.'
    Test-Refused { param($c) $c.audit = 'on' } 'audit must be an object' 'A non-object audit section must be refused.'
    Test-Refused { param($c) $c.audit.workspaceRetentionDays = 29 } 'audit\.workspaceRetentionDays' 'Workspace retention below 30 must be refused.'
    Test-Refused { param($c) $c.audit.workspaceRetentionDays = 731 } 'audit\.workspaceRetentionDays' 'Workspace retention above 730 must be refused.'
    # Null keeps blobs (no deletion) and means no immutability; an absent storageSku is Standard_LRS.
    $c = New-ValidConfig; $c.audit.archive.retentionDays = $null; $c.audit.archive.immutabilityDays = $null; $c.audit.archive.Remove('storageSku')
    $a = Get-StgAuditArchive (Read-Config $c)
    Assert-Contract ($null -eq $a.retentionDays -and $null -eq $a.immutabilityDays -and $a.storageSku -ceq 'Standard_LRS') 'Null retention/immutability and an absent SKU must normalise to keep, none and Standard_LRS.'
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------- names and deployment parameters
$names = @{ logAnalyticsWorkspace = 'ccoflab-abc-law'; apps = @{ resolver = @{ storageAccount = 'ccoflab4f2kq7xz3m6bwres' } } }
$name = Get-StgAuditArchiveName $names
Assert-Contract ($name -ceq 'ccoflab4f2kq7xz3m6bwaud') "The archive account name must be the Stage 1 storage stem plus aud (got $name)."
Assert-Contract ($name.Length -le 24 -and $name -cmatch '^[a-z0-9]+$') 'The archive account name must be 3-24 lowercase letters or digits.'
$cfgOn = @{ tags = @{ workload = 'claude-code-on-foundry' }; audit = @{ archive = @{ enabled = $true; retentionDays = 2555; immutabilityDays = 365; storageSku = 'Standard_ZRS' } } }
$p = Get-StgAuditDeployment -Cfg $cfgOn -Names $names -ApimLocation 'westeurope' -LockedContainers @('insights-logs-gatewaylogs')
Assert-Contract ($p.accountName -ceq $name -and $p.location -ceq 'westeurope' -and $p.storageSku -ceq 'Standard_ZRS') 'The archive must be in the gateway region with the configured SKU.'
Assert-Contract ($p.retentionDays -eq 2555 -and $p.immutabilityDays -eq 365) 'The deployment parameters must carry retention and immutability.'
Assert-Contract ((@($p.lockedContainers) -join ',') -ceq 'insights-logs-gatewaylogs') 'Locked containers must be passed so Stage 5 never rewrites a locked policy.'
Assert-Contract ($null -eq (Get-StgAuditDeployment -Cfg @{} -Names $names -ApimLocation 'eastus2')) 'With the archive off there are no deployment parameters.'
Assert-Contract ((Format-StgAuditPreview -Deployment $p -WorkspaceRetentionDays 365) -match "audit archive: $name in westeurope.*2555.*365.*Standard_ZRS.*ccof-gateway-archive.*workspace retention 365") 'The Stage 5 preview must name the account, retention, immutability, SKU, setting and workspace retention.'
$archiveOff = Format-StgAuditPreview -Deployment $null -WorkspaceRetentionDays $null
Assert-Contract ($archiveOff -match 'audit archive: off.*existing.*ccof-gateway-archive.*keeps exporting.*az monitor diagnostic-settings delete --name ccof-gateway-archive --resource.*workspace retention unchanged') 'The Stage 5 preview must warn that an existing setting still exports and give the manual deletion command.'
# ARM returns the gateway region as its display name, which the preview prints as is (live: "in East US 2").
$pDisplay = Get-StgAuditDeployment -Cfg $cfgOn -Names $names -ApimLocation 'East US 2'
Assert-Contract ((Format-StgAuditPreview -Deployment $pDisplay -WorkspaceRetentionDays $null) -clike "audit archive: $name in East US 2, blobs deleted after 2555 days, *") 'The preview prints the API Management region as ARM returns it.'

# ---------------------------------------------------------------- Stage 5 configuration hash
$base = @{ tenantId = 't'; subscriptionId = 's'; resourceGroup = 'rg'; stage1 = @{ prefix = 'ccoflab' }; apim = @{}; backends = @(); groups = @() }
$hashOff = Get-StgStageInput $base 5
# The same configuration's Stage 5 hash before ADR-0043 (e076ae1): installs without audit.* keep their Stage 5 record.
Assert-Contract ($hashOff -ceq '2bc716561bbb3953e72e476d27a6ea91f710d37ec9f8aa444aefb32a1f9d8482') "A configuration without audit.* must keep its pre-archive Stage 5 hash (got $hashOff)."
$withOther = $base.Clone(); $withOther.audit = @{ chargebackHistory = @{ enabled = $true; closeAfterDays = 2; ttlDays = $null } }
# The archive's own hash input ignores another feature's audit key; that key's effect on Stage 5 is its own ADR's
# decision (ADR-0044 deliberately adds audit.chargebackHistory to the Stage 2, 3 and 5 inputs).
Assert-Contract ($null -eq (Get-StgAuditStageInput $withOther)) 'The archive hash input must ignore another feature''s audit key.'
Assert-Contract ((Get-StgStageInput $withOther 5) -cne $hashOff) 'Configuring audit.chargebackHistory must change the Stage 5 hash (ADR-0044), so Stage 5 runs again.'
$withArchive = $base.Clone(); $withArchive.audit = @{ archive = @{ enabled = $true; retentionDays = 2555 } }
$hashOn = Get-StgStageInput $withArchive 5
Assert-Contract ($hashOn -cne $hashOff) 'audit.archive must be a Stage 5 configuration hash input.'
$withArchive.audit.archive.retentionDays = 3650
Assert-Contract ((Get-StgStageInput $withArchive 5) -cne $hashOn) 'A changed retentionDays must change the Stage 5 hash.'
$withRetention = $base.Clone(); $withRetention.audit = @{ workspaceRetentionDays = 365 }
Assert-Contract ((Get-StgStageInput $withRetention 5) -cne $hashOff) 'audit.workspaceRetentionDays must be a Stage 5 configuration hash input.'
foreach ($n in 0, 1, 2, 3, 4, 6, 7, 8) { Assert-Contract ((Get-StgStageInput $withArchive $n) -ceq (Get-StgStageInput $base $n)) "audit.archive must not change the Stage $n hash." }

# ---------------------------------------------------------------- templates
$out = & $BicepPath build (Join-Path $root 'infra\staged\stage5-config.bicep') --stdout 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Bicep compilation failed: stage5-config.bicep' }
$arm = ($out -join "`n") | ConvertFrom-Json -AsHashtable -Depth 100
$all = @(Get-Resources $arm)
Assert-Contract ($arm.parameters.auditArchive.defaultValue.Count -eq 0) 'stage5-config auditArchive must default to {} (archive off).'
$modules = @($arm.resources | Where-Object { $_.type -ceq 'Microsoft.Resources/deployments' -and "$($_.name)" -match 'audit' })
Assert-Contract ($modules.Count -eq 2 -and @($modules | Where-Object { "$($_.condition)" -match 'empty\(parameters\(''auditArchive''\)\)' }).Count -eq 2) 'Both audit modules must be conditional on a non-empty auditArchive.'
$account = @($all | Where-Object type -CEQ 'Microsoft.Storage/storageAccounts')
Assert-Contract ($account.Count -eq 1) 'Stage 5 must declare exactly one storage account (the archive).'
$ap = $account[0].properties
Assert-Contract ($account[0].kind -ceq 'StorageV2' -and $ap.supportsHttpsTrafficOnly -eq $true -and $ap.minimumTlsVersion -ceq 'TLS1_2') 'The archive must be StorageV2, HTTPS only, TLS 1.2.'
Assert-Contract ($ap.allowBlobPublicAccess -eq $false -and $ap.allowSharedKeyAccess -eq $false) 'The archive must disable blob public access and Shared Key.'
Assert-Contract ($ap.publicNetworkAccess -ceq 'Enabled' -and $ap.networkAcls.defaultAction -ceq 'Deny' -and $ap.networkAcls.bypass -ceq 'AzureServices') 'The archive firewall must deny by default and admit trusted services (Azure Monitor).'
Assert-Contract (@($ap.networkAcls.ipRules).Count -eq 0 -and @($ap.networkAcls.virtualNetworkRules).Count -eq 0) 'The archive firewall must have no IP or VNet rule.'
$policy = @($all | Where-Object type -CEQ 'Microsoft.Storage/storageAccounts/managementPolicies')
$rule = $policy[0].properties.policy.rules[0]
Assert-Contract ($policy.Count -eq 1 -and (@($rule.definition.filters.blobTypes) -join ',') -ceq 'appendBlob') 'The lifecycle rule must target append blobs.'
Assert-Contract ((@($rule.definition.filters.prefixMatch) -join ',') -ceq 'insights-logs-gatewaylogs/,insights-logs-gatewayllmlogs/') 'The lifecycle rule must cover only the two gateway log containers.'
Assert-Contract ($null -ne $rule.definition.actions.baseBlob.delete -and -not (($rule.definition.actions | ConvertTo-Json -Depth 20) -match 'tierTo')) 'The lifecycle rule deletes only; append blobs cannot be tiered.'
$containers = @($all | Where-Object type -CEQ 'Microsoft.Storage/storageAccounts/blobServices/containers')
Assert-Contract ($containers.Count -eq 1 -and "$($containers[0].copy.count)" -match 'length') 'The two gateway log containers must be declared (one copy loop).'
$immutable = @($all | Where-Object type -CEQ 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies')
Assert-Contract ($immutable.Count -eq 1 -and $immutable[0].properties.allowProtectedAppendWrites -eq $true) 'Immutability must allow protected append writes (the logs are append blobs).'
Assert-Contract ("$($immutable[0].condition)" -match 'lockedContainers') 'Stage 5 must not write an immutability policy the owner has locked.'
$diagAll = @($all | Where-Object type -CEQ 'Microsoft.Insights/diagnosticSettings')
# ADR-0045: besides the archive, the only other setting is ccof-gateway-logs for an existing API Management (deployed
# only when gatewayLogs is given: tests/Test-StagedStages.ps1, tests/Test-StagedApimExisting.ps1).
$diag = @($diagAll | Where-Object name -CEQ 'ccof-gateway-archive')
$otherDiag = @($diagAll | Where-Object name -CNE 'ccof-gateway-archive')
Assert-Contract ($diag.Count -eq 1 -and $otherDiag.Count -eq 1 -and "$($otherDiag[0].properties.logAnalyticsDestinationType)" -ceq 'Dedicated') 'Stage 5 must declare only the ccof-gateway-archive diagnostic setting (and, for an existing API Management, ccof-gateway-logs).'
Assert-Contract ($diag[0].properties.ContainsKey('storageAccountId') -and -not $diag[0].properties.ContainsKey('workspaceId')) 'The archive setting must send to storage only, never repeat the workspace destination of ccof-gateway-logs.'
Assert-Contract ((@($diag[0].properties.logs | Where-Object enabled | ForEach-Object category) -join ',') -ceq 'GatewayLogs,GatewayLlmLogs') 'The archive setting must send GatewayLogs and GatewayLlmLogs.'

# ---------------------------------------------------------------- Stage 5 read-back
$accountId = '/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg-ccoflab/providers/Microsoft.Storage/storageAccounts/ccoflab4f2kq7xz3m6bwaud'
function New-Observed {
    @{
        account = @{ id = $accountId; kind = 'StorageV2'; location = 'westeurope'; sku = @{ name = 'Standard_ZRS' }
            properties = @{ supportsHttpsTrafficOnly = $true; minimumTlsVersion = 'TLS1_2'; allowBlobPublicAccess = $false; allowSharedKeyAccess = $false
                publicNetworkAccess = 'Enabled'; networkAcls = @{ defaultAction = 'Deny'; bypass = 'AzureServices'; ipRules = @(); virtualNetworkRules = @() } } }
        policy = @{ properties = @{ policy = @{ rules = @(@{ name = 'ccof-audit-retention'; enabled = $true
            definition = @{ filters = @{ blobTypes = @('appendBlob') }; actions = @{ baseBlob = @{ delete = @{ daysAfterModificationGreaterThan = 2555 } } } } }) } } }
        immutability = @{
            'insights-logs-gatewaylogs' = @{ properties = @{ immutabilityPeriodSinceCreationInDays = 400; state = 'Locked'; allowProtectedAppendWrites = $true } }
            'insights-logs-gatewayllmlogs' = @{ properties = @{ immutabilityPeriodSinceCreationInDays = 365; state = 'Unlocked'; allowProtectedAppendWrites = $true } } }
        diagnostic = @{ name = 'ccof-gateway-archive'; properties = @{ storageAccountId = $accountId.ToUpperInvariant()
            logs = @(@{ category = 'GatewayLogs'; enabled = $true }, @{ category = 'GatewayLlmLogs'; enabled = $true }) } }
        workspace = @{ properties = @{ retentionInDays = 365 } }
    }
}
function Get-Problems($Observed, $Deployment = $p, $WorkspaceRetentionDays = 365) {
    @(Get-StgAuditArchiveProblems -Deployment $Deployment -Account $Observed.account -ManagementPolicy $Observed.policy -Immutability $Observed.immutability -Diagnostic $Observed.diagnostic -Workspace $Observed.workspace -WorkspaceRetentionDays $WorkspaceRetentionDays)
}
$good = Get-Problems (New-Observed)
Assert-Contract ($good.Count -eq 0) "A matching archive must pass the read-back (got: $($good -join '; '))."
$cases = [ordered]@{
    'Shared Key'           = { param($o) $o.account.properties.allowSharedKeyAccess = $true }
    'TLS'                  = { param($o) $o.account.properties.minimumTlsVersion = 'TLS1_0' }
    'public blob'          = { param($o) $o.account.properties.allowBlobPublicAccess = $true }
    'firewall'             = { param($o) $o.account.properties.networkAcls.defaultAction = 'Allow' }
    'trusted services'     = { param($o) $o.account.properties.networkAcls.bypass = 'None' }
    'IP or VNet rule'      = { param($o) $o.account.properties.networkAcls.ipRules = @(@{ value = '203.0.113.7' }) }
    'public network'       = { param($o) $o.account.properties.publicNetworkAccess = 'SecuredByPerimeter' }
    'public network absent' = { param($o) $o.account.properties.Remove('publicNetworkAccess') }
    'disabled, no bypass'  = { param($o) $o.account.properties.publicNetworkAccess = 'Disabled'; $o.account.properties.networkAcls.bypass = 'None' }
    'disabled, allow'      = { param($o) $o.account.properties.publicNetworkAccess = 'Disabled'; $o.account.properties.networkAcls.defaultAction = 'Allow' }
    'disabled, IP rule'    = { param($o) $o.account.properties.publicNetworkAccess = 'Disabled'; $o.account.properties.networkAcls.ipRules = @(@{ value = '203.0.113.7' }) }
    'SKU'                  = { param($o) $o.account.sku.name = 'Standard_LRS' }
    'region'               = { param($o) $o.account.location = 'eastus2' }
    'lifecycle'            = { param($o) $o.policy.properties.policy.rules[0].definition.actions.baseBlob.delete.daysAfterModificationGreaterThan = 30 }
    'lifecycle missing'    = { param($o) $o.policy = $null }
    'immutability'         = { param($o) $o.immutability['insights-logs-gatewayllmlogs'].properties.immutabilityPeriodSinceCreationInDays = 30 }
    'locked shorter'       = { param($o) $o.immutability['insights-logs-gatewaylogs'].properties.immutabilityPeriodSinceCreationInDays = 300 }
    'append writes'        = { param($o) $o.immutability['insights-logs-gatewayllmlogs'].properties.allowProtectedAppendWrites = $false }
    'immutability missing' = { param($o) $o.immutability.Remove('insights-logs-gatewayllmlogs') }
    'diagnostic missing'   = { param($o) $o.diagnostic = $null }
    'diagnostic target'    = { param($o) $o.diagnostic.properties.storageAccountId = "$accountId-other" }
    'diagnostic category'  = { param($o) $o.diagnostic.properties.logs = @(@{ category = 'GatewayLogs'; enabled = $true }) }
    'workspace retention'  = { param($o) $o.workspace.properties.retentionInDays = 30 }
}
foreach ($k in $cases.Keys) {
    $o = New-Observed; & $cases[$k] $o
    Assert-Contract ((Get-Problems $o).Count -gt 0) "The read-back must refuse a changed $k."
}
# A storage policy (modify effect) can force public network access off after Stage 5 creates the account; Azure Monitor
# still writes through the trusted-services bypass (live 2026-10-26), so Disabled + Deny + AzureServices passes.
$o = New-Observed; $o.account.properties.publicNetworkAccess = 'Disabled'
$disabled = Get-Problems $o
Assert-Contract ($disabled.Count -eq 0) "Public network access Disabled with Deny and the trusted-services bypass must pass (got: $($disabled -join '; '))."
$o.account.properties.networkAcls.bypass = 'Logging, Metrics, AzureServices'
Assert-Contract ((Get-Problems $o).Count -eq 0) 'A bypass list that includes AzureServices must pass.'
Assert-Contract ((Get-StgAuditArchiveNetworkMode (New-Observed).account) -ceq 'public-enabled') 'Enabled + Deny + bypass is the public-enabled mode.'
Assert-Contract ((Get-StgAuditArchiveNetworkMode $o.account) -ceq 'public-disabled') 'Disabled + Deny + bypass is the public-disabled mode.'
$o.account.properties.networkAcls.bypass = 'None'
Assert-Contract ($null -eq (Get-StgAuditArchiveNetworkMode $o.account)) 'Without the trusted-services bypass there is no accepted network mode.'
Assert-Contract ((Format-StgAuditNetwork -AccountName 'ccoflab4f2kq7xz3m6bwaud' -Mode 'public-disabled') -ceq 'audit archive: ccoflab4f2kq7xz3m6bwaud network public-disabled (policy or private), trusted services allowed') 'Stage 5 must name the public-disabled network mode.'
Assert-Contract ((Format-StgAuditNetwork -AccountName 'ccoflab4f2kq7xz3m6bwaud' -Mode 'public-enabled') -ceq 'audit archive: ccoflab4f2kq7xz3m6bwaud network public-enabled (firewall Deny, no rules), trusted services allowed') 'Stage 5 must name the public-enabled network mode.'
$savedArm = ${function:Get-StgArm}
try {
    $obs = New-Observed; $obs.account.properties.publicNetworkAccess = 'Disabled'
    function Get-StgArm { param([string]$Path, [string]$ApiVersion)
        if ($Path -like '*/managementPolicies/default') { return $obs.policy }
        if ($Path -like '*/immutabilityPolicies/default') { return $obs.immutability[($Path -split '/')[-3]] }
        if ($Path -like '*/diagnosticSettings') { return @{ value = @($obs.diagnostic) } }
        if ($Path -like '*/storageAccounts/*') { return $obs.account }
        return $obs.workspace }
    $read = Test-StgAuditArchive -Cfg @{ subscriptionId = 's'; resourceGroup = 'rg-ccoflab'; audit = @{ workspaceRetentionDays = 365 } } -Deployment $p -Names $names -Apim @{ id = '/apim' }
    Assert-Contract ($read.network -ceq 'public-disabled') "The Stage 5 read-back records the network mode (got $($read.network))."
} finally { ${function:Get-StgArm} = $savedArm }
# Retention null: the rule must be present but disabled; immutability null: policies are not checked.
$keep = [ordered]@{}; foreach ($k in $p.Keys) { $keep[$k] = $p[$k] }; $keep.retentionDays = $null; $keep.immutabilityDays = $null
$o = New-Observed; $o.policy.properties.policy.rules[0].enabled = $false; $o.immutability = @{}
Assert-Contract ((Get-Problems $o $keep).Count -eq 0) 'Keep-forever with no immutability must pass with a disabled rule.'
$o.policy.properties.policy.rules[0].enabled = $true
Assert-Contract ((Get-Problems $o $keep).Count -gt 0) 'Keep-forever must refuse an enabled deletion rule.'
$o = New-Observed; $o.workspace.properties.retentionInDays = 30
Assert-Contract ((Get-Problems $o $p $null).Count -eq 0) 'Without workspaceRetentionDays the workspace retention is not checked.'

# ---------------------------------------------------------------- workspace retention and Stage 5 wiring
$savedAz = ${function:Invoke-StgAzJson}
try {
    $script:azCalls = @()
    function Invoke-StgAzJson { param([string[]]$Arguments) $script:azCalls += , $Arguments; @{ retentionInDays = 365 } }
    $cfgRet = @{ subscriptionId = 's'; resourceGroup = 'rg-ccoflab'; audit = @{ workspaceRetentionDays = 365 } }
    Set-StgWorkspaceRetention -Cfg $cfgRet -Names $names
    Assert-Contract ($script:azCalls.Count -eq 1 -and ($script:azCalls[0] -join ' ') -cmatch 'monitor log-analytics workspace update .*--workspace-name ccoflab-abc-law .*--retention-time 365') "Workspace retention must be set with az monitor log-analytics workspace update (got: $($script:azCalls | ForEach-Object { $_ -join ' ' }))."
    $script:azCalls = @()
    Set-StgWorkspaceRetention -Cfg @{ subscriptionId = 's'; resourceGroup = 'rg' } -Names $names
    Assert-Contract ($script:azCalls.Count -eq 0) 'Without audit.workspaceRetentionDays the workspace is not touched.'
} finally { ${function:Invoke-StgAzJson} = $savedAz }
$stage5 = (Get-Command Invoke-Stage5).ScriptBlock.ToString()
Assert-Contract ($stage5 -match 'Get-StgAuditDeployment' -and $stage5 -match 'auditArchive' -and $stage5 -match 'Format-StgAuditPreview') 'Invoke-Stage5 must pass the archive to the template and print its preview line.'
$applyPart = $stage5.Substring($stage5.IndexOf('if (-not $Apply) { return $null }'))
Assert-Contract ($applyPart -match 'Set-StgWorkspaceRetention' -and $applyPart -match 'Test-StgAuditArchive') 'Invoke-Stage5 must set workspace retention and read back the archive only when applying.'
Assert-Contract ($applyPart -match 'Format-StgAuditNetwork') 'Invoke-Stage5 must print the archive network mode it read back.'

# ---------------------------------------------------------------- retention held from (ADR-0043)
# Raising the workspace retention does not bring back deleted rows: Stage 5 records the oldest instant the workspace
# held when it raised it, and the reports use the later of that and now - retention.
$now = [DateTimeOffset]::Parse('2026-10-10T00:00:00Z')
$held = { param($Current, $Desired, $Previous, $At = $now) Get-StgRetentionHeldFrom -CurrentDays $Current -DesiredDays $Desired -Previous $Previous -Now $At }
Assert-Contract ((& $held 30 90 $null) -ceq '2026-09-10T00:00:00.000Z') 'Raising 30 -> 90 must record now - 30 days.'
Assert-Contract ((& $held 90 180 '2026-09-10T00:00:00.000Z' ([DateTimeOffset]::Parse('2026-11-01T00:00:00Z'))) -ceq '2026-09-10T00:00:00.000Z') 'A second raise must keep the later of the recorded instant and now - the previous retention.'
Assert-Contract ($null -eq (& $held 90 30 $null)) 'Lowering records nothing: the workspace holds now - retention.'
Assert-Contract ((& $held 90 90 '2026-09-10T00:00:00.000Z' ([DateTimeOffset]::Parse('2026-10-20T00:00:00Z'))) -ceq '2026-09-10T00:00:00.000Z') 'Unchanged retention keeps the recorded instant while it is later than now - retention.'
Assert-Contract ($null -eq (& $held 90 90 '2026-09-10T00:00:00.000Z' ([DateTimeOffset]::Parse('2027-01-15T00:00:00Z')))) 'The recorded instant is dropped once now - retention passes it.'
Assert-Contract ((& $held $null 30 '2026-09-20T00:00:00.000Z') -ceq '2026-09-20T00:00:00.000Z') 'Without audit.workspaceRetentionDays Stage 5 does not change retention and keeps the recorded instant.'
$recorded = Join-Path $root '.env.public-test-scratch\stage5.retention.test.json'
New-Item -ItemType Directory -Force -Path (Split-Path $recorded) | Out-Null
@{ days = 90; heldFrom = '2026-09-10T00:00:00.000Z' } | ConvertTo-Json | Set-Content -LiteralPath $recorded -Encoding utf8NoBOM
Assert-Contract ((Get-StgRecordedRetentionHeldFrom $recorded) -ceq '2026-09-10T00:00:00.000Z' -and $null -eq (Get-StgRecordedRetentionHeldFrom ($recorded + '.absent'))) 'The previous instant comes from the file the last Stage 5 apply wrote.'
Remove-Item -LiteralPath $recorded
# Lost state folder (council round 3, R3-4): without evidence/stage5.retention.json the previous instant comes from the
# deployment: the later of the admin app's ADMIN_LOG_RETENTION_HELD_FROM and the workbook's retention cut.
$wbText = '{"items":[{"content":{"query":"let ReportNow = now(); let RetentionCut = max_of(ReportNow - 90 * 1d, datetime(2026-09-12T00:00:00.000Z));"}}]}'
$adminList = @(@{ name = 'ADMIN_WORKSPACE_ID'; value = 'x' }, @{ name = 'ADMIN_LOG_RETENTION_HELD_FROM'; value = '2026-09-10T00:00:00.000Z' })
Assert-Contract ((Get-StgDeployedRetentionHeldFrom -AdminSettings $adminList -WorkbookContent $null) -ceq '2026-09-10T00:00:00.000Z') 'The admin app setting must give the deployed instant.'
Assert-Contract ((Get-StgDeployedRetentionHeldFrom -AdminSettings @() -WorkbookContent $wbText) -ceq '2026-09-12T00:00:00.000Z') 'Without the admin setting the workbook retention cut must give the deployed instant.'
Assert-Contract ((Get-StgDeployedRetentionHeldFrom -AdminSettings $adminList -WorkbookContent $wbText) -ceq '2026-09-12T00:00:00.000Z') 'With both, the later instant must be kept.'
Assert-Contract ($null -eq (Get-StgDeployedRetentionHeldFrom -AdminSettings @(@{ name = 'ADMIN_LOG_RETENTION_DAYS'; value = '90' }) -WorkbookContent '{"q":"ReportNow - 90 * 1d"}')) 'Without either, there is no deployed instant.'
$queriesTs = Get-Content -Raw (Join-Path $root 'analytics\workbooks\queries.ts')
Assert-Contract ($queriesTs.Contains('const cut = `ReportNow - ${answers.retentionDays} * 1d`;') -and $queriesTs.Contains('return `max_of(${cut}, datetime(${answers.retentionHeldFrom}))`;')) 'The workbook retention cut the fallback parses must match queries.ts.'
$script:AzCalls = [Collections.Generic.List[string]]::new()
$script:WorkbookAnswer = { @{ properties = @{ serializedData = $wbText } } }
function Invoke-StgAzJson {
    param([string[]]$Arguments)
    $script:AzCalls.Add($Arguments -join ' ')
    if ($Arguments[0] -ceq 'rest') { return & $script:WorkbookAnswer }
    return $adminList
}
$lostCfg = @{ subscriptionId = 's'; resourceGroup = 'r'; stage1 = @{ includeAdmin = $true }; workbook = @{ resourceName = 'wb' } }
$lostNames = @{ apps = @{ admin = @{ functionApp = 'adm' } } }
Assert-Contract ((Get-StgPreviousRetentionHeldFrom -Cfg $lostCfg -Names $lostNames -Path ($recorded + '.absent')) -ceq '2026-09-12T00:00:00.000Z' -and @($script:AzCalls | Where-Object { $_ -match 'appsettings list .*--name adm' }).Count -eq 1 -and @($script:AzCalls | Where-Object { $_ -match '^rest --method get --url https://management\.azure\.com/subscriptions/s/resourceGroups/r/providers/Microsoft\.Insights/workbooks/wb\?api-version=2023-06-01 --url-parameters canFetchContent=true' -and $_ -notmatch '&' }).Count -eq 1) "Without the evidence file Stage 5 must read the instant back from the admin app and the workbook: $($script:AzCalls -join ' | ')"
@{ days = 90; heldFrom = $null } | ConvertTo-Json | Set-Content -LiteralPath $recorded -Encoding utf8NoBOM
$script:AzCalls.Clear()
Assert-Contract ($null -eq (Get-StgPreviousRetentionHeldFrom -Cfg $lostCfg -Names $lostNames -Path $recorded) -and $script:AzCalls.Count -eq 0) 'With the evidence file, its value is used, even none, and Azure is not read.'
Remove-Item -LiteralPath $recorded
$script:AzCalls.Clear()
$script:WorkbookAnswer = { throw 'ERROR: (ResourceNotFound) The Resource was not found.' }
$noAdmin = @{ subscriptionId = 's'; resourceGroup = 'r'; stage1 = @{ includeAdmin = $false }; workbook = @{ resourceName = 'wb' } }
Assert-Contract ($null -eq (Get-StgPreviousRetentionHeldFrom -Cfg $noAdmin -Names $lostNames -Path ($recorded + '.absent')) -and @($script:AzCalls | Where-Object { $_ -match 'appsettings' }).Count -eq 0) 'Without an admin app and with no workbook yet, there is no previous instant.'
$script:WorkbookAnswer = { throw 'ERROR: (AuthorizationFailed) no access' }
$failed = try { $null = Get-StgPreviousRetentionHeldFrom -Cfg $noAdmin -Names $lostNames -Path ($recorded + '.absent'); '' } catch { $_.Exception.Message }
Assert-Contract ($failed -match 'AuthorizationFailed') 'Any other read failure must stop Stage 5 rather than drop the instant.'
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
$stage5Bicep = Get-Content -Raw (Join-Path $root 'infra\staged\stage5-config.bicep')
Assert-Contract ($stage5Bicep -match "ADMIN_LOG_RETENTION_HELD_FROM: logRetention\.heldFrom") 'Stage 5 must write ADMIN_LOG_RETENTION_HELD_FROM when an instant is recorded.'
$deployPart = $stage5.Substring(0, $stage5.IndexOf('Invoke-StgBicep'))
Assert-Contract ($deployPart -match 'Get-StgRetentionHeldFrom' -and $deployPart -match 'logRetentionHeldFrom' -and $deployPart -match 'logRetention = Get-StgLogRetentionSettings' -and $deployPart -match 'Get-StgPreviousRetentionHeldFrom -Cfg \$Cfg -Names \$s1\.names' -and $deployPart -match 'stage5\.retention\.json' -and $applyPart -match 'logRetention = ') 'Invoke-Stage5 must compute the instant before it deploys the settings, record it before any change, pass it to the admin settings and the workbook, and show it in its verify record.'
$common = (Get-Command Get-StgQuickstartParameters).ScriptBlock.ToString()
Assert-Contract ($common -match 'logRetentionDays = \(Get-StgLogRetentionDays \$Cfg\)') 'The workbook must use the effective retention (audit.workspaceRetentionDays, else stage1.retentionInDays).'
$qs = Get-Content -Raw (Join-Path $root 'infra\quickstart\Deploy-Quickstart.ps1')
Assert-Contract ($qs -match 'retentionHeldFrom') 'The workbook answers must carry retentionHeldFrom when Stage 5 recorded one.'

# Stage 7 and 8 depend on Stage 5's outputs, not its verify record (Get-StgOutputHash). Those outputs do not depend on
# the archive, the workspace retention or chargeback history, so turning them on does not make Stages 7 and 8 rerun.
Assert-Contract ($stage5 -match 'return @\{ gatewayUrl = \$out\.gatewayUrl; settingsWritten = \$out\.settingsWritten; workbookDeployed = \$out\.workbookDeployed; apimIdentityAppId = \$apimSp\.appId; verify = \$v \}') 'Stage 5 must return only the gateway URL, settings list, workbook flag and APIM identity besides its verify record.'
Assert-Contract ($stage5Bicep -match "output settingsWritten array = concat\(\['resolver', 'sync', 'reconciler', 'resolver-auth'\], adminEnabled \? \['admin'\] : \[\]\)") 'The settings list Stage 5 records must depend only on whether the admin app exists.'

"Audit archive: $passed checks passed (validation, names, hash, template, read-back, Stage 5 wiring). No Azure calls."
