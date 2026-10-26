# Staged deployment: stage 5 (Entra registrations and groups through Microsoft Graph). Dot-sourced by Invoke-StagedDeployment.ps1; not run directly.

# ---------------------------------------------------------------- stage 5: Entra

function Get-StgApp { param([string]$DisplayName)
    # No `$select: az.cmd passes arguments through cmd.exe, which would treat & as a separator.
    $found = @((Get-StgGraph "applications?`$filter=displayName eq '$DisplayName'").value)
    if ($found.Count -gt 1) { throw "entra_ambiguous: $($found.Count) applications are named '$DisplayName'." }
    return $found | Select-Object -First 1
}
function Get-StgAppById { param([string]$AppId)
    $found = @((Get-StgGraph "applications?`$filter=appId eq '$AppId'").value)
    if ($found.Count -ne 1) { throw "entra_app_not_found: no application with appId $AppId is readable by the operator." }
    return $found[0]
}
function Resolve-StgApp {
    # entra.existing.<kind>AppId reuses a registration (changes are merged, never replaced); otherwise
    # the display name is looked up and created when absent.
    param($Cfg, [string]$Kind, [switch]$Apply)
    $id = ($Cfg.entra.existing ?? @{})["${Kind}AppId"]
    if ($id) { $a = Get-StgAppById $id; Write-Host "reuse existing $Kind application '$($a.displayName)' ($($a.appId))"; return $a }
    return New-StgApp $Cfg.entra["${Kind}AppDisplayName"] -Apply:$Apply
}
# The leading comma keeps a one-item list an array (PowerShell unrolls function output); Graph needs arrays.
function Join-StgUnique { param([object[]]$Current, [object[]]$Add) return , @(@($Current) + @($Add) | Where-Object { $_ } | Select-Object -Unique) }
function Merge-StgPreauthorized {
    # Keeps every other client's entry; adds the scope to each listed client.
    param($App, [string[]]$ClientIds, [string]$ScopeId)
    $list = [Collections.Generic.List[object]]::new()
    foreach ($p in @($App.api.preAuthorizedApplications)) { if ($p) { $list.Add(@{ appId = $p.appId; delegatedPermissionIds = @($p.delegatedPermissionIds) }) } }
    foreach ($cid in $ClientIds) {
        $e = @($list | Where-Object { $_.appId -ieq $cid })[0]
        if ($e) { $e.delegatedPermissionIds = Join-StgUnique $e.delegatedPermissionIds @($ScopeId) } else { $list.Add(@{ appId = $cid; delegatedPermissionIds = @($ScopeId) }) }
    }
    return , @($list)
}
function New-StgApp { param([string]$DisplayName, [switch]$Apply)
    $app = Get-StgApp $DisplayName
    if ($app) { Write-Host "reuse application '$DisplayName' ($($app.appId))"; return $app }
    if (-not $Apply) { Write-Host "preview: create application '$DisplayName' (single tenant)"; return $null }
    $null = Send-StgGraph 'post' 'applications' @{ displayName = $DisplayName; signInAudience = 'AzureADMyOrg' }
    for ($i = 0; $i -lt 10 -and -not $app; $i++) { Start-Sleep 3; $app = Get-StgApp $DisplayName }
    Write-Host "created application '$DisplayName' ($($app.appId))"
    return $app
}
function Get-StgServicePrincipal { param([string]$AppId, [switch]$Apply)
    $sp = @((Get-StgGraph "servicePrincipals?`$filter=appId eq '$AppId'").value) | Select-Object -First 1
    if (-not $sp -and $Apply) { $sp = Send-StgGraph 'post' 'servicePrincipals' @{ appId = $AppId } }
    return $sp
}
function Set-StgScope { param($App, [string]$Value, [string]$Type, [string]$Text)
    $scope = @($App.api.oauth2PermissionScopes | Where-Object { $_.value -ceq $Value }) | Select-Object -First 1
    $id = if ($scope) { $scope.id } else { [guid]::NewGuid().ToString() }
    $others = @($App.api.oauth2PermissionScopes | Where-Object { $_.value -cne $Value })
    return @{ id = $id; scopes = @($others) + @(@{ id = $id; value = $Value; type = $Type; isEnabled = $true; adminConsentDisplayName = $Text; adminConsentDescription = $Text; userConsentDisplayName = $Text; userConsentDescription = $Text }) }
}
# The delegated scope each application exposes, as Set-StgScope writes it (the apply and its preview share this).
$script:StgScopes = @{
    gateway = @{ value = 'access_as_user'; type = 'User'; text = 'Access the Claude gateway as the signed-in user' }
    admin = @{ value = 'Projects.Manage'; type = 'Admin'; text = 'Manage CCOF projects' }
}

