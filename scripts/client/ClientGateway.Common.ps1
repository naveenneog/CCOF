#Requires -Version 7.0
$script:ClientRepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

function Assert-ClientWindows {
    <# Claude Desktop setup and the inventory use cmd.exe helpers and Windows folders; elsewhere they stop before reading or writing anything. #>
    param([Parameter(Mandatory)][string]$Script, [bool]$OnWindows = $IsWindows)
    if ($OnWindows) { return }
    [ordered]@{ event = 'unsupported_platform'; platform = $(if ($IsMacOS) { 'macOS' } elseif ($IsLinux) { 'Linux' } else { 'other' }); script = $Script
        reason = 'Claude Desktop setup and the installed-client check support Windows only; nothing was changed. Claude Code setup runs on macOS and Linux (signInMethod azure-cli).'
        docs = 'docs/CLIENTS.md#macos-and-linux' } | ConvertTo-Json -Compress
    exit 2
}

function Read-ClientJson {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{} }
    try { $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop }
    catch { throw 'Invalid JSON configuration. Repair the original file before retrying; nothing was overwritten.' }
    if ($value -isnot [Collections.IDictionary]) { throw 'Configuration must be a JSON object.' }
    return $value
}

function New-ClientDirectory {
    <# Off Windows, every folder setup creates (parents included) is 700 from the start (ADR-0048); existing folders keep their mode. #>
    param([Parameter(Mandatory)][string]$Path)
    if ($IsWindows) { [void][IO.Directory]::CreateDirectory($Path); return }
    $missing = [Collections.Generic.Stack[string]]::new()
    for ($dir = [IO.Path]::GetFullPath($Path); $dir -and -not [IO.Directory]::Exists($dir); $dir = [IO.Path]::GetDirectoryName($dir)) { $missing.Push($dir) }
    foreach ($dir in $missing) { [void][IO.Directory]::CreateDirectory($dir, [IO.UnixFileMode]448) }
}

function Write-ClientText {
    <# -UnixMode (off Windows only): the mode the file is created with; default 600 (decimal 384), the helper 700 (448). #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Text, [int]$UnixMode = 384)
    New-ClientDirectory (Split-Path $Path -Parent)
    $pending = "$Path.pending-$([guid]::NewGuid().ToString('N'))"
    try {
        if ($IsWindows) { [IO.File]::WriteAllText($pending, $Text, [Text.UTF8Encoding]::new($false)) }
        else {
            $options = [IO.FileStreamOptions]@{ Mode = 'CreateNew'; Access = 'Write'; UnixCreateMode = [IO.UnixFileMode]$UnixMode }
            $writer = [IO.StreamWriter]::new($pending, [Text.UTF8Encoding]::new($false), $options)
            try { $writer.Write($Text) } finally { $writer.Dispose() }
        }
        [IO.File]::Move($pending, $Path, $true)
    } finally {
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
    }
}

function Write-ClientJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    Write-ClientText $Path (($Value | ConvertTo-Json -Depth 100) + "`n")
}

function Get-ClientDefaultConfigPath {
    <# Off Windows: $XDG_CONFIG_HOME/ClaudeGateway (when absolute), else ~/.config/ClaudeGateway (ADR-0048, XDG Base Directory). #>
    param([bool]$OnWindows = $IsWindows, [string]$HomePath = $HOME)
    if ($env:CCOF_CONFIG_FILE) { return $env:CCOF_CONFIG_FILE }
    if (-not $OnWindows) {
        $base = if ($env:XDG_CONFIG_HOME -and [IO.Path]::IsPathFullyQualified($env:XDG_CONFIG_HOME)) { $env:XDG_CONFIG_HOME } else { Join-Path $HomePath '.config' }
        return Join-Path $base 'ClaudeGateway/config.json'
    }
    if (-not $env:LOCALAPPDATA) { throw 'Set CCOF_CONFIG_FILE to an absolute client configuration file path.' }
    return Join-Path $env:LOCALAPPDATA 'ClaudeGateway\config.json'
}

function Read-ClientConfiguration {
    param([Parameter(Mandatory)][string]$Path)
    if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw 'Client configuration path must be absolute.' }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js is missing. Ask the coordinator before installing it.' }
    $value = & $node.Source (Join-Path $script:ClientRepoRoot 'client\bin\validate-config.mjs') $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $value) {
        throw 'Client configuration is missing or invalid. Review docs/CLIENTS.md and the administrator answers.'
    }
    return ($value | ConvertFrom-Json -AsHashtable)
}

