# Staged deployment: an existing API Management instance (ADR-0045). Dot-sourced by Invoke-StagedDeployment.ps1.
# Stage 0 checks the instance read-only; Stage 5 sends its gateway logs to CCOF's workspace. CCOF never changes the
# instance's networking, identity, tier, global policy, other APIs or the owner's diagnostic settings.

$script:StgGatewayLogSettingName = 'ccof-gateway-logs'
$script:StgGatewayArchiveSettingName = 'ccof-gateway-archive'
$script:StgGatewayLogCategories = @('GatewayLlmLogs', 'GatewayLogs')
$script:StgApimSupportedSkus = @('BasicV2', 'StandardV2', 'PremiumV2')
$script:StgDiagnosticSettingsLimit = 5

function Test-StgApimExisting {
    # True when the deployment uses apim.existing (Read-StgConfig refuses a new instance together with it).
    param($Cfg)
    return [bool](-not $Cfg.stage1.approveNewPublicApimBootstrap -and $Cfg.apim.existing)
}

function Test-StgPermission {
    # Effective Azure RBAC permission: some entry grants the action and the same entry does not exclude it.
    param($Permissions, [string]$Action)
    $match = { param($pattern) $Action -like $pattern }
    foreach ($p in @($Permissions)) {
        if (@($p.actions | Where-Object { & $match $_ }).Count -and -not @($p.notActions | Where-Object { & $match $_ }).Count) { return $true }
    }
    return $false
}

function Get-StgApimPrivateTargets {
    # What the gateway must reach privately: private Foundry accounts and, with public access off, the Function Apps.
    param($Cfg, $BackendReports = @())
    $targets = [Collections.Generic.List[string]]::new()
    $fd = $Cfg.stage1.foundry
    foreach ($b in @($Cfg.backends)) {
        $createdPrivate = $fd -and $fd.create -and $b.accountName -ceq $fd.accountName -and $fd.publicNetworkAccess -ceq 'Disabled'
        if ($b.privateEndpoint -or $createdPrivate) { $targets.Add("Foundry account $($b.accountName)") }
    }
    foreach ($r in @($BackendReports)) { if ($r.publicNetworkAccess -ceq 'Disabled') { $targets.Add("Foundry account $($r.account)") } }
    if ($Cfg.stage1.functionsPublicNetworkAccess -ceq 'Disabled') { $targets.Add('the Function Apps (resolver)') }
    return @($targets | Select-Object -Unique)
}

