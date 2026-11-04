<#
.SYNOPSIS
    Sets up Claude Code on Windows to use the CCOF gateway with the Azure CLI sign-in. No Node.js, npm, Git,
    Python or PowerShell 7 is needed: it runs in the Windows PowerShell 5.1 built into Windows.

.DESCRIPTION
    Writes the same files as Set-ClaudeCodeGateway.ps1 does for signInMethod azure-cli (ADR-0041):
      %USERPROFILE%\.claude\ccof-token.cmd     token helper; runs az in its own profile
      %USERPROFILE%\.claude\settings.json      gateway URL, helper, models, group header (merged)
      %LOCALAPPDATA%\ClaudeGateway\config.json the client configuration
      %APPDATA%\Code\User\settings.json        only when the Claude Code VS Code extension is installed
    The /usage command and status line need Node.js and are not set up (docs/get-started/developer-setup-azure-cli.md).
    Without -Confirmed it only checks and reports; nothing is written. Every write is backed up first and rolled
    back on failure; -Restore <backup folder> undoes a setup.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeCodeAzureCli.ps1 -ConfigPath .\client-config.json -Confirmed -Login -Test
#>
[CmdletBinding()]
param(
    [string]$ConfigPath,
    [switch]$Confirmed,
    [switch]$Login,
    [switch]$Test,
    [string]$Restore,
    [switch]$AllowChangedFiles,
    # Test seams; defaults are the real locations.
    [string]$ClaudeHome,
    [string]$StateRoot,
    [string]$VSCodeSettingsPath,
    [string]$VSCodeExtensionsPath,
    [string]$AzureCliPath
)

$script:Guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$script:Deployment = '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'

function Test-CcofAbsolutePath([string]$Path) {
    return [bool]($Path -match '^[A-Za-z]:\\' -or $Path -match '^\\\\[^\\]+\\')
}

function ConvertTo-CcofHashtable($Value) {
    <# Windows PowerShell 5.1 has no ConvertFrom-Json -AsHashtable: objects become ordered dictionaries, arrays stay arrays. #>
    if ($null -eq $Value) { return $null }
    if ($Value -is [Management.Automation.PSCustomObject]) {
        $table = [ordered]@{}
        foreach ($p in $Value.PSObject.Properties) { $table[$p.Name] = ConvertTo-CcofHashtable $p.Value }
        return $table
    }
    if ($Value -is [Collections.IList] -and $Value -isnot [string]) {
        $list = @()
        foreach ($item in $Value) { $list += , (ConvertTo-CcofHashtable $item) }
        return , $list
    }
    return $Value
}