function Assert-ClientConfirmation {
    param([switch]$Confirmed)
    if (-not $Confirmed) { throw 'No changes made. Review the target and rerun with -Confirmed to explicitly approve the change.' }
}

function Get-ClientFileHash {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
    return $null
}

function New-ClientSnapshot {
    param([string]$Kind, [string[]]$Paths, [string]$BackupRoot)
    $id = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N')
    $directory = Join-Path $BackupRoot $id
    New-ClientDirectory $directory
    $records = @(); $index = 0; $createdDirectories = [Collections.Generic.List[string]]::new()
    foreach ($path in $Paths) {
        $exists = Test-Path -LiteralPath $path -PathType Leaf
        $backupFile = "$index.bin"
        if ($exists) { Copy-Item -LiteralPath $path -Destination (Join-Path $directory $backupFile) -ErrorAction Stop }
        $records += @{ path = [IO.Path]::GetFullPath($path); existed = $exists; backupFile = $backupFile
            beforeSha256 = Get-ClientFileHash $path; afterSha256 = $null }
        # Folders setup will create for this file (for example skills\usage), so restore can remove them again.
        $parent = Split-Path ([IO.Path]::GetFullPath($path)) -Parent
        while ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            if (-not $createdDirectories.Contains($parent)) { $createdDirectories.Add($parent) }
            $parent = Split-Path $parent -Parent
        }
        $index++
    }
    $snapshot = @{ schemaVersion = 1; kind = $Kind; changeId = $id; complete = $false; files = $records; createdDirectories = @($createdDirectories) }
    Write-ClientJson (Join-Path $directory 'snapshot.json') $snapshot
    return @{ Directory = $directory; Manifest = $snapshot }
}

function Complete-ClientSnapshot {
    param($Snapshot)
    foreach ($record in $Snapshot.Manifest.files) { $record.afterSha256 = Get-ClientFileHash $record.path }
    $Snapshot.Manifest.complete = $true
    Write-ClientJson (Join-Path $Snapshot.Directory 'snapshot.json') $Snapshot.Manifest
}

function Restore-ClientSnapshot {
    param([Parameter(Mandatory)][string]$BackupPath, [Parameter(Mandatory)][string]$Kind,
        [switch]$Confirmed, [switch]$AllowChangedFiles)
    Assert-ClientConfirmation -Confirmed:$Confirmed
    $manifest = Read-ClientJson (Join-Path $BackupPath 'snapshot.json')
    if ($manifest.schemaVersion -ne 1 -or -not [string]::Equals($manifest.kind, $Kind, 'Ordinal') -or -not $manifest.files) {
        throw 'This backup does not match the requested client. Select its original snapshot directory.'
    }
    foreach ($record in $manifest.files) {
        if ($record.backupFile -notmatch '^\d+\.bin$' -or -not [IO.Path]::IsPathFullyQualified($record.path)) {
            throw 'Invalid backup manifest. No files restored.'
        }
        if ($record.existed -and -not [string]::Equals(
            (Get-ClientFileHash (Join-Path $BackupPath $record.backupFile)), $record.beforeSha256, 'Ordinal')) {
            throw 'Backup integrity check failed. No files restored.'
        }
        if (-not $AllowChangedFiles -and (-not $manifest.complete -or -not [string]::Equals(
            (Get-ClientFileHash $record.path), $record.afterSha256, 'Ordinal'))) {
            throw 'A configured file changed after setup, or setup was interrupted. Review it; use -AllowChangedFiles only to explicitly restore the original.'
        }
    }
    foreach ($record in $manifest.files) {
        if ($record.existed) { Copy-Item -LiteralPath (Join-Path $BackupPath $record.backupFile) -Destination $record.path -Force -ErrorAction Stop }
        elseif (Test-Path -LiteralPath $record.path) { Remove-Item -LiteralPath $record.path -Force -ErrorAction Stop }
    }
    # Folders setup created, deepest first, only when empty: anything the person put there stays.
    foreach ($dir in @($manifest.createdDirectories | Where-Object { $_ -and [IO.Path]::IsPathFullyQualified($_) } | Sort-Object { $_.Length } -Descending)) {
        if ((Test-Path -LiteralPath $dir -PathType Container) -and -not (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)) {
            Remove-Item -LiteralPath $dir -Force -ErrorAction Stop
        }
    }
    return (@{ event = 'restored'; component = $Kind; changeId = $manifest.changeId } | ConvertTo-Json -Compress)
}