function Get-StgApimExistingProblems {
    # Pure: the Stage 0 verdict on an existing instance from its ARM facts (Get-StgApimExistingFacts).
    param($Cfg, $Facts, $BackendReports = @())
    $e = $Cfg.apim.existing
    $where = "API Management $($e.name) in resource group $($e.resourceGroup) (subscription $($e.subscriptionId))"
    $problems = [Collections.Generic.List[string]]::new(); $warnings = [Collections.Generic.List[string]]::new()
    $s = $Facts.service
    if (-not $s) {
        $problems.Add("apim_existing_unreadable: cannot read $where ($($Facts.readError)). Check apim.existing name, subscriptionId and resourceGroup, and ask the instance's owner for Reader on it.")
        return [ordered]@{ problems = @($problems); warnings = @($warnings); globalPolicy = '' }
    }
    if ("$($s.identity.type)" -notmatch 'SystemAssigned') {
        $problems.Add("apim_identity_missing: $($e.name) has no system-assigned managed identity; CCOF calls Foundry and the resolver with it. Ask its owner to turn it on (Portal: the API Management service > Security > Managed identities > System assigned > On) and rerun Stage 0.")
    }
    if ($s.sku.name -notin $script:StgApimSupportedSkus) {
        $problems.Add("apim_existing_sku: $($e.name) is the $($s.sku.name) tier; CCOF needs Basic v2, Standard v2 or Premium v2 (the Anthropic token limits run only in the v2 tiers). Use another instance or set stage1.approveNewPublicApimBootstrap to true.")
    }
    $api = @($Facts.apis | Where-Object { $_.name -ceq $Cfg.apim.apiId })[0]
    if ($api) {
        if ($api.properties.path -ceq $Cfg.apim.apiPath -and $api.properties.displayName -ceq $Cfg.apim.apiDisplayName) {
            $warnings.Add("API $($Cfg.apim.apiId) (path $($Cfg.apim.apiPath)) already exists with CCOF's display name: Stage 5 updates it (a rerun).")
        } else {
            $problems.Add("apim_existing_api_conflict: $($e.name) already has an API $($api.name) (path '$($api.properties.path)', display name '$($api.properties.displayName)') that is not this CCOF API. Set apim.apiId (and apim.apiPath) to unused values.")
        }
    }
    foreach ($other in @($Facts.apis | Where-Object { $_.name -cne $Cfg.apim.apiId -and $_.properties.path -ieq $Cfg.apim.apiPath })) {
        $problems.Add("apim_existing_path_taken: API $($other.name) on $($e.name) already uses path '$($other.properties.path)'. Set apim.apiPath to a path no other API uses.")
    }
    foreach ($b in @($Cfg.backends)) {
        $existing = @($Facts.backends | Where-Object { $_.name -ceq $b.id })[0]
        if ($existing -and $existing.properties.url -cne $b.url) {
            $problems.Add("apim_existing_backend_conflict: $($e.name) already has a backend $($b.id) pointing at $($existing.properties.url); Stage 5 would overwrite it. Rename backends[].id (and the groups' backendId) to an unused name.")
        }
    }
    $ours = @($script:StgGatewayLogSettingName) + $(if (Get-StgAuditArchive $Cfg) { @($script:StgGatewayArchiveSettingName) } else { @() })
    $owner = @($Facts.diagnosticSettings | Where-Object { $_.name -notin @($script:StgGatewayLogSettingName, $script:StgGatewayArchiveSettingName) } | ForEach-Object { $_.name })
    if ($owner.Count + $ours.Count -gt $script:StgDiagnosticSettingsLimit) {
        $problems.Add("apim_existing_diagnostic_settings_full: $($e.name) has $($owner.Count) diagnostic settings ($($owner -join ', ')); Azure allows five per resource and CCOF adds $($ours -join ' and '). Ask its owner to remove one$(if ($ours.Count -gt 1) { ', or set audit.archive.enabled to false' }).")
    }
    $private = @(Get-StgApimPrivateTargets -Cfg $Cfg -BackendReports $BackendReports)
    $vnet = "$($s.properties.virtualNetworkType)"
    if ($private.Count -and $vnet -notin 'External', 'Internal') {
        $problems.Add("apim_existing_no_private_route: $($e.name) has no virtual network, but the gateway must reach $($private -join ', ') privately. CCOF does not change the networking of an existing API Management. Either its owner connects it to a virtual network that reaches these and resolves their private DNS names (Standard v2/Premium v2: outbound virtual network integration), or keep them public (stage1.foundry.publicNetworkAccess Enabled, backends[].privateEndpoint false, stage1.functionsPublicNetworkAccess Enabled).")
    } elseif ($private.Count) {
        $warnings.Add("$($e.name) has a virtual network ($vnet); Stage 0 cannot prove it routes to $($private -join ', ') and resolves their private DNS names. Stage 8 proves it.")
    }
    if ("$($Facts.globalPolicy)".Trim()) {
        $warnings.Add("the global (all APIs) policy of $($e.name) also runs for the CCOF API (its inbound section starts with <base />). Review it below; Stage 5 does not change it.")
    }
    $missing = @()
    if ($Facts.permissions) {
        if (-not (Test-StgPermission $Facts.permissions.apim 'Microsoft.ApiManagement/service/apis/write')) { $missing += 'API Management Service Contributor on the instance (Microsoft.ApiManagement/service/apis/write)' }
        if (-not (Test-StgPermission $Facts.permissions.apim 'Microsoft.Insights/diagnosticSettings/write')) { $missing += 'Monitoring Contributor on the instance (Microsoft.Insights/diagnosticSettings/write)' }
        if (-not (Test-StgPermission $Facts.permissions.resourceGroup 'Microsoft.Resources/deployments/write')) { $missing += "Microsoft.Resources/deployments/write on resource group $($e.resourceGroup)" }
    }
    if ($missing.Count) { $warnings.Add("you cannot run Stage 5 on $($e.name) yet; it needs: $($missing -join '; '). Ask its owner for these, or have them run Stage 5.") }
    return [ordered]@{ problems = @($problems); warnings = @($warnings); globalPolicy = "$($Facts.globalPolicy)" }
}

