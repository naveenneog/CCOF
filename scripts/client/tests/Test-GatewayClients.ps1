#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
. (Join-Path $repo 'scripts/client/ClientGateway.Common.ps1')
. (Join-Path $repo 'scripts/client/ClaudeCodeGateway.ps1')
. (Join-Path $repo 'scripts/client/ClaudeDesktopGateway.ps1')
. (Join-Path $repo 'scripts/client/DeveloperSignInRedirects.ps1')

$work = Join-Path $repo ('client/.test-work/scripts-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
$script:passed = 0
$script:failed = 0
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Test-Case([string]$Name, [scriptblock]$Test) {
    try { & $Test; $script:passed++; Write-Host "PASS: $Name" }
    catch { $script:failed++; Write-Host "FAIL: $Name - $($_.Exception.Message)" }
}
function Refuses([scriptblock]$Action, [string]$Pattern) {
    try { & $Action | Out-Null } catch {
        Assert ($_.Exception.Message -match $Pattern) "Refusal did not name the expected remedy: $($_.Exception.Message)"
        return
    }
    throw 'Expected refusal'
}

try {
    $configPath = Join-Path $work 'config.json'
    $config = @{
        schemaVersion = 1
        tenantId = '11111111-1111-4111-8111-111111111111'
        clientId = '22222222-2222-4222-8222-222222222222'
        scope = 'api://33333333-3333-4333-8333-333333333333/access_as_user'
        gatewayUrl = 'https://gateway.example.test/anthropic'
        helperTtlSeconds = 300; minimumTokenLifetimeSeconds = 360
        loginTimeoutSeconds = 120; tokenTimeoutSeconds = 30
        disableNonessentialTraffic = $true
        models = @{ default = 'sonnet-deployment'; opus = 'opus-deployment'
            sonnet = 'sonnet-deployment'; haiku = 'haiku-deployment'
            available = @('sonnet-deployment', 'opus-deployment', 'haiku-deployment')
            capabilities = @{ opus = 'thinking,adaptive_thinking'; sonnet = 'thinking,adaptive_thinking' } }
        desktop = @{ profileId = '44444444-4444-4444-8444-444444444444'; profileName = 'Test gateway' }
    }
    Write-ClientJson $configPath $config
    $backupRoot = Join-Path $work 'backups'
    $claudeHome = Join-Path $work '.claude'
    $vscodePath = Join-Path $work 'code/settings.json'
    $desktopRoot = Join-Path $work 'Claude-3p/configLibrary'
    $inventory = @{ CliVersion = '2.1.272'; VSCodeVersion = '2.1.289'; DesktopVersion = '2.2553.1.0' }
    $node = (Get-Command node -ErrorAction Stop).Source
    $entry = Join-Path $repo 'client/bin/ccof-token.mjs'
    $usageEntry = Join-Path $repo 'client/bin/ccof-usage.mjs'
    $codeArgs = @{ ConfigPath = $configPath; ClaudeHome = $claudeHome; VSCodeSettingsPath = $vscodePath
        BackupRoot = $backupRoot; Inventory = $inventory; NodePath = $node; TokenEntryPath = $entry; UsageEntryPath = $usageEntry }
    $settingsPath = Join-Path $claudeHome 'settings.json'
    $old = '{"theme":"dark","model":"old","env":{"KEEP_ME":"yes","CLAUDE_CODE_USE_FOUNDRY":"1"}}'
    [void][IO.Directory]::CreateDirectory($claudeHome)
    [IO.File]::WriteAllText($settingsPath, $old)
    Write-ClientJson $vscodePath @{ 'editor.fontSize' = 17; 'claudeCode.environmentVariables' = @(
        @{ name = 'KEEP_VSCODE'; value = 'yes' }, @{ name = 'CLAUDE_CODE_USE_FOUNDRY'; value = '1' }) }

    Test-Case 'configuration is validated by the same Node schema used by the helper' {
        $loaded = Read-ClientConfiguration $configPath
        Assert ([string]::Equals($loaded.gatewayUrl, $config.gatewayUrl, 'Ordinal')) 'Gateway changed'
        $bad = Join-Path $work 'bad.json'
        [IO.File]::WriteAllText($bad, '{"tenantId":"hidden-private-value"}')
        Refuses { Read-ClientConfiguration $bad } 'configuration'
    }
    Test-Case 'setup refuses without confirmation before writing any file' {
        Refuses { Set-CcofClaudeCode @codeArgs } 'Confirmed'
        Assert ([IO.File]::ReadAllText($settingsPath) -ceq $old) 'Original changed on refusal'
        Assert (-not (Test-Path $backupRoot)) 'Refusal created a backup'
    }
    Test-Case 'Claude Code merges settings, pins every model, clears conflicting auth and backs up first' {
        $script:codeResult = Set-CcofClaudeCode @codeArgs -Confirmed | ConvertFrom-Json -AsHashtable
        $settings = Read-ClientJson $settingsPath
        Assert ($settings.theme -ceq 'dark') 'Unrelated setting lost'
        Assert ($settings.env.KEEP_ME -ceq 'yes') 'Unrelated environment lost'
        Assert ($settings.env.ANTHROPIC_BASE_URL -ceq $config.gatewayUrl) 'Incorrect API base'
        Assert ($settings.env.CLAUDE_CODE_USE_FOUNDRY -ceq '0') 'Conflicting provider retained'
        Assert ($settings.env.ANTHROPIC_MODEL -ceq 'sonnet-deployment') 'Default model not pinned'
        Assert ($settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL -ceq 'haiku-deployment') 'Haiku not pinned'
        Assert ($settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL -ceq 'opus-deployment') 'Opus not pinned'
        Assert ($settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL -ceq 'sonnet-deployment') 'Sonnet not pinned'
        Assert ($settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS -ceq '300000') 'Helper TTL incorrect'
        Assert ($settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -ceq '1') 'Traffic decision missing'
        Assert ($settings.apiKeyHelper -match '^".+ccof-token\.cmd" token$') 'Silent token command missing'
        # One sign-in command for every method: the helper setup just wrote, with `login`.
        Assert ($codeResult.signInMethod -ceq 'msal') "Sign-in method not reported: $($codeResult.signInMethod)"
        Assert ($codeResult.signIn -ceq ('"' + (Join-Path $claudeHome 'ccof-token.cmd') + '" login')) "Sign-in command not reported: $($codeResult.signIn)"
        $snapshot = Join-Path $backupRoot $codeResult.changeId
        $manifest = Read-ClientJson (Join-Path $snapshot 'snapshot.json')
        $record = $manifest.files | Where-Object { [string]::Equals($_.path, $settingsPath, 'Ordinal') }
        Assert ([IO.File]::ReadAllText((Join-Path $snapshot $record.backupFile)) -ceq $old) 'Backup not exact'
    }
    Test-Case 'VS Code receives the common environment and disables only its hosted login prompt' {
        $vscode = Read-ClientJson $vscodePath
        Assert ($vscode['editor.fontSize'] -eq 17) 'Unrelated VS Code setting lost'
        Assert ($vscode['claudeCode.disableLoginPrompt'] -eq $true) 'External auth prelaunch check not configured'
        $envs = @{}; foreach ($row in $vscode['claudeCode.environmentVariables']) { $envs[$row.name] = $row.value }
        Assert ($envs.KEEP_VSCODE -ceq 'yes') 'Unrelated VS Code env lost'
        Assert ($envs.ANTHROPIC_BASE_URL -ceq $config.gatewayUrl) 'VS Code does not point at gateway'
        Assert ($envs.CLAUDE_CODE_USE_FOUNDRY -ceq '0') 'VS Code old provider still active'
    }
    Test-Case 'generated Windows shim quotes paths, pins config, and never invokes Azure CLI' {
        $shim = [IO.File]::ReadAllText((Join-Path $claudeHome 'ccof-token.cmd'))
        Assert ($shim -match '@echo off') 'Echo could leak credentials'
        Assert ($shim -match 'DisableDelayedExpansion') 'Exclamation marks would be re-expanded'
        Assert ($shim.Contains('set "CCOF_CONFIG_FILE=')) 'Config not pinned'
        Assert (-not ($shim -match '\baz\b|get-access-token')) 'Developer shim invokes Azure CLI'
        Assert ($shim -match 'exit /b %errorlevel%') 'Helper exit status not propagated'
    }
    Test-Case 'the /usage skill and its wrapper are installed: the skill runs the wrapper through powershell -File, with forward slashes' {
        $skillPath = Join-Path $claudeHome 'skills/usage/SKILL.md'
        $wrapperPath = Join-Path $claudeHome 'ccof-usage.ps1'
        Assert (Test-Path -LiteralPath $skillPath) 'Skill not installed'
        $skill = [IO.File]::ReadAllText($skillPath)
        Assert ($skill -match '(?s)^---\r?\nname: usage\r?\ndescription: .+\r?\n---\r?\n') 'Skill front matter missing or not named usage'
        $expected = '!`powershell -NoProfile -ExecutionPolicy Bypass -File "' + $wrapperPath.Replace('\', '/') + '"`'
        Assert ($skill.Contains($expected)) "Skill does not inject the wrapper's output: expected $expected"
        Assert ($skill -match 'exactly as written') 'Skill does not tell Claude to show the figures unchanged'
        $wrapper = [IO.File]::ReadAllText($wrapperPath)
        Assert ($wrapper.Contains("`$env:CCOF_CONFIG_FILE = '")) 'Wrapper does not pin the config'
        Assert ($wrapper.Contains('ccof-usage.mjs') -and $wrapper.Contains('exit $LASTEXITCODE')) 'Wrapper does not run ccof-usage or pass its exit code'
        Assert (-not (Test-Path -LiteralPath (Join-Path $claudeHome 'ccof-usage.cmd'))) 'An unused .cmd shim was written'
        $settings = Read-ClientJson $settingsPath
        Assert (-not $settings.Contains('statusLine')) 'Status line set without -UsageStatusLine'
    }
    Test-Case 'the generated command runs ccof-usage in PowerShell and in Git Bash, the two shells Claude Code uses on Windows' {
        $skill = [IO.File]::ReadAllText((Join-Path $claudeHome 'skills/usage/SKILL.md'))
        $command = [regex]::Match($skill, '!`([^`]+)`').Groups[1].Value
        Assert ($command) 'No command in the skill'
        $ps = & pwsh -NoProfile -Command "$command --bogus-argument 2>&1" | Out-String
        Assert ($ps -match 'Usage: ccof-usage \[--statusline\]') "PowerShell did not reach ccof-usage: $ps"
        $bash = Join-Path ${env:ProgramFiles} 'Git\bin\bash.exe'
        Assert (Test-Path -LiteralPath $bash) 'Git Bash not found: the Git Bash path cannot be tested on this machine'
        $gb = & $bash -c "$command --bogus-argument 2>&1" | Out-String
        Assert ($gb -match 'Usage: ccof-usage \[--statusline\]') "Git Bash did not reach ccof-usage: $gb"
    }
    Test-Case 'a usage path with a backtick, dollar sign or quote is refused before any file is written' {
        $options = $codeArgs.Clone(); $options.ClaudeHome = Join-Path $work 'odd$home/.claude'
        Refuses { Set-CcofClaudeCode @options -Confirmed } 'backtick'
        Assert (-not (Test-Path -LiteralPath (Join-Path $options.ClaudeHome 'skills'))) 'Skill written for an unsafe path'
    }
    Test-Case '-UsageStatusLine sets the status line only when none exists' {
        $home2 = Join-Path $work 'status/.claude'
        $options = $codeArgs.Clone(); $options.ClaudeHome = $home2; $options.BackupRoot = Join-Path $work 'status-backups'
        Set-CcofClaudeCode @options -UsageStatusLine -Confirmed | Out-Null
        $set = Read-ClientJson (Join-Path $home2 'settings.json')
        $want = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $home2 'ccof-usage.ps1').Replace('\', '/') + '" --statusline'
        Assert ($set.statusLine.type -ceq 'command' -and $set.statusLine.command -ceq $want) "Status line not set to the usage wrapper: $($set.statusLine.command)"
        $mine = @{ type = 'command'; command = 'my-own-statusline' }
        $set.statusLine = $mine; Write-ClientJson (Join-Path $home2 'settings.json') $set
        $result = Set-CcofClaudeCode @options -UsageStatusLine -Confirmed | ConvertFrom-Json -AsHashtable
        $kept = Read-ClientJson (Join-Path $home2 'settings.json')
        Assert ($kept.statusLine.command -ceq 'my-own-statusline') 'An existing status line was replaced'
        Assert ($result.statusLine -ceq 'kept_existing') 'Keeping the existing status line was not reported'
    }
    Test-Case 'restore keeps a created folder that now holds another file' {
        $home3 = Join-Path $work 'keep/.claude'
        $options = $codeArgs.Clone(); $options.ClaudeHome = $home3; $options.BackupRoot = Join-Path $work 'keep-backups'
        $r = Set-CcofClaudeCode @options -Confirmed | ConvertFrom-Json -AsHashtable
        $mine = Join-Path $home3 'skills/mine/SKILL.md'; Write-ClientText $mine 'mine'
        Restore-ClientSnapshot -BackupPath (Join-Path $options.BackupRoot $r.changeId) -Kind 'claude-code' -Confirmed | Out-Null
        Assert (Test-Path -LiteralPath $mine) 'A file the person added under a created folder was removed'
        Assert (-not (Test-Path -LiteralPath (Join-Path $home3 'skills/usage'))) 'The empty created usage folder was left behind'
    }
    Test-Case 'a snapshot written before createdDirectories existed still restores its files' {
        $home4 = Join-Path $work 'old/.claude'
        $options = $codeArgs.Clone(); $options.ClaudeHome = $home4; $options.BackupRoot = Join-Path $work 'old-backups'
        $r = Set-CcofClaudeCode @options -Confirmed | ConvertFrom-Json -AsHashtable
        $backup = Join-Path $options.BackupRoot $r.changeId
        $manifest = Read-ClientJson (Join-Path $backup 'snapshot.json')
        Assert ($manifest.Contains('createdDirectories')) 'The new snapshot does not record created folders'
        $manifest.Remove('createdDirectories'); Write-ClientJson (Join-Path $backup 'snapshot.json') $manifest
        Restore-ClientSnapshot -BackupPath $backup -Kind 'claude-code' -Confirmed | Out-Null
        Assert (-not (Test-Path -LiteralPath (Join-Path $home4 'skills/usage/SKILL.md'))) 'An old-format snapshot did not restore its files'
    }
    Test-Case 'restore detects later edits rather than overwriting them silently' {
        [IO.File]::AppendAllText($settingsPath, "`n")
        Refuses { Restore-ClientSnapshot -BackupPath (Join-Path $backupRoot $codeResult.changeId) -Kind 'claude-code' -Confirmed } 'changed'
        $script:edited = $true
    }
    Test-Case 'explicit restore recovers byte-exact originals and removes only newly created files' {
        Restore-ClientSnapshot -BackupPath (Join-Path $backupRoot $codeResult.changeId) -Kind 'claude-code' -Confirmed -AllowChangedFiles | Out-Null
        Assert ([IO.File]::ReadAllText($settingsPath) -ceq $old) 'Restore did not recover original bytes'
        Assert (-not (Test-Path (Join-Path $claudeHome 'ccof-token.cmd'))) 'New shim not removed'
        Assert (-not (Test-Path (Join-Path $claudeHome 'ccof-usage.ps1'))) 'New usage wrapper not removed'
        Assert (-not (Test-Path (Join-Path $claudeHome 'skills/usage/SKILL.md'))) 'New usage skill not removed'
        Assert (-not (Test-Path (Join-Path $claudeHome 'skills'))) 'Folders created for the usage skill were left behind'
        Assert (Test-Path -LiteralPath $claudeHome) 'Restore removed a folder that existed before setup'
        $vscode = Read-ClientJson $vscodePath
        Assert (-not $vscode.Contains('claudeCode.disableLoginPrompt')) 'Restore retained added key'
    }
    Test-Case 'corrupted backup bytes fail integrity before any restored file is overwritten' {
        $path = Join-Path $work 'integrity.json'
        Write-ClientText $path 'original'
        $snapshot = New-ClientSnapshot 'claude-code' @($path) $backupRoot
        Write-ClientText $path 'configured'
        Complete-ClientSnapshot $snapshot
        Write-ClientText (Join-Path $snapshot.Directory '0.bin') 'corrupted'
        Refuses { Restore-ClientSnapshot -BackupPath $snapshot.Directory -Kind 'claude-code' -Confirmed } 'integrity'
        Assert ([IO.File]::ReadAllText($path) -ceq 'configured') 'Restore wrote before integrity validation'
    }
    Test-Case 'missing clients are reported and never installed or configured' {
        $options = $codeArgs.Clone(); $options.Inventory = @{ CliVersion = $null; VSCodeVersion = $null }
        $result = Set-CcofClaudeCode @options -Confirmed | ConvertFrom-Json -AsHashtable
        Assert ($result.event -ceq 'not_installed') 'Missing app not reported'
        Assert ([IO.File]::ReadAllText($settingsPath) -ceq $old) 'Missing app configured'
    }
    $keys = @('inferenceProvider', 'inferenceGatewayBaseUrl', 'inferenceGatewayAuthScheme',
        'inferenceCredentialKind', 'inferenceCredentialHelper', 'inferenceCredentialHelperArgs',
        'inferenceCredentialHelperTimeoutSec', 'inferenceCredentialHelperTtlSec',
        'inferenceCredentialHelperSilentRefreshEnabled', 'inferenceModels')
    $schema = @{ keys = $keys; credentialKinds = @('static', 'helper-script', 'interactive') }
    $desktopArgs = @{ ConfigPath = $configPath; LibraryPath = $desktopRoot; BackupRoot = $backupRoot
        Inventory = $inventory; Schema = $schema; NodePath = $node; TokenEntryPath = $entry }
    $previousId = '55555555-5555-4555-8555-555555555555'
    Write-ClientJson (Join-Path $desktopRoot '_meta.json') @{
        appliedId = $previousId; entries = @(@{ id = $previousId; name = 'Previous' }); unrelated = 'keep'
    }
    Test-Case 'Desktop older bundle uses MSAL helper and preserves existing profile selection metadata' {
        $script:desktopResult = Set-CcofClaudeDesktop @desktopArgs -Confirmed | ConvertFrom-Json -AsHashtable
        $profile = Read-ClientJson (Join-Path $desktopRoot "$($config.desktop.profileId).json")
        Assert ($profile.inferenceCredentialKind -ceq 'helper-script') 'Unsupported external-idp was selected'
        Assert ($profile.inferenceGatewayBaseUrl -ceq $config.gatewayUrl) 'Desktop URL is wrong'
        Assert ($profile.inferenceGatewayAuthScheme -ceq 'bearer') 'Desktop must send bearer tokens'
        Assert ($profile.inferenceCredentialHelperArgs[0] -ceq 'token') 'Desktop helper is not silent'
        Assert ($desktopResult.signIn -ceq ('"' + (Join-Path (Split-Path $desktopRoot -Parent) 'ccof-token.cmd') + '" login')) "Desktop sign-in command not reported: $($desktopResult.signIn)"
        Assert ($profile.inferenceCredentialHelperTtlSec -lt $config.minimumTokenLifetimeSeconds) 'Desktop TTL too long'
        $meta = Read-ClientJson (Join-Path $desktopRoot '_meta.json')
        Assert ($meta.appliedId -ceq $config.desktop.profileId) 'New profile not selected'
        Assert ($meta.entries.Count -eq 2) 'Existing profile entry lost'
        Assert ($meta.unrelated -ceq 'keep') 'Unrelated metadata lost'
    }
    Test-Case 'Desktop restore returns to previous appliedId and removes new profile and helper' {
        Restore-ClientSnapshot -BackupPath (Join-Path $backupRoot $desktopResult.changeId) -Kind 'claude-desktop' -Confirmed | Out-Null
        $meta = Read-ClientJson (Join-Path $desktopRoot '_meta.json')
        Assert ($meta.appliedId -ceq $previousId) 'Previous selection was not restored'
        Assert (-not (Test-Path (Join-Path $desktopRoot "$($config.desktop.profileId).json"))) 'New profile retained'
    }
    Test-Case 'Desktop modern schema uses broker access-token OIDC for the configured API, never id_token' {
        $modern = @{ keys = $keys + @('inferenceIdpOidc', 'inferenceIdpAuthFlow'); credentialKinds = @('external-idp', 'helper-script') }
        $profile = New-CcofDesktopProfile -Config $config -Schema $modern -HelperPath 'unused'
        Assert ($profile.inferenceCredentialKind -ceq 'external-idp') 'New build did not use external-idp'
        Assert ($profile.inferenceIdpAuthFlow -ceq 'broker') 'Desktop broker not enabled'
        Assert ($profile.inferenceIdpOidc.bearerTokenType -ceq 'access_token') 'Wrong gateway audience type'
        Assert ($profile.inferenceIdpOidc.scopes -ceq $config.scope) 'Wrong gateway scope'
        Assert (-not $profile.Contains('inferenceCredentialHelper')) 'OIDC mixed with helper credentials'
    }
    Test-Case 'Desktop puts the configured default deployment first regardless of available-list order' {
        $orderedConfig = $config.Clone(); $orderedConfig.models = $config.models.Clone()
        $orderedConfig.models.available = @('opus-deployment', 'haiku-deployment', 'sonnet-deployment')
        $profile = New-CcofDesktopProfile -Config $orderedConfig -Schema $schema -HelperPath 'helper'
        Assert ($profile.inferenceModels[0].name -ceq 'sonnet-deployment') 'Desktop silently chose another default'
        Assert ($profile.inferenceModels.Count -eq 3) 'Model ordering lost or duplicated a deployment'
    }
    Test-Case 'Desktop reconfiguration preserves unrelated profile keys and clears obsolete credentials' {
        $custom = @{ organizationInstructions = 'Preserve these organization instructions'
            disableNonessentialTelemetry = $true; inferenceGatewayApiKey = 'synthetic-old-key' }
        $profilePath = Join-Path $desktopRoot "$($config.desktop.profileId).json"
        Write-ClientJson $profilePath $custom
        $originalBytes = [IO.File]::ReadAllText($profilePath)
        $options = $desktopArgs.Clone()
        $options.Schema = @{ keys = $keys + @('organizationInstructions', 'disableNonessentialTelemetry', 'inferenceGatewayApiKey')
            credentialKinds = @('helper-script') }
        $result = Set-CcofClaudeDesktop @options -Confirmed | ConvertFrom-Json -AsHashtable
        $profile = Read-ClientJson $profilePath
        Assert ($profile.organizationInstructions -ceq $custom.organizationInstructions) 'Unrelated instructions were deleted'
        Assert ($profile.disableNonessentialTelemetry -eq $true) 'Telemetry policy was deleted'
        Assert (-not $profile.Contains('inferenceGatewayApiKey')) 'Old static credential remained'
        Restore-ClientSnapshot -BackupPath (Join-Path $backupRoot $result.changeId) -Kind 'claude-desktop' -Confirmed | Out-Null
        Assert ([IO.File]::ReadAllText($profilePath) -ceq $originalBytes) 'Reconfiguration backup was not byte-exact'
        Remove-Item -LiteralPath $profilePath
    }
    Test-Case 'missing Desktop keys refuse before writing configuration or backup' {
        $badSchema = @{ keys = @('inferenceProvider'); credentialKinds = @('helper-script') }
        $options = $desktopArgs.Clone(); $options.Schema = $badSchema
        Refuses { Set-CcofClaudeDesktop @options -Confirmed } 'support|schema'
        Assert (-not (Test-Path (Join-Path $desktopRoot "$($config.desktop.profileId).json"))) 'Unsupported profile written'
    }
    Test-Case 'Desktop refuses a hybrid bootstrap pointer that would override the selected local profile' {
        $metaPath = Join-Path $desktopRoot '_meta.json'
        $original = [IO.File]::ReadAllText($metaPath)
        $meta = Read-ClientJson $metaPath
        $meta.hybridPointer = @{ source = 'another-configuration' }
        Write-ClientJson $metaPath $meta
        try {
            Refuses { Set-CcofClaudeDesktop @desktopArgs -Confirmed } 'hybrid|bootstrap'
        } finally {
            [IO.File]::WriteAllText($metaPath, $original)
            $profilePath = Join-Path $desktopRoot "$($config.desktop.profileId).json"
            if (Test-Path -LiteralPath $profilePath) { Remove-Item -LiteralPath $profilePath }
        }
    }
    $script:remote = @{ id = '66666666-6666-4666-8666-666666666666'
        appId = $config.clientId; publicClient = @{ redirectUris = @('http://localhost', 'https://login.microsoftonline.com/common/oauth2/nativeclient') }
        identifierUris = @("api://$($config.clientId)")
        api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = @(@{ value = 'access_as_user'; isEnabled = $true }) } }
    $script:patches = 0
    $graph = {
        param($Method, $Uri, $Body)
        if ($Method -ceq 'PATCH') {
            if ($script:patches -eq 0) {
                Assert (@(Get-ChildItem $backupRoot -Recurse -File -Filter 'redirects.json').Count -gt 0) 'Redirect backup must exist before PATCH'
            }
            $patch = $Body | ConvertFrom-Json -AsHashtable
            Assert (@($patch.Keys).Count -eq 1 -and $patch.Contains('publicClient')) 'Redirect PATCH must never overwrite combined API settings'
            $script:patches++; $script:remote.publicClient = $patch.publicClient; return
        }
        return $script:remote
    }
    $redirectArgs = @{ ConfigPath = $configPath; SubscriptionId = '77777777-7777-4777-8777-777777777777'
        BackupRoot = $backupRoot; InvokeGraph = $graph }
    Test-Case 'redirect setup refuses unconfirmed writes before making Graph calls' {
        Refuses { Set-CcofDeveloperRedirects @redirectArgs } 'Confirmed'
        Assert ($patches -eq 0) 'Unconfirmed Graph PATCH'
    }
    Test-Case 'redirect setup backs up before PATCH and adds broker URI while preserving existing redirects' {
        $script:redirectResult = Set-CcofDeveloperRedirects @redirectArgs -Confirmed | ConvertFrom-Json -AsHashtable
        Assert ($patches -eq 1) 'Expected one Graph PATCH'
        Assert ($remote.publicClient.redirectUris -ccontains "ms-appx-web://Microsoft.AAD.BrokerPlugin/$($config.clientId)") 'Broker URI missing'
        Assert ($remote.publicClient.redirectUris -ccontains 'http://localhost') 'Existing redirect lost'
        Assert ($remote.identifierUris[0] -ceq "api://$($config.clientId)" -and
            $remote.api.requestedAccessTokenVersion -eq 2 -and $remote.api.oauth2PermissionScopes[0].isEnabled) 'Combined API identifier, scope or token version lost'
        Assert (Test-Path (Join-Path $backupRoot "$($redirectResult.changeId)/redirects.json")) 'Redirect backup missing'
    }
    Test-Case 'redirect setup is idempotent' {
        Set-CcofDeveloperRedirects @redirectArgs -Confirmed | Out-Null
        Assert ($patches -eq 1) 'Idempotent rerun wrote to Graph'
    }
    Test-Case 'redirect restore recovers original values only for the matching application' {
        Restore-CcofDeveloperRedirects -ConfigPath $configPath -SubscriptionId $redirectArgs.SubscriptionId `
            -BackupPath (Join-Path $backupRoot $redirectResult.changeId) -InvokeGraph $graph -Confirmed | Out-Null
        Assert ($remote.publicClient.redirectUris.Count -eq 2) 'Redirects not restored'
        Assert (-not ($remote.publicClient.redirectUris -cmatch '^ms-appx-web:')) 'Broker URI retained'
    }
    Test-Case 'a foreign Graph application is rejected before any PATCH' {
        $foreign = { param($Method, $Uri, $Body) return @{ id = $script:remote.id; appId = '88888888-8888-4888-8888-888888888888'; publicClient = $script:remote.publicClient } }
        $options = $redirectArgs.Clone(); $options.InvokeGraph = $foreign
        $count = $patches
        Refuses { Set-CcofDeveloperRedirects @options -Confirmed } 'application'
        Assert ($patches -eq $count) 'Foreign application modified'
    }
    Test-Case 'Graph failures are not treated as an empty redirect list' {
        $options = $redirectArgs.Clone(); $options.InvokeGraph = { throw 'Graph unavailable' }
        $count = $patches
        Refuses { Set-CcofDeveloperRedirects @options -Confirmed } 'Graph'
        Assert ($patches -eq $count) 'Graph error caused PATCH'
    }
    Test-Case 'malformed Graph application data refuses before any PATCH' {
        foreach ($badRead in @(
            @{ id = 'not-guid'; appId = $config.clientId; publicClient = @{ redirectUris = @() } },
            @{ id = $remote.id; appId = $config.clientId; publicClient = $null },
            @{ id = $remote.id; appId = $config.clientId; publicClient = @{} })) {
            $counter = @{ writes = 0 }
            $reader = { param($Method, $Uri, $Body)
                if ($Method -ceq 'PATCH') { $counter.writes++; throw 'Unexpected write reached' }
                return $badRead
            }.GetNewClosure()
            $options = $redirectArgs.Clone(); $options.InvokeGraph = $reader
            Refuses { Set-CcofDeveloperRedirects @options -Confirmed } 'GUID|redirect list'
            Assert ($counter.writes -eq 0) 'Malformed response caused a write'
        }
    }
    Test-Case 'redirect PATCH is not success until readback matches the recorded target' {
        $unchanged = @{ id = $remote.id; appId = $config.clientId; publicClient = @{ redirectUris = @('http://localhost') } }
        $counter = @{ writes = 0 }
        $reader = { param($Method, $Uri, $Body)
            if ($Method -ceq 'PATCH') { $counter.writes++; return }
            return $unchanged
        }.GetNewClosure()
        $options = $redirectArgs.Clone(); $options.InvokeGraph = $reader
        Refuses { Set-CcofDeveloperRedirects @options -Confirmed } 'verification failed'
        Assert ($counter.writes -eq 1) 'Readback regression did not exercise PATCH'
    }
    Test-Case 'redirect restore refuses another administrator change before PATCH' {
        $parallel = @{ id = $remote.id; appId = $config.clientId; publicClient = @{
            redirectUris = @('http://localhost', 'https://login.microsoftonline.com/common/oauth2/nativeclient',
                'https://approved.example.test/callback') } }
        $counter = @{ writes = 0 }
        $reader = { param($Method, $Uri, $Body)
            if ($Method -ceq 'PATCH') { $counter.writes++; return }
            return $parallel
        }.GetNewClosure()
        Refuses { Restore-CcofDeveloperRedirects -ConfigPath $configPath -SubscriptionId $redirectArgs.SubscriptionId `
            -BackupPath (Join-Path $backupRoot $redirectResult.changeId) -InvokeGraph $reader -Confirmed } 'changed'
        Assert ($counter.writes -eq 0) 'Concurrent administrator change was overwritten'
    }
    Test-Case 'public redirect entrypoint uses its real default invoker without script-scope resolution failure' {
        $child = Join-Path $PSScriptRoot 'Test-RedirectEntrypointChild.ps1'
        $childOutput = & pwsh -NoProfile -File $child -ConfigPath $configPath -BackupRoot $backupRoot `
            -SubscriptionId $redirectArgs.SubscriptionId 2>$null
        Assert ($LASTEXITCODE -eq 0) 'Public redirect entrypoint failed in a fresh process'
        Assert (($childOutput | ConvertFrom-Json -AsHashtable).ok -eq $true) 'Fresh process did not verify the adapter'
        $global:CcofMockGraph = @{ app = @{ id = '66666666-6666-4666-8666-666666666666'
                appId = $config.clientId; publicClient = @{ redirectUris = @('http://localhost') } }
            azCalls = 0; restCalls = 0; tenant = $config.tenantId; subscription = $redirectArgs.SubscriptionId
            credential = 'synthetic-admin-value' }
        function global:az {
            $global:CcofMockGraph.azCalls++
            if ($args -ccontains '--tenant' -or $args -cnotcontains '--subscription' -or $args -cnotcontains 'ms-graph') {
                $global:LASTEXITCODE = 1
                return ''
            }
            $global:LASTEXITCODE = 0
            return (@{ accessToken = $global:CcofMockGraph.credential; tenant = $global:CcofMockGraph.tenant
                subscription = $global:CcofMockGraph.subscription } | ConvertTo-Json -Compress)
        }
        function global:Invoke-RestMethod {
            param($Method, $Uri, $Headers, $Body, $ContentType, $MaximumRedirection, $ErrorAction)
            $global:CcofMockGraph.restCalls++
            if ($Headers.Authorization -cne 'Bearer synthetic-admin-value') { throw 'Expected mocked Graph credential only' }
            if ($Method -ceq 'PATCH') { $global:CcofMockGraph.app.publicClient = ($Body | ConvertFrom-Json -AsHashtable).publicClient; return }
            return $global:CcofMockGraph.app
        }
        try {
            & (Join-Path $repo 'scripts/client/Set-DeveloperSignInRedirects.ps1') -ConfigPath $configPath `
                -SubscriptionId $redirectArgs.SubscriptionId -BackupRoot $backupRoot -Confirmed | Out-Null
            Assert ($global:CcofMockGraph.azCalls -eq 3) 'Default invoker did not obtain mocked Graph tokens'
            Assert ($global:CcofMockGraph.restCalls -eq 3) 'Default invoker did not execute GET/PATCH/readback'
            foreach ($field in @('tenant', 'subscription', 'credential')) {
                $before = $global:CcofMockGraph[$field]
                $global:CcofMockGraph[$field] = 'invalid metadata'
                Refuses { Invoke-CcofGraph 'GET' 'https://graph.microsoft.com/v1.0/applications' $null $config.tenantId $redirectArgs.SubscriptionId } 'token|tenant|subscription'
                Assert ($global:CcofMockGraph.restCalls -eq 3) 'Mismatched administrator token reached Graph'
                $global:CcofMockGraph[$field] = $before
            }
        } finally {
            Remove-Item Function:\az, Function:\Invoke-RestMethod
            Remove-Variable CcofMockGraph -Scope Global
        }
    }
    Test-Case 'model capability declarations are optional and nonessential traffic is an explicit choice' {
        $withoutCapabilities = $config.Clone()
        $withoutCapabilities.models = $config.models.Clone()
        $withoutCapabilities.models.Remove('capabilities')
        $withoutCapabilities.disableNonessentialTraffic = $false
        $envs = New-CcofCodeEnvironment $withoutCapabilities $configPath
        Assert ($envs.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES -ceq '') 'Optional capabilities were fabricated'
        Assert ($envs.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -ceq '0') 'Explicit traffic choice ignored'
    }
    Test-Case 'public setup, restore and verification entrypoints exist and parse' {
        foreach ($name in @('Set-ClaudeCodeGateway.ps1', 'Restore-ClaudeCodeGateway.ps1',
            'Set-ClaudeDesktopGateway.ps1', 'Restore-ClaudeDesktopGateway.ps1',
            'Set-DeveloperSignInRedirects.ps1', 'Restore-DeveloperSignInRedirects.ps1',
            'Test-InstalledClients.ps1', 'Test-ClientGatewayAccess.ps1')) {
            $file = Join-Path $repo "scripts/client/$name"
            Assert (Test-Path $file) "Missing public entrypoint $name"
            $tokens = $null; $errors = $null
            [void][Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
            Assert ($errors.Count -eq 0) "Invalid PowerShell in $name"
        }
    }
    Test-Case 'child-process verification closes stdin and captures credentials without printing them' {
        $file = Join-Path $repo 'scripts/client/ClientProcess.ps1'
        Assert (Test-Path $file) 'Missing bounded process adapter'
        . $file
        $result = Invoke-CcofChild -FilePath $node -Arguments @('-e', 'process.stdin.on("end",()=>process.stdout.write("synthetic-child-value")).resume()') `
            -WorkingDirectory $work -TimeoutSeconds 5 -Environment @{ CCOF_CONFIG_FILE = $configPath }
        Assert ($result.ExitCode -eq 0) 'Non-interactive child failed'
        Assert ($result.Stdout -ceq 'synthetic-child-value') 'Child output was not captured exactly'
        Assert ($result.Stderr -ceq '') 'Child wrote unexpected diagnostic output'
    }
    Test-Case 'child-process verification times out and terminates only its own process tree' {
        $file = Join-Path $repo 'scripts/client/ClientProcess.ps1'
        Assert (Test-Path $file) 'Missing bounded process adapter'
        . $file
        $result = Invoke-CcofChild -FilePath $node -Arguments @('-e', 'setTimeout(()=>{},30000)') `
            -WorkingDirectory $work -TimeoutSeconds 1
        Assert ($result.TimedOut -eq $true) 'Child timeout ignored'
        Assert ($result.ExitCode -ne 0) 'Timed-out child reported success'
    }
    Test-Case 'CMD child launch uses native shell quoting and preserves spaces and empty arguments' {
        . (Join-Path $repo 'scripts/client/ClientProcess.ps1')
        $cmdPath = Join-Path $work 'cmd fixture/echo.cmd'
        [void][IO.Directory]::CreateDirectory((Split-Path $cmdPath -Parent))
        [IO.File]::WriteAllText($cmdPath, "@echo off`r`n`"$node`" -e `"process.stdout.write(JSON.stringify(process.argv.slice(1)))`" %*`r`nexit /b %errorlevel%`r`n")
        $start = New-CcofChildStartInfo -FilePath $cmdPath -Arguments @('one two', '', 'tail') -WorkingDirectory $work
        Assert ($start.ArgumentList.Count -eq 0) 'CMD command was escaped as a CRT argument'
        Assert ($start.Arguments.StartsWith('/d /s /c ""')) 'CMD raw command quoting is missing'
        if ([Environment]::OSVersion.Platform -eq 'Win32NT') {
            $result = Invoke-CcofChild -FilePath $cmdPath -Arguments @('one two', '', 'tail') -WorkingDirectory $work -TimeoutSeconds 5
            Assert ($result.ExitCode -eq 0) 'Actual CMD execution failed'
            Assert ($result.Stdout -ceq '["one two","","tail"]') 'CMD arguments were changed'
        }
    }
    Test-Case 'project profiles share SSO and send only the configured selector while preserving unrelated headers' {
        $selected = $config.Clone()
        $selected.project = @{ id = 'CCOFPILOT01'; selectorHeader = 'X-Test-Project' }
        $selectedPath = Join-Path $work 'project-config.json'
        Write-ClientJson $selectedPath $selected
        $options = $codeArgs.Clone()
        $options.ConfigPath = $selectedPath
        $options.ClaudeHome = Join-Path $work 'project/.claude'
        $options.VSCodeSettingsPath = Join-Path $work 'project/code/settings.json'
        Write-ClientJson (Join-Path $options.ClaudeHome 'settings.json') @{ env = @{ ANTHROPIC_CUSTOM_HEADERS = 'X-Keep: one' } }
        Write-ClientJson $options.VSCodeSettingsPath @{ 'claudeCode.environmentVariables' = @(@{ name = 'ANTHROPIC_CUSTOM_HEADERS'; value = 'X-Editor: two' }) }
        Set-CcofClaudeCode @options -Confirmed | Out-Null
        $value = Read-ClientJson (Join-Path $options.ClaudeHome 'settings.json')
        Assert ($value.env.ANTHROPIC_CUSTOM_HEADERS -match '(?m)^X-Test-Project: CCOFPILOT01$') 'Project selector missing'
        Assert ($value.env.ANTHROPIC_CUSTOM_HEADERS -match 'X-Keep: one') 'Existing CLI header lost'
        Assert ($value.env.ANTHROPIC_CUSTOM_HEADERS -match 'X-Editor: two') 'Existing editor header lost'
        $desktopOptions = $desktopArgs.Clone()
        $desktopOptions.ConfigPath = $selectedPath
        $desktopOptions.LibraryPath = Join-Path $work 'project/desktop/configLibrary'
        $desktopOptions.Schema = @{ keys = $keys + @('inferenceCustomHeaders'); credentialKinds = @('helper-script') }
        Set-CcofClaudeDesktop @desktopOptions -Confirmed | Out-Null
        $firstPath = Join-Path $desktopOptions.LibraryPath "$($selected.desktop.profileId).json"
        $first = Read-ClientJson $firstPath
        Assert ($first.inferenceCustomHeaders['X-Test-Project'] -ceq 'CCOFPILOT01') 'Desktop selector missing'
        $first.inferenceCustomHeaders['X-Desktop'] = 'preserve'
        Write-ClientJson $firstPath $first
        Set-CcofClaudeDesktop @desktopOptions -Confirmed | Out-Null
        Assert ((Read-ClientJson $firstPath).inferenceCustomHeaders['X-Desktop'] -ceq 'preserve') 'Unrelated Desktop header lost'
        $selected.project.id = 'CCOFPILOT02'
        $selected.desktop = @{ profileId = '99999999-9999-4999-8999-999999999999'; profileName = 'Project two' }
        Write-ClientJson $selectedPath $selected
        Set-CcofClaudeDesktop @desktopOptions -Confirmed | Out-Null
        $second = Read-ClientJson (Join-Path $desktopOptions.LibraryPath "$($selected.desktop.profileId).json")
        Assert ($second.inferenceCredentialHelper -ceq $first.inferenceCredentialHelper) 'Project profiles do not share the helper'
        Assert ((Read-ClientJson $firstPath).inferenceCustomHeaders['X-Test-Project'] -ceq 'CCOFPILOT01') 'First project profile changed'
        Assert ($second.inferenceCustomHeaders['X-Test-Project'] -ceq 'CCOFPILOT02') 'Second project selector missing'
        $selected.project.id = $null
        Write-ClientJson $selectedPath $selected
        Set-CcofClaudeCode @options -Confirmed | Out-Null
        $cleared = Read-ClientJson (Join-Path $options.ClaudeHome 'settings.json')
        Assert ($cleared.env.ANTHROPIC_CUSTOM_HEADERS -notmatch 'X-Test-Project') 'Explicit no-selector profile retained a selector'
        Assert ($cleared.env.ANTHROPIC_CUSTOM_HEADERS -match 'X-Keep: one') 'Clearing selector removed unrelated headers'
    }
    Test-Case 'project header merging rejects malformed values, credential headers and unrelated conflicts' {
        $project = @{ id = 'CCOFPILOT01'; selectorHeader = 'X-Test-Project' }
        foreach ($source in @(42, 'not-a-header', @{ 'X-Other' = @('not', 'string') },
            "X-Other: one`rtwo", 'Authorization: synthetic', 'x-api-key: synthetic')) {
            Refuses { Merge-CcofProjectHeaders -Sources @($source) -Project $project } 'headers|credential'
        }
        Refuses { Merge-CcofProjectHeaders -Sources @('X-Other: one', 'X-Other: two') -Project $project } 'conflict'
    }

    # Azure CLI sign-in (ADR-0041): a mock az.cmd records each call and the profile folder it ran with.
    $azConfig = $config.Clone(); $azConfig.signInMethod = 'azure-cli'
    $azConfigPath = Join-Path $work 'az-mode/config.json'
    Write-ClientJson $azConfigPath $azConfig
    $mockDir = Join-Path $work 'mock-az'
    [void][IO.Directory]::CreateDirectory($mockDir)
    [IO.File]::WriteAllText((Join-Path $mockDir 'az.cmd'), @'
@echo off
>>"%~dp0calls.log" echo [%AZURE_CONFIG_DIR%] %*
if "%1"=="login" goto login
if "%1"=="logout" goto logout
if "%2"=="show" goto show
if "%2"=="get-access-token" goto token
exit /b 99
:token
if not exist "%~dp0session" goto needlogin
echo eyJ.mock.token
exit /b 0
:needlogin
>&2 echo AADSTS50076 interaction required.
exit /b 1
:show
if not exist "%~dp0session" goto needlogin
echo developer@example.test
exit /b 0
:login
echo LOGIN-OUTPUT-NOT-A-TOKEN
>"%~dp0session" echo signed-in
exit /b 0
:logout
del "%~dp0session"
exit /b 0
'@)
    $mockAz = Join-Path $mockDir 'az.cmd'
    # A planted az.cmd in the folder the helper is started from, and first on PATH: the helper must use neither.
    $planted = Join-Path $work 'untrusted project'
    [void][IO.Directory]::CreateDirectory($planted)
    [IO.File]::WriteAllText((Join-Path $planted 'az.cmd'), "@echo off`r`n>>`"%~dp0planted.log`" echo %*`r`necho eyJ.planted.token`r`nexit /b 0`r`n")
    function Invoke-AzHelper([string]$Helper, [string]$Argument) {
        $out = Join-Path $mockDir 'stdout.txt'; $err = Join-Path $mockDir 'stderr.txt'
        $saved = $env:PATH; $env:PATH = "$planted;$saved"
        Push-Location -LiteralPath $planted
        try { & $env:ComSpec /d /c "`"$Helper`" $Argument" 1> $out 2> $err; $code = $LASTEXITCODE } finally { Pop-Location; $env:PATH = $saved }
        return @{ exitCode = $code; stdout = ([IO.File]::ReadAllText($out)).Trim(); stderr = ([IO.File]::ReadAllText($err)).Trim() }
    }
    function Use-MockAzOnPath([scriptblock]$Body) { $saved = $env:PATH; $env:PATH = "$mockDir;$saved"; try { & $Body } finally { $env:PATH = $saved } }
    function Read-AzCalls { $log = Join-Path $mockDir 'calls.log'; if (Test-Path $log) { $c = @(Get-Content $log); Remove-Item $log; return $c }; return @() }

    Test-Case 'Azure CLI helper refuses an unsafe tenant, scope or profile folder before writing anything' {
        $good = @{ TenantId = $config.tenantId; Scope = $config.scope; AzureConfigDir = (Join-Path $work 'az-profile'); AzureCliPath = $mockAz }
        Assert ((New-ClientAzureCliTokenShim @good).Contains("set `"AZ=$mockAz`"")) 'Valid values refused, or az.cmd not pinned by its full path'
        foreach ($bad in @(@{ TenantId = 'common' }, @{ TenantId = "$($config.tenantId)&calc" }, @{ Scope = "$($config.scope)&calc" },
            @{ Scope = 'api://x/a%PATH%' }, @{ Scope = 'api://x/a"b' }, @{ AzureConfigDir = 'relative\az' }, @{ AzureConfigDir = 'C:\a"b\az' },
            @{ AzureConfigDir = "C:\a`r`nb\az" }, @{ AzureCliPath = 'az.cmd' }, @{ AzureCliPath = 'C:\a"b\az.cmd' }, @{ AzureCliPath = "C:\a`nb\az.cmd" })) {
            $values = $good.Clone(); foreach ($k in $bad.Keys) { $values[$k] = $bad[$k] }
            Refuses { New-ClientAzureCliTokenShim @values } 'tenant|scope|folder|Azure CLI path'
        }
    }
    Test-Case 'Azure CLI helper: one interactive sign-in, its own profile, only the token on stdout, and login/status/logout' {
        $azProfile = Join-Path $work 'az profile 100%'
        $helper = Join-Path $work 'az-helper/ccof-token.cmd'
        Write-ClientText $helper (New-ClientAzureCliTokenShim -TenantId $config.tenantId -Scope $config.scope -AzureConfigDir $azProfile -AzureCliPath $mockAz)
        $null = Read-AzCalls
        $first = Invoke-AzHelper $helper 'token'
        Assert ($first.exitCode -eq 0 -and $first.stdout -ceq 'eyJ.mock.token') "First token call: $($first | ConvertTo-Json -Compress)"
        Assert ($first.stderr -match 'LOGIN-OUTPUT-NOT-A-TOKEN') 'az login output was not kept off stdout'
        $calls = Read-AzCalls
        Assert ($calls.Count -eq 3 -and $calls[0] -match ' account get-access-token ' -and $calls[1] -match ' login ' -and $calls[2] -match ' account get-access-token ') "Expected token, login, token: $($calls -join ' | ')"
        Assert (@($calls | Where-Object { -not $_.StartsWith("[$azProfile] ") }).Count -eq 0) "Azure CLI ran outside the gateway profile: $($calls -join ' | ')"
        Assert ($calls[1] -match "--tenant `"?$($config.tenantId)`"? --scope `"?$([regex]::Escape($config.scope))`"? --allow-no-subscriptions") "Sign-in arguments: $($calls[1])"
        Assert ($calls[0] -match '--query accessToken --output tsv') "Token arguments: $($calls[0])"
        $again = Invoke-AzHelper $helper ''
        Assert ($again.stdout -ceq 'eyJ.mock.token' -and (Read-AzCalls).Count -eq 1) 'A cached token must not sign in again'
        $status = Invoke-AzHelper $helper 'status'
        Assert ($status.exitCode -eq 0 -and $status.stdout -match 'developer@example\.test') "status: $($status | ConvertTo-Json -Compress)"
        $null = Read-AzCalls
        $out = Invoke-AzHelper $helper 'logout'
        Assert ($out.exitCode -eq 0 -and -not (Test-Path (Join-Path $mockDir 'session'))) 'logout did not sign out'
        $login = Invoke-AzHelper $helper 'login'
        Assert ($login.exitCode -eq 0 -and -not $login.stdout.Contains('eyJ') -and -not $login.stdout.Contains('LOGIN-OUTPUT')) "login printed to stdout: $($login.stdout)"
        $bad = Invoke-AzHelper $helper 'bogus'
        Assert ($bad.exitCode -ne 0 -and -not $bad.stdout) 'An unknown command must fail with nothing on stdout'
        $null = Read-AzCalls
        Assert (-not (Test-Path (Join-Path $planted 'planted.log'))) 'The az.cmd in the start folder or first on PATH ran instead of the pinned Azure CLI'
    }
    Test-Case 'Azure CLI helper: silent-token never opens a sign-in, and a missing Azure CLI exits 3' {
        $helper = Join-Path $work 'az-helper2/ccof-token.cmd'
        Write-ClientText $helper (New-ClientAzureCliTokenShim -TenantId $config.tenantId -Scope $config.scope -AzureConfigDir (Join-Path $work 'az-p2') -AzureCliPath $mockAz)
        Remove-Item (Join-Path $mockDir 'session') -ErrorAction SilentlyContinue; $null = Read-AzCalls
        $silent = Invoke-AzHelper $helper 'silent-token'
        $calls = @(Read-AzCalls)
        Assert ($silent.exitCode -eq 4 -and -not $silent.stdout -and $calls.Count -eq 1 -and $calls[0] -match ' account get-access-token ') "silent-token while signed out: $($silent | ConvertTo-Json -Compress) calls: $($calls -join ' | ')"
        Assert ($silent.stderr -match 'AADSTS50076' -and $silent.stderr -match 'login') "silent-token must pass the Entra code and name login: $($silent.stderr)"
        $gone = Join-Path $work 'az-helper3/ccof-token.cmd'
        Write-ClientText $gone (New-ClientAzureCliTokenShim -TenantId $config.tenantId -Scope $config.scope -AzureConfigDir (Join-Path $work 'az-p3') -AzureCliPath (Join-Path $work 'uninstalled/az.cmd'))
        $missing = Invoke-AzHelper $gone 'token'
        Assert ($missing.exitCode -eq 3 -and -not $missing.stdout -and $missing.stderr -match 'installazurecliwindows') "Missing Azure CLI: $($missing | ConvertTo-Json -Compress)"
        Assert (-not (Test-Path (Join-Path $planted 'planted.log'))) 'A planted az.cmd ran when the pinned Azure CLI was missing'
    }
    Test-Case 'Setup refuses azure-cli mode when the Azure CLI is not installed, before writing anything' {
        $options = $codeArgs.Clone(); $options.ConfigPath = $azConfigPath; $options.ClaudeHome = Join-Path $work 'az-none/.claude'
        $options.VSCodeSettingsPath = Join-Path $work 'az-none/code/settings.json'
        $saved = $env:PATH; $env:PATH = (Join-Path $env:SystemRoot 'System32') + ';' + (Split-Path $node -Parent)
        try { Refuses { Set-CcofClaudeCode @options -Confirmed } 'azure_cli_missing' } finally { $env:PATH = $saved }
        Assert (-not (Test-Path -LiteralPath $options.ClaudeHome)) 'Files written although the Azure CLI is missing'
    }
    Test-Case 'the verifier finds the Claude Code helper, else the Desktop helper, else reports it missing' {
        $root = Join-Path $work 'helpers'; $code = Join-Path $root 'profile/.claude/ccof-token.cmd'; $desk = Join-Path $root 'local/Claude-3p/ccof-token.cmd'
        $args2 = @{ UserProfile = (Join-Path $root 'profile'); LocalAppData = (Join-Path $root 'local') }
        Assert ($null -eq (Resolve-ClientTokenHelperPath @args2)) 'A helper was reported where none exists'
        Write-ClientText $desk '@echo off'
        Assert ((Resolve-ClientTokenHelperPath @args2) -ceq $desk) 'The Desktop helper was not found'
        Write-ClientText $code '@echo off'
        Assert ((Resolve-ClientTokenHelperPath @args2) -ceq $code) 'The Claude Code helper was not preferred'
        $script = Join-Path $script:ClientRepoRoot 'scripts/client/Test-ClientGatewayAccess.ps1'
        Assert ([IO.File]::ReadAllText($script) -match 'token_helper_missing') 'The verifier does not report a missing helper'
    }
    Test-Case 'Claude Code in azure-cli mode writes the Azure CLI helper, a cache below the Azure CLI refresh floor, and pins the helper for /usage' {
        $options = $codeArgs.Clone(); $options.ConfigPath = $azConfigPath; $options.ClaudeHome = Join-Path $work 'az-mode/.claude'
        $options.VSCodeSettingsPath = Join-Path $work 'az-mode/code/settings.json'
        $result = Use-MockAzOnPath { Set-CcofClaudeCode @options -Confirmed } | ConvertFrom-Json -AsHashtable
        Assert ($result.signInMethod -ceq 'azure-cli') "Sign-in method not reported: $($result.signInMethod)"
        Assert ($result.signIn -ceq ('"' + (Join-Path $options.ClaudeHome 'ccof-token.cmd') + '" login')) "Sign-in command not reported: $($result.signIn)"
        $shim = [IO.File]::ReadAllText((Join-Path $options.ClaudeHome 'ccof-token.cmd'))
        Assert ($shim -match '"%AZ%" account get-access-token' -and $shim.Contains("set `"AZ=$mockAz`"") -and $shim -notmatch '\bnode\b') "Claude Code helper is not the Azure CLI helper pinned to the installed az.cmd: $(($shim -split "`r`n") -match '^set .AZ=')"
        Assert ($shim.Contains('set "AZURE_CONFIG_DIR=' + (Join-Path (Split-Path $azConfigPath -Parent) 'az') + '"')) 'Profile folder is not beside the configuration'
        $settings = Read-ClientJson (Join-Path $options.ClaudeHome 'settings.json')
        Assert ($settings.apiKeyHelper -match '^".+ccof-token\.cmd" token$') 'apiKeyHelper not set'
        Assert ([int]$settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS -le 240000) "Helper cache too long: $($settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS)"
        $wrapper = [IO.File]::ReadAllText((Join-Path $options.ClaudeHome 'ccof-usage.ps1'))
        Assert ($wrapper.Contains("`$env:CCOF_TOKEN_HELPER = '" + (Join-Path $options.ClaudeHome 'ccof-token.cmd') + "'")) 'Usage wrapper does not pin the helper'
    }
    Test-Case 'Desktop in azure-cli mode uses helper-script with the Azure CLI helper even when external-idp is supported' {
        $modern = @{ keys = $keys + @('inferenceIdpOidc', 'inferenceIdpAuthFlow'); credentialKinds = @('external-idp', 'helper-script') }
        $options = $desktopArgs.Clone(); $options.ConfigPath = $azConfigPath; $options.Schema = $modern
        $options.LibraryPath = Join-Path $work 'az-mode/Claude-3p/configLibrary'
        $result = Use-MockAzOnPath { Set-CcofClaudeDesktop @options -Confirmed } | ConvertFrom-Json -AsHashtable
        Assert ($result.credentialKind -ceq 'helper-script') 'Desktop did not use the helper'
        Assert ($result.signInMethod -ceq 'azure-cli') "Desktop sign-in method not reported: $($result.signInMethod)"
        Assert ($result.signIn -ceq ('"' + (Join-Path (Split-Path $options.LibraryPath -Parent) 'ccof-token.cmd') + '" login')) "Desktop sign-in command not reported: $($result.signIn)"
        $profile = Read-ClientJson (Join-Path $options.LibraryPath "$($config.desktop.profileId).json")
        Assert ($profile.inferenceProvider -ceq 'gateway' -and $profile.inferenceGatewayAuthScheme -ceq 'bearer') 'Not a gateway bearer profile'
        Assert ($profile.inferenceCredentialHelperTtlSec -le 240) 'Desktop helper cache too long'
        Assert ($profile.inferenceCredentialHelperTimeoutSec -ge ($config.loginTimeoutSeconds + $config.tokenTimeoutSeconds)) 'Helper timeout too short for one sign-in'
        $shim = [IO.File]::ReadAllText($profile.inferenceCredentialHelper)
        Assert ($shim -match '"%AZ%" login' -and $shim -notmatch '\bnode\b') 'Desktop helper is not the Azure CLI helper'
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "$script:passed passed, $script:failed failed"
if ($script:failed) { exit 1 }
