#Requires -Version 7.0
<#
.SYNOPSIS
    Runs scripts/manual/Test-NetworkConfiguration.ps1 against a fake az (first on PATH) to prove its Cosmos regional
    DNS check (ADR-0036): every configured region needs <account>-<region> in privatelink.documents.azure.com, the
    global name is required too, and without -CosmosRegions the check is not run. No Azure call.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$work = Join-Path ([IO.Path]::GetTempPath()) "net-cosmos-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory $work | Out-Null
$passed = 0; $failed = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') { if ($Ok) { $script:passed++; Write-Host "PASS: $Name" } else { $script:failed++; Write-Host "FAIL: $Name $Detail" } }

$sub = '00000000-0000-4000-8000-000000000002'
$cosmosId = "/subscriptions/$sub/resourceGroups/rg/providers/Microsoft.DocumentDB/databaseAccounts/acct"
$vnetId = "/subscriptions/$sub/resourceGroups/netrg/providers/Microsoft.Network/virtualNetworks/vnet"
# The fake answers the two calls this check reads and [] for everything else.
$fake = @'
$joined = $args -join ' '
if ($joined -match 'dns-zone-group list') {
    $names = @($env:FAKE_COSMOS_DNS -split ',' | Where-Object { $_ })
    $sets = @($names | ForEach-Object { @{ fqdn = "$_.privatelink.documents.azure.com."; ipAddresses = @('10.0.0.4') } })
    @(@{ privateDnsZoneConfigs = @(@{ privateDnsZoneId = '/subscriptions/s/resourceGroups/hub/providers/Microsoft.Network/privateDnsZones/privatelink.documents.azure.com'; recordSets = $sets }) }) | ConvertTo-Json -Depth 10 -AsArray
} elseif ($joined -match 'private-endpoint list') {
    @(@{ name = 'acct-pe'; subnet = @{ id = 'x/subnets/pe' }; privateLinkServiceConnections = @(@{ privateLinkServiceId = $env:FAKE_COSMOS_ID; groupIds = @('Sql'); privateLinkServiceConnectionState = @{ status = 'Approved' } }); manualPrivateLinkServiceConnections = @() }) | ConvertTo-Json -Depth 10 -AsArray
} else { '[]' }
exit 0
'@
Set-Content -LiteralPath (Join-Path $work 'fake-az.ps1') -Value $fake -Encoding utf8NoBOM
if ($IsWindows) {
    Set-Content -LiteralPath (Join-Path $work 'az.cmd') -Value "@pwsh -NoProfile -File `"%~dp0fake-az.ps1`" %*`r`n" -Encoding ascii
} else {
    # On macOS and Linux az is a shell script found on PATH; the fake is one too.
    $fakeAz = Join-Path $work 'az'
    Set-Content -LiteralPath $fakeAz -Value "#!/bin/sh`nexec pwsh -NoProfile -File `"`$(dirname `"`$0`")/fake-az.ps1`" `"`$@`"`n" -Encoding ascii -NoNewline
    chmod +x $fakeAz
}
$savedPath = $env:PATH
try {
    $env:PATH = "$work$([IO.Path]::PathSeparator)$env:PATH"; $env:FAKE_COSMOS_ID = $cosmosId
    function Run([string]$Dns, [string[]]$Regions) {
        $env:FAKE_COSMOS_DNS = $Dns
        $result = Join-Path $work "result-$([guid]::NewGuid().ToString('N')).json"
        $params = @{ SubscriptionId = $sub; VnetResourceId = $vnetId; FlexSubnet = 'f'; PeSubnet = 'pe'; CosmosResourceId = $cosmosId
            StorageAccountIds = @('/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/st'); FunctionAppIds = @('/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/app'); ResultPath = $result }
        if ($Regions) { $params.CosmosRegions = $Regions }
        $null = & (Join-Path $root 'scripts\manual\Test-NetworkConfiguration.ps1') @params *>&1
        return @(Get-Content -LiteralPath $result -Raw | ConvertFrom-Json | Where-Object { $_.Item -eq 'Cosmos regional names' })
    }
    $resolved = (Get-Command az -CommandType Application | Select-Object -First 1).Source
    Check 'the fake az is the one the script resolves' ($resolved -like "$work*") $resolved
    $all = Run 'acct,acct-eastus2,acct-centralus' @('eastus2', 'centralus')
    Check 'every region and the global name present: PASS' ($all.Count -eq 1 -and $all[0].State -eq 'PASS') ($all | ConvertTo-Json -Compress)
    $missing = Run 'acct,acct-eastus2' @('eastus2', 'centralus')
    Check 'a missing secondary region name: FAIL naming it' ($missing.Count -eq 1 -and $missing[0].State -eq 'FAIL' -and $missing[0].Detail -match 'acct-centralus') ($missing | ConvertTo-Json -Compress)
    $noGlobal = Run 'acct-eastus2' @('eastus2')
    Check 'a missing global name: FAIL' ($noGlobal.Count -eq 1 -and $noGlobal[0].State -eq 'FAIL' -and $noGlobal[0].Detail -match '\bacct\b') ($noGlobal | ConvertTo-Json -Compress)
    $absent = Run 'acct' $null
    Check 'without -CosmosRegions the check is not run' ($absent.Count -eq 0) ($absent | ConvertTo-Json -Compress)
} finally {
    $env:PATH = $savedPath; Remove-Item Env:FAKE_COSMOS_DNS, Env:FAKE_COSMOS_ID -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
Write-Host "$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
exit 0