function Get-StgApimExistingFacts {
    param($Cfg)
    $e = $Cfg.apim.existing
    $id = "/subscriptions/$($e.subscriptionId)/resourceGroups/$($e.resourceGroup)/providers/Microsoft.ApiManagement/service/$($e.name)"
    $facts = [ordered]@{ id = $id }
    try { $facts.service = Get-StgArm $id '2024-05-01' } catch { $facts.service = $null; $facts.readError = "$($_.Exception.Message)".Trim(); return $facts }
    $facts.apis = @((Get-StgArm "$id/apis" '2024-05-01').value)
    $facts.backends = @((Get-StgArm "$id/backends" '2024-05-01').value)
    $facts.diagnosticSettings = @((Get-StgArm "$id/providers/Microsoft.Insights/diagnosticSettings" '2021-05-01-preview').value)
    # No global policy: APIM answers 404 PoliciesConfiguration not found.
    $facts.globalPolicy = try { [string](Get-StgArm "$id/policies/policy" '2024-05-01').properties.value } catch { if ("$_" -match 'NotFound') { '' } else { throw } }
    $facts.permissions = @{
        apim = @((Get-StgArm "$id/providers/Microsoft.Authorization/permissions" '2022-04-01').value)
        resourceGroup = @((Get-StgArm "/subscriptions/$($e.subscriptionId)/resourceGroups/$($e.resourceGroup)/providers/Microsoft.Authorization/permissions" '2022-04-01').value)
    }
    return $facts
}

