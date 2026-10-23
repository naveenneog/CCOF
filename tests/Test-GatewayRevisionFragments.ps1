#Requires -Version 7.0
# Core gateway revision deployment with policy fragments (ADR-0039): API Management refuses an API policy
# over 16 KB, so the fragments are saved before the revision's API policy, which includes them.
# No Azure calls: a fake ARM session records every request.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'infra\gateway\GatewayDeploy.psm1') -Force
$passed = 0
function Assert-That([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAIL: $Message" }; $script:passed++ }

$work = Join-Path ([IO.Path]::GetTempPath()) "gw-frag-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $sub = '00000000-0000-4000-8000-000000000001'
    $configPath = Join-Path $work 'gateway-config.json'
    @{ configurationId = 'cfg-1'; apim = @{ subscriptionId = $sub; resourceGroup = 'rg'; serviceName = 'apim1'; apiId = 'claude-messages'; apiPath = 'anthropic'; gatewayBaseUrl = 'https://apim1.azure-api.net' } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
    $apiPolicy = '<policies><inbound><base /><include-fragment fragment-id="claude-messages-inbound-aaaaaaaaaaaa" /></inbound><backend><include-fragment fragment-id="claude-messages-backend-bbbbbbbbbbbb" /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>'
    $digest = 'a' * 64
    $render = {
        param($Config, $Out)
        [pscustomobject]@{ ConfigurationId = 'cfg-1'; ApiId = 'claude-messages'; PolicySha256 = $digest; ConfigSha256 = 'c' * 64; TemplateSha256 = 't' * 64
            PolicyXml = '<policies><!-- full --></policies>'
            Deployment = @{ apiPolicyXml = $apiPolicy; fragments = @(@{ id = 'claude-messages-inbound-aaaaaaaaaaaa'; xml = '<fragment><set-variable name="a" value="1" /></fragment>' }, @{ id = 'claude-messages-backend-bbbbbbbbbbbb'; xml = '<fragment><forward-request /></fragment>' }) } }
    }.GetNewClosure()
    $calls = [Collections.Generic.List[object]]::new()
    $service = "/subscriptions/$sub/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim1"
    $arm = {
        param([string]$Method, [string]$Path, $Body, [hashtable]$Headers)
        $calls.Add([pscustomobject]@{ Method = $Method; Path = $Path; Body = $Body })
        $p = $Path.Split('?')[0]
        if ($Method -eq 'GET' -and $p -ceq "$service/apis/claude-messages") { return [pscustomobject]@{ Status = 200; Body = @{ properties = @{ path = 'anthropic' } } } }
        if ($Method -eq 'GET' -and $p -like '*/revisions') { return [pscustomobject]@{ Status = 200; Body = @{ value = @(@{ apiRevision = '1'; isCurrent = $true; isOnline = $true }) } } }
        if ($Method -eq 'GET' -and $p -like '*/policies/policy') { $stored = @($calls | Where-Object { $_.Method -eq 'PUT' -and $_.Path -like '*rev=2/policies/policy*' })[-1]; return [pscustomobject]@{ Status = 200; Body = @{ properties = @{ value = $(if ($stored) { $stored.Body.properties.value } else { '<policies />' }) } } } }
        if ($Method -eq 'GET' -and $p -like '*;rev=2') { return [pscustomobject]@{ Status = 200; Body = @{ properties = @{ isCurrent = $false } } } }
        if ($Method -eq 'PUT') { return [pscustomobject]@{ Status = 201; Body = @{ properties = @{ isCurrent = $false } } } }
        throw "unexpected $Method $Path"
    }.GetNewClosure()
    $answers = Join-Path $work 'answers.json'
    @{ action = 'createRevision'; apiId = 'claude-messages'; configurationId = 'cfg-1'; expectedCurrentRevision = '1'; policySha256 = $digest; approvedBy = '00000000-0000-4000-8000-000000000002' } | ConvertTo-Json | Set-Content -LiteralPath $answers -Encoding utf8NoBOM

    $result = Invoke-GatewayRevisionDeployment -ConfigPath $configPath -OutDir $work -AnswersPath $answers -Render $render -ArmSession ([pscustomobject]@{ Invoke = $arm; ActorObjectId = 'x' }) 6>$null

    $puts = @($calls | Where-Object Method -eq 'PUT')
    $fragmentPuts = @($puts | Where-Object { $_.Path -like "$service/policyFragments/*" })
    $policyPut = @($puts | Where-Object { $_.Path -like '*rev=2/policies/policy*' })
    Assert-That ($fragmentPuts.Count -eq 2) "both fragments are saved (got $($fragmentPuts.Count))"
    Assert-That (($fragmentPuts | ForEach-Object { $_.Path.Split('?')[0].Split('/')[-1] }) -join ',' -ceq 'claude-messages-inbound-aaaaaaaaaaaa,claude-messages-backend-bbbbbbbbbbbb') 'fragment IDs are the rendered ones'
    Assert-That ($fragmentPuts[0].Body.properties.format -ceq 'rawxml' -and $fragmentPuts[0].Body.properties.value -like '<fragment>*') 'fragments are saved as raw XML'
    Assert-That ($policyPut.Count -eq 1 -and $policyPut[0].Body.properties.value -ceq $apiPolicy) 'the revision gets the API policy that includes the fragments, not the full rendered policy'
    Assert-That ($puts.IndexOf($fragmentPuts[-1]) -lt $puts.IndexOf($policyPut[0])) 'fragments are saved before the API policy that includes them'
    Assert-That ($result.StoredMatchesRendered -eq $true) 'the stored policy is compared with the deployed API policy'

    $noDeployment = { param($Config, $Out) [pscustomobject]@{ ConfigurationId = 'cfg-1'; ApiId = 'claude-messages'; PolicySha256 = $digest; ConfigSha256 = 'c' * 64; TemplateSha256 = 't' * 64; PolicyXml = '<policies />' } }.GetNewClosure()
    $calls.Clear()
    $refused = try { Invoke-GatewayRevisionDeployment -ConfigPath $configPath -OutDir $work -AnswersPath $answers -Render $noDeployment -ArmSession ([pscustomobject]@{ Invoke = $arm; ActorObjectId = 'x' }) 6>$null; '' } catch { $_.Exception.Message }
    Assert-That ($refused -match 'policy_deployment_missing') "a render without the fragment split is refused ($refused)"
    Assert-That (@($calls | Where-Object Method -eq 'PUT').Count -eq 0) 'nothing is written when the split is missing'
} finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
"Gateway revision fragments: $passed checks passed. No Azure calls."
