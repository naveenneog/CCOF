#Requires -Version 7.0
<#
.SYNOPSIS
    Offline tests for deploying into an existing API Management instance (ADR-0045): the configuration rules, the
    Stage 0 checks of the instance, the Stage 5 gateway-log diagnostic setting plan and its templates. No Azure call:
    the instance's facts are ARM-shaped fixtures and Bicep compiles locally.
#>
[CmdletBinding()]
param([string]$BicepPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $BicepPath) {
    $command = Get-Command bicep -ErrorAction SilentlyContinue
    if ($command) { $BicepPath = $command.Source }
    elseif (Test-Path (Join-Path $HOME '.azure\bin\bicep.exe')) { $BicepPath = Join-Path $HOME '.azure\bin\bicep.exe' }
    elseif (Test-Path (Join-Path $HOME '.azure/bin/bicep')) { $BicepPath = Join-Path $HOME '.azure/bin/bicep' }
    else { throw 'Offline Bicep CLI required. Supply -BicepPath; this test does not install tools or call Azure.' }
}
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:passed++ }
function Build-Arm([string]$Relative) {
    $out = & $BicepPath build (Join-Path $root $Relative) --stdout 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Bicep compilation failed: $Relative" }
    return ($out -join "`n") | ConvertFrom-Json -AsHashtable -Depth 100
}

. (Join-Path $root 'infra/staged/Invoke-StagedDeployment.ps1') -DotSourceOnly

$sub = '00000000-0000-4000-8000-000000000002'
$apimId = "/subscriptions/$sub/resourceGroups/shared-apim-rg/providers/Microsoft.ApiManagement/service/contoso-apim"
$ws = "/subscriptions/$sub/resourceGroups/rg-new/providers/Microsoft.OperationalInsights/workspaces/ccof-law"

# ---------------------------------------------------------------- configuration
$example = Join-Path $root 'infra/staged/staged.config.example.json'
$tmp = Join-Path ([IO.Path]::GetTempPath()) "staged-apim-$([guid]::NewGuid().ToString('N')).json"
function New-ValidConfig {
    $c = Get-Content -LiteralPath $example -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    $c.tenantId = '00000000-0000-4000-8000-000000000001'; $c.subscriptionId = $sub; $c.resourceGroup = 'rg-new'
    $vnet = "/subscriptions/$sub/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet/subnets"
    $c.network.existing = @{ functionsSubnetId = "$vnet/functions"; privateEndpointSubnetId = "$vnet/private"; apimSubnetId = "$vnet/apim" }
    $c.apim.existing = @{ name = 'contoso-apim'; subscriptionId = $sub; resourceGroup = 'shared-apim-rg' }
    return $c
}
function Get-ConfigError($c) {
    $c | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
    try { $null = Read-StgConfig $tmp; return '' } catch { return $_.Exception.Message }
}
try {
    Assert-Contract ((Get-ConfigError (New-ValidConfig)) -eq '') "A configuration naming only an existing API Management must be accepted: $(Get-ConfigError (New-ValidConfig))"
    $c = New-ValidConfig; $c.stage1.approveNewPublicApimBootstrap = $true; $c.stage1.apimPublisherEmail = 'ops@contoso.com'; $c.stage1.apimPublisherName = 'Contoso'
    $m = Get-ConfigError $c
    Assert-Contract ($m -match 'both' -and $m -match 'apim\.existing' -and $m -match 'approveNewPublicApimBootstrap') "A new API Management together with apim.existing must be refused (Stage 1 would ignore the existing one): $m"
    $c = New-ValidConfig; $c.apim.existing.subscriptionId = 'contoso-sub'
    $m = Get-ConfigError $c
    Assert-Contract ($m -match 'apim\.existing\.subscriptionId must be a GUID') "A non-GUID apim.existing.subscriptionId must be refused: $m"
} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------- Stage 0: checks of the existing instance
$cfg = New-ValidConfig
$cfg.backends = @(@{ id = 'foundry-eastus2'; subscriptionId = $sub; resourceGroup = 'rg-new'; accountName = 'ccoffoundry'; url = 'https://ccoffoundry.services.ai.azure.com/anthropic'; privateEndpoint = $false })
$cfg.stage1.foundry = @{ create = $true; accountName = 'ccoffoundry'; publicNetworkAccess = 'Enabled' }
$cfg.stage1.functionsPublicNetworkAccess = 'Enabled'
$cfg.audit = @{}
function New-Facts {
    [ordered]@{
        service = @{ id = $apimId; name = 'contoso-apim'; location = 'eastus2'; sku = @{ name = 'StandardV2'; capacity = 1 }
            identity = @{ type = 'SystemAssigned'; principalId = '00000000-0000-4000-8000-0000000000aa' }
            properties = @{ virtualNetworkType = 'None'; gatewayUrl = 'https://contoso-apim.azure-api.net' } }
        apis = @(@{ name = 'contoso-orders'; properties = @{ path = 'orders'; displayName = 'Contoso Orders' } })
        backends = @()
        diagnosticSettings = @(@{ name = 'contoso-own-logs'; properties = @{ workspaceId = '/subscriptions/x/resourceGroups/y/providers/Microsoft.OperationalInsights/workspaces/own'; logs = @(@{ categoryGroup = 'allLogs'; enabled = $true }) } })
        globalPolicy = '<policies><inbound><set-header name="X-Contoso" exists-action="override"><value>1</value></set-header></inbound><backend><forward-request /></backend><outbound /><on-error /></policies>'
        permissions = @{ apim = @(@{ actions = @('*'); notActions = @() }); resourceGroup = @(@{ actions = @('*'); notActions = @() }) }
    }
}
function Get-Check($Facts, $Config = $cfg) { Get-StgApimExistingProblems -Cfg $Config -Facts $Facts }

