#Requires -Version 7.0
param([string]$Case='all')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
Write-Host 'Client alias preflight suite loaded'
$passed=0
function Check([bool]$ok,[string]$message){if(-not $ok){throw $message};$script:passed++}
function ErrorOf([scriptblock]$action){try{& $action | Out-Null;''}catch{$_.Exception.Message}}
function Config {
    $c=@{
        groups=@(
            @{kind='group';groupDisplayName='Other';backendId='other';familyPolicy=@{families=@{sonnet=@{models=@('model-sonnet')}}}},
            @{kind='group';groupDisplayName='Engineering';backendId='chosen';familyPolicy=@{families=@{haiku=@{models=@('model-haiku')};sonnet=@{models=@('model-sonnet')}}}}
        )
        backends=@(
            @{id='other';deploymentInferenceGeo=@{'model-sonnet'='global'}},
            @{id='chosen';deploymentInferenceGeo=@{'model-haiku'='global';'not-in-policy'='global'}}
        )
        client=@{group='Engineering';models=@{default='model-sonnet';opus='model-haiku';sonnet='model-haiku';haiku='model-haiku'}}
    }
    return $c | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
}
function CheckAliasError([string]$message){
    Check ($message.StartsWith('client_alias_not_admitted: every alias must name an exact admitted deployment on the selected backend.')) "Expected early client_alias_not_admitted, got '$message'"
    Check ($message -match 'default=model-sonnet' -and $message -match 'Admitted deployments: model-haiku' -and $message -notmatch 'Admitted deployments: .*not-in-policy') 'Alias refusal must name the aliases and only the selected backend/policy admitted deployments'
}
if($Case -in 'all','pure'){
    $c=Config
    CheckAliasError (ErrorOf {Assert-StgClientAliases $c})
    foreach($alias in 'default','opus','sonnet','haiku'){$c.client.models[$alias]='model-haiku'}
    Assert-StgClientAliases $c
    Check $true 'Valid selected group aliases must pass before Entra group resolution'
    $c.client.models.default='MODEL-HAIKU'
    Check ((ErrorOf {Assert-StgClientAliases $c}) -match '^client_alias_not_admitted:') 'Alias admission must remain case-sensitive'
    $c.client.models.default='not-in-policy'
    Check ((ErrorOf {Assert-StgClientAliases $c}) -match '^client_alias_not_admitted:') 'A backend deployment outside the selected family policy must not be admitted'
    $c=Config; $c.client.models.Remove('opus')
    Check ((ErrorOf {Assert-StgClientAliases $c}) -match '^client_aliases_invalid:') 'Missing aliases must keep the export shape check'
    $c=Config; $c.client=@{projectId='pilot';classification='STD';models=@{default='model-haiku';opus='model-haiku';sonnet='model-haiku';haiku='model-haiku'}}
    $c.groups=@(@{projectId='pilot';classification='STD';familyPolicy=@{families=@{haiku=@{models=@('model-haiku')}}}})
    $c.backends=@($c.backends[1])
    Assert-StgClientAliases $c
    Check $true 'Legacy project/classification selection must preserve its single-backend default'
}
$script:azureReads=0; $script:contextCalls=0; $script:publishCalls=0
function Invoke-StgAzJson {$script:azureReads++;throw 'test_stop_azure_read'}
function Get-StgStage {return @{groups=@{};azureCliClientAllowed=$false}}
function New-StgQsContext {$script:contextCalls++;throw 'test_stop_context'}
function Invoke-QsCode {$script:publishCalls++;throw 'unexpected_publish'}
if($Case -in 'all','stage0'){
    $c=Config
    CheckAliasError (ErrorOf {Invoke-Stage0 $c})
    Check ($script:azureReads -eq 0) 'Stage 0 must reject aliases before any Azure read'
    $c.client.models.default='model-haiku'
    Check ((ErrorOf {Invoke-Stage0 $c}) -ceq 'test_stop_azure_read') 'Valid Stage 0 aliases must continue to its read-only checks'
}
if($Case -in 'all','stage7'){
    $c=Config
    foreach($apply in $false,$true){
        CheckAliasError (ErrorOf {Invoke-Stage7 $c -Apply:$apply})
    }
    Check ($script:contextCalls -eq 0 -and $script:publishCalls -eq 0) 'Stage 7 preview and apply must refuse before context, build or publication'
    $c.client.models.default='model-haiku'
    Check ((ErrorOf {Invoke-Stage7 $c}) -ceq 'test_stop_context') 'Valid Stage 7 aliases must continue to its normal preflight'
}
if($Case -in 'all','export'){
    $c=Config
    $ctx=@{P=@{backends=$c.backends}}
    CheckAliasError (ErrorOf {New-QsClientFiles -Ctx $ctx -ProjectId 'pilot' -FamilyPolicy $c.groups[1].familyPolicy -BackendId 'chosen' -Aliases $c.client.models})
}
Write-Host "Client alias preflight: $passed checks PASS"
