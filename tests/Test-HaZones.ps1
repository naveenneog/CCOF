#Requires -Version 7.0
param([string]$Case = 'all', [string]$BicepPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$scratch = Join-Path $root '.env.public-test-scratch\ha-zones'
New-Item -ItemType Directory -Force $scratch | Out-Null
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
Write-Host 'HA zones suite loaded'
$passed = 0
function Check([bool]$ok, [string]$message) { if (-not $ok) { throw $message }; $script:passed++ }
function Refuses([scriptblock]$action, [string]$pattern) {
    $message = ''
    try { & $action | Out-Null } catch { $message = $_.Exception.Message }
    Check ($message -match $pattern) "Expected refusal $pattern; got '$message'"
}
function Config {
    $c = Get-Content (Join-Path $root 'infra\staged\staged.config.example.json') -Raw | ConvertFrom-Json -AsHashtable
    $c.tenantId = '00000000-0000-4000-8000-000000000001'; $c.subscriptionId = '00000000-0000-4000-8000-000000000002'
    $c.resourceGroup = 'contoso-ha-rg'; $c.location = 'centralindia'
    $c.network.mode = 'create'; $c.stage1.approveNewPublicApimBootstrap = $true
    $c.stage1.cosmosLocations = @(@{locationName='centralindia';isZoneRedundant=$true}, @{locationName='southindia';isZoneRedundant=$false})
    return $c
}
function ReadConfig($c) {
    $p = Join-Path $scratch 'config.json'
    $c | ConvertTo-Json -Depth 100 | Set-Content $p
    Read-StgConfig $p
}

if ($Case -in 'all', 'config') {
    $c = Config; $c.ha = @{apim=@{zoneRedundant='true'}}
    Refuses { ReadConfig $c } 'ha.apim.zoneRedundant must be a JSON boolean'
    $c.ha = @{functions=@{zoneRedundant=$true}}
    Refuses { ReadConfig $c } 'zone-redundant Functions require.*Standard_ZRS.*Standard_GZRS'
    $c.stage1.storageSku = 'Standard_GZRS'; $c.ha.apim = @{zoneRedundant=$true}
    $c.stage1.apimSku = 'BasicV2'
    Refuses { ReadConfig $c } 'ha.apim.*StandardV2.*PremiumV2'
    $c.stage1.apimSku = 'PremiumV2'
    Check ([bool](ReadConfig $c).ha.functions.zoneRedundant) 'Valid HA config refused'
    $c.stage1.approveNewPublicApimBootstrap = $false
    $c.apim.existing = @{name='contoso';subscriptionId=$c.subscriptionId;resourceGroup='contoso'}
    Refuses { ReadConfig $c } 'ha.apim.*new.*owner'
    $c = Config; $c.ha = @{function=@{zoneRedundant=$true}}
    Refuses { ReadConfig $c } 'ha.*unknown'
    $c = Config; $c.ha = 'enabled'
    Refuses { ReadConfig $c } 'ha must be an object'
    $c.ha = @{apim='enabled'}
    Refuses { ReadConfig $c } 'ha.apim must be an object'
    $c.ha = @{apim=@{zoneRedundant=$false;zones=@('1','2')}}
    Refuses { ReadConfig $c } 'ha.apim.*unknown'
}
if ($Case -in 'all', 'component-casing') {
    foreach ($component in 'Functions','APIM') {
        $c=Config; $c.ha=@{}; $c.ha[$component]=@{zoneRedundant=$true}
        Refuses { ReadConfig $c } "ha has unknown component '$component'"
    }
}
if ($Case -in 'all', 'hash') {
    $c = Config
    $old = @{}; 0..8 | ForEach-Object { $old[$_] = Get-StgStageInput $c $_ }
    Check (-not (Get-Stage1Parameters $c).Contains('ha')) 'Absent HA changed Stage 1 parameters'
    $c.ha = @{apim=@{zoneRedundant=$true}}
    foreach ($n in 0..1) { Check ((Get-StgStageInput $c $n) -cne $old[$n]) "HA omitted from Stage $n hash" }
    Check ((Get-Stage1Parameters $c).ha.apim.zoneRedundant -eq $true) 'HA omitted from Stage 1 parameters'
    $d = @{properties=@{parameters=@{}}}
    foreach ($k in (Get-Stage1Parameters $c).Keys) { $d.properties.parameters[$k]=@{value=(Get-Stage1Parameters $c)[$k]} }
    $d = $d | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
    $c.ha.apim.zoneRedundant = $false
    Refuses { Assert-StgStage1Parameters $d $c } 'stage1_parameters_changed.*ha'
    $c.Remove('ha')
    Refuses { Assert-StgStage1Parameters $d $c } 'stage1_parameters_changed.*ha'
    foreach ($n in 0..8) { Check ((Get-StgStageInput $c $n) -ceq $old[$n]) "Absent HA changed Stage $n hash" }
    $legacy = [ordered]@{tenantId=$c.tenantId;subscriptionId=$c.subscriptionId;resourceGroup=$c.resourceGroup;location=$c.location;tags=$c.tags;sharedResourceGroup=$c.sharedResourceGroup;stage1=$c.stage1}
    $canonical = ConvertTo-StgCanonical $legacy | ConvertTo-Json -Depth 100 -Compress
    Check ((Get-StgStageInput $c 1) -ceq ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical))).ToLowerInvariant())) 'Absent HA changed the legacy Stage 1 hash contract'
}
function Invoke-StgAzJson($Arguments) {
    if ($Arguments[0] -eq 'account') { throw 'Region lookup must use target-subscription ARM locations; account list-locations has no --subscription argument' }
    return @(@{name='Central India'})
}
function Get-StgArm($Path, $ApiVersion) {
    Check ($Path -ceq '/subscriptions/00000000-0000-4000-8000-000000000002/locations') 'Region lookup must target the configured subscription'
    return @{value=@(
        @{name='centralindia';displayName='Central India';availabilityZoneMappings=@(@{logicalZone='1'},@{logicalZone='2'},@{logicalZone='3'});metadata=@{pairedRegion=@(@{name='southindia'})}},
        @{name='southindia';displayName='South India';availabilityZoneMappings=@();metadata=@{pairedRegion=@(@{name='centralindia'})}}
    )}
}
if ($Case -in 'all', 'regions') {
    $c = Config; $c.ha = @{apim=@{zoneRedundant=$true};functions=@{zoneRedundant=$true}}; $c.stage1.storageSku='Standard_ZRS'
    $r = Get-StgHaCheck $c
    Check ($r.apim.configured -and $r.functions.available -and $r.storage.configured) 'HA report omitted configured components'
    Check ($r.cosmos[0].pairedRegion -eq 'southindia' -and -not $r.cosmos[0].pairedRegionHasZones) 'HA report omitted pair zone support'
    $c.location='southindia'
    Refuses { Get-StgHaCheck $c } 'southindia.*no availability zones.*location'
    $c.location='centralindia'; $c.stage1.cosmosLocations[1].isZoneRedundant=$true
    Refuses { Get-StgHaCheck $c } 'southindia.*no availability zones.*isZoneRedundant'
    $c.stage1.cosmosLocations[1].isZoneRedundant=$false
    function Invoke-StgAzJson($Arguments) { return @() }
    Refuses { Get-StgHaCheck $c } 'Flex.*centralindia.*not supported.*ha.functions'
}
if ($Case -in 'all', 'readback') {
    $c = Config; $c.ha=@{apim=@{zoneRedundant=$true};functions=@{zoneRedundant=$true}}; $c.stage1.storageSku='Standard_ZRS'; $c.stage1.apimUnits=2
    Refuses { Assert-StgHaApim $c @{sku=@{capacity=2};properties=@{zoneRedundant=$false}} } 'APIM zoneRedundant'
    Refuses { Assert-StgHaApim $c @{sku=@{capacity=1};properties=@{zoneRedundant=$true}} } 'APIM units'
    Refuses { Assert-StgHaPlan $c @{name='resolver';properties=@{zoneRedundant=$false}} } 'resolver.*zoneRedundant'
    Refuses { Assert-StgHaStorage $c @{name='host';sku=@{name='Standard_LRS'}} } 'host.*storage SKU'
    Assert-StgHaApim $c @{sku=@{capacity=2};properties=@{zoneRedundant=$true}}
    Assert-StgHaPlan $c @{name='resolver';properties=@{zoneRedundant=$true}}
    Assert-StgHaStorage $c @{name='host';sku=@{name='Standard_ZRS'}}
}
if ($Case -in 'all', 'wiring') {
    $c = Config; $c.ha=@{functions=@{zoneRedundant=$true}}; $c.stage1.storageSku='Standard_ZRS'
    function Read-StgState { return @{stages=@{}} }
    function Get-StgSite { return @{publicNetworkAccess='Disabled';httpsOnly=$true;runtimeName='node';runtimeVersion='22';ftpsState='Disabled';virtualNetworkSubnetId=''} }
    function Get-StgAllowedFunctionsSubnets { return @('') }
    function Invoke-StgAzJson { return @() }
    function Get-StgArm { return @{name='resolver';properties=@{zoneRedundant=$false}} }
    $out = @{functionApps=@(@{key='resolver';service=@{name='resolver';planId='/plans/resolver';principalId=$c.tenantId}});names=@{apps=@{}}}
    Refuses { Test-Stage1 $c $out } 'resolver.*zoneRedundant'
    $c.ha.functions.zoneRedundant=$false
    $out.functionApps=@(); $out.names.apps=@{resolver=@{storageAccount='host'}}
    function Invoke-StgAzJson { return @(@{name='host';sku=@{name='Standard_LRS'}}) }
    Refuses { Test-Stage1 $c $out } 'host.*storage SKU'
    $c.Remove('ha')
    Refuses { Test-Stage1 $c $out } 'host.*storage SKU'
}
if ($Case -in 'all', 'template') {
    if (-not $BicepPath) {
        $command = Get-Command bicep -ErrorAction SilentlyContinue
        if ($command) { $BicepPath = $command.Source }
        else { $BicepPath = @('bicep.exe','bicep' | ForEach-Object { Join-Path $HOME ".azure\bin\$_" } | Where-Object { Test-Path $_ -PathType Leaf })[0] }
    }
    if (-not $BicepPath) { throw 'Offline Bicep CLI required; supply -BicepPath. No Azure call or tool install is permitted by this test.' }
    function Arm([string]$file) {
        $text = & $BicepPath build (Join-Path $root "infra\staged\$file") --stdout 2>$null
        if ($LASTEXITCODE) { throw "Compilation failed: $file" }
        ($text -join "`n") | ConvertFrom-Json -AsHashtable -Depth 100
    }
    $main = Arm 'main.bicep'
    Check ($main.parameters.ContainsKey('ha') -and $main.parameters.ha.defaultValue.Count -eq 0) 'HA template default must remain empty'
    $modules = @($main.resources | Where-Object type -eq 'Microsoft.Resources/deployments')
    $apimModule = @($modules | Where-Object name -eq 'stage1-apim')[0]
    $functionModule = @($modules | Where-Object { "$($_.name)" -match "stage1-.*apps" })[0]
    Check ("$($apimModule.properties.parameters.zoneRedundant.value)" -match "parameters\('ha'\).*'apim'.*'zoneRedundant'") 'APIM HA option is not wired from main'
    Check ("$($functionModule.properties.parameters.zoneRedundant.value)" -match "parameters\('ha'\).*'functions'.*'zoneRedundant'") 'Functions HA option is not wired from main'
    $apim = Arm 'apim-service.bicep'
    $a = @($apim.resources | Where-Object type -eq 'Microsoft.ApiManagement/service')[0]
    Check ("$($a.properties)" -match "createObject\('zoneRedundant', true\(\)\)") 'APIM lacks zoneRedundant'
    $fn = Arm 'function-service.bicep'
    $p = @($fn.resources | Where-Object type -eq 'Microsoft.Web/serverfarms')[0]
    Check ("$($p.properties)" -match "createObject\('zoneRedundant', true\(\)\)") 'Flex plan lacks zoneRedundant'
    Check ($fn.parameters.storageSku.allowedValues -contains 'Standard_GZRS') 'GZRS storage unsupported'
}
if ($Case -in 'all', 'existing') {
    $c = Config; $c.stage1.approveNewPublicApimBootstrap=$false
    $c.apim.existing=@{name='contoso-apim';resourceGroup='contoso';subscriptionId='00000000-0000-4000-8000-000000000003'}
    function Invoke-StgAzJson { return @(@{name='Central India'}) }
    function Get-StgArm($Path, $ApiVersion) {
        if ($Path -like '*/locations') {
            return @{value=@(@{name='centralindia';availabilityZoneMappings=@(@{logicalZone='1'});metadata=@{}},
                @{name='eastus2';displayName='East US 2';availabilityZoneMappings=@(@{logicalZone='1'});metadata=@{}},
                @{name='southindia';availabilityZoneMappings=@();metadata=@{}})}
        }
        Check ($Path -like '/subscriptions/00000000-0000-4000-8000-000000000003/*/contoso-apim') 'Existing APIM HA read used the wrong subscription'
        return @{location='East US 2';sku=@{name='StandardV2';capacity=3};properties=@{zoneRedundant=$true}}
    }
    $c.stage1.cosmosLocations=@(@{locationName='centralindia';isZoneRedundant=$true})
    $r=Get-StgHaCheck $c
    Check ($r.apim.configured -and $r.apim.available -and $r.apim.region -eq 'eastus2' -and $r.apim.units -eq 3) 'HA report must read existing APIM zones/region/units without modifying it'
    Check (-not $r.cosmos[0].pairedRegionHasZones) 'Missing region pair must not imply zone support'
}
if ($Case -in 'all', 'missing-region') {
    $c=Config; $c.ha=@{apim=@{zoneRedundant=$true}}
    function Invoke-StgAzJson { return @() }
    function Get-StgArm { return @{value=@(@{name='centralindia';metadata=@{}})} }
    Refuses { Get-StgHaCheck $c } 'centralindia.*no availability zones'
}
if ($Case -in 'all', 'defaults') {
    $c=Config; $c.ha=@{apim=@{zoneRedundant=$true}}
    $c.stage1.Remove('apimUnits'); $c.stage1.Remove('storageSku')
    Assert-StgHaApim $c @{sku=@{capacity=1};properties=@{zoneRedundant=$true}}
    Assert-StgHaStorage $c @{name='host';sku=@{name='Standard_LRS'}}
    Check $true 'HA must preserve effective ARM defaults for omitted units/storage SKU'
}
if ($Case -in 'all', 'apim-wiring') {
    $c=Config; $c.ha=@{apim=@{zoneRedundant=$true}}
    function Read-StgState { return @{stages=@{}} }
    function Get-StgCosmosAccountProblems { return @() }
    function Invoke-StgAzJson($Arguments) {
        if (($Arguments -join ' ') -like 'cosmosdb list*') {
            return @(@{name='cosmos';publicNetworkAccess='Disabled';disableLocalAuth=$true;locations=@();consistencyPolicy=@{defaultConsistencyLevel='Session'}})
        }
        return @()
    }
    function Get-StgArm($Path, $ApiVersion) {
        if ($Path -eq '/apim') { return @{sku=@{name='StandardV2';capacity=1};identity=@{principalId='00000000-0000-4000-8000-000000000001'};properties=@{zoneRedundant=$false;publicNetworkAccess='Enabled'}} }
        return @{value=@()}
    }
    $out=@{functionApps=@();names=@{apps=@{};cosmosAccount='cosmos'};apimId='/apim';apimPrincipalId=$c.tenantId}
    Refuses { Test-Stage1 $c $out } 'APIM zoneRedundant'
}
if ($Case -in 'all', 'stage0') {
    function Assert-StgClientAliases { param($Cfg) }
    $c=Config; $c.backends=@(); $c.groups=@()
    function Invoke-QsAz { return 'false' }
    function Get-StgGraph { return @{id='operator';userPrincipalName='operator@contoso.com'} }
    function Write-StgEvidence { return '' }
    function Invoke-StgAzJson($Arguments) {
        if ($Arguments[0] -eq 'account') { return @{tenantId='00000000-0000-4000-8000-000000000001';user=@{name='operator'}} }
        if ($Arguments[0] -eq 'provider') { return @{registrationState='Registered'} }
        return @(@{name='Central India'},@{name='South India'})
    }
    function Get-StgArm { return @{value=@(
        @{name='centralindia';availabilityZoneMappings=@(@{logicalZone='1'});metadata=@{}},
        @{name='southindia';availabilityZoneMappings=@();metadata=@{}})} }
    $r=Invoke-Stage0 $c
    Check ($r.ha.region -eq 'centralindia' -and $r.ha.cosmos.Count -eq 2) 'Stage 0 must include the HA capability report'
    $c.stage1.Remove('cosmosLocations')
    $c=$c | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
    $defaultReport=Invoke-Stage0 $c
    Check ($defaultReport.ha.cosmos.Count -eq 1 -and $defaultReport.ha.cosmos[0].region -ceq 'centralindia' -and $defaultReport.ha.cosmos[0].available -and -not $defaultReport.ha.cosmos[0].configured) 'Stage 0 must report the default Cosmos region when cosmosLocations is omitted'
    $c.location='southindia'; $c.ha=@{apim=@{zoneRedundant=$true}}
    Refuses { Invoke-Stage0 $c } 'southindia.*no availability zones'
}
if ($Case -in 'all', 'suggestions') {
    $c=Config; $c.stage1.cosmosLocations[0].isZoneRedundant=$false
    $messages=(& { $null=Get-StgHaCheck $c } 6>&1 | Out-String)
    Check ($messages -match 'suggestion: cosmos zones: centralindia has zones but capacity may be refused') 'Cosmos suggestion must distinguish regional availability from subscription capacity'
}
Write-Host "HA zones: $passed checks PASS"