function New-ClientTokenShim {
    param([string]$ConfigPath, [string]$NodePath, [string]$TokenEntryPath)
    foreach ($value in @($ConfigPath, $NodePath, $TokenEntryPath)) {
        if (-not [IO.Path]::IsPathFullyQualified($value) -or $value -match '["\r\n]') { throw 'Helper paths must be absolute and contain no quotes or line breaks.' }
    }
    $config = $ConfigPath.Replace('%', '%%')
    $node = $NodePath.Replace('%', '%%')
    $entry = $TokenEntryPath.Replace('%', '%%')
    return "@echo off`r`nsetlocal DisableDelayedExpansion`r`nset `"CCOF_CONFIG_FILE=$config`"`r`n`"$node`" `"$entry`" %*`r`nexit /b %errorlevel%`r`n"
}

function Get-ClientAzureCliProfilePath {
    <# The helper's own Azure CLI profile, beside the client configuration: shared by Claude Code and Desktop, never the developer's default az login. #>
    param([Parameter(Mandatory)][string]$ConfigPath)
    return Join-Path (Split-Path $ConfigPath -Parent) 'az'
}

function Resolve-ClientAzureCliPath {
    <#
    Full path of the installed Azure CLI, pinned into the helper so it never runs an az found in the folder it is
    started from or earlier on PATH: az.cmd on Windows (cmd.exe), az elsewhere (ADR-0048).
    #>
    param([bool]$OnWindows = $IsWindows)
    if ($OnWindows) {
        $az = Get-Command az.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $az) { throw 'azure_cli_missing: signInMethod azure-cli needs the Azure CLI. Install it (https://aka.ms/installazurecliwindows), open a new terminal, and run the setup again.' }
        return $az.Source
    }
    $az = Get-Command az -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $az) { throw 'azure_cli_missing: signInMethod azure-cli needs the Azure CLI. Install it (macOS: brew install azure-cli; Linux: https://learn.microsoft.com/cli/azure/install-azure-cli), open a new terminal, and run the setup again.' }
    return $az.Source
}

