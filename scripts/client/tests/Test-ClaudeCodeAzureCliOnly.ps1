# Tests for Install-ClaudeCodeAzureCli.ps1. Run under both engines:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\client\tests\Test-ClaudeCodeAzureCliOnly.ps1
#   pwsh -NoProfile -File scripts\client\tests\Test-ClaudeCodeAzureCliOnly.ps1
# Under PowerShell 7 it also checks parity with the Node-based setup (ClientGateway.Common.ps1, ClaudeCodeGateway.ps1,
# client/bin/validate-config.mjs).
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$installer = Join-Path $repo 'scripts\client\Install-ClaudeCodeAzureCli.ps1'
$engine = (Get-Process -Id $PID).Path
$isCore = $PSVersionTable.PSEdition -eq 'Core'
. $installer

$work = Join-Path ([IO.Path]::GetTempPath()) ('ccof azcli test ' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
$script:passed = 0; $script:failed = 0
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Test-Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:passed++; Write-Host "PASS: $Name" }
    catch { $script:failed++; Write-Host "FAIL: $Name - $($_.Exception.Message)" }
}
function Read-Json([string]$Path) { ConvertTo-CcofHashtable ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) }
function Write-Json([string]$Path, $Value) { [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 20)) }

# A fake Azure CLI in a folder with a space: login marks the profile signed in, get-access-token prints a token.
$fakeAzDir = Join-Path $work 'fake az'
[void][IO.Directory]::CreateDirectory($fakeAzDir)
$fakeAz = Join-Path $fakeAzDir 'az.cmd'
[IO.File]::WriteAllText($fakeAz, (@(
    '@echo off'
    'if not exist "%AZURE_CONFIG_DIR%" mkdir "%AZURE_CONFIG_DIR%"'
    '>>"%AZURE_CONFIG_DIR%\args.txt" echo %*'
    'if "%1"=="login" (type nul > "%AZURE_CONFIG_DIR%\signed-in" & exit /b 0)'
    'if "%1"=="logout" (del "%AZURE_CONFIG_DIR%\signed-in" 2>nul & exit /b 0)'
    'if not exist "%AZURE_CONFIG_DIR%\signed-in" exit /b 1'
    'if "%2"=="get-access-token" (echo fake.jwt.token& exit /b 0)'
    'if "%2"=="show" (echo dev@contoso.test& exit /b 0)'
    'exit /b 1') -join "`r`n"))

$group = 'aaaaaaaa-0000-4000-8000-000000000007'
function New-Config([hashtable]$Change = @{}) {
    $c = [ordered]@{
        schemaVersion = 1; tenantId = '11111111-1111-4111-8111-111111111111'; clientId = '22222222-2222-4222-8222-222222222222'
        scope = 'api://22222222-2222-4222-8222-222222222222/access_as_user'; gatewayUrl = 'https://gw.example.test/ccof'
        helperTtlSeconds = 300; minimumTokenLifetimeSeconds = 360; loginTimeoutSeconds = 120; tokenTimeoutSeconds = 30
        disableNonessentialTraffic = $true; signInMethod = 'azure-cli'
        models = [ordered]@{ default = 'claude-sonnet-5-5'; opus = 'claude-opus-5-5'; sonnet = 'claude-sonnet-5-5'; haiku = 'claude-haiku-4-5'
            available = @('claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'); capabilities = [ordered]@{ sonnet = 'thinking' } }
        desktop = [ordered]@{ profileId = '44444444-4444-4444-8444-444444444444'; profileName = 'CCOF' }
        project = [ordered]@{ id = $group; selectorHeader = 'x-ccof-project' }
    }
    foreach ($k in $Change.Keys) { $c[$k] = $Change[$k] }
    return $c
}

