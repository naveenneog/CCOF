#Requires -Version 7.0
. (Join-Path $PSScriptRoot 'ClientGateway.Common.ps1')
. (Join-Path $PSScriptRoot 'ClientProjectHeaders.ps1')

function New-CcofCodeEnvironment {
    param($Config, [string]$ConfigPath)
    # ADR-0041: the Azure CLI refreshes a token only when under 5 minutes remain, so a 300-second helper cache
    # could hand Claude Code a token that expires before the next call.
    $ttlSeconds = if ($Config.signInMethod -ceq 'azure-cli') { [Math]::Min($Config.helperTtlSeconds, 240) } else { $Config.helperTtlSeconds }
    $envs = @{
        ANTHROPIC_BASE_URL = $Config.gatewayUrl
        ANTHROPIC_MODEL = $Config.models.default
        CLAUDE_CODE_API_KEY_HELPER_TTL_MS = [string]($ttlSeconds * 1000)
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

function New-CcofUsageWrapper {
    <#
    .SYNOPSIS
        ~/.claude/ccof-usage.ps1: pins the client configuration and runs ccof-usage with the installed Node.
        Run as `powershell -NoProfile -ExecutionPolicy Bypass -File "<path with forward slashes>"`, the form Claude
        Code documents for Windows: it works whether Claude Code runs the command through Git Bash or PowerShell
        (Claude Code docs, "Customize your status line", Windows configuration). -ExecutionPolicy Bypass applies
        to that one process and does not override a Group Policy execution policy.
    #>
    param([string]$ConfigPath, [string]$NodePath, [string]$UsageEntryPath, [string]$TokenHelperPath)
    foreach ($value in @($ConfigPath, $NodePath, $UsageEntryPath) + @($TokenHelperPath | Where-Object { $_ })) {
        if (-not [IO.Path]::IsPathFullyQualified($value) -or $value -match "[`r`n]") { throw 'Usage paths must be absolute and contain no line breaks.' }
    }
    $q = { param([string]$s) "'" + $s.Replace("'", "''") + "'" }
    # In azure-cli mode /usage takes its token from the same helper Claude Code runs (client/src/helper-token.mjs).
    $helperLine = if ($TokenHelperPath) { "`$env:CCOF_TOKEN_HELPER = $(& $q $TokenHelperPath)`r`n" } else { '' }
    return "`$ErrorActionPreference = 'Stop'`r`n`$env:CCOF_CONFIG_FILE = $(& $q $ConfigPath)`r`n$helperLine& $(& $q $NodePath) $(& $q $UsageEntryPath) @args`r`nexit `$LASTEXITCODE`r`n"
}

function Get-CcofUsageCommand {
    <# Windows: powershell -File with forward slashes (Git Bash or PowerShell runs it). macOS/Linux: pwsh -File (ADR-0048). #>
    param([Parameter(Mandatory)][string]$WrapperPath, [bool]$OnWindows = $IsWindows)
    if (-not $OnWindows) { return "pwsh -NoProfile -File `"$(ConvertTo-CcofPosixPath $WrapperPath)`"" }
    return "powershell -NoProfile -ExecutionPolicy Bypass -File `"$($WrapperPath.Replace('\', '/'))`""
}

function ConvertTo-CcofPosixPath {
    <# A backslash is a path separator only on a Windows host (where the POSIX setup is simulated in tests). #>
    param([Parameter(Mandatory)][string]$Path)
    if ([IO.Path]::DirectorySeparatorChar -eq '\') { return $Path.Replace('\', '/') }
    return $Path
}

function Test-CcofGitBash {
    <# Whether Claude Code finds Git Bash and therefore runs a skill's injected command with its Bash tool. #>
    if ($env:CLAUDE_CODE_GIT_BASH_PATH -and (Test-Path -LiteralPath $env:CLAUDE_CODE_GIT_BASH_PATH -PathType Leaf)) { return $true }
    $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates = @(
        $(if ($git) { Join-Path (Split-Path (Split-Path $git.Source -Parent) -Parent) 'bin\bash.exe' })
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Git\bin\bash.exe' }))
    return [bool]@($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }).Count
}

function New-CcofUsageSkill {
    <#
    .SYNOPSIS
        ~/.claude/skills/usage/SKILL.md (docs/USAGE.md). A personal skill named usage replaces the built-in
        /usage in a local terminal session; /cost and /stats still run the built-in (Claude Code docs, "Extend
        Claude with skills", skills that share a name). The !`command` line runs the wrapper before the skill
        reaches Claude, so the figures come from the gateway, not from the model.
        Claude Code checks that command against the permission rules and aborts the skill unless they allow it
        ("Shell command permission check failed ... requires approval", DEV-1), so allowed-tools pre-approves
        exactly this one command (Claude Code docs, "Permission checks on injected commands"; deny and ask rules
        still win). With Git Bash the Bash tool runs it: `powershell -File <wrapper>`. Without Git Bash the
        PowerShell tool runs it, and that tool refuses a nested PowerShell process ("Command spawns a nested
        PowerShell process which cannot be validated", Claude Code 2.1.272), so the skill sets `shell: powershell`
        and calls the wrapper directly.
    #>
    param([Parameter(Mandatory)][string]$WrapperPath, [ValidateSet('bash', 'powershell')][string]$Shell = 'bash', [bool]$OnWindows = $IsWindows)
    if ($WrapperPath -match "[`r`n```$`"]") { throw 'The usage wrapper path cannot hold a line break, backtick, dollar sign or quote.' }
    # PowerShell closes a single-quoted string at ' and at U+2018-U+201B; doubling any of them keeps it literal.
    $command = if ($Shell -ceq 'bash') { Get-CcofUsageCommand $WrapperPath -OnWindows $OnWindows } else { "& '" + ($WrapperPath.Replace('\', '/') -replace "(['\u2018-\u201B])", '$1$1') + "'" }
    $tool = if ($Shell -ceq 'bash') { 'Bash' } else { 'PowerShell' }
    $lines = @(
        '---'
        'name: usage'
        'description: Show the CCOF budget for Claude on this gateway - spent, budget and remaining this month in USD, as of the last cost run. Use when asked how much budget is used or left.'
        $(if ($Shell -ceq 'powershell') { 'shell: powershell' })
        'allowed-tools:'
        ("  - '" + "$tool($command)".Replace("'", "''") + "'")
        '---'
        "!``$command``"
        ''
        'Show the lines above to the user exactly as written, as plain text. Do not recalculate, round, convert or estimate any figure, and do not add figures that are not above.'
        'If a line asks the user to sign in or retry, repeat that instruction. For this session''s own cost estimate, the user can run /cost.'
    )
    return ($lines -join "`n") + "`n"
}

function Set-CcofClaudeCode {
    param([string]$ConfigPath, [string]$ClaudeHome, [string]$VSCodeSettingsPath, [string]$BackupRoot,
        $Inventory, [string]$NodePath, [string]$TokenEntryPath, [string]$UsageEntryPath, [switch]$UsageStatusLine, [switch]$Confirmed,
        [ValidateSet('bash', 'powershell')][string]$SkillShell, [bool]$OnWindows = $IsWindows)
    Assert-ClientConfirmation -Confirmed:$Confirmed
    if (-not $Inventory.CliVersion -and -not $Inventory.VSCodeVersion) {
        return (@{ event = 'not_installed'; component = 'claude-code' } | ConvertTo-Json -Compress)
    }
    $config = Read-ClientConfiguration $ConfigPath
    # ADR-0048: off Windows only the Azure CLI sign-in has a helper; nothing is written for another method.
    if (-not $OnWindows -and $config.signInMethod -cne 'azure-cli') {
        $method = if ($config.signInMethod) { $config.signInMethod } else { 'msal' }
        throw "unsupported_sign_in_method: on macOS and Linux Claude Code setup supports signInMethod azure-cli only (this configuration uses '$method'). Ask the administrator for an azure-cli client configuration; nothing was changed."
    }
    $path = Join-Path $ClaudeHome 'settings.json'
    $helper = Join-Path $ClaudeHome $(if ($OnWindows) { 'ccof-token.cmd' } else { 'ccof-token' })
    if (-not $OnWindows -and $helper -match "[`r`n]") { throw 'The Claude home path holds a line break; nothing was changed.' }
    # Claude Code runs apiKeyHelper through cmd on Windows and /bin/sh on macOS and Linux.
    $helperCommand = if ($OnWindows) { "`"$helper`"" } else { ConvertTo-ClientShQuoted $helper }
    $settings = Read-ClientJson $path
    if ($settings.Contains('env') -and $settings.env -isnot [Collections.IDictionary]) { throw 'Claude Code env must be an object; nothing was changed.' }
    if (-not $settings.env) { $settings.env = @{} }
    $entries = @()
    if ($Inventory.VSCodeVersion) {
        $vscode = Read-ClientJson $VSCodeSettingsPath
        $entries = @($vscode['claudeCode.environmentVariables'])
        if ($entries.Count -eq 1 -and $null -eq $entries[0]) { $entries = @() }
        foreach ($entry in $entries) {
            if ($entry -isnot [Collections.IDictionary] -or -not $entry.name -or $entry.value -isnot [string]) {
                throw 'VS Code claudeCode.environmentVariables must be name/value objects; nothing was changed.'
            }
        }
    }
    $envs = New-CcofCodeEnvironment $config $ConfigPath
    if ($config.project) {
        $sources = @($settings.env.ANTHROPIC_CUSTOM_HEADERS) + @($entries |
            Where-Object { $_.name -eq 'ANTHROPIC_CUSTOM_HEADERS' } | ForEach-Object { $_.value })
        $headers = Merge-CcofProjectHeaders -Sources $sources -Project $config.project
        $envs.ANTHROPIC_CUSTOM_HEADERS = (@($headers.Keys | ForEach-Object { "${_}: $($headers[$_])" }) -join "`n")
    }
    foreach ($key in $envs.Keys) { $settings.env[$key] = $envs[$key] }
    foreach ($key in @('ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL',
        'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN')) { $settings.env.Remove($key) | Out-Null }
    $settings.apiKeyHelper = "$helperCommand token"
    $settings.model = $config.models.default
    $settings.availableModels = @($config.models.available)
    $settings.enforceAvailableModels = $true
    $azureCli = $config.signInMethod -ceq 'azure-cli'
    $azProfile = Get-ClientAzureCliProfilePath $ConfigPath
    $shim = if ($azureCli -and -not $OnWindows) { New-ClientAzureCliPosixTokenShim -TenantId $config.tenantId -Scope $config.scope -AzureConfigDir $azProfile -AzureCliPath (Resolve-ClientAzureCliPath -OnWindows $false) }
            elseif ($azureCli) { New-ClientAzureCliTokenShim -TenantId $config.tenantId -Scope $config.scope -AzureConfigDir $azProfile -AzureCliPath (Resolve-ClientAzureCliPath) }
            else { New-ClientTokenShim $ConfigPath $NodePath $TokenEntryPath }
    $paths = @($path, $helper)
    $usageShimPath = Join-Path $ClaudeHome 'ccof-usage.ps1'
    $skillPath = Join-Path $ClaudeHome 'skills/usage/SKILL.md'
    $statusLineResult = 'not_requested'
    if ($UsageEntryPath) {
        # The command line is run by Git Bash or PowerShell: refuse characters either would expand in it.
        if ($usageShimPath -match '[`$"]') { throw 'The Claude home path holds a backtick, dollar sign or quote, which the /usage skill command cannot carry; nothing was changed.' }
        $usageShim = New-CcofUsageWrapper $ConfigPath $NodePath $UsageEntryPath $(if ($azureCli) { $helper } else { '' })
        $usageCommand = Get-CcofUsageCommand $usageShimPath -OnWindows $OnWindows
        # macOS and Linux have bash, so Claude Code runs the skill's command with its Bash tool (ADR-0048).
        $skillShellUsed = if ($SkillShell) { $SkillShell } elseif (-not $OnWindows -or (Test-CcofGitBash)) { 'bash' } else { 'powershell' }
        $usageSkill = New-CcofUsageSkill -WrapperPath $usageShimPath -Shell $skillShellUsed -OnWindows $OnWindows
        $paths += @($usageShimPath, $skillPath)
        if ($UsageStatusLine) {
            # Only when the person has no status line of their own; an existing one is never replaced.
            if ($settings.Contains('statusLine')) { $statusLineResult = 'kept_existing' }
            else { $settings.statusLine = [ordered]@{ type = 'command'; command = "$usageCommand --statusline" }; $statusLineResult = 'set' }
        }
    }
    if ($Inventory.VSCodeVersion) {
        $merged = @($entries | Where-Object {
            -not $envs.ContainsKey([string]$_.name) -and $_.name -notlike 'ANTHROPIC_FOUNDRY_*'
        })
        foreach ($key in ($envs.Keys | Sort-Object)) { $merged += @{ name = $key; value = $envs[$key] } }
        $vscode['claudeCode.environmentVariables'] = $merged
        $vscode['claudeCode.disableLoginPrompt'] = $true
        $paths += $VSCodeSettingsPath
    }
    $snapshot = New-ClientSnapshot 'claude-code' $paths $BackupRoot
    if ($azureCli -and -not $IsWindows) {
        # The helper's own Azure CLI profile holds its tokens: owner-only, also when it already exists.
        New-ClientDirectory $azProfile
        [IO.File]::SetUnixFileMode($azProfile, [IO.UnixFileMode]448)
    }
    Write-ClientText $helper $shim -UnixMode 448
    if ($UsageEntryPath) { Write-ClientText $usageShimPath $usageShim; Write-ClientText $skillPath $usageSkill }
    Write-ClientJson $path $settings
    if ($Inventory.VSCodeVersion) { Write-ClientJson $VSCodeSettingsPath $vscode }
    Complete-ClientSnapshot $snapshot
    return (@{ event = 'configured'; component = 'claude-code'; changeId = $snapshot.Manifest.changeId; usageSkill = [bool]$UsageEntryPath; usageSkillShell = $skillShellUsed; statusLine = $statusLineResult
        signInMethod = $(if ($azureCli) { 'azure-cli' } else { 'msal' }); signIn = "$helperCommand login"
        models = [ordered]@{ default = $config.models.default; opus = $config.models.opus; sonnet = $config.models.sonnet; haiku = $config.models.haiku } } | ConvertTo-Json -Compress)
}
