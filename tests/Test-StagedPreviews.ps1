#Requires -Version 7.0
<#
.SYNOPSIS
    Offline tests for the read-only previews of the staged deployment: Stage 0 refuses planned Foundry deployments
    above the free model quota (counting only capacity added to this lab's existing deployments), and the Stage 4
    preview names every change the apply makes to a reused Entra registration. No Azure call: az, ARM and Graph
    reads are replaced by fakes, and any write fails the test.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:passed++ }
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly

# Stage 0 refuses planned Foundry deployments that exceed the free model quota (novice run 3, 2026-10-26: Stage 0
# passed with 7 of 27 DataZoneStandard units free for a capacity of 20; soft-deleted accounts of deleted labs held them).
$quotaSaved = @{ az = ${function:Invoke-StgAzJson}; qs = ${function:Invoke-QsAz}; graph = ${function:Get-StgGraph}; ev = ${function:Write-StgEvidence}; arm = ${function:Get-StgArm} }
try {
    $script:quotaUsages = @(); $script:quotaDeleted = @(); $script:quotaAccount = $null; $script:quotaArmError = $null
    function Get-StgArm { param([string]$Path, [string]$ApiVersion)
        if ($script:quotaArmError) { throw $script:quotaArmError }
        if ($Path -cne '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct' -and $Path -cne '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/deployments') { throw "unexpected ARM read in the Stage 0 quota test: $Path" }
        if (-not $script:quotaAccount) { throw "az rest failed: (ResourceNotFound) The Resource 'Microsoft.CognitiveServices/accounts/acct' under resource group 'rg' was not found." }
        if ($Path -like '*/deployments') { return @{ value = @($script:quotaAccount.deployments) } }
        return @{ id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct'; name = 'acct' } }
    function New-QuotaExisting([string]$Name, [string]$Model, [string]$Sku, [double]$Capacity) { @{ name = $Name; sku = @{ name = $Sku; capacity = $Capacity }; properties = @{ model = @{ format = 'Anthropic'; name = $Model; version = '2' } } } }
    function Invoke-StgAzJson { param([string[]]$Arguments)
        $a = $Arguments -join ' '
        if ($a -like 'account show*') { return @{ id = 's'; name = 'sub'; tenantId = 't'; user = @{ name = 'u' } } }
        if ($a -like 'provider show*') { return @{ registrationState = 'Registered' } }
        if ($a -like 'functionapp list-flexconsumption-locations*') { return @(@{ name = 'East US 2' }) }
        if ($a -like 'cognitiveservices model list*') { return @(
            @{ model = @{ format = 'Anthropic'; name = 'claude-haiku-5-5'; version = '2'; skus = @(@{ name = 'DataZoneStandard' }, @{ name = 'GlobalStandard' }) } },
            @{ model = @{ format = 'Anthropic'; name = 'claude-sonnet-5-5'; version = '2'; skus = @(@{ name = 'DataZoneStandard' }) } }) }
        if ($a -like 'cognitiveservices usage list*') { return $script:quotaUsages }
        if ($a -like 'cognitiveservices account list-deleted*') { return $script:quotaDeleted }
        throw "unexpected az call in the Stage 0 quota test: $a" }
    function Invoke-QsAz { param([string[]]$Arguments) 'false' }
    function Get-StgGraph { param([string]$Path) @{ id = 'o'; userPrincipalName = 'u' } }
    function Write-StgEvidence { param([string]$Name, $Value) '' }
    function New-QuotaCfg([object[]]$Deployments) {
        $geo = [ordered]@{}; foreach ($d in $Deployments) { $geo[$d.name] = 'us' }
        @{ tenantId = 't'; subscriptionId = 's'; resourceGroup = 'rg'; location = 'eastus2'; groups = @()
           stage1 = @{ foundry = @{ create = $true; accountName = 'acct'; deployments = $Deployments } }
           backends = @(@{ id = 'b'; accountName = 'acct'; deploymentInferenceGeo = $geo }) } }
    function New-QuotaLine([string]$Name, [double]$Used, [double]$Limit) { @{ name = @{ value = $Name }; currentValue = $Used; limit = $Limit } }
    $haiku = @{ name = 'claude-haiku-5-5'; model = 'claude-haiku-5-5'; version = '2'; sku = 'DataZoneStandard'; capacity = 20 }
    $sonnet = @{ name = 'claude-sonnet-5-5'; model = 'claude-sonnet-5-5'; version = '2'; sku = 'DataZoneStandard'; capacity = 20 }
    $script:quotaUsages = @((New-QuotaLine 'AIServices.DataZoneStandard.claude-haiku-5-5.Azure' 20 27), (New-QuotaLine 'AIServices.DataZoneStandard.claude-sonnet-5-5.Azure' 20 80))
    $script:quotaDeleted = @(@{ name = 'old-lab-foundry'; location = 'East US 2' }, @{ name = 'elsewhere'; location = 'westus' })
    $message = ''; try { $null = Invoke-Stage0 (New-QuotaCfg @($haiku, $sonnet)) 6>$null } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'quota' -and $message -match 'claude-haiku-5-5' -and $message -match 'needs 20' -and $message -match '7 free' -and $message -match 'list-deleted' -and $message -match 'old-lab-foundry' -and $message -notmatch 'elsewhere' -and $message -notmatch 'claude-sonnet-5-5') "Stage 0 must refuse a deployment above the free quota, naming it, the free units and the soft-deleted accounts in the region (got: $message)."
    $script:quotaDeleted = @(@{ name = 'elsewhere'; location = 'westus' })
    $message = ''; try { $null = Invoke-Stage0 (New-QuotaCfg @($haiku)) 6>$null } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'needs 20' -and $message -notmatch 'purge') "Stage 0 must not advise purging when no soft-deleted account holds quota in the region (got: $message)."
    # Council finding (2026-10-26): after Stage 1 the usage already counts this lab's own deployments; a rerun counts only added capacity.
    $script:quotaAccount = @{ deployments = @((New-QuotaExisting 'claude-haiku-5-5' 'claude-haiku-5-5' 'DataZoneStandard' 20)) }
    $rerun = Invoke-Stage0 (New-QuotaCfg @($haiku)) 6>$null
    Assert-Contract ($rerun.backends.Count -eq 1) 'A Stage 0 rerun must pass when the planned deployment already exists with the same capacity.'
    $raised = @{ name = 'claude-haiku-5-5'; model = 'claude-haiku-5-5'; version = '2'; sku = 'DataZoneStandard'; capacity = 30 }
    $message = ''; try { $null = Invoke-Stage0 (New-QuotaCfg @($raised)) 6>$null } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'needs 10 more' -and $message -match '7 free' -and $message -notmatch 'needs 30' -and $message -notmatch 'purge') "A raised capacity on an existing deployment must be refused naming only the extra units (got: $message)."
    $lowered = @{ name = 'claude-haiku-5-5'; model = 'claude-haiku-5-5'; version = '2'; sku = 'DataZoneStandard'; capacity = 5 }
    $added = @{ name = 'haiku-b'; model = 'claude-haiku-5-5'; version = '2'; sku = 'DataZoneStandard'; capacity = 10 }
    $message = ''; try { $null = Invoke-Stage0 (New-QuotaCfg @($lowered, $added)) 6>$null } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'needs 10 more' -and $message -match '7 free') "A lowered capacity must not offset another deployment on the same quota line (got: $message)."
    $script:quotaAccount = @{ deployments = @((New-QuotaExisting 'claude-haiku-5-5' 'claude-haiku-5-5' 'GlobalStandard' 20)) }
    $message = ''; try { $null = Invoke-Stage0 (New-QuotaCfg @($haiku)) 6>$null } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'needs 20' -and $message -match '7 free') "An existing deployment on another quota line must not reduce the planned need (got: $message)."
    $script:quotaAccount = $null; $script:quotaArmError = 'az rest failed: (AuthorizationFailed) no read access'
    $message = ''; try { $null = Invoke-Stage0 (New-QuotaCfg @($haiku)) 6>$null } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'AuthorizationFailed') "Stage 0 must not treat an unreadable Foundry account as absent (got: $message)."
    $script:quotaArmError = $null
    $okReport = Invoke-Stage0 (New-QuotaCfg @($sonnet)) 6>$null
    Assert-Contract ($okReport.backends.Count -eq 1) 'Stage 0 must pass a deployment within the free quota.'
    $half = @{ name = 'haiku-a'; model = 'claude-haiku-5-5'; version = '2'; sku = 'DataZoneStandard'; capacity = 5 }
    $otherHalf = @{ name = 'haiku-b'; model = 'claude-haiku-5-5'; version = '2'; sku = 'DataZoneStandard'; capacity = 5 }
    $message = ''; try { $null = Invoke-Stage0 (New-QuotaCfg @($half, $otherHalf)) 6>$null } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'needs 10' -and $message -match '7 free') "Stage 0 must add deployments that share one quota line (got: $message)."
    $global = @{ name = 'claude-haiku-5-5'; model = 'claude-haiku-5-5'; version = '2'; capacity = 20 }
    $script:quotaUsages = @((New-QuotaLine 'AIServices.GlobalStandard.claude-haiku-5-5.Azure' 70 80))
    $message = ''; try { $null = Invoke-Stage0 (New-QuotaCfg @($global)) 6>$null } catch { $message = $_.Exception.Message }
    Assert-Contract ($message -match 'AIServices\.GlobalStandard\.claude-haiku-5-5\.Azure' -and $message -match '10 free') "A deployment without sku uses the GlobalStandard quota line (got: $message)."
    $script:quotaUsages = @()
    $noLine = Invoke-Stage0 (New-QuotaCfg @($haiku)) 6>$null
    Assert-Contract ($noLine.backends.Count -eq 1) 'A missing quota line is not a refusal (the model list already confirmed the offer).'
} finally {
    ${function:Invoke-StgAzJson} = $quotaSaved.az; ${function:Invoke-QsAz} = $quotaSaved.qs; ${function:Get-StgGraph} = $quotaSaved.graph;     ${function:Write-StgEvidence} = $quotaSaved.ev; ${function:Get-StgArm} = $quotaSaved.arm
}
# The Stage 4 preview names what the apply would change on each reused registration, and writes nothing (novice run 3:
# the preview of three shared registrations printed only the generic plan, so the Entra owner could not tell that
# the apply adds two SPA redirect URIs to a shared admin application).
$s4Saved = @{ graph = ${function:Get-StgGraph}; send = ${function:Send-StgGraph}; stage = ${function:Get-StgStage} }
try {
    $gwText = 'Access the Claude gateway as the signed-in user'; $admText = 'Manage CCOF projects'
    $gwApp = @{ id = 'og'; appId = 'gw-app'; displayName = 'Shared Gateway'; identifierUris = @('api://gw-app'); isFallbackPublicClient = $true
        api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = @(@{ id = 'sc-gw'; value = 'access_as_user'; type = 'User'; isEnabled = $true
                     adminConsentDisplayName = $gwText; adminConsentDescription = $gwText; userConsentDisplayName = $gwText; userConsentDescription = $gwText })
                 preAuthorizedApplications = @(@{ appId = 'gw-app'; delegatedPermissionIds = @('sc-gw') }, @{ appId = $script:AzureCliClientId; delegatedPermissionIds = @('sc-gw') }) }
        publicClient = @{ redirectUris = @('http://localhost', 'ms-appx-web://microsoft.aad.brokerplugin/gw-app') } }
    $resApp = @{ id = 'or'; appId = 'res-app'; displayName = 'Shared Resolver'; identifierUris = @(); api = @{ requestedAccessTokenVersion = 2 } }
    $admApp = @{ id = 'oa'; appId = 'adm-app'; displayName = 'Shared Admin'; identifierUris = @('api://adm-app')
        appRoles = @(@{ value = 'CCOF.Projects.Read' }, @{ value = 'CCOF.Projects.Write' })
        api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = @(@{ id = 'sc-adm'; value = 'Projects.Manage'; type = 'Admin'; isEnabled = $true
                     adminConsentDisplayName = $admText; adminConsentDescription = $admText; userConsentDisplayName = $admText; userConsentDescription = $admText })
                 preAuthorizedApplications = @(@{ appId = 'adm-app'; delegatedPermissionIds = @('sc-adm') }) }
        spa = @{ redirectUris = @('https://other-admin.azurewebsites.net/api/console') } }
    $script:s4Apps = @{ 'gw-app' = $gwApp; 'res-app' = $resApp; 'adm-app' = $admApp }
    $script:s4Sps = @{ 'gw-app' = @{ id = 'sp-gw'; appId = 'gw-app' }; 'res-app' = @{ id = 'sp-res'; appId = 'res-app' }; 'adm-app' = @{ id = 'sp-adm'; appId = 'adm-app'; appRoleAssignmentRequired = $true } }
    function Get-StgGraph { param([string]$Path)
        if ($Path -like 'me*') { return @{ id = 'me' } }
        if ($Path -match "^servicePrincipals\?\`$filter=appId eq '([^']+)'$") { return @{ value = @($script:s4Sps[$Matches[1]] | Where-Object { $_ }) } }
        if ($Path -match "appId eq '([^']+)'") { return @{ value = @($script:s4Apps[$Matches[1]]) } }
        throw "unexpected Graph read in the Stage 4 preview test: $Path" }
    function Send-StgGraph { param([string]$Method, [string]$Path, $Body) throw "the Stage 4 preview wrote to Graph: $Method $Path" }
    function Get-StgStage { param($Cfg, $Stage) @{ names = @{ apps = @{ admin = @{ functionApp = 'lab-admin' } } } } }
    $s4Cfg = @{ stage1 = @{ includeAdmin = $true }; groups = @(); admin = @{ extraAllowedClientIds = @($script:AzureCliClientId) }
        entra = @{ allowAzureCliClient = $true; existing = @{ gatewayAppId = 'gw-app'; resolverAppId = 'res-app'; adminAppId = 'adm-app' } } }
    $s4Out = (Invoke-Stage4 $s4Cfg 6>&1 | Out-String)
    Assert-Contract ($s4Out -match "gateway application 'Shared Gateway'[^\r\n]*: no change") "The Stage 4 preview must say a fully configured reused gateway app is not changed (got: $s4Out)."
    Assert-Contract ($s4Out -match "resolver application 'Shared Resolver'[^\r\n]*: add identifier URI api://res-app") "The Stage 4 preview must name a missing identifier URI (got: $s4Out)."
    Assert-Contract ($s4Out -match "admin application 'Shared Admin'[^\r\n]*add SPA redirect https://lab-admin\.azurewebsites\.net/api/console[;,]" -and $s4Out -match 'add SPA redirect https://lab-admin\.azurewebsites\.net/api/console-v3' -and $s4Out -match "preauthorize $([regex]::Escape($script:AzureCliClientId)) for Projects\.Manage") "The Stage 4 preview must name the redirects and preauthorizations the apply adds to a reused admin app (got: $s4Out)."
    $gwApp.api.preAuthorizedApplications = @($gwApp.api.preAuthorizedApplications[0])
    $s4Out = (Invoke-Stage4 $s4Cfg 6>&1 | Out-String)
    Assert-Contract ($s4Out -match "gateway application 'Shared Gateway'[^\r\n]*: preauthorize $([regex]::Escape($script:AzureCliClientId)) for access_as_user") "The Stage 4 preview must name a missing Azure CLI preauthorization (got: $s4Out)."
    Assert-Contract ($s4Out -notmatch '(service principal|user assignment|scope type|enable scope|consent text)') "A matching scope and service principal must not be reported as a change (got: $s4Out)."
    # Council finding (2026-10-26): the apply also rewrites the scope type, isEnabled and consent texts, creates missing
    # service principals and requires user assignment on the admin application; the preview must name each.
    $gwApp.api.oauth2PermissionScopes[0].type = 'Admin'; $gwApp.api.oauth2PermissionScopes[0].userConsentDescription = 'Old text'
    $admApp.api.oauth2PermissionScopes[0].isEnabled = $false
    $script:s4Sps['adm-app'].appRoleAssignmentRequired = $false; $script:s4Sps.Remove('res-app')
    $s4Out = (Invoke-Stage4 $s4Cfg 6>&1 | Out-String)
    Assert-Contract ($s4Out -match "gateway application 'Shared Gateway'[^\r\n]*set access_as_user scope type User" -and $s4Out -match "gateway application 'Shared Gateway'[^\r\n]*set access_as_user consent text") "The Stage 4 preview must name a scope type and consent text the apply rewrites (got: $s4Out)."
    Assert-Contract ($s4Out -match "admin application 'Shared Admin'[^\r\n]*enable scope Projects\.Manage" -and $s4Out -match "admin application 'Shared Admin'[^\r\n]*require user assignment" -and $s4Out -notmatch "admin application 'Shared Admin'[^\r\n]*(create service principal|scope type|consent text)") "The Stage 4 preview must name a disabled admin scope and user assignment that is not required (got: $s4Out)."
    Assert-Contract ($s4Out -match "resolver application 'Shared Resolver'[^\r\n]*create service principal" -and $s4Out -notmatch "resolver application 'Shared Resolver'[^\r\n]*require user assignment") "The Stage 4 preview must name a service principal the apply creates (got: $s4Out)."
    $script:s4Sps.Remove('adm-app')
    $s4Out = (Invoke-Stage4 $s4Cfg 6>&1 | Out-String)
    Assert-Contract ($s4Out -match "admin application 'Shared Admin'[^\r\n]*create service principal" -and $s4Out -match "admin application 'Shared Admin'[^\r\n]*require user assignment") "A missing admin service principal is created and then requires user assignment (got: $s4Out)."
} finally { ${function:Get-StgGraph} = $s4Saved.graph; ${function:Send-StgGraph} = $s4Saved.send; ${function:Get-StgStage} = $s4Saved.stage }

"Staged previews: $passed checks passed (Stage 0 model quota, Stage 4 reused registrations). No Azure calls."