$r = Get-Check (New-Facts)
Assert-Contract (@($r.problems).Count -eq 0) "A suitable existing instance must pass Stage 0: $(@($r.problems) -join '; ')"
Assert-Contract (@($r.warnings | Where-Object { $_ -match 'global' -and $_ -match 'not change' }).Count -eq 1) "A global policy must be reported for review and left unchanged: $(@($r.warnings) -join '; ')"
Assert-Contract ($r.globalPolicy -match 'X-Contoso') 'Stage 0 must return the global policy text so it is printed for review.'

$f = New-Facts; $f.service = $null; $f.readError = 'ResourceNotFound'
$r = Get-Check $f
Assert-Contract (@($r.problems | Where-Object { $_ -match '^apim_existing_unreadable' -and $_ -match 'contoso-apim' -and $_ -match 'shared-apim-rg' -and $_ -match 'Reader' }).Count -eq 1) "An unreadable instance must be refused with its name, resource group and the Reader next step: $(@($r.problems) -join '; ')"

$f = New-Facts; $f.service.identity = @{ type = 'None' }
$r = Get-Check $f
Assert-Contract (@($r.problems | Where-Object { $_ -match '^apim_identity_missing' -and $_ -match 'Managed identities' }).Count -eq 1) "An instance without a system-assigned identity must be refused with the Portal next step: $(@($r.problems) -join '; ')"
$f = New-Facts; $f.service.identity = @{ type = 'UserAssigned' }
Assert-Contract (@((Get-Check $f).problems | Where-Object { $_ -match '^apim_identity_missing' }).Count -eq 1) 'A user-assigned identity alone must be refused: CCOF uses the system-assigned identity.'
$f = New-Facts; $f.service.identity = @{ type = 'SystemAssigned, UserAssigned'; principalId = '00000000-0000-4000-8000-0000000000aa' }
Assert-Contract (@((Get-Check $f).problems).Count -eq 0) 'System-assigned plus user-assigned identities must pass.'

foreach ($sku in 'Developer', 'Basic', 'Standard', 'Premium', 'Consumption') {
    $f = New-Facts; $f.service.sku.name = $sku
    Assert-Contract (@((Get-Check $f).problems | Where-Object { $_ -match '^apim_existing_sku' -and $_ -match $sku -and $_ -match 'Standard v2' }).Count -eq 1) "Tier $sku must be refused (Anthropic token limits run only in the v2 tiers)."
}
foreach ($sku in 'BasicV2', 'StandardV2', 'PremiumV2') {
    $f = New-Facts; $f.service.sku.name = $sku
    Assert-Contract (@((Get-Check $f).problems).Count -eq 0) "Tier $sku must be accepted."
}