function ConvertFrom-CcofJsonc([string]$Text) {
    <# VS Code settings are JSONC. Removes // and /* */ comments and trailing commas outside strings, which
       PowerShell 7's ConvertFrom-Json accepts and Windows PowerShell 5.1's does not. #>
    $out = New-Object Text.StringBuilder
    $i = 0; $n = $Text.Length
    while ($i -lt $n) {
        $c = $Text[$i]
        if ($c -eq '"') {
            $start = $i; $i++
            while ($i -lt $n -and $Text[$i] -ne '"') { if ($Text[$i] -eq '\') { $i++ }; $i++ }
            $i++
            [void]$out.Append($Text.Substring($start, [Math]::Min($i, $n) - $start))
            continue
        }
        if ($c -eq '/' -and $i + 1 -lt $n -and $Text[$i + 1] -eq '/') { while ($i -lt $n -and $Text[$i] -ne "`n") { $i++ }; continue }
        if ($c -eq '/' -and $i + 1 -lt $n -and $Text[$i + 1] -eq '*') {
            $end = $Text.IndexOf('*/', $i + 2)
            $i = if ($end -lt 0) { $n } else { $end + 2 }
            continue
        }
        [void]$out.Append($c); $i++
    }
    $clean = $out.ToString()
    # A comma followed only by whitespace and a closing bracket; strings were already copied verbatim, so re-scan
    # them to skip commas inside strings.
    $result = New-Object Text.StringBuilder
    $i = 0; $n = $clean.Length
    while ($i -lt $n) {
        $c = $clean[$i]
        if ($c -eq '"') {
            $start = $i; $i++
            while ($i -lt $n -and $clean[$i] -ne '"') { if ($clean[$i] -eq '\') { $i++ }; $i++ }
            $i++
            [void]$result.Append($clean.Substring($start, [Math]::Min($i, $n) - $start))
            continue
        }
        if ($c -eq ',') {
            $j = $i + 1
            while ($j -lt $n -and [char]::IsWhiteSpace($clean[$j])) { $j++ }
            if ($j -lt $n -and ($clean[$j] -eq '}' -or $clean[$j] -eq ']')) { $i++; continue }
        }
        [void]$result.Append($c); $i++
    }
    return $result.ToString()
}

function Read-CcofJsonFile([string]$Path, [string]$What, [switch]$Jsonc) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $text = [IO.File]::ReadAllText($Path)
    if ($Jsonc) { $text = ConvertFrom-CcofJsonc $text }
    if ([string]::IsNullOrWhiteSpace($text)) { return [ordered]@{} }
    try { $value = ConvertTo-CcofHashtable ($text | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw "$What at '$Path' is not valid JSON. Repair it, or move it aside, and run again; nothing was changed." }
    if ($value -isnot [Collections.IDictionary]) { throw "$What at '$Path' must be a JSON object; nothing was changed." }
    return $value
}

function Write-CcofText([string]$Path, [string]$Text) {
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) { [void][IO.Directory]::CreateDirectory($dir) }
    $pending = "$Path.pending-$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText($pending, $Text, (New-Object Text.UTF8Encoding $false))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($pending, $Path, [NullString]::Value) } else { [IO.File]::Move($pending, $Path) }
    } finally {
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
    }
}

function Write-CcofJson([string]$Path, $Value) {
    Write-CcofText $Path ((ConvertTo-Json -InputObject $Value -Depth 100) + "`n")
}

function Get-CcofFileHash([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
    return $null
}

function Test-CcofClientConfiguration {
    <#
    The rules of client/src/config.mjs (the Node validator Set-ClaudeCodeGateway.ps1 uses), plus: signInMethod must be
    azure-cli. Returns @{ Config; Problems }; each problem names its remedy.
    #>
    param([Parameter(Mandatory)]$Value)
    $problems = New-Object Collections.Generic.List[string]
    if ($Value -isnot [Collections.IDictionary]) { $problems.Add('The configuration must be a JSON object.'); return @{ Config = $null; Problems = $problems } }
    $required = @('schemaVersion', 'tenantId', 'clientId', 'scope', 'gatewayUrl', 'helperTtlSeconds', 'minimumTokenLifetimeSeconds',
        'loginTimeoutSeconds', 'tokenTimeoutSeconds', 'disableNonessentialTraffic', 'models', 'desktop')
    foreach ($key in $Value.Keys) { if ($required -notcontains $key -and @('project', 'signInMethod') -notcontains $key) { $problems.Add("Unknown key '$key'.") } }
    foreach ($key in $required) { if (-not $Value.Contains($key)) { $problems.Add("Missing key '$key'.") } }
    if ($problems.Count) { return @{ Config = $null; Problems = $problems } }

    if (-not ($Value.schemaVersion -is [int] -or $Value.schemaVersion -is [long]) -or $Value.schemaVersion -ne 1) { $problems.Add('schemaVersion must be 1.') }
    if ([string]$Value.tenantId -notmatch $script:Guid) { $problems.Add('tenantId must be the directory (tenant) ID GUID.') }
    if ([string]$Value.clientId -notmatch $script:Guid) { $problems.Add('clientId must be the gateway app registration''s application (client) ID GUID.') }
    if ($Value.signInMethod -cne 'azure-cli') {
        $method = if ($Value.signInMethod) { $Value.signInMethod } else { 'msal (default)' }
        $problems.Add("signInMethod is '$method'. This setup supports only 'azure-cli'; the msal sign-in needs Node.js. Ask the administrator for a configuration with `"signInMethod`": `"azure-cli`" (deployment setting entra.allowAzureCliClient).")
    }

    $url = [string]$Value.gatewayUrl
    $parsed = $null
    if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$parsed) -or $url -match '\s') { $problems.Add("gatewayUrl '$url' is not a URL.") }
    elseif ($parsed.Scheme -ne 'https' -or $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment) { $problems.Add("gatewayUrl '$url' must be https:// with no user, query or fragment.") }
    elseif ($parsed.AbsolutePath -match '/v1(/messages)?/?$') {
        $fixed = $url -replace '/v1(/messages)?/?$', ''
        $problems.Add("gatewayUrl '$url' ends in /v1 or /v1/messages. Claude Code adds /v1/messages itself. Set it to '$fixed'.")
    }

    $scope = [string]$Value.scope
    $selfGuid = $scope -match '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/[A-Za-z0-9][A-Za-z0-9_.-]*$' -and
        [string]::Equals($Matches[1], [string]$Value.clientId, 'OrdinalIgnoreCase')
    if ($scope -cnotmatch '^[A-Za-z0-9:/._-]+$') { $problems.Add('scope may contain only letters, digits and : / . _ - for the Azure CLI helper.') }
    elseif (-not $selfGuid -and $scope -notmatch '^(api|https)://[^/]+/[^/].*$') { $problems.Add("scope '$scope' must look like api://<gateway app ID>/access_as_user.") }

    foreach ($key in @('helperTtlSeconds', 'minimumTokenLifetimeSeconds', 'loginTimeoutSeconds', 'tokenTimeoutSeconds')) {
        $n = $Value[$key]
        if (-not ($n -is [int] -or $n -is [long]) -or $n -le 0 -or $n * 1000 -gt 2147483647) { $problems.Add("$key must be a positive whole number of seconds.") }
    }
    if (-not $problems.Count -and $Value.minimumTokenLifetimeSeconds -le $Value.helperTtlSeconds) { $problems.Add('minimumTokenLifetimeSeconds must be greater than helperTtlSeconds.') }
    if ($Value.disableNonessentialTraffic -isnot [bool]) { $problems.Add('disableNonessentialTraffic must be true or false.') }

    $models = $Value.models
    if ($models -isnot [Collections.IDictionary]) { $problems.Add('models must be an object.') }
    else {
        foreach ($key in $models.Keys) { if (@('default', 'opus', 'sonnet', 'haiku', 'available', 'capabilities') -notcontains $key) { $problems.Add("models.$key is not a known key.") } }
        $available = @($models.available)
        if ($models.available -isnot [Collections.IList] -or $models.available -is [string] -or
            -not $available.Count -or @($available | Where-Object { $_ -isnot [string] -or $_ -notmatch $script:Deployment }).Count -or
            @($available | Select-Object -Unique).Count -ne $available.Count) { $problems.Add('models.available must list unique deployment names.') }
        foreach ($alias in @('default', 'opus', 'sonnet', 'haiku')) {
            if ($available -cnotcontains $models[$alias]) { $problems.Add("models.$alias must be one of models.available.") }
        }
        if ($models.Contains('capabilities')) {
            $caps = $models.capabilities
            if ($caps -isnot [Collections.IDictionary] -or @($caps.Keys | Where-Object { @('opus', 'sonnet', 'haiku') -notcontains $_ -or $caps[$_] -isnot [string] -or $caps[$_] -cnotmatch '^[a-z_]+(,[a-z_]+)*$' }).Count) {
                $problems.Add('models.capabilities is invalid.')
            }
        }
    }
    $desktop = $Value.desktop
    if ($desktop -isnot [Collections.IDictionary] -or @($desktop.Keys | Where-Object { @('profileId', 'profileName') -notcontains $_ }).Count -or
        [string]$desktop.profileId -notmatch $script:Guid -or $desktop.profileName -isnot [string] -or [string]::IsNullOrWhiteSpace($desktop.profileName) -or $desktop.profileName -match "[`r`n]") {
        $problems.Add('desktop must hold profileId (GUID) and profileName.')
    }
    if ($Value.Contains('project')) {
        $project = $Value.project
        $reserved = @('authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie', 'host', 'content-type',
            'content-length', 'connection', 'transfer-encoding', 'anthropic-version', 'anthropic-beta')
        if ($project -isnot [Collections.IDictionary] -or @($project.Keys | Where-Object { @('id', 'selectorHeader') -notcontains $_ }).Count -or
            -not $project.Contains('id') -or ($null -ne $project.id -and ($project.id -isnot [string] -or $project.id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$')) -or
            $project.selectorHeader -isnot [string] -or $project.selectorHeader -cnotmatch '^[A-Za-z][A-Za-z0-9-]{0,63}$' -or
            $reserved -contains $project.selectorHeader.ToLowerInvariant()) { $problems.Add('project must hold id (group Object ID) and selectorHeader.') }
    }
    if ($problems.Count) { return @{ Config = $null; Problems = $problems } }
    $Value.gatewayUrl = $url.TrimEnd('/')
    return @{ Config = $Value; Problems = $problems }
}

function New-CcofAzCliHelperText {
    <# Byte-identical to New-ClientAzureCliTokenShim in ClientGateway.Common.ps1 (tests check this). #>
    param([Parameter(Mandatory)][string]$TenantId, [Parameter(Mandatory)][string]$Scope, [Parameter(Mandatory)][string]$AzureConfigDir,
        [Parameter(Mandatory)][string]$AzureCliPath)
    if ($TenantId -notmatch $script:Guid) { throw 'The tenant must be a directory (tenant) ID GUID.' }
    if ($Scope -cnotmatch '^[A-Za-z0-9:/._-]+$') { throw 'The scope may contain only letters, digits and : / . _ - for the Azure CLI helper.' }
    if (-not (Test-CcofAbsolutePath $AzureConfigDir) -or $AzureConfigDir -match '["\r\n]') { throw 'The Azure CLI profile folder must be absolute and contain no quotes or line breaks.' }
    if (-not (Test-CcofAbsolutePath $AzureCliPath) -or $AzureCliPath -match '["\r\n]') { throw 'The Azure CLI path must be absolute and contain no quotes or line breaks.' }
    $profileDir = $AzureConfigDir.Replace('%', '%%')
    $azPath = $AzureCliPath.Replace('%', '%%')
    $lines = @(
        '@echo off'
        'setlocal DisableDelayedExpansion'
        'set "NoDefaultCurrentDirectoryInExePath=1"'
        "set `"AZ=$azPath`""
        "set `"TENANT=$TenantId`""
        "set `"SCOPE=$Scope`""
        "set `"AZURE_CONFIG_DIR=$profileDir`""
        'set "AZURE_CORE_LOGIN_EXPERIENCE_V2=off"'
        'if not exist "%AZ%" goto noaz'
        'set "CCOF_COMMAND=%~1"'
        'if not defined CCOF_COMMAND set "CCOF_COMMAND=token"'
        'if /i "%CCOF_COMMAND%"=="token" goto token'
        'if /i "%CCOF_COMMAND%"=="silent-token" goto silenttoken'
        'if /i "%CCOF_COMMAND%"=="login" goto login'
        'if /i "%CCOF_COMMAND%"=="status" goto status'
        'if /i "%CCOF_COMMAND%"=="logout" goto logout'
        '>&2 echo Usage: ccof-token.cmd [token^|silent-token^|login^|status^|logout]'
        'exit /b 2'
        ':token'
        'call :gettoken 2>nul && exit /b 0'
        '>&2 echo Not signed in to the Claude gateway. Opening the Microsoft Entra sign-in.'
        'call :signin || exit /b 4'
        'call :gettoken && exit /b 0'
        '>&2 echo No gateway token after sign-in. Run "%~f0" status and contact the platform team.'
        'exit /b 4'
        ':silenttoken'
        'call :gettoken 2>nul && exit /b 0'
        '>&2 echo Not signed in to the Claude gateway. Run: "%~f0" login'
        'exit /b 4'
        ':login'
        'call :signin || exit /b 4'
        '>&2 echo Signed in. Claude Code and Claude Desktop now use this sign-in.'
        'exit /b 0'
        ':status'
        'call "%AZ%" account show --query user.name --output tsv --only-show-errors 2>nul'
        'if errorlevel 1 goto notsignedin'
        'exit /b 0'
        ':notsignedin'
        '>&2 echo Not signed in. Run: "%~f0" login'
        'exit /b 4'
        ':logout'
        'call "%AZ%" logout --only-show-errors 1>&2'
        'exit /b 0'
        ':gettoken'
        'call "%AZ%" account get-access-token --tenant "%TENANT%" --scope "%SCOPE%" --query accessToken --output tsv --only-show-errors'
        'exit /b'
        ':signin'
        'call "%AZ%" login --tenant "%TENANT%" --scope "%SCOPE%" --allow-no-subscriptions --output none --only-show-errors <nul 1>&2'
        'exit /b'
        ':noaz'
        '>&2 echo The Azure CLI is not installed at "%AZ%". Install it from https://aka.ms/installazurecliwindows and run the client setup again.'
        'exit /b 3'
    )
    return ($lines -join "`r`n") + "`r`n"
}

function New-CcofCodeEnvironmentValues {
    <# The env block of New-CcofCodeEnvironment (ClaudeCodeGateway.ps1) for signInMethod azure-cli (tests check this). #>
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$ConfigPath)
    $ttl = [Math]::Min([int]$Config.helperTtlSeconds, 240)
    $envs = @{
        ANTHROPIC_BASE_URL = $Config.gatewayUrl
        ANTHROPIC_MODEL = $Config.models.default
        CLAUDE_CODE_API_KEY_HELPER_TTL_MS = [string]($ttl * 1000)
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = $(if ($Config.disableNonessentialTraffic) { '1' } else { '0' })
        CCOF_CONFIG_FILE = $ConfigPath
        CLAUDE_CODE_USE_FOUNDRY = '0'; CLAUDE_CODE_USE_BEDROCK = '0'; CLAUDE_CODE_USE_VERTEX = '0'
        CLAUDE_CODE_USE_ANTHROPIC_AWS = '0'; CLAUDE_CODE_USE_MANTLE = '0'
        ANTHROPIC_API_KEY = ''; ANTHROPIC_AUTH_TOKEN = ''; CLAUDE_CODE_OAUTH_TOKEN = ''
    }
    foreach ($alias in @('opus', 'sonnet', 'haiku')) {
        $prefix = "ANTHROPIC_DEFAULT_$($alias.ToUpperInvariant())_MODEL"
        $envs[$prefix] = $Config.models[$alias]
        $envs["$($prefix)_SUPPORTED_CAPABILITIES"] = if ($Config.models.capabilities) { [string]$Config.models.capabilities[$alias] } else { '' }
    }
    return $envs
}

function Merge-CcofHeaders {
    <# Merge-CcofProjectHeaders (ClientProjectHeaders.ps1): keeps unrelated headers, replaces the group selector. #>
    param([object[]]$Sources, [Parameter(Mandatory)]$Project)
    $headers = [ordered]@{}
    foreach ($source in $Sources) {
        if ($null -eq $source -or $source -ceq '') { continue }
        $pairs = @()
        if ($source -is [Collections.IDictionary]) {
            foreach ($key in $source.Keys) { $pairs += @{ Name = [string]$key; Value = $source[$key] } }
        } elseif ($source -is [string]) {
            foreach ($line in ($source -split "`n")) {
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                $colon = $line.IndexOf(':')
                if ($colon -lt 1) { throw 'Existing custom headers are malformed. No client settings were changed.' }
                $pairs += @{ Name = $line.Substring(0, $colon).Trim(); Value = $line.Substring($colon + 1).Trim() }
            }
        } else { throw 'Existing custom headers must be an object or a header string. No settings were changed.' }
        foreach ($pair in $pairs) {
            if ($pair.Name -cnotmatch '^[A-Za-z][A-Za-z0-9-]{0,63}$' -or $pair.Value -isnot [string] -or $pair.Value -match "[`r`n`0]") {
                throw 'Existing custom headers are invalid. No client settings were changed.'
            }
            if (@('authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie') -contains $pair.Name.ToLowerInvariant()) {
                throw 'Remove static credential headers before configuring a project profile; use the Entra helper instead.'
            }
            if ([string]::Equals($pair.Name, $Project.selectorHeader, 'OrdinalIgnoreCase')) { continue }
            if ($headers.Contains($pair.Name) -and -not [string]::Equals($headers[$pair.Name], $pair.Value, 'Ordinal')) {
                throw 'Unrelated custom header values conflict between clients. Align them before configuring a project profile.'
            }
            $headers[$pair.Name] = $pair.Value
        }
    }
    if ($null -ne $Project.id) { $headers[$Project.selectorHeader] = [string]$Project.id }
    return $headers
}

function Get-CcofPlan {
    <# Everything the setup would write, computed without writing. #>
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$ClaudeHome, [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$AzureCliPath, [string]$VSCodeSettingsPath, [bool]$VSCodeExtension)
    $installedConfig = Join-Path $StateRoot 'config.json'
    $helper = Join-Path $ClaudeHome 'ccof-token.cmd'
    $settingsPath = Join-Path $ClaudeHome 'settings.json'
    $helperText = New-CcofAzCliHelperText -TenantId $Config.tenantId -Scope $Config.scope -AzureConfigDir (Join-Path $StateRoot 'az') -AzureCliPath $AzureCliPath
    $envs = New-CcofCodeEnvironmentValues $Config $installedConfig

    $settings = Read-CcofJsonFile $settingsPath 'Claude Code settings'
    if ($null -eq $settings) { $settings = [ordered]@{} }
    if ($settings.Contains('env') -and $settings.env -isnot [Collections.IDictionary]) { throw 'Claude Code settings "env" must be an object; nothing was changed.' }
    if (-not $settings.env) { $settings.env = [ordered]@{} }

    $vscode = $null; $entries = @()
    if ($VSCodeExtension -and $VSCodeSettingsPath) {
        $vscode = Read-CcofJsonFile $VSCodeSettingsPath 'VS Code user settings' -Jsonc
        if ($null -eq $vscode) { $vscode = [ordered]@{} }
        $entries = @($vscode['claudeCode.environmentVariables'] | Where-Object { $null -ne $_ })
        foreach ($entry in $entries) {
            if ($entry -isnot [Collections.IDictionary] -or -not $entry.name -or $entry.value -isnot [string]) {
                throw 'VS Code claudeCode.environmentVariables must be name/value objects; nothing was changed.'
            }
        }
    }
    if ($Config.project) {
        $sources = @($settings.env.ANTHROPIC_CUSTOM_HEADERS) + @($entries | Where-Object { $_.name -eq 'ANTHROPIC_CUSTOM_HEADERS' } | ForEach-Object { $_.value })
        $headers = Merge-CcofHeaders -Sources $sources -Project $Config.project
        $envs.ANTHROPIC_CUSTOM_HEADERS = (@($headers.Keys | ForEach-Object { "${_}: $($headers[$_])" }) -join "`n")
    }
    foreach ($key in $envs.Keys) { $settings.env[$key] = $envs[$key] }
    foreach ($key in @('ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN')) {
        if ($settings.env.Contains($key)) { $settings.env.Remove($key) }
    }
    $settings.apiKeyHelper = "`"$helper`" token"
    $settings.model = $Config.models.default
    $settings.availableModels = @($Config.models.available)
    $settings.enforceAvailableModels = $true

    $paths = @($settingsPath, $helper, $installedConfig)
    if ($vscode) {
        $merged = @($entries | Where-Object { -not $envs.ContainsKey([string]$_.name) -and $_.name -notlike 'ANTHROPIC_FOUNDRY_*' })
        foreach ($key in ($envs.Keys | Sort-Object)) { $merged += [ordered]@{ name = $key; value = $envs[$key] } }
        $vscode['claudeCode.environmentVariables'] = $merged
        $vscode['claudeCode.disableLoginPrompt'] = $true
        $paths += $VSCodeSettingsPath
    }
    return @{ Paths = $paths; Helper = $helper; HelperText = $helperText; SettingsPath = $settingsPath; Settings = $settings
        InstalledConfig = $installedConfig; Config = $Config; VSCodePath = $VSCodeSettingsPath; VSCode = $vscode; Env = $envs }
}

function Invoke-CcofApply {
    <# Backs up every target (manifest compatible with Restore-ClaudeCodeGateway.ps1), writes, rolls back on failure. #>
    param([Parameter(Mandatory)]$Plan, [Parameter(Mandatory)][string]$BackupRoot)
    $id = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N')
    $directory = Join-Path $BackupRoot $id
    [void][IO.Directory]::CreateDirectory($directory)
    $records = @(); $index = 0
    foreach ($path in $Plan.Paths) {
        $exists = Test-Path -LiteralPath $path -PathType Leaf
        if ($exists) { Copy-Item -LiteralPath $path -Destination (Join-Path $directory "$index.bin") -ErrorAction Stop }
        $records += [ordered]@{ path = [IO.Path]::GetFullPath($path); existed = $exists; backupFile = "$index.bin"; beforeSha256 = (Get-CcofFileHash $path); afterSha256 = $null }
        $index++
    }
    $manifest = [ordered]@{ schemaVersion = 1; kind = 'claude-code'; changeId = $id; complete = $false; files = $records; createdDirectories = @() }
    Write-CcofJson (Join-Path $directory 'snapshot.json') $manifest
    try {
        Write-CcofText $Plan.Helper $Plan.HelperText
        Write-CcofJson $Plan.SettingsPath $Plan.Settings
        if ($Plan.VSCode) { Write-CcofJson $Plan.VSCodePath $Plan.VSCode }
        if (-not [string]::Equals([IO.Path]::GetFullPath($script:SourceConfigPath), [IO.Path]::GetFullPath($Plan.InstalledConfig), 'OrdinalIgnoreCase')) {
            Write-CcofJson $Plan.InstalledConfig $Plan.Config
        }
        foreach ($record in $manifest.files) { $record.afterSha256 = Get-CcofFileHash $record.path }
        $manifest.complete = $true
        Write-CcofJson (Join-Path $directory 'snapshot.json') $manifest
    } catch {
        $failure = $_
        try { Restore-CcofBackup -BackupPath $directory -AllowChanged | Out-Null }
        catch { throw "Setup failed and the rollback did not finish. Review backup '$directory'. Setup: $($failure.Exception.Message). Rollback: $($_.Exception.Message)" }
        throw $failure
    }
    return $directory
}

function Restore-CcofBackup {
    param([Parameter(Mandatory)][string]$BackupPath, [switch]$AllowChanged)
    $manifest = Read-CcofJsonFile (Join-Path $BackupPath 'snapshot.json') 'Backup manifest'
    if ($null -eq $manifest -or $manifest.schemaVersion -ne 1 -or $manifest.kind -cne 'claude-code' -or -not $manifest.files) {
        throw "'$BackupPath' is not a Claude Code setup backup. Select a folder under %LOCALAPPDATA%\ClaudeGateway\backups."
    }
    foreach ($record in $manifest.files) {
        if ($record.backupFile -notmatch '^\d+\.bin$' -or -not (Test-CcofAbsolutePath $record.path)) { throw 'Invalid backup manifest. No files restored.' }
        if ($record.existed -and -not [string]::Equals((Get-CcofFileHash (Join-Path $BackupPath $record.backupFile)), $record.beforeSha256, 'Ordinal')) {
            throw 'Backup integrity check failed. No files restored.'
        }
        if (-not $AllowChanged -and (-not $manifest.complete -or -not [string]::Equals((Get-CcofFileHash $record.path), $record.afterSha256, 'Ordinal'))) {
            throw "'$($record.path)' changed after setup, or setup did not finish. Review it; add -AllowChangedFiles to restore the original anyway."
        }
    }
    foreach ($record in $manifest.files) {
        if ($record.existed) { Copy-Item -LiteralPath (Join-Path $BackupPath $record.backupFile) -Destination $record.path -Force -ErrorAction Stop }
        elseif (Test-Path -LiteralPath $record.path) { Remove-Item -LiteralPath $record.path -Force -ErrorAction Stop }
    }
    return $manifest.changeId
}

function Invoke-CcofGatewayTest {
    <# One small Messages request with a token from the helper. Returns @{ Status; Message }; never returns or prints the token. #>
    param([Parameter(Mandatory)][string]$Helper, [Parameter(Mandatory)]$Config, [string]$Url)
    if (-not $Url) { $Url = $Config.gatewayUrl + '/v1/messages' }
    $output = @(& $Helper silent-token)
    $token = if ($output.Count) { [string]$output[0] } else { '' }
    $output = $null
    if ($LASTEXITCODE -ne 0 -or -not $token) { return @{ Status = 0; Message = "No token. Run: & `"$Helper`" login" } }
    $headers = @{ Authorization = 'Bearer ' + $token.Trim(); 'anthropic-version' = '2023-06-01' }
    $token = $null
    if ($Config.project -and $null -ne $Config.project.id) { $headers[$Config.project.selectorHeader] = [string]$Config.project.id }
    $body = ConvertTo-Json -Compress -Depth 5 -InputObject ([ordered]@{ model = $Config.models.default; max_tokens = 16
        messages = @([ordered]@{ role = 'user'; content = 'Reply with exactly: gateway OK' }) })
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try {
        $response = Invoke-WebRequest -Method Post -Uri $Url -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 120
        $text = ''
        try { $text = (($response.Content | ConvertFrom-Json).content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text } catch { }
        return @{ Status = [int]$response.StatusCode; Message = $text }
    } catch {
        $status = 0
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        $detail = [string]$_.ErrorDetails.Message
        $message = $detail
        try { $message = ($detail | ConvertFrom-Json).error.message } catch { }
        if (-not $message) { $message = $_.Exception.Message }
        return @{ Status = $status; Message = $message }
    } finally { $headers = $null }
}

# Dot-sourcing (the tests) loads the functions only.
if ($MyInvocation.InvocationName -eq '.') { return }

$ErrorActionPreference = 'Stop'
function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This setup is for Windows. On macOS and Linux use scripts/client/Set-ClaudeCodeGateway.ps1 (docs/get-started/05-developer-setup.md).' }
    if (-not $StateRoot) { $StateRoot = Join-Path $env:LOCALAPPDATA 'ClaudeGateway' }
    if (-not $ClaudeHome) { $ClaudeHome = Join-Path $env:USERPROFILE '.claude' }
    if (-not $VSCodeSettingsPath) { $VSCodeSettingsPath = Join-Path $env:APPDATA 'Code\User\settings.json' }
    if (-not $VSCodeExtensionsPath) { $VSCodeExtensionsPath = Join-Path $env:USERPROFILE '.vscode\extensions' }

    if ($Restore) {
        if (-not $Confirmed) { throw 'No changes made. Rerun with -Confirmed to restore this backup.' }
        $changeId = Restore-CcofBackup -BackupPath $Restore -AllowChanged:$AllowChangedFiles
        Say "Restored the files from backup $changeId." Green
        exit 0
    }
    if (-not $ConfigPath) { throw 'Give the administrator''s file: -ConfigPath .\client-config.json' }
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "No file at '$ConfigPath'." }
    $script:SourceConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path

    Say 'Checking...' Cyan
    $raw = Read-CcofJsonFile $script:SourceConfigPath 'The client configuration'
    $check = Test-CcofClientConfiguration $raw
    if ($check.Problems.Count) {
        Say "The client configuration needs fixing (ask the administrator; nothing was changed):" Red
        $check.Problems | ForEach-Object { Say "  - $_" Red }
        exit 2
    }
    $config = $check.Config
    Say "  Configuration ok: gateway $($config.gatewayUrl)" Green

    if (-not $AzureCliPath) {
        $az = Get-Command az.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $az) { throw 'The Azure CLI is not installed. Install it with the MSI from https://aka.ms/installazurecliwindowsx64 (or your company portal), open a new PowerShell window, and run this again.' }
        $AzureCliPath = $az.Source
    }
    Say "  Azure CLI: $AzureCliPath" Green
    $claude = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $claude -and (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.local\bin\claude.exe'))) { $claude = Get-Item (Join-Path $env:USERPROFILE '.local\bin\claude.exe') }
    if ($claude) { Say "  Claude Code: found" Green } else { Say '  Claude Code: not found. Setup continues; install it before use (docs/get-started/developer-setup-azure-cli.md).' Yellow }
    $vscodeExtension = [bool](Test-Path -LiteralPath $VSCodeExtensionsPath) -and [bool](Get-ChildItem -LiteralPath $VSCodeExtensionsPath -Directory -Filter 'anthropic.claude-code-*' -ErrorAction SilentlyContinue)
    if ($vscodeExtension) { Say '  Claude Code VS Code extension: found; its settings are updated too' Green }

    $plan = Get-CcofPlan -Config $config -ClaudeHome $ClaudeHome -StateRoot $StateRoot -AzureCliPath $AzureCliPath `
        -VSCodeSettingsPath $VSCodeSettingsPath -VSCodeExtension $vscodeExtension
    if (-not $Confirmed) {
        Say 'Files this setup would write (each is backed up first):' Cyan
        $plan.Paths | ForEach-Object { Say "  $_" }
        Say 'Nothing was changed. Rerun with -Confirmed to apply.' Yellow
        exit 0
    }

    $backup = Invoke-CcofApply -Plan $plan -BackupRoot (Join-Path $StateRoot 'backups')
    Say 'Claude Code is set up for the gateway.' Green
    Say "  Default model: $($config.models.default)"
    Say "  Backup (undo with -Restore): $backup"

    if ($Login) {
        Say 'Signing in: a Microsoft sign-in window opens...' Cyan
        & $plan.Helper login
        if ($LASTEXITCODE -ne 0) { Say "Sign-in did not finish. Run: & `"$($plan.Helper)`" login" Red; exit 4 }
    }
    if ($Test) {
        Say 'Sending one test request to the gateway...' Cyan
        $result = Invoke-CcofGatewayTest -Helper $plan.Helper -Config $config
        if ($result.Status -eq 200) { Say "  HTTP 200. Reply: $($result.Message)" Green }
        else { Say "  HTTP $($result.Status): $($result.Message)" Red; Say '  See the troubleshooting table in docs/get-started/developer-setup-azure-cli.md.' Yellow; exit 5 }
    }
    if (-not $Login) { Say "Next: sign in once with  & `"$($plan.Helper)`" login" Cyan }
    Say 'Then start Claude Code with: claude' Cyan
    exit 0
} catch {
    Say $_.Exception.Message Red
    exit 1
}