function Get-StgAppChanges {
    # What the Stage 4 apply would change on a reused registration (lists are merged, never pruned), for the preview.
    param($App, [string]$Kind, $Cfg, [string]$AdminHost)
    $changes = [Collections.Generic.List[string]]::new()
    if (@($App.identifierUris) -notcontains "api://$($App.appId)") { $changes.Add("add identifier URI api://$($App.appId)") }
    if ($App.api.requestedAccessTokenVersion -ne 2) { $changes.Add('set access token version 2') }
    $spec = $script:StgScopes[$Kind]
    $scopeName = $spec.value
    $clients = switch ($Kind) {
        'gateway' { @($App.appId) + $(if ($Cfg.entra.allowAzureCliClient) { @($script:AzureCliClientId) } else { @() }) }
        'admin' { @($App.appId) + @($Cfg.admin.extraAllowedClientIds | Where-Object { $_ -match $script:Guid }) }
        default { @() }
    }
    if ($scopeName) {
        $scope = @($App.api.oauth2PermissionScopes | Where-Object { $_.value -ceq $scopeName }) | Select-Object -First 1
        if (-not $scope) { $changes.Add("add scope $scopeName") }
        else {
            if ($scope.type -cne $spec.type) { $changes.Add("set $scopeName scope type $($spec.type)") }
            if ($scope.isEnabled -ne $true) { $changes.Add("enable scope $scopeName") }
            if (@('adminConsentDisplayName', 'adminConsentDescription', 'userConsentDisplayName', 'userConsentDescription' | Where-Object { $scope.$_ -cne $spec.text }).Count) { $changes.Add("set $scopeName consent text '$($spec.text)'") }
        }
        foreach ($cid in $clients) {
            if (-not $scope -or -not @($App.api.preAuthorizedApplications | Where-Object { $_.appId -ieq $cid -and @($_.delegatedPermissionIds) -contains $scope.id }).Count) { $changes.Add("preauthorize $cid for $scopeName") }
        }
    }
    if ($Kind -ceq 'gateway') {
        if ($App.isFallbackPublicClient -ne $true) { $changes.Add('allow public client flows') }
        foreach ($uri in @('http://localhost', "ms-appx-web://microsoft.aad.brokerplugin/$($App.appId)")) { if (@($App.publicClient.redirectUris) -notcontains $uri) { $changes.Add("add public client redirect $uri") } }
    }
    if ($Kind -ceq 'admin') {
        foreach ($role in 'CCOF.Projects.Read', 'CCOF.Projects.Write') { if (-not @($App.appRoles | Where-Object { $_.value -ceq $role }).Count) { $changes.Add("add app role $role") } }
        foreach ($uri in @("https://$AdminHost/api/console", "https://$AdminHost/api/console-v3")) { if (@($App.spa.redirectUris) -notcontains $uri) { $changes.Add("add SPA redirect $uri") } }
    }
    $sp = Get-StgServicePrincipal $App.appId
    if (-not $sp) { $changes.Add('create service principal') }
    if ($Kind -ceq 'admin' -and $sp.appRoleAssignmentRequired -ne $true) { $changes.Add('require user assignment') }
    return , @($changes)
}