$f = New-Facts; $f.apis += @{ name = 'orders-v2'; properties = @{ path = 'anthropic'; displayName = 'Orders v2' } }
Assert-Contract (@((Get-Check $f).problems | Where-Object { $_ -match '^apim_existing_path_taken' -and $_ -match 'orders-v2' -and $_ -match 'apim\.apiPath' }).Count -eq 1) 'Another API on apim.apiPath must be refused, naming it and the setting to change.'
$f = New-Facts; $f.apis += @{ name = 'claude-messages'; properties = @{ path = 'claude'; displayName = 'Claude Messages (staged)' } }
Assert-Contract (@((Get-Check $f).problems | Where-Object { $_ -match '^apim_existing_api_conflict' -and $_ -match 'apim\.apiId' }).Count -eq 1) 'An API with apim.apiId on another path must be refused.'
$f = New-Facts; $f.apis += @{ name = 'claude-messages'; properties = @{ path = 'anthropic'; displayName = 'Someone else''s API' } }
Assert-Contract (@((Get-Check $f).problems | Where-Object { $_ -match '^apim_existing_api_conflict' }).Count -eq 1) 'An API with apim.apiId and path but another display name is not CCOF''s and must be refused.'
$f = New-Facts; $f.apis += @{ name = 'claude-messages'; properties = @{ path = 'anthropic'; displayName = 'Claude Messages (staged)' } }
$r = Get-Check $f
Assert-Contract (@($r.problems).Count -eq 0 -and @($r.warnings | Where-Object { $_ -match 'claude-messages' -and $_ -match 'rerun' }).Count -eq 1) "CCOF's own API (same ID, path and display name) is a rerun: a warning, not a refusal: $(@($r.problems) -join '; ')"

$f = New-Facts; $f.backends = @(@{ name = 'foundry-eastus2'; properties = @{ url = 'https://other.example/anthropic' } })
Assert-Contract (@((Get-Check $f).problems | Where-Object { $_ -match '^apim_existing_backend_conflict' -and $_ -match 'foundry-eastus2' -and $_ -match 'backends\[\]\.id' }).Count -eq 1) 'A backend with the same name and another URL must be refused (Stage 5 would overwrite it).'
$f = New-Facts; $f.backends = @(@{ name = 'foundry-eastus2'; properties = @{ url = 'https://ccoffoundry.services.ai.azure.com/anthropic' } })
Assert-Contract (@((Get-Check $f).problems).Count -eq 0) 'A backend already pointing at the same URL (a rerun) must pass.'

$own = { param($n) @{ name = $n; properties = @{ workspaceId = '/subscriptions/x/resourceGroups/y/providers/Microsoft.OperationalInsights/workspaces/own'; logs = @(@{ category = 'GatewayLogs'; enabled = $true }) } } }
$f = New-Facts; $f.diagnosticSettings = @(1..4 | ForEach-Object { & $own "owner-$_" })
Assert-Contract (@((Get-Check $f).problems).Count -eq 0) 'Four owner settings leave room for ccof-gateway-logs (five per resource).'
$f = New-Facts; $f.diagnosticSettings = @(1..5 | ForEach-Object { & $own "owner-$_" })
Assert-Contract (@((Get-Check $f).problems | Where-Object { $_ -match '^apim_existing_diagnostic_settings_full' -and $_ -match 'owner-1' -and $_ -match 'five' }).Count -eq 1) 'Five owner settings must be refused, naming them.'
$withArchive = New-ValidConfig; foreach ($k in 'backends', 'stage1') { $withArchive[$k] = $cfg[$k] }; $withArchive.audit = @{ archive = @{ enabled = $true } }
$f = New-Facts; $f.diagnosticSettings = @(1..4 | ForEach-Object { & $own "owner-$_" })
Assert-Contract (@((Get-Check $f $withArchive).problems | Where-Object { $_ -match '^apim_existing_diagnostic_settings_full' -and $_ -match 'ccof-gateway-archive' }).Count -eq 1) 'With audit.archive, four owner settings leave no room for both CCOF settings.'
$f = New-Facts; $f.diagnosticSettings = @((1..3 | ForEach-Object { & $own "owner-$_" }) + @(& $own 'ccof-gateway-logs') + @(& $own 'ccof-gateway-archive'))
Assert-Contract (@((Get-Check $f $withArchive).problems).Count -eq 0) 'CCOF''s own settings (a rerun) count as already present, not as extra.'

