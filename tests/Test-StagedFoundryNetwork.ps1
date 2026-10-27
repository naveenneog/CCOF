#Requires -Version 7.2
param([string]$CaseName = 'all')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
$passed = 0
function Check([bool]$ok, [string]$message) { if (-not $ok) { throw $message }; $script:passed++ }
$sub = '00000000-0000-4000-8000-000000000002'
$vnet = "/subscriptions/$sub/resourceGroups/contoso-rg/providers/Microsoft.Network/virtualNetworks/contoso-vnet"
$zones = @('cognitiveservices.azure.com','openai.azure.com','services.ai.azure.com' | ForEach-Object {
    "/subscriptions/$sub/resourceGroups/contoso-rg/providers/Microsoft.Network/privateDnsZones/privatelink.$_"
})
function New-Config {
    @{
        tenantId=$sub; subscriptionId=$sub; resourceGroup='contoso-rg'; location='centralus'; tags=@{}
        stage1=@{ foundry=@{create=$false}; apimSku='StandardV2' }; apim=@{}
        network=@{ mode='existing'; create=@{vnetName='contoso-vnet'}; existing=@{
            privateEndpointSubnetId="$vnet/subnets/private"; functionsSubnetId="$vnet/subnets/functions"
            privateDnsZoneIds=@{ foundry=@{cognitiveServices=$zones[0];openAi=$zones[1];aiServices=$zones[2]} }
        } }
        backends=@(@{id='claude'; subscriptionId=$sub;resourceGroup='contoso-rg';accountName='primary'
            url='https://primary.services.ai.azure.com/anthropic'; deploymentInferenceGeo=@{'claude-haiku-5-5'='global'}
            failover=@{subscriptionId=$sub;resourceGroup='contoso-rg';accountName='standby'
                url='https://standby.services.ai.azure.com/anthropic';privateEndpoint=$true
                deploymentInferenceGeo=@{'claude-haiku-5-5'='global'} }
        })
    }
}
function Get-ExpectedBaseHash($Cfg) {
    $base = $Cfg | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
    foreach ($b in $base.backends) { $b.Remove('failover') }
    return Get-StgStageInput $base 6
}
$cases = [ordered]@{
    'existing-preview' = {
        $c = New-Config
        $script:endpoints = @()
        function Get-StgStage { return @{names=@{apps=@{}};apimName=''} }
        function Read-StgState { return @{stages=@{}} }
        function Invoke-StgBicep($Cfg,$Template,$Name,$Parameters,[switch]$Apply) {
            if ($Template -ceq 'stage6-foundry-failover.bicep') { $script:endpoints += $Parameters }
            return $null
        }
        $null = Invoke-Stage6 $c
        Check ($endpoints.Count -eq 1 -and $endpoints[0].subnetId -ceq "$vnet/subnets/private") 'existing-network preview must derive the standby subnet from configuration'
        Check ($endpoints[0].vnetId -ceq $vnet) 'existing-network preview must derive the standby VNet ID'
        Check (($endpoints[0].zoneIds | Sort-Object) -join '|' -ceq (($zones | Sort-Object) -join '|')) 'existing-network preview must pass all configured Foundry zone IDs'
        Check ($endpoints[0].createZones -eq $false) 'existing-network preview must never create customer DNS zones'
    }
    'create-preview' = {
        $c = New-Config; $c.network.mode = 'create'
        $script:endpoints = @()
        function Get-StgStage { return @{names=@{apps=@{}};apimName=''} }
        function Read-StgState { return @{stages=@{}} }
        function Invoke-StgAzJson { return @() }
        function Invoke-StgBicep($Cfg,$Template,$Name,$Parameters,[switch]$Apply) {
            if ($Template -ceq 'stage6-foundry-failover.bicep') { $script:endpoints += $Parameters }
            return $null
        }
        $text = (& { $null = Invoke-Stage6 $c } 6>&1 | Out-String)
        Check ($endpoints.Count -eq 0) 'first-create preview must defer standby what-if until network outputs exist'
        Check ($text -match 'preview:.*Foundry failover.*deferred') 'first-create preview must explain the deferred standby endpoint preview'
    }
    'null-zones' = {
        $c = New-Config
        $script:captured = $null
        function Invoke-StgBicep($Cfg,$Template,$Name,$Parameters,[switch]$Apply) { $script:captured=$Parameters; return $null }
        $null = Invoke-StgFailoverEndpoints -Cfg $c -Network @{privateEndpointSubnetId="$vnet/subnets/private";vnetId=$vnet;foundryPrivateDnsZoneIds=@($null)}
        Check ($captured.zoneIds.Count -eq 3 -and -not @($captured.zoneIds | Where-Object { -not $_ }).Count) 'null-only verified zone array must fall back to configured Foundry zones'
        $c.network.mode='create'
        $null = Invoke-StgFailoverEndpoints -Cfg $c -Network @{privateEndpointSubnetId="$vnet/subnets/private";vnetId=$vnet;foundryPrivateDnsZoneIds=@($null)}
        Check ($captured.zoneIds.Count -eq 3 -and $captured.createZones) 'null-only create-mode zones must generate the three local Foundry zones'
    }
    'missing-network' = {
        $script:calls=0
        function Invoke-StgBicep { $script:calls++; return $null }
        $c=New-Config; $c.network.existing.Remove('privateEndpointSubnetId'); $message=''
        try { $null=Invoke-StgFailoverEndpoints -Cfg $c -Network $null } catch { $message=$_.Exception.Message }
        Check ($message -match 'failover_network_unverified' -and $calls -eq 0) 'missing configured subnet must refuse before any standby what-if'
        $c=New-Config; $c.network.mode='create'; $message=''
        try { $null=Invoke-StgFailoverEndpoints -Cfg $c -Network $null -Apply } catch { $message=$_.Exception.Message }
        Check ($message -match 'failover_network_unverified' -and $calls -eq 0) 'apply must refuse missing verified network outputs rather than defer'
        $c=New-Config; $c.network.existing.privateDnsZoneIds.foundry=@{}; $message=''
        try { $null=Invoke-StgFailoverEndpoints -Cfg $c -Network @{privateEndpointSubnetId="$vnet/subnets/private";vnetId=$vnet;foundryPrivateDnsZoneIds=@($null)} } catch { $message=$_.Exception.Message }
        Check ($message -match 'DNS zone IDs are missing' -and $calls -eq 0) 'missing DNS fallback must refuse before any standby what-if'
    }
    'fingerprint-guard' = {
        $old = New-Config; $old.network.mode='create'
        $second = $old.backends[0] | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
        $second.id='second'; $second.accountName='second-primary'; $second.Remove('failover')
        $old.backends += $second
        $script:networkState = @{stages=@{'6'=@{configHash=(Get-StgStageInput $old 6);outputs=@{
            vnetId=$vnet;verify=@{foundryFailoverBaseNetworkHash=(Get-ExpectedBaseHash $old)}
        }}}}
        function Read-StgState { return $script:networkState }
        $next = $old | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
        $next.backends[1].failover = $old.backends[0].failover
        $message=''; $result=$null
        try { $result=Get-StgFailoverNetworkState $next } catch { $message=$_.Exception.Message }
        Check (-not $message -and $result.vnetId -ceq $vnet) 'adding a second backend standby must reuse the recorded base network'
        $next = $old | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
        $next.backends[0].failover.accountName='replacement'
        $next.backends[0].failover.url='https://replacement.services.ai.azure.com/anthropic'
        $message=''; $result=$null
        try { $result=Get-StgFailoverNetworkState $next } catch { $message=$_.Exception.Message }
        Check (-not $message -and $result.vnetId -ceq $vnet) 'replacing a standby must reuse the recorded base network'
        $next.network.create.vnetName='another-vnet'; $message=''
        try { $null=Get-StgFailoverNetworkState $next } catch { $message=$_.Exception.Message }
        Check ($message -match 'network changed beyond adding failover') 'a base-network change must still be refused'
    }
    'fingerprint-record' = {
        $c=New-Config
        $script:networkOutput=@{vnetId=$vnet;functionsSubnetId="$vnet/subnets/functions";privateEndpointSubnetId="$vnet/subnets/private"
            storagePrivateEndpointIds=@();cosmosPrivateEndpointId='cosmos-pe';foundryPrivateEndpointIds=@()}
        function Get-StgStage { return @{names=@{apps=@{}};apimName=''} }
        function Read-StgState { return @{stages=@{}} }
        function Invoke-StgBicep { return $script:networkOutput | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable }
        function Invoke-StgFailoverEndpoints { return @() }
        function Get-StgNetworkDnsTargets { return @{zoneIds=@()} }
        function Get-StgCosmosDnsProblems { return @() }
        function Write-StgEvidence { return '' }
        function Get-StgArm($Id,$Version) {
            if ($Id.EndsWith('/privateDnsZoneGroups/default')) { return @{properties=@{privateDnsZoneConfigs=@(@{properties=@{recordSets=@(@{fqdn='private.example';ipAddresses=@('10.0.0.1')})}})}} }
            return @{name=$Id;properties=@{privateLinkServiceConnections=@(@{properties=@{privateLinkServiceConnectionState=@{status='Approved'}}})}}
        }
        $result=Invoke-Stage6 -Cfg $c -Apply
        Check ($result.verify.foundryFailoverBaseNetworkHash -ceq (Get-ExpectedBaseHash $c)) 'Stage 6 must record the failover-independent network fingerprint'
        Check ((Get-StgOutputHash $result) -ceq (Get-StgOutputHash $networkOutput)) 'recording the network fingerprint must not invalidate published app state'
    }
}
if ($CaseName -cne 'all' -and -not $cases.Contains($CaseName)) { throw "Unknown case $CaseName" }
foreach ($key in $cases.Keys) { if ($CaseName -ceq 'all' -or $CaseName -ceq $key) { & $cases[$key] } }
Write-Host "Foundry network review: $passed passed"