function Resolve-ClientTokenHelperPath {
    <#
    The generated helper: on Windows ccof-token.cmd of Claude Code, else of Claude Desktop (both share one Azure CLI
    profile); elsewhere ~/.claude/ccof-token (ADR-0048). $null when there is none.
    #>
    param([string]$UserProfile = $env:USERPROFILE, [string]$LocalAppData = $env:LOCALAPPDATA, [bool]$OnWindows = $IsWindows, [string]$HomePath = $HOME)
    $candidates = if ($OnWindows) { @((Join-Path $UserProfile '.claude\ccof-token.cmd'), (Join-Path $LocalAppData 'Claude-3p\ccof-token.cmd')) }
                  else { @(Join-Path $HomePath '.claude/ccof-token') }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function ConvertTo-ClientShQuoted {
    <# One sh word: the value in single quotes, each ' written as '\'' (POSIX Shell Command Language 2.2.2). #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    return "'" + $Value.Replace("'", "'\''") + "'"
}

function New-ClientAzureCliPosixTokenShim {
    <#
    .SYNOPSIS
        ~/.claude/ccof-token on macOS and Linux (ADR-0048): the sh counterpart of New-ClientAzureCliTokenShim, with
        the same verbs (token, silent-token, login, status, logout) and exit codes (0 token, 2 usage, 3 Azure CLI
        missing, 4 not signed in). Claude Code runs apiKeyHelper through /bin/sh there. Only token and silent-token
        write to stdout, and only the token; Azure CLI output goes to stderr. Every value is one single-quoted word;
        the tenant and scope are validated as on Windows, and no value may hold a line break.
    #>
    param([Parameter(Mandatory)][string]$TenantId, [Parameter(Mandatory)][string]$Scope, [Parameter(Mandatory)][string]$AzureConfigDir,
        [Parameter(Mandatory)][string]$AzureCliPath)
    if ($TenantId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'The tenant must be a directory (tenant) ID GUID.' }
    if ($Scope -cnotmatch '^[A-Za-z0-9:/._-]+$') { throw 'The scope may contain only letters, digits and : / . _ - for the Azure CLI helper.' }
    if (-not [IO.Path]::IsPathFullyQualified($AzureConfigDir) -or $AzureConfigDir -match "[\r\n\0]") { throw 'The Azure CLI profile folder must be absolute and contain no line breaks.' }
    if (-not [IO.Path]::IsPathFullyQualified($AzureCliPath) -or $AzureCliPath -match "[\r\n\0]") { throw 'The Azure CLI path must be absolute and contain no line breaks.' }
    $lines = @(
        '#!/bin/sh'
        '# CCOF gateway token helper (signInMethod azure-cli, ADR-0041/ADR-0048), generated by Set-ClaudeCodeGateway.ps1.'
        '# Usage: ccof-token [token|silent-token|login|status|logout]. Only the token is written to stdout.'
        "AZ=$(ConvertTo-ClientShQuoted $AzureCliPath)"
        "TENANT='$TenantId'"
        "SCOPE='$Scope'"
        "AZURE_CONFIG_DIR=$(ConvertTo-ClientShQuoted $AzureConfigDir)"
        'AZURE_CORE_LOGIN_EXPERIENCE_V2=off'
        'export AZURE_CONFIG_DIR AZURE_CORE_LOGIN_EXPERIENCE_V2'
        'gettoken() { "$AZ" account get-access-token --tenant "$TENANT" --scope "$SCOPE" --query accessToken --output tsv --only-show-errors; }'
        'signin() { "$AZ" login --tenant "$TENANT" --scope "$SCOPE" --allow-no-subscriptions --output none --only-show-errors </dev/null 1>&2; }'
        'if [ ! -x "$AZ" ]; then'
        '  echo "The Azure CLI is not installed at $AZ. Install it (macOS: brew install azure-cli; Linux: https://learn.microsoft.com/cli/azure/install-azure-cli) and run the client setup again." >&2'
        '  exit 3'
        'fi'
        'case "${1:-token}" in'
        '  token)'
        '    gettoken 2>/dev/null && exit 0'
        '    echo "Not signed in to the Claude gateway. Opening the Microsoft Entra sign-in." >&2'
        '    signin || exit 4'
        '    gettoken && exit 0'
        '    echo "No gateway token after sign-in. Run: ''$0'' status, and contact the platform team." >&2'
        '    exit 4 ;;'
        '  silent-token)'
        '    gettoken && exit 0'
        '    echo "Not signed in to the Claude gateway. Run: ''$0'' login" >&2'
        '    exit 4 ;;'
        '  login)'
        '    signin || exit 4'
        '    echo "Signed in. Claude Code now uses this sign-in." >&2'
        '    exit 0 ;;'
        '  status)'
        '    "$AZ" account show --query user.name --output tsv --only-show-errors && exit 0'
        '    echo "Not signed in. Run: ''$0'' login" >&2'
        '    exit 4 ;;'
        '  logout)'
        '    "$AZ" logout --only-show-errors 1>&2'
        '    exit 0 ;;'
        '  *)'
        '    echo "Usage: ccof-token [token|silent-token|login|status|logout]" >&2'
        '    exit 2 ;;'
        'esac'
    )
    return ($lines -join "`n") + "`n"
}

function New-ClientAzureCliTokenShim {
    <#
    .SYNOPSIS
        ccof-token.cmd for signInMethod azure-cli (ADR-0041). `token` (or no argument) prints only the gateway
        access token from `az account get-access-token`; when that fails it runs one interactive `az login`
        for the gateway scope and tries once more. `silent-token` never signs in (for /usage and its status
        line). `login`, `status` and `logout` manage the sign-in. Every call runs in its own AZURE_CONFIG_DIR
        and through the az.cmd found at setup, by full path. Azure CLI output other than the token goes to stderr.
        Exit codes: 0 token, 2 usage, 3 Azure CLI missing, 4 not signed in or sign-in failed.
        az.cmd hands its arguments to cmd.exe, so the tenant and scope are restricted to characters cmd.exe
        does not interpret.
    #>
    param([Parameter(Mandatory)][string]$TenantId, [Parameter(Mandatory)][string]$Scope, [Parameter(Mandatory)][string]$AzureConfigDir,
        [Parameter(Mandatory)][string]$AzureCliPath)
    if ($TenantId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'The tenant must be a directory (tenant) ID GUID.' }
    if ($Scope -cnotmatch '^[A-Za-z0-9:/._-]+$') { throw 'The scope may contain only letters, digits and : / . _ - for the Azure CLI helper.' }
    if (-not [IO.Path]::IsPathFullyQualified($AzureConfigDir) -or $AzureConfigDir -match '["\r\n]') { throw 'The Azure CLI profile folder must be absolute and contain no quotes or line breaks.' }
    if (-not [IO.Path]::IsPathFullyQualified($AzureCliPath) -or $AzureCliPath -match '["\r\n]') { throw 'The Azure CLI path must be absolute and contain no quotes or line breaks.' }
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
        'call :gettoken && exit /b 0'
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