# Network: a private backend or private Function Apps need the owner's route; CCOF does not change the instance.
$private = New-ValidConfig; foreach ($k in 'backends', 'stage1', 'audit') { $private[$k] = ConvertTo-Json -InputObject $cfg[$k] -Depth 20 | ConvertFrom-Json -AsHashtable -NoEnumerate }
$private.stage1.foundry.publicNetworkAccess = 'Disabled'
$r = Get-Check (New-Facts) $private
Assert-Contract (@($r.problems | Where-Object { $_ -match '^apim_existing_no_private_route' -and $_ -match 'ccoffoundry' -and $_ -match 'does not change' }).Count -eq 1) "A private Foundry with an instance without a virtual network must be refused: $(@($r.problems) -join '; ')"
$private = New-ValidConfig; foreach ($k in 'backends', 'stage1', 'audit') { $private[$k] = ConvertTo-Json -InputObject $cfg[$k] -Depth 20 | ConvertFrom-Json -AsHashtable -NoEnumerate }
$private.backends[0].privateEndpoint = $true
Assert-Contract (@((Get-Check (New-Facts) $private).problems | Where-Object { $_ -match '^apim_existing_no_private_route' }).Count -eq 1) 'A backend with privateEndpoint must be treated as private.'
$private = New-ValidConfig; foreach ($k in 'backends', 'stage1', 'audit') { $private[$k] = ConvertTo-Json -InputObject $cfg[$k] -Depth 20 | ConvertFrom-Json -AsHashtable -NoEnumerate }
$private.stage1.functionsPublicNetworkAccess = 'Disabled'
Assert-Contract (@((Get-Check (New-Facts) $private).problems | Where-Object { $_ -match '^apim_existing_no_private_route' -and $_ -match 'Function Apps' }).Count -eq 1) 'Private Function Apps (the resolver) must be treated as private.'
$f = New-Facts; $f.service.properties.virtualNetworkType = 'External'
$r = Get-Check $f $private
Assert-Contract (@($r.problems).Count -eq 0 -and @($r.warnings | Where-Object { $_ -match 'Stage 8' -and $_ -match 'External' }).Count -eq 1) 'With a virtual network Stage 0 warns that Stage 8 proves the route.'
$r = Get-StgApimExistingProblems -Cfg $cfg -Facts (New-Facts) -BackendReports @(@{ id = 'foundry-other'; account = 'other'; publicNetworkAccess = 'Disabled' })
Assert-Contract (@($r.problems | Where-Object { $_ -match '^apim_existing_no_private_route' -and $_ -match 'other' }).Count -eq 1) 'An existing Foundry account with public access Disabled (read by Stage 0) must be treated as private.'

# Permissions: warnings naming the roles, never refusals.
$f = New-Facts; $f.permissions = @{ apim = @(@{ actions = @('*/read'); notActions = @() }); resourceGroup = @(@{ actions = @('*/read'); notActions = @() }) }
$r = Get-Check $f
Assert-Contract (@($r.problems).Count -eq 0) 'Missing permissions must not refuse Stage 0 (another person may run Stage 5).'
Assert-Contract (@($r.warnings | Where-Object { $_ -match 'API Management Service Contributor' -and $_ -match 'Monitoring Contributor' -and $_ -match 'deployments/write' }).Count -eq 1) "Missing permissions must be named with the roles: $(@($r.warnings) -join '; ')"
$f = New-Facts; $f.permissions = @{ apim = @(@{ actions = @('Microsoft.ApiManagement/service/*', 'Microsoft.Insights/DiagnosticSettings/*'); notActions = @() }); resourceGroup = @(@{ actions = @('Microsoft.Resources/deployments/*'); notActions = @() }) }
Assert-Contract (@((Get-Check $f).warnings | Where-Object { $_ -match 'Contributor' }).Count -eq 0) 'Wildcard grants (case-insensitive) must satisfy the permission check.'
$f = New-Facts; $f.permissions = @{ apim = @(@{ actions = @('*'); notActions = @('Microsoft.Insights/diagnosticSettings/write') }); resourceGroup = @(@{ actions = @('*'); notActions = @() }) }
Assert-Contract (@((Get-Check $f).warnings | Where-Object { $_ -match 'Monitoring Contributor' }).Count -eq 1) 'notActions must remove a permission.'