$n = 0
function New-Sandbox {
    $script:n++
    $root = Join-Path $work "user $script:n"
    $s = @{ Root = $root; Claude = (Join-Path $root '.claude'); State = (Join-Path $root 'AppData\Local\ClaudeGateway')
        VSCode = (Join-Path $root 'AppData\Roaming\Code\User\settings.json'); Ext = (Join-Path $root '.vscode\extensions'); Config = (Join-Path $root 'client-config.json') }
    [void][IO.Directory]::CreateDirectory($s.Claude)
    return $s
}
function Invoke-Installer($Sandbox, [string[]]$Extra) {
    # PATH holds only Windows and this engine: no Node, npm, Git or Python.
    $savedPath = $env:Path
    $env:Path = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0;$(Split-Path $engine -Parent)"
    try {
        $out = & $engine -NoProfile -ExecutionPolicy Bypass -File $installer -ClaudeHome $Sandbox.Claude -StateRoot $Sandbox.State `
            -VSCodeSettingsPath $Sandbox.VSCode -VSCodeExtensionsPath $Sandbox.Ext -AzureCliPath $fakeAz @Extra 2>&1 | Out-String
        return @{ Code = $LASTEXITCODE; Out = $out }
    } finally { $env:Path = $savedPath }
}

try {
    Test-Case 'node is not on the PATH the installer runs with' {
        $savedPath = $env:Path
        $env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
        try { Assert (-not (Get-Command node -ErrorAction SilentlyContinue)) 'node still resolvable' } finally { $env:Path = $savedPath }
    }

    Test-Case 'without -Confirmed it reports the targets and writes nothing' {
        $s = New-Sandbox; Write-Json $s.Config (New-Config)
        $r = Invoke-Installer $s @('-ConfigPath', $s.Config)
        Assert ($r.Code -eq 0) "exit $($r.Code): $($r.Out)"
        Assert ($r.Out -match 'Nothing was changed') $r.Out
        Assert (-not (Get-ChildItem -LiteralPath $s.Claude)) 'files written in preview'
        Assert (-not (Test-Path -LiteralPath $s.State)) 'state written in preview'
    }

    Test-Case 'a gateway URL ending in /v1/messages is refused with the corrected value' {
        $s = New-Sandbox; Write-Json $s.Config (New-Config @{ gatewayUrl = 'https://gw.example.test/ccof/v1/messages' })
        $r = Invoke-Installer $s @('-ConfigPath', $s.Config, '-Confirmed')
        Assert ($r.Code -eq 2) "exit $($r.Code)"
        Assert ($r.Out -match [regex]::Escape("Set it to 'https://gw.example.test/ccof'")) $r.Out
        Assert (-not (Get-ChildItem -LiteralPath $s.Claude)) 'files written on refusal'
    }

    Test-Case 'an msal configuration is refused, naming azure-cli' {
        $s = New-Sandbox; $c = New-Config; $c.Remove('signInMethod'); Write-Json $s.Config $c
        $r = Invoke-Installer $s @('-ConfigPath', $s.Config, '-Confirmed')
        Assert ($r.Code -eq 2 -and $r.Out -match 'azure-cli') "exit $($r.Code): $($r.Out)"
    }

    $main = New-Sandbox
    Write-Json $main.Config (New-Config)
    $originalSettings = '{"theme":"dark","model":"old","env":{"KEEP_ME":"yes","CLAUDE_CODE_USE_FOUNDRY":"1","ANTHROPIC_FOUNDRY_RESOURCE":"x","ANTHROPIC_CUSTOM_HEADERS":"X-Team: blue"}}'
    [IO.File]::WriteAllText((Join-Path $main.Claude 'settings.json'), $originalSettings)
    [void][IO.Directory]::CreateDirectory((Join-Path $main.Ext 'anthropic.claude-code-2.1.300-win32-x64'))
    [void][IO.Directory]::CreateDirectory((Split-Path $main.VSCode -Parent))
    $originalVSCode = '{"editor.fontSize":17,"claudeCode.environmentVariables":[{"name":"KEEP_VSCODE","value":"yes"},{"name":"CLAUDE_CODE_USE_FOUNDRY","value":"1"}]}'
    [IO.File]::WriteAllText($main.VSCode, $originalVSCode)
    $script:applied = $null

    Test-Case 'setup merges settings.json, pins models, sets the helper and group header, keeps unrelated keys' {
        $r = Invoke-Installer $main @('-ConfigPath', $main.Config, '-Confirmed')
        Assert ($r.Code -eq 0) "exit $($r.Code): $($r.Out)"
        $script:applied = $r
        $set = Read-Json (Join-Path $main.Claude 'settings.json')
        $helper = Join-Path $main.Claude 'ccof-token.cmd'
        Assert ($set.theme -eq 'dark' -and $set.env.KEEP_ME -eq 'yes') 'unrelated settings lost'
        Assert ($set.apiKeyHelper -ceq "`"$helper`" token") "apiKeyHelper: $($set.apiKeyHelper)"
        Assert ($set.env.ANTHROPIC_BASE_URL -ceq 'https://gw.example.test/ccof') 'base URL'
        Assert ($set.env.CLAUDE_CODE_USE_FOUNDRY -ceq '0' -and -not $set.env.Contains('ANTHROPIC_FOUNDRY_RESOURCE')) 'Foundry route not cleared'
        Assert ($set.env.ANTHROPIC_AUTH_TOKEN -ceq '' -and $set.env.ANTHROPIC_API_KEY -ceq '') 'static credentials not cleared'
        Assert ($set.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS -ceq '240000') "TTL $($set.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS)"
        Assert ($set.env.ANTHROPIC_CUSTOM_HEADERS -ceq "X-Team: blue`nx-ccof-project: $group") "headers: $($set.env.ANTHROPIC_CUSTOM_HEADERS)"
        Assert ($set.model -ceq 'claude-sonnet-5-5' -and $set.env.ANTHROPIC_MODEL -ceq 'claude-sonnet-5-5') 'default model'
        Assert ($set.env.ANTHROPIC_DEFAULT_HAIKU_MODEL -ceq 'claude-haiku-4-5' -and $set.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES -ceq 'thinking') 'alias pins'
        Assert (@($set.availableModels).Count -eq 3 -and $set.enforceAvailableModels -eq $true) 'model allowlist'
        Assert ($set.env.CCOF_CONFIG_FILE -ceq (Join-Path $main.State 'config.json')) 'config path'
        Assert (Test-Path -LiteralPath (Join-Path $main.State 'config.json')) 'config not installed'
    }

    Test-Case 'the VS Code extension settings get the same environment and keep unrelated entries' {
        $v = Read-Json $main.VSCode
        $entries = @($v['claudeCode.environmentVariables'])
        Assert ($v['editor.fontSize'] -eq 17 -and $v['claudeCode.disableLoginPrompt'] -eq $true) 'VS Code keys'
        Assert (@($entries | Where-Object { $_.name -eq 'KEEP_VSCODE' }).Count -eq 1) 'unrelated VS Code entry lost'
        $foundry = @($entries | Where-Object { $_.name -eq 'CLAUDE_CODE_USE_FOUNDRY' })
        Assert ($foundry.Count -eq 1 -and $foundry[0].value -ceq '0') 'VS Code Foundry entry not replaced'
        Assert (@($entries | Where-Object { $_.name -eq 'ANTHROPIC_BASE_URL' -and $_.value -ceq 'https://gw.example.test/ccof' }).Count -eq 1) 'VS Code base URL'
    }

    Test-Case 'the helper signs in through az, then prints only the token' {
        # Windows PowerShell 5.1 turns redirected native stderr into errors; this case checks exit codes instead.
        $ErrorActionPreference = 'Continue'
        $helper = Join-Path $main.Claude 'ccof-token.cmd'
        $null = & $helper silent-token 2>$null
        Assert ($LASTEXITCODE -eq 4) "silent-token before login exited $LASTEXITCODE"
        & $helper login 2>$null
        Assert ($LASTEXITCODE -eq 0) "login exited $LASTEXITCODE"
        $out = @(& $helper silent-token 2>$null)
        Assert ($LASTEXITCODE -eq 0 -and $out.Count -eq 1 -and $out[0].Trim() -ceq 'fake.jwt.token') "token output: $($out -join '|')"
        $azArgs = [IO.File]::ReadAllText((Join-Path $main.State 'az\args.txt'))
        Assert ($azArgs -match '--tenant "11111111-1111-4111-8111-111111111111" --scope "api://22222222-2222-4222-8222-222222222222/access_as_user"') "az args: $azArgs"
    }

    Test-Case 'a single available model is still written as a JSON array' {
        $s = New-Sandbox
        $c = New-Config; $c.models.available = @('claude-sonnet-5-5'); $c.models.opus = 'claude-sonnet-5-5'; $c.models.haiku = 'claude-sonnet-5-5'
        Write-Json $s.Config $c
        $r = Invoke-Installer $s @('-ConfigPath', $s.Config, '-Confirmed')
        Assert ($r.Code -eq 0) "exit $($r.Code): $($r.Out)"
        Assert ([IO.File]::ReadAllText((Join-Path $s.Claude 'settings.json')) -match '"availableModels":\s*\[') 'availableModels not an array'
    }

    Test-Case 'the gateway test sends the token and group header, and reports a 200 and a refusal' {
        $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $port = $listener.LocalEndpoint.Port
        $server = [powershell]::Create().AddScript({
            param($listener)
            $seen = @()
            foreach ($reply in @(@(200, '{"content":[{"type":"text","text":"gateway OK"}]}'), @(403, '{"error":{"type":"permission_error","message":"not an active member of Claude group"}}'))) {
                $deadline = [DateTime]::UtcNow.AddSeconds(60)
                while (-not $listener.Pending() -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
                if (-not $listener.Pending()) { break }
                $client = $listener.AcceptTcpClient()
                $stream = $client.GetStream()
                $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII)
                $head = @(); while (($line = $reader.ReadLine())) { $head += $line }
                $length = 0; foreach ($h in $head) { if ($h -match '^Content-Length:\s*(\d+)') { $length = [int]$Matches[1] } }
                $buffer = New-Object char[] $length; $read = 0; while ($read -lt $length) { $read += $reader.Read($buffer, $read, $length - $read) }
                $seen += , @($head + (New-Object string (, $buffer)))
                $bytes = [Text.Encoding]::UTF8.GetBytes($reply[1])
                $status = if ($reply[0] -eq 200) { '200 OK' } else { '403 Forbidden' }
                $response = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n")
                $stream.Write($response, 0, $response.Length); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
                $client.Close()
            }
            , $seen
        }).AddArgument($listener)
        $async = $server.BeginInvoke()
        try {
            $config = (Test-CcofClientConfiguration (Read-Json $main.Config)).Config
            $helper = Join-Path $main.Claude 'ccof-token.cmd'
            $ok = Invoke-CcofGatewayTest -Helper $helper -Config $config -Url "http://127.0.0.1:$port/ccof/v1/messages"
            $refused = Invoke-CcofGatewayTest -Helper $helper -Config $config -Url "http://127.0.0.1:$port/ccof/v1/messages"
            $seen = $server.EndInvoke($async)[0]
        } finally { $listener.Stop(); $server.Dispose() }
        Assert ($ok.Status -eq 200 -and $ok.Message -ceq 'gateway OK') "200 case: $($ok.Status) $($ok.Message)"
        Assert ($refused.Status -eq 403 -and $refused.Message -ceq 'not an active member of Claude group') "403 case: $($refused.Status) $($refused.Message)"
        $first = $seen[0] -join "`n"
        Assert ($first -match '(?m)^POST /ccof/v1/messages ') 'request line'
        Assert ($first -match '(?mi)^Authorization: Bearer fake\.jwt\.token$') 'bearer token not sent'
        Assert ($first -match "(?mi)^x-ccof-project: $group$") 'group header not sent'
        Assert ($first -match '(?mi)^anthropic-version: 2023-06-01$') 'anthropic-version not sent'
        Assert ($first -match '"model":"claude-sonnet-5-5"') 'model not in body'
    }

    Test-Case 'restore puts every file back as it was and removes what setup created' {
        $backup = @(Get-ChildItem -LiteralPath (Join-Path $main.State 'backups') -Directory)[0].FullName
        $r = Invoke-Installer $main @('-Restore', $backup, '-Confirmed')
        Assert ($r.Code -eq 0) "exit $($r.Code): $($r.Out)"
        Assert ([IO.File]::ReadAllText((Join-Path $main.Claude 'settings.json')) -ceq $originalSettings) 'settings not restored'
        Assert ([IO.File]::ReadAllText($main.VSCode) -ceq $originalVSCode) 'VS Code not restored'
        Assert (-not (Test-Path -LiteralPath (Join-Path $main.Claude 'ccof-token.cmd'))) 'helper left behind'
        Assert (-not (Test-Path -LiteralPath (Join-Path $main.State 'config.json'))) 'installed config left behind'
    }

    Test-Case 'restore refuses when a file changed after setup, unless -AllowChangedFiles' {
        $s = New-Sandbox; Write-Json $s.Config (New-Config)
        $r = Invoke-Installer $s @('-ConfigPath', $s.Config, '-Confirmed')
        Assert ($r.Code -eq 0) "setup exit $($r.Code)"
        $settingsPath = Join-Path $s.Claude 'settings.json'
        [IO.File]::AppendAllText($settingsPath, ' ')
        $backup = @(Get-ChildItem -LiteralPath (Join-Path $s.State 'backups') -Directory)[0].FullName
        $r = Invoke-Installer $s @('-Restore', $backup, '-Confirmed')
        Assert ($r.Code -eq 1 -and (Test-Path -LiteralPath $settingsPath)) "changed-file restore exit $($r.Code)"
        $r = Invoke-Installer $s @('-Restore', $backup, '-Confirmed', '-AllowChangedFiles')
        Assert ($r.Code -eq 0 -and -not (Test-Path -LiteralPath $settingsPath)) "forced restore exit $($r.Code)"
    }

    Test-Case 'a VS Code settings.json with comments and trailing commas is read, as PowerShell 7 does' {
        $s = New-Sandbox; Write-Json $s.Config (New-Config)
        [void][IO.Directory]::CreateDirectory((Join-Path $s.Ext 'anthropic.claude-code-2.1.300-win32-x64'))
        [void][IO.Directory]::CreateDirectory((Split-Path $s.VSCode -Parent))
        [IO.File]::WriteAllText($s.VSCode, "{`n  // font`n  `"editor.fontSize`": 15, /* block */`n  `"a.url`": `"http://x//y`",`n  `"list`": [1, 2,],`n}`n")
        $r = Invoke-Installer $s @('-ConfigPath', $s.Config, '-Confirmed')
        Assert ($r.Code -eq 0) "exit $($r.Code): $($r.Out)"
        $v = Read-Json $s.VSCode
        Assert ($v['editor.fontSize'] -eq 15 -and $v['a.url'] -ceq 'http://x//y' -and @($v.list).Count -eq 2) 'VS Code values lost'
        Assert (@($v['claudeCode.environmentVariables'] | Where-Object { $_.name -eq 'ANTHROPIC_BASE_URL' }).Count -eq 1) 'environment not merged'
    }

    Test-Case 'configuration types are checked strictly: schemaVersion "1" and a string models.available are refused' {
        $c = New-Config @{ schemaVersion = '1' }
        Assert ((Test-CcofClientConfiguration (ConvertTo-CcofHashtable ((ConvertTo-Json $c -Depth 10) | ConvertFrom-Json))).Problems.Count) 'schemaVersion "1" accepted'
        $c = New-Config; $c.models = [ordered]@{ default = 'm'; opus = 'm'; sonnet = 'm'; haiku = 'm'; available = 'm' }
        Assert ((Test-CcofClientConfiguration (ConvertTo-CcofHashtable ((ConvertTo-Json $c -Depth 10) | ConvertFrom-Json))).Problems.Count) 'string models.available accepted'
    }

    Test-Case 'invalid existing settings.json is refused and left untouched' {
        $s = New-Sandbox; Write-Json $s.Config (New-Config)
        [IO.File]::WriteAllText((Join-Path $s.Claude 'settings.json'), '{ broken')
        $r = Invoke-Installer $s @('-ConfigPath', $s.Config, '-Confirmed')
        Assert ($r.Code -eq 1 -and $r.Out -match 'not valid JSON') "exit $($r.Code): $($r.Out)"
        Assert ([IO.File]::ReadAllText((Join-Path $s.Claude 'settings.json')) -ceq '{ broken') 'broken file overwritten'
        Assert (-not (Test-Path -LiteralPath (Join-Path $s.Claude 'ccof-token.cmd'))) 'helper written on refusal'
    }

    if ($isCore) {
        . (Join-Path $repo 'scripts\client\ClientGateway.Common.ps1')
        . (Join-Path $repo 'scripts\client\ClaudeCodeGateway.ps1')

        Test-Case 'parity: the helper is byte-identical to the Node-based setup''s azure-cli helper' {
            $a = @{ TenantId = '11111111-1111-4111-8111-111111111111'; Scope = 'api://22222222-2222-4222-8222-222222222222/access_as_user'
                AzureConfigDir = 'C:\Users\a b%x\AppData\Local\ClaudeGateway\az'; AzureCliPath = 'C:\Program Files\Azure CLI\wbin\az.cmd' }
            Assert ((New-CcofAzCliHelperText @a) -ceq (New-ClientAzureCliTokenShim @a)) 'helper text differs'
        }

        Test-Case 'parity: the Claude Code environment equals New-CcofCodeEnvironment for azure-cli' {
            foreach ($c in @((New-Config), (New-Config @{ helperTtlSeconds = 120; minimumTokenLifetimeSeconds = 200; disableNonessentialTraffic = $false }))) {
                $c2 = (Test-CcofClientConfiguration (ConvertTo-CcofHashtable ((ConvertTo-Json $c -Depth 10) | ConvertFrom-Json))).Config
                Assert $c2 'config refused'
                $mine = New-CcofCodeEnvironmentValues $c2 'C:\x\config.json'
                $theirs = New-CcofCodeEnvironment $c2 'C:\x\config.json'
                Assert (($mine.Keys | Sort-Object) -join ',' -ceq (($theirs.Keys | Sort-Object) -join ',')) 'keys differ'
                foreach ($k in $theirs.Keys) { Assert ([string]$mine[$k] -ceq [string]$theirs[$k]) "value differs for $k" }
            }
        }

        $node = Get-Command node -ErrorAction SilentlyContinue
        if ($node) {
            Test-Case 'parity: configurations accepted or refused exactly as the Node validator does' {
                $cases = @(
                    @{ Name = 'valid'; Config = (New-Config) }
                    @{ Name = 'trailing slash'; Config = (New-Config @{ gatewayUrl = 'https://gw.example.test/ccof/' }) }
                    @{ Name = '/v1'; Config = (New-Config @{ gatewayUrl = 'https://gw.example.test/ccof/v1' }) }
                    @{ Name = '/v1/messages'; Config = (New-Config @{ gatewayUrl = 'https://gw.example.test/ccof/v1/messages' }) }
                    @{ Name = 'http'; Config = (New-Config @{ gatewayUrl = 'http://gw.example.test/ccof' }) }
                    @{ Name = 'query'; Config = (New-Config @{ gatewayUrl = 'https://gw.example.test/ccof?x=1' }) }
                    @{ Name = 'tenant'; Config = (New-Config @{ tenantId = 'contoso' }) }
                    @{ Name = 'self GUID scope'; Config = (New-Config @{ scope = '22222222-2222-4222-8222-222222222222/access_as_user' }) }
                    @{ Name = 'scope with space'; Config = (New-Config @{ scope = 'api://x/access as user' }) }
                    @{ Name = 'ttl order'; Config = (New-Config @{ minimumTokenLifetimeSeconds = 300 }) }
                    @{ Name = 'extra key'; Config = (New-Config @{ extra = 1 }) }
                    @{ Name = 'model not available'; Config = (New-Config @{ models = [ordered]@{ default = 'x'; opus = 'claude-opus-5-5'; sonnet = 'claude-opus-5-5'; haiku = 'claude-opus-5-5'; available = @('claude-opus-5-5') } }) }
                    @{ Name = 'project header reserved'; Config = (New-Config @{ project = [ordered]@{ id = $group; selectorHeader = 'authorization' } }) }
                    @{ Name = 'null project id'; Config = (New-Config @{ project = [ordered]@{ id = $null; selectorHeader = 'x-ccof-project' } }) }
                    @{ Name = 'schemaVersion string'; Config = (New-Config @{ schemaVersion = '1' }) }
                    @{ Name = 'available string'; Config = (New-Config @{ models = [ordered]@{ default = 'm'; opus = 'm'; sonnet = 'm'; haiku = 'm'; available = 'm' } }) }
                )
                foreach ($case in $cases) {
                    $file = Join-Path $work "parity-$([guid]::NewGuid().ToString('N')).json"
                    Write-Json $file $case.Config
                    $null = & $node.Source (Join-Path $repo 'client\bin\validate-config.mjs') $file 2>$null
                    $nodeOk = $LASTEXITCODE -eq 0
                    $mineOk = -not (Test-CcofClientConfiguration (Read-Json $file)).Problems.Count
                    Assert ($nodeOk -eq $mineOk) "$($case.Name): node $nodeOk, installer $mineOk"
                }
            }
        } else { Write-Host 'SKIP: Node validator parity (node not installed)' }
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion): $script:passed passed, $script:failed failed"
if ($script:failed -gt 0 -or $script:passed -lt 14) { exit 1 }
exit 0