function Invoke-StgApimExistingCheck {
    # Stage 0: prints warnings and the global policy, refuses on problems, returns the report for stage0.json.
    param($Cfg, $BackendReports = @())
    $facts = Get-StgApimExistingFacts $Cfg
    $verdict = Get-StgApimExistingProblems -Cfg $Cfg -Facts $facts -BackendReports $BackendReports
    foreach ($w in $verdict.warnings) { Write-Host "WARNING: $w" -ForegroundColor Yellow }
    if ($verdict.globalPolicy.Trim()) { Write-Host "global policy of $($Cfg.apim.existing.name):`n$($verdict.globalPolicy)" }
    if (@($verdict.problems).Count) { throw "the existing API Management cannot be used yet:`n  - $(@($verdict.problems) -join "`n  - ")" }
    $s = $facts.service
    Write-Host "existing API Management $($s.name): $($s.sku.name), system-assigned identity on, $(@($facts.apis).Count) APIs, $(@($facts.diagnosticSettings).Count) diagnostic settings; CCOF adds API $($Cfg.apim.apiId) at /$($Cfg.apim.apiPath)"
    return [ordered]@{ id = $facts.id; sku = $s.sku.name; location = $s.location; virtualNetworkType = "$($s.properties.virtualNetworkType)"
        apis = @($facts.apis | ForEach-Object { $_.name }); diagnosticSettings = @($facts.diagnosticSettings | ForEach-Object { $_.name })
        # A policy may hold an inline secret: the state folder keeps its hash, the console shows the text.
        globalPolicySha256 = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($verdict.globalPolicy))) -Algorithm SHA256).Hash.ToLowerInvariant()
        globalPolicyLength = $verdict.globalPolicy.Length; warnings = @($verdict.warnings) }
}

function Get-StgGatewayLogCategories {
    # The enabled log categories of a diagnostic setting; the allLogs group covers both gateway categories.
    param($Setting)
    $logs = @($Setting.properties.logs | Where-Object { $_.enabled -eq $true })
    if (@($logs | Where-Object { $_.categoryGroup -ieq 'allLogs' }).Count) { return $script:StgGatewayLogCategories }
    return @($logs | ForEach-Object { "$($_.category)" } | Where-Object { $_ -in $script:StgGatewayLogCategories } | Sort-Object -Unique)
}

function Test-StgGatewayLogSuitable { param($Setting) ($Setting.properties.logAnalyticsDestinationType -ceq 'Dedicated') -and (@(Get-StgGatewayLogCategories $Setting).Count -eq $script:StgGatewayLogCategories.Count) }

function Get-StgGatewayLogPlan {
    # Stage 5, existing instance: create ccof-gateway-logs, reuse an equivalent setting, or refuse a conflicting one.
    param($Settings, [string]$WorkspaceId)
    $toWorkspace = @($Settings | Where-Object { $_.name -cne $script:StgGatewayLogSettingName -and "$($_.properties.workspaceId)" -ieq $WorkspaceId })
    $reuse = @($toWorkspace | Where-Object { Test-StgGatewayLogSuitable $_ })[0]
    if ($reuse) { return [ordered]@{ action = 'reuse'; name = $reuse.name } }
    $conflict = @($toWorkspace | Where-Object { @(Get-StgGatewayLogCategories $_).Count })[0]
    if ($conflict) {
        return [ordered]@{ action = 'refuse'; name = $conflict.name; message = "apim_gateway_logs_conflict: diagnostic setting $($conflict.name) already sends gateway logs to CCOF's workspace, but not both GatewayLogs and GatewayLlmLogs in resource-specific mode, which CCOF reads; Azure refuses the same category to the same workspace twice. Ask the instance's owner to change it to resource-specific with both categories, or to remove it, and rerun Stage 5." }
    }
    return [ordered]@{ action = 'create'; name = $script:StgGatewayLogSettingName }
}

function Test-StgGatewayLogSetting {
    # Stage 5 read-back: the named setting sends both categories to CCOF's workspace, resource-specific.
    param($Settings, [string]$WorkspaceId, [string]$Name)
    $s = @($Settings | Where-Object { $_.name -ceq $Name })[0]
    Assert-Stg ([bool]$s) "diagnostic setting $Name is missing on the API Management instance"
    Assert-Stg ("$($s.properties.workspaceId)" -ieq $WorkspaceId) "diagnostic setting $Name sends to $($s.properties.workspaceId), not CCOF's workspace"
    $categories = @(Get-StgGatewayLogCategories $s)
    Assert-Stg ((Test-StgGatewayLogSuitable $s)) "diagnostic setting $Name must send GatewayLogs and GatewayLlmLogs resource-specific; it sends $($categories -join ', ') ($($s.properties.logAnalyticsDestinationType))"
    return [ordered]@{ name = $Name; workspace = ($WorkspaceId -split '/')[-1]; categories = $categories; destinationType = 'Dedicated' }
}

function Get-StgStage5ApimInput {
    # Stage 5 parameters for an existing instance: the gateway-log setting to create (or none) and the logger choice.
    param($Cfg, $Stage1, $Apim)
    if (-not (Test-StgApimExisting $Cfg)) { return [ordered]@{ gatewayLogs = @{}; reuseMonitorLogger = $false; plan = $null } }
    $settings = @((Get-StgArm "$($Apim.id)/providers/Microsoft.Insights/diagnosticSettings" '2021-05-01-preview').value)
    $plan = Get-StgGatewayLogPlan -Settings $settings -WorkspaceId $Stage1.workspaceId
    if ($plan.action -ceq 'refuse') { throw $plan.message }
    $workspace = ($Stage1.workspaceId -split '/')[-1]
    if ($plan.action -ceq 'reuse') { Write-Host "gateway logs: reusing diagnostic setting $($plan.name) on $($Apim.name), which already sends GatewayLogs and GatewayLlmLogs to $workspace" }
    else { Write-Host "gateway logs: diagnostic setting $($plan.name) on $($Apim.name) sends GatewayLogs and GatewayLlmLogs to $workspace (resource-specific); the owner's other settings are not changed" }
    $logger = try { Get-StgArm "$($Apim.id)/loggers/azuremonitor" '2024-05-01' } catch { if ("$_" -match 'NotFound') { $null } else { throw } }
    return [ordered]@{ gatewayLogs = $(if ($plan.action -ceq 'create') { @{ name = $plan.name; workspaceId = $Stage1.workspaceId } } else { @{} }); reuseMonitorLogger = [bool]$logger; plan = $plan }
}

function Test-StgStage5ApimExisting {
    # Stage 5 read-back for an existing instance: the gateway-log setting sends both categories to CCOF's workspace.
    param($Cfg, $Stage1, $Apim, $Plan)
    if (-not $Plan) { return $null }
    $settings = @((Get-StgArm "$($Apim.id)/providers/Microsoft.Insights/diagnosticSettings" '2021-05-01-preview').value)
    $v = Test-StgGatewayLogSetting -Settings $settings -WorkspaceId $Stage1.workspaceId -Name $Plan.name
    $v.reused = ($Plan.action -ceq 'reuse')
    $v.ownerSettings = @($settings | Where-Object { $_.name -notin @($script:StgGatewayLogSettingName, $script:StgGatewayArchiveSettingName, $Plan.name) } | ForEach-Object { $_.name })
    Write-Host "gateway logs: $($v.name) on $($Apim.name) verified: $($v.categories -join ', ') to $($v.workspace) (resource-specific)"
    return $v
}