# The Stage 0 report (stage0.json) keeps a hash of the global policy, not its text: a policy may hold an inline secret.
# The text is printed for the operator, who can read it in the Portal with Reader anyway.
function Get-StgApimExistingFacts { param($Cfg) $script:fakeFacts }
$script:fakeFacts = New-Facts; $script:fakeFacts.globalPolicy = '<policies><inbound><set-header name="x-key"><value>inline-secret-value</value></set-header></inbound></policies>'
$report = Invoke-StgApimExistingCheck -Cfg $cfg 6>$null
$json = $report | ConvertTo-Json -Depth 10
Assert-Contract (-not $json.Contains('inline-secret-value')) 'stage0.json must not hold the global policy text.'
Assert-Contract ($report.globalPolicySha256 -match '^[0-9a-f]{64}$' -and $report.globalPolicyLength -eq $script:fakeFacts.globalPolicy.Length) 'stage0.json records the global policy''s SHA-256 and length, so a later change is visible.'
$script:fakeFacts = New-Facts; $script:fakeFacts.service.identity = @{ type = 'None' }
$bad = $false; try { $null = Invoke-StgApimExistingCheck -Cfg $cfg 6>$null } catch { $bad = $_.Exception.Message -match 'apim_identity_missing' }
Assert-Contract $bad 'Stage 0 throws the problems it found.'
Remove-Item Function:\Get-StgApimExistingFacts

# ---------------------------------------------------------------- Stage 5: gateway logs to CCOF's workspace
$suitable = @{ name = 'platform-to-ccof'; properties = @{ workspaceId = $ws.ToUpperInvariant(); logAnalyticsDestinationType = 'Dedicated'; logs = @(@{ category = 'GatewayLogs'; enabled = $true }, @{ category = 'GatewayLlmLogs'; enabled = $true }) } }
$plan = Get-StgGatewayLogPlan -Settings @() -WorkspaceId $ws
Assert-Contract ($plan.action -ceq 'create' -and $plan.name -ceq 'ccof-gateway-logs') 'Without a suitable setting Stage 5 creates ccof-gateway-logs.'
$plan = Get-StgGatewayLogPlan -Settings @((& $own 'contoso-own-logs'), $suitable) -WorkspaceId $ws
Assert-Contract ($plan.action -ceq 'reuse' -and $plan.name -ceq 'platform-to-ccof') 'A setting sending both categories to the CCOF workspace in resource-specific mode is reused (Azure refuses a duplicate).'
$allLogs = @{ name = 'all-to-ccof'; properties = @{ workspaceId = $ws; logAnalyticsDestinationType = 'Dedicated'; logs = @(@{ categoryGroup = 'allLogs'; enabled = $true }) } }
Assert-Contract ((Get-StgGatewayLogPlan -Settings @($allLogs) -WorkspaceId $ws).action -ceq 'reuse') 'The allLogs category group covers both categories.'
$azureDiag = @{ name = 'legacy-to-ccof'; properties = @{ workspaceId = $ws; logs = @(@{ category = 'GatewayLogs'; enabled = $true }, @{ category = 'GatewayLlmLogs'; enabled = $true }) } }
$plan = Get-StgGatewayLogPlan -Settings @($azureDiag) -WorkspaceId $ws
Assert-Contract ($plan.action -ceq 'refuse' -and $plan.message -match '^apim_gateway_logs_conflict' -and $plan.message -match 'legacy-to-ccof' -and $plan.message -match 'resource-specific') 'A setting sending the categories to the CCOF workspace in AzureDiagnostics mode must be refused, naming it.'
$partial = @{ name = 'llm-only'; properties = @{ workspaceId = $ws; logAnalyticsDestinationType = 'Dedicated'; logs = @(@{ category = 'GatewayLlmLogs'; enabled = $true }, @{ category = 'GatewayLogs'; enabled = $false }) } }
Assert-Contract ((Get-StgGatewayLogPlan -Settings @($partial) -WorkspaceId $ws).action -ceq 'refuse') 'A setting sending only one category to the CCOF workspace must be refused.'
$otherWs = @{ name = 'contoso'; properties = @{ workspaceId = '/subscriptions/x/resourceGroups/y/providers/Microsoft.OperationalInsights/workspaces/ccof-law-2'; logAnalyticsDestinationType = 'Dedicated'; logs = @(@{ categoryGroup = 'allLogs'; enabled = $true }) } }
Assert-Contract ((Get-StgGatewayLogPlan -Settings @($otherWs) -WorkspaceId $ws).action -ceq 'create') 'A setting to another workspace (even with a similar name) is not CCOF''s.'
$ours = @{ name = 'ccof-gateway-logs'; properties = @{ workspaceId = $ws; logAnalyticsDestinationType = 'Dedicated'; logs = @(@{ category = 'GatewayLogs'; enabled = $true }, @{ category = 'GatewayLlmLogs'; enabled = $true }) } }
$plan = Get-StgGatewayLogPlan -Settings @($ours) -WorkspaceId $ws
Assert-Contract ($plan.action -ceq 'create' -and $plan.name -ceq 'ccof-gateway-logs') 'CCOF''s own setting is redeployed (idempotent), not treated as someone else''s.'

