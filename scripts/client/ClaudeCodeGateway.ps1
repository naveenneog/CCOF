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
    param([Parameter(Mandatory)][string]$WrapperPath)
    return "powershell -NoProfile -ExecutionPolicy Bypass -File `"$($WrapperPath.Replace('\', '/'))`""
}

function New-CcofUsageSkill {
    <#
    .SYNOPSIS
        ~/.claude/skills/usage/SKILL.md (docs/USAGE.md). A personal skill named usage replaces the built-in
        /usage in a local terminal session; /cost and /stats still run the built-in (Claude Code docs, "Extend
        Claude with skills", skills that share a name). The !`command` line runs the wrapper before the skill
        reaches Claude, so the figures come from the gateway, not from the model.
    #>
    param([Parameter(Mandatory)][string]$UsageCommand)
    $lines = @(
        '---'
        'name: usage'
        'description: Show the CCOF budget for Claude on this gateway - spent, budget and remaining this month in USD, as of the last cost run. Use when asked how much budget is used or left.'
        '---'
        "!``$UsageCommand``"
        ''
        'Show the lines above to the user exactly as written, as plain text. Do not recalculate, round, convert or estimate any figure, and do not add figures that are not above.'
        'If a line asks the user to sign in or retry, repeat that instruction. For this session''s own cost estimate, the user can run /cost.'
    )
    return ($lines -join "`n") + "`n"
}

function Set-CcofClaudeCode {
    param([string]$ConfigPath, [string]$ClaudeHome, [string]$VSCodeSettingsPath, [string]$BackupRoot,
        $Inventory, [string]$NodePath, [string]$TokenEntryPath, [string]$UsageEntryPath, [switch]$UsageStatusLine, [switch]$Confirmed)
    Assert-ClientConfirmation -Confirmed:$Confirmed
    if (-not $Inventory.CliVersion -and -not $Inventory.VSCodeVersion) {
        return (@{ event = 'not_installed'; component = 'claude-code' } | ConvertTo-Json -Compress)
    }
    $config = Read-ClientConfiguration $ConfigPath
    $path = Join-Path $ClaudeHome 'settings.json'
    $helper = Join-Path $ClaudeHome 'ccof-token.cmd'
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
    $settings.apiKeyHelper = "`"$helper`" token"
    $settings.model = $config.models.default
    $settings.availableModels = @($config.models.available)
    $settings.enforceAvailableModels = $true
    $azureCli = $config.signInMethod -ceq 'azure-cli'
    $shim = if ($azureCli) { New-ClientAzureCliTokenShim -TenantId $config.tenantId -Scope $config.scope -AzureConfigDir (Get-ClientAzureCliProfilePath $ConfigPath) -AzureCliPath (Resolve-ClientAzureCliPath) }
            else { New-ClientTokenShim $ConfigPath $NodePath $TokenEntryPath }
    $paths = @($path, $helper)
    $usageShimPath = Join-Path $ClaudeHome 'ccof-usage.ps1'
    $skillPath = Join-Path $ClaudeHome 'skills/usage/SKILL.md'
    $statusLineResult = 'not_requested'
    if ($UsageEntryPath) {
        # The command line is run by Git Bash or PowerShell: refuse characters either would expand in it.
        if ($usageShimPath -match '[`$"]') { throw 'The Claude home path holds a backtick, dollar sign or quote, which the /usage skill command cannot carry; nothing was changed.' }
        $usageShim = New-CcofUsageWrapper $ConfigPath $NodePath $UsageEntryPath $(if ($azureCli) { $helper } else { '' })
        $usageCommand = Get-CcofUsageCommand $usageShimPath
        $usageSkill = New-CcofUsageSkill $usageCommand
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
    Write-ClientText $helper $shim
    if ($UsageEntryPath) { Write-ClientText $usageShimPath $usageShim; Write-ClientText $skillPath $usageSkill }
    Write-ClientJson $path $settings
    if ($Inventory.VSCodeVersion) { Write-ClientJson $VSCodeSettingsPath $vscode }
    Complete-ClientSnapshot $snapshot
    return (@{ event = 'configured'; component = 'claude-code'; changeId = $snapshot.Manifest.changeId; usageSkill = [bool]$UsageEntryPath; statusLine = $statusLineResult
        signInMethod = $(if ($azureCli) { 'azure-cli' } else { 'msal' }); signIn = "`"$helper`" login" } | ConvertTo-Json -Compress)
}