function Invoke-Stage4 {
    param($Cfg, [switch]$Apply)
    $e = $Cfg.entra; $s1 = Get-StgStage $Cfg 1
    $me = Get-StgGraph 'me?$select=id'
    $resolve = { param($x) if ($x -ceq '@me') { $me.id } else { $x } }
    # Gateway API + developer sign-in (one application, ADR-0009 single-app contract).
    $gw = Resolve-StgApp $Cfg 'gateway' -Apply:$Apply
    $res = Resolve-StgApp $Cfg 'resolver' -Apply:$Apply
    $adm = if ($Cfg.stage1.includeAdmin) { Resolve-StgApp $Cfg 'admin' -Apply:$Apply }
    if (-not $Apply) {
        Write-Host ('preview: gateway app: api://<appId>, access_as_user, v2 tokens, public client (localhost, WAM), self preauthorized' + $(if ($e.allowAzureCliClient) { ' and Azure CLI' } else { '' }))
        Write-Host 'preview: resolver app: api://<appId>, v2 tokens, no redirects or secrets'
        if ($Cfg.stage1.includeAdmin) { Write-Host ('preview: admin app: Projects.Manage scope, CCOF.Projects.Read/Write roles, SPA redirects /api/console and /api/console-v3, assignment required, self preauthorized' + $(if (@($Cfg.admin.extraAllowedClientIds).Count) { " and $(@($Cfg.admin.extraAllowedClientIds) -join ', ')" } else { '' })) }
        foreach ($g in $Cfg.groups) { Write-Host "preview: group $(Get-StgGroupKey $g): $(if ($g.groupId) { "use $($g.groupId)" } else { "create or reuse '$($g.groupDisplayName)'" }), members $(@($g.members) -join ',')" }
        $adminHost = "$($s1.names.apps.admin.functionApp).azurewebsites.net"
        foreach ($pair in @(@{ kind = 'gateway'; app = $gw }, @{ kind = 'resolver'; app = $res }, @{ kind = 'admin'; app = $adm })) {
            if (-not $pair.app) { continue }
            $changes = Get-StgAppChanges -App $pair.app -Kind $pair.kind -Cfg $Cfg -AdminHost $adminHost
            Write-Host "preview: $($pair.kind) application '$($pair.app.displayName)' ($($pair.app.appId)): $(if ($changes.Count) { $changes -join '; ' } else { 'no change' })"
        }
        Write-Host 'not done here: Microsoft Graph application permission for the sync identity (sync.mode delegated-snapshot needs none); a Privileged Role Administrator runs infra/quickstart/Grant-SyncGraphPermissions.ps1 if approved.'
        return $null
    }
    $gwScope = Set-StgScope $gw $script:StgScopes.gateway.value $script:StgScopes.gateway.type $script:StgScopes.gateway.text
    $clients = @($gw.appId) + $(if ($e.allowAzureCliClient) { @($script:AzureCliClientId) } else { @() })
    $null = Send-StgGraph 'patch' "applications/$($gw.id)" @{
        identifierUris = (Join-StgUnique $gw.identifierUris @("api://$($gw.appId)")); isFallbackPublicClient = $true
        api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = $gwScope.scopes }
        publicClient = @{ redirectUris = (Join-StgUnique $gw.publicClient.redirectUris @('http://localhost', "ms-appx-web://microsoft.aad.brokerplugin/$($gw.appId)")) } }
    $null = Send-StgGraph 'patch' "applications/$($gw.id)" @{ api = @{ preAuthorizedApplications = (Merge-StgPreauthorized $gw $clients $gwScope.id) } }
    $null = Send-StgGraph 'patch' "applications/$($res.id)" @{ identifierUris = (Join-StgUnique $res.identifierUris @("api://$($res.appId)")); api = @{ requestedAccessTokenVersion = 2 } }
    $gwSp = Get-StgServicePrincipal $gw.appId -Apply; $resSp = Get-StgServicePrincipal $res.appId -Apply
    $registrations = @{ gatewayApi = @{ appId = $gw.appId; scope = 'access_as_user'; accessTokenVersion = 2 }; developerSignIn = @{ appId = $gw.appId }; resolverApi = @{ appId = $res.appId } }
    $admin = @{}
    if ($adm) {
        $adm = Get-StgAppById $adm.appId
        $scope = Set-StgScope $adm $script:StgScopes.admin.value $script:StgScopes.admin.type $script:StgScopes.admin.text
        $roles = @($adm.appRoles)
        foreach ($r in @(@{ v = 'CCOF.Projects.Read'; n = 'CCOF project reader' }, @{ v = 'CCOF.Projects.Write'; n = 'CCOF project editor' })) {
            if (-not ($roles | Where-Object { $_.value -ceq $r.v })) { $roles += @{ id = [guid]::NewGuid().ToString(); value = $r.v; displayName = $r.n; description = $r.n; allowedMemberTypes = @('User'); isEnabled = $true } }
        }
        $hostName = "$($s1.names.apps.admin.functionApp).azurewebsites.net"
        $null = Send-StgGraph 'patch' "applications/$($adm.id)" @{ identifierUris = (Join-StgUnique $adm.identifierUris @("api://$($adm.appId)")); appRoles = $roles
            api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = $scope.scopes }
            spa = @{ redirectUris = (Join-StgUnique $adm.spa.redirectUris @("https://$hostName/api/console", "https://$hostName/api/console-v3")) } }
        # ADMIN_ALLOWED_CLIENT_IDS also lists admin.extraAllowedClientIds (Staged.Application.ps1); without
        # preauthorization those clients cannot get a token without a consent prompt (AADSTS65001).
        $adminClients = @($adm.appId) + @($Cfg.admin.extraAllowedClientIds | Where-Object { $_ -match $script:Guid })
        $null = Send-StgGraph 'patch' "applications/$($adm.id)" @{ api = @{ preAuthorizedApplications = (Merge-StgPreauthorized $adm $adminClients $scope.id) } }
        $admSp = Get-StgServicePrincipal $adm.appId -Apply
        $null = Send-StgGraph 'patch' "servicePrincipals/$($admSp.id)" @{ appRoleAssignmentRequired = $true }
        $adm = Get-StgAppById $adm.appId
        $assigned = @((Get-StgGraph "servicePrincipals/$($admSp.id)/appRoleAssignedTo").value)
        foreach ($pair in @(@{ ids = $e.adminEditors; role = 'CCOF.Projects.Write' }, @{ ids = $e.adminReaders; role = 'CCOF.Projects.Read' })) {
            $roleId = @($adm.appRoles | Where-Object { $_.value -ceq $pair.role })[0].id
            foreach ($u in @($pair.ids | Where-Object { $_ })) {
                $uid = & $resolve $u
                if (-not ($assigned | Where-Object { $_.principalId -ieq $uid -and $_.appRoleId -ieq $roleId })) {
                    $null = Send-StgGraph 'post' "servicePrincipals/$($admSp.id)/appRoleAssignedTo" @{ principalId = $uid; resourceId = $admSp.id; appRoleId = $roleId }
                }
            }
        }
        $admin = @{ appId = $adm.appId; servicePrincipalId = $admSp.id; redirects = @("https://$hostName/api/console", "https://$hostName/api/console-v3") }
    }
    $groups = @{}
    foreach ($g in $Cfg.groups) {
        $key = Get-StgGroupKey $g
        $grp = if ($g.groupId) { Get-StgGraph "groups/$($g.groupId)?`$select=id,displayName,securityEnabled" }
               else { @((Get-StgGraph "groups?`$filter=displayName eq '$($g.groupDisplayName)'").value) | Select-Object -First 1 }
        if (-not $grp) {
            $nick = ($g.groupDisplayName -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
            $grp = Send-StgGraph 'post' 'groups' @{ displayName = $g.groupDisplayName; mailEnabled = $false; mailNickname = $nick; securityEnabled = $true; description = "CCOF $key access group" }
            Write-Host "created group $($g.groupDisplayName) ($($grp.id))"
        }
        $members = @((Get-StgGraph "groups/$($grp.id)/members?`$select=id").value | ForEach-Object { $_.id })
        foreach ($m in @($g.members | Where-Object { $_ })) {
            $uid = & $resolve $m
            if ($members -notcontains $uid) { $null = Send-StgGraph 'post' "groups/$($grp.id)/members/`$ref" @{ '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$uid" } }
        }
        $groups[$key] = @{ id = $grp.id; displayName = $grp.displayName; members = @((Get-StgGraph "groups/$($grp.id)/members?`$select=id").value | ForEach-Object { $_.id }) }
    }
    # Verify.
    $gwNow = Get-StgAppById $gw.appId
    Assert-Stg (@($gwNow.identifierUris) -contains "api://$($gw.appId)") 'gateway identifier URI missing'
    Assert-Stg ($gwNow.api.requestedAccessTokenVersion -eq 2) 'gateway tokens are not v2'
    Assert-Stg (@($gwNow.api.oauth2PermissionScopes | Where-Object { $_.value -ceq 'access_as_user' -and $_.isEnabled }).Count -eq 1) 'access_as_user scope missing'
    $gwScopeId = @($gwNow.api.oauth2PermissionScopes | Where-Object { $_.value -ceq 'access_as_user' })[0].id
    foreach ($cid in $clients) {
        Assert-Stg (@($gwNow.api.preAuthorizedApplications | Where-Object { $_.appId -ieq $cid -and @($_.delegatedPermissionIds) -contains $gwScopeId }).Count -eq 1) "gateway app does not preauthorize client $cid for access_as_user"
    }
    if ($adm) {
        $admNow = Get-StgAppById $adm.appId
        $admScopeId = @($admNow.api.oauth2PermissionScopes | Where-Object { $_.value -ceq 'Projects.Manage' })[0].id
        foreach ($cid in $adminClients) {
            Assert-Stg (@($admNow.api.preAuthorizedApplications | Where-Object { $_.appId -ieq $cid -and @($_.delegatedPermissionIds) -contains $admScopeId }).Count -eq 1) "admin app does not preauthorize client $cid for Projects.Manage"
        }
    }
    $result = @{ registrations = $registrations; gatewayIdentifierUri = "api://$($gw.appId)"; gatewayServicePrincipalId = $gwSp.id
        resolverServicePrincipalId = $resSp.id; admin = $admin; groups = $groups; azureCliClientAllowed = [bool]$e.allowAzureCliClient
        graphApplicationPermission = 'not granted (sync.mode delegated-snapshot)' }
    $null = Write-StgEvidence 'stage4.verify.json' $result
    return $result
}