$v = Test-StgGatewayLogSetting -Settings @($ours) -WorkspaceId $ws -Name 'ccof-gateway-logs'
Assert-Contract ($v.name -ceq 'ccof-gateway-logs' -and ($v.categories -join ',') -ceq 'GatewayLlmLogs,GatewayLogs' -and $v.destinationType -ceq 'Dedicated') 'The read-back records the setting, its categories and destination type.'
$bad = $false; try { $null = Test-StgGatewayLogSetting -Settings @($partial) -WorkspaceId $ws -Name 'llm-only' } catch { $bad = $_.Exception.Message -match 'GatewayLogs' }
Assert-Contract $bad 'The read-back must fail when the setting lacks a category.'
$bad = $false; try { $null = Test-StgGatewayLogSetting -Settings @() -WorkspaceId $ws -Name 'ccof-gateway-logs' } catch { $bad = $_.Exception.Message -match 'ccof-gateway-logs is missing' }
Assert-Contract $bad 'The read-back must fail when the setting is missing.'

# ---------------------------------------------------------------- templates
$logs = Build-Arm 'infra/staged/stage5-gateway-logs.bicep'
$setting = @($logs.resources.Values + $logs.resources | Where-Object { $_ -is [Collections.IDictionary] -and $_.type -ceq 'Microsoft.Insights/diagnosticSettings' })[0]
Assert-Contract ($null -ne $setting -and $setting.properties.logAnalyticsDestinationType -ceq 'Dedicated') 'stage5-gateway-logs.bicep declares a resource-specific diagnostic setting.'
Assert-Contract ((@($setting.properties.logs | ForEach-Object { $_.category }) -join ',') -ceq 'GatewayLogs,GatewayLlmLogs') 'The setting sends exactly GatewayLogs and GatewayLlmLogs.'
$tel = Build-Arm 'infra/staged/stage5-api-telemetry.bicep'
Assert-Contract ($tel.parameters.ContainsKey('reuseLogger')) 'stage5-api-telemetry.bicep takes reuseLogger, so an existing instance''s azuremonitor logger is referenced, not rewritten.'
$config = Build-Arm 'infra/staged/stage5-config.bicep'
Assert-Contract ($config.parameters.ContainsKey('gatewayLogs') -and $config.parameters.gatewayLogs.defaultValue.Count -eq 0) 'stage5-config.bicep takes gatewayLogs (default empty: a CCOF-created instance keeps Stage 1''s setting).'
$text = Get-Content -LiteralPath (Join-Path $root 'infra/staged/stage5-config.bicep') -Raw
Assert-Contract ($text -match "module gatewayLogsSetting 'stage5-gateway-logs\.bicep' = if \(!empty\(gatewayLogs\)\)" -and $text -match 'scope: resourceGroup\(apim\.subscriptionId, apim\.resourceGroup\)') 'The gateway-log setting is deployed only when requested, in the instance''s resource group.'

# Stage 6 never changes an existing instance.
$resources = Get-Content -LiteralPath (Join-Path $root 'infra/staged/Staged.Resources.ps1') -Raw
Assert-Contract ($resources -match '\$integrateApim = \$s1\.apimName -and') 'Stage 6 integrates only an instance Stage 1 created.'
Assert-Contract ([regex]::Matches($resources, 'Write-Host "API Management \$\(\$Cfg\.apim\.existing\.name\) \(apim\.existing\) is not changed: CCOF does not change the networking of an existing API Management\."').Count -eq 2) 'Both Stage 6 previews (network mode verify, and existing/create) say an existing instance is not changed.'

Write-Host "PASS: $passed existing API Management contract checks"
