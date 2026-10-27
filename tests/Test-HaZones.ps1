#Requires -Version 7.0
param([string]$Case = 'all')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$scratch = Join-Path $root '.env.public-test-scratch\ha-zones'
New-Item -ItemType Directory -Force $scratch | Out-Null
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
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
}
if ($Case -in 'all', 'hash') {
    $c = Config
    $old = @{}; 0..8 | ForEach-Object { $old[$_] = Get-StgStageInput $c $_ }
    Check (-not (Get-Stage1Parameters $c).Contains('ha')) 'Absent HA changed Stage 1 parameters'
    $c.ha = @{apim=@{zoneRedundant=$true}}
    foreach ($n in 0..1) { Check ((Get-StgStageInput $c $n) -cne $old[$n]) "HA omitted from Stage $n hash" }
    Check ((Get-Stage1Parameters $c).ha.apim.zoneRedundant) 'HA omitted from Stage 1 parameters'
    $d = @{properties=@{parameters=@{}}}
    foreach ($k in (Get-Stage1Parameters $c).Keys) { $d.properties.parameters[$k]=@{value=(Get-Stage1Parameters $c)[$k]} }
    $d = $d | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
    $c.ha.apim.zoneRedundant = $false
    Refuses { Assert-StgStage1Parameters $d $c } 'stage1_parameters_changed.*ha'
    $c.Remove('ha')
    foreach ($n in 0..8) { Check ((Get-StgStageInput $c $n) -ceq $old[$n]) "Absent HA changed Stage $n hash" }
}
function Invoke-StgAzJson($Arguments) {
    if ($Arguments[0] -eq 'account') { return @(
        @{name='centralindia';displayName='Central India';availabilityZoneMappings=@(@{logicalZone='1'},@{logicalZone='2'},@{logicalZone='3'});metadata=@{pairedRegion=@(@{name='southindia'})}},
        @{name='southindia';displayName='South India';availabilityZoneMappings=@();metadata=@{pairedRegion=@(@{name='centralindia'})}}
    ) }
    return @(@{name='Central India'})
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
    function Invoke-StgAzJson($Arguments) { if ($Arguments[0] -eq 'account') { return @(@{name='centralindia';availabilityZoneMappings=@(@{logicalZone='1'});metadata=@{}},@{name='southindia';availabilityZoneMappings=@();metadata=@{}}) }; return @() }
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
if ($Case -in 'all', 'template') {
    $bicep = Join-Path $HOME '.azure\bin\bicep.exe'
    function Arm([string]$file) {
        $text = & $bicep build (Join-Path $root "infra\staged\$file") --stdout 2>$null
        if ($LASTEXITCODE) { throw "Compilation failed: $file" }
        ($text -join "`n") | ConvertFrom-Json -AsHashtable -Depth 100
    }
    $main = Arm 'main.bicep'
    Check ($main.parameters.ContainsKey('ha') -and $main.parameters.ha.defaultValue.Count -eq 0) 'HA template default must remain empty'
    $apim = Arm 'apim-service.bicep'
    $a = @($apim.resources | Where-Object type -eq 'Microsoft.ApiManagement/service')[0]
    Check ("$($a.properties)" -match 'zoneRedundant' -or ($a.properties | ConvertTo-Json) -match 'zoneRedundant') 'APIM lacks zoneRedundant'
    $fn = Arm 'function-service.bicep'
    $p = @($fn.resources | Where-Object type -eq 'Microsoft.Web/serverfarms')[0]
    Check (($p.properties | ConvertTo-Json) -match 'zoneRedundant') 'Flex plan lacks zoneRedundant'
    Check ($fn.parameters.storageSku.allowedValues -contains 'Standard_GZRS') 'GZRS storage unsupported'
}
Write-Host "HA zones: $passed checks PASS"
