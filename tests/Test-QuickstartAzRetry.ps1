#Requires -Version 7.0
<#
.SYNOPSIS
    Invoke-QsAz retries only the Cloud Shell token-broker timeout ("Timeout waiting for token from
    portal", live 2026-10-14) and fails at once on every other az error. Fake az; no Azure call.
#>
$ErrorActionPreference = 'Continue'
$script:Pass = 0; $script:Fail = 0
$root = Split-Path $PSScriptRoot -Parent
function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    if ($Condition) { Write-Host "PASS: $Name" -ForegroundColor Green; $script:Pass++ }
    else { Write-Host "FAIL: $Name $Detail" -ForegroundColor Red; $script:Fail++ }
}
. (Join-Path $root 'infra' 'quickstart' 'Deploy-Quickstart.ps1') -DotSourceOnly
$script:QsTokenRetrySeconds = @(0, 0, 0)
$timeout = 'ERROR: Timeout waiting for token from portal. Audience: https://graph.microsoft.com/'

function az { $script:Calls++; $answer = $script:Answers[[Math]::Min($script:Calls, $script:Answers.Count) - 1]; $global:LASTEXITCODE = $answer.Code; $answer.Out }

$script:Calls = 0; $script:Answers = @(@{ Code = 1; Out = $timeout }, @{ Code = 0; Out = '{"id":"g1"}' })
$r = $null; $m = ''; try { $r = Invoke-QsAz @('rest', '--method', 'get', '--url', 'https://graph.microsoft.com/v1.0/groups/g1') } catch { $m = $_.Exception.Message }
Assert-True 'a token-broker timeout is retried and the later answer returned' ($r.id -ceq 'g1' -and $script:Calls -eq 2 -and -not $m) "calls=$script:Calls $m"

$script:Calls = 0; $script:Answers = @(@{ Code = 1; Out = $timeout })
$m = ''; try { $null = Invoke-QsAz @('rest', '--method', 'get', '--url', 'https://graph.microsoft.com/v1.0/groups/g1') } catch { $m = $_.Exception.Message }
Assert-True 'a timeout that persists fails after three retries, naming the recovery' ($script:Calls -eq 4 -and $m -match 'Reload the Azure Portal' -and $m -match 'get-access-token --resource https://graph') "calls=$script:Calls $m"

$script:Calls = 0; $script:Answers = @(@{ Code = 1; Out = "ERROR: Please run 'az login' to setup account." })
$m = ''; try { $null = Invoke-QsAz @('rest', '--method', 'get', '--url', 'https://graph.microsoft.com/v1.0/groups/g1') } catch { $m = $_.Exception.Message }
Assert-True 'any other az error fails at once without retry' ($script:Calls -eq 1 -and $m -match "az login") "calls=$script:Calls $m"

# ARM errors nest the cause several levels down, sometimes as a JSON string inside "message" (Cosmos DB). The first
# line names the failing resource and its innermost message; the full error follows unchanged. Live 2026-10-25.
$zonal = 'ERROR: {"status":"Failed","error":{"code":"DeploymentFailed","target":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg/providers/Microsoft.Resources/deployments/stage1-services","message":"At least one resource deployment operation failed.","details":[{"code":"ResourceDeploymentFailure","target":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg/providers/Microsoft.DocumentDB/databaseAccounts/lab-cosmos","message":"The resource write operation failed to complete successfully.","details":[{"code":"ServiceUnavailable","message":"Database account creation failed. Operation Id: 1, Error : Message: {\"code\":\"ServiceUnavailable\",\"message\":\"Sorry, we are currently experiencing high demand in East US 2 region for the zonal redundant (Availability Zones) accounts.\\r\\nActivityId: 2\"}, Request URI: /serviceReservation"}]}]}}'
$script:Calls = 0; $script:Answers = @(@{ Code = 1; Out = $zonal })
$m = ''; try { $null = Invoke-QsAz @('deployment', 'group', 'create') } catch { $m = $_.Exception.Message }
$first = ($m -split "`n")[0]
Assert-True 'an ARM failure leads with the failing resource and its innermost message' ($first -match '^az deployment group failed: Microsoft\.DocumentDB/databaseAccounts/lab-cosmos: ServiceUnavailable: Sorry, we are currently experiencing high demand in East US 2 region for the zonal redundant \(Availability Zones\) accounts\.$') $first
Assert-True 'the full ARM error still follows the summary' ($m.Contains($zonal)) $m
$failedState = 'ERROR: {"status":"Failed","error":{"code":"DeploymentFailed","message":"At least one resource deployment operation failed.","details":[{"code":"BadRequest","target":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/rg/providers/Microsoft.DocumentDB/databaseAccounts/lab-cosmos","message":"{\r\n  \"code\": \"BadRequest\",\r\n  \"message\": \"DatabaseAccount lab-cosmos is in a failed provisioning state because the previous attempt to create it was not successful. Please delete the previous instance before attempting to recreate this account.\\r\\nActivityId: 3\"\r\n}"}]}}'
$script:Calls = 0; $script:Answers = @(@{ Code = 1; Out = $failedState })
$m = ''; try { $null = Invoke-QsAz @('deployment', 'group', 'create') } catch { $m = $_.Exception.Message }
$first = ($m -split "`n")[0]
Assert-True 'a message that is itself JSON is unwrapped' ($first -match 'databaseAccounts/lab-cosmos: BadRequest: DatabaseAccount lab-cosmos is in a failed provisioning state .* Please delete the previous instance before attempting to recreate this account\.$') $first
$script:Calls = 0; $script:Answers = @(@{ Code = 1; Out = 'ERROR: not json {' })
$m = ''; try { $null = Invoke-QsAz @('deployment', 'group', 'create') } catch { $m = $_.Exception.Message }
Assert-True 'an error that is not ARM JSON is reported unchanged' ($m -ceq 'az deployment group failed: ERROR: not json {') $m

Write-Host "$script:Pass passed, $script:Fail failed"
if ($script:Fail) { exit 1 }
