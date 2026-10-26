#Requires -Version 7.0
# ADR-0048: Claude Code setup on macOS and Linux with the Azure CLI sign-in. Runs on every platform: on Windows
# the POSIX branch is simulated (-OnWindows:$false) and the generated text is checked; on macOS and Linux the
# generated sh helper also runs against a mock az, and file modes and the setup entrypoint are checked.
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
. (Join-Path $repo 'scripts/client/ClientGateway.Common.ps1')
. (Join-Path $repo 'scripts/client/ClaudeCodeGateway.ps1')
. (Join-Path $repo 'scripts/client/ClientInventory.ps1')
. (Join-Path $repo 'scripts/client/ClientProcess.ps1')

$work = Join-Path $repo ('client/.test-work/posix-' + [guid]::NewGuid().ToString('N'))
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
function Get-Mode([string]$Path) { '{0:000}' -f [Convert]::ToInt32([Convert]::ToString([int][IO.File]::GetUnixFileMode($Path), 8)) }
$posixHost = -not $IsWindows

try {
    $config = @{
        schemaVersion = 1
        tenantId = '11111111-1111-4111-8111-111111111111'
        clientId = '22222222-2222-4222-8222-222222222222'
        scope = 'api://33333333-3333-4333-8333-333333333333/access_as_user'
        gatewayUrl = 'https://gateway.example.test/anthropic'
        helperTtlSeconds = 300; minimumTokenLifetimeSeconds = 360
        loginTimeoutSeconds = 120; tokenTimeoutSeconds = 30
        disableNonessentialTraffic = $true
        signInMethod = 'azure-cli'
        models = @{ default = 'sonnet-deployment'; opus = 'opus-deployment'
            sonnet = 'sonnet-deployment'; haiku = 'haiku-deployment'
            available = @('sonnet-deployment', 'opus-deployment', 'haiku-deployment') }
        desktop = @{ profileId = '44444444-4444-4444-8444-444444444444'; profileName = 'Test gateway' }
    }
    $configPath = Join-Path $work 'xdg/ClaudeGateway/config.json'
    Write-ClientJson $configPath $config
    $msalConfig = $config.Clone(); $msalConfig.Remove('signInMethod')
    $msalPath = Join-Path $work 'msal/config.json'
    Write-ClientJson $msalPath $msalConfig
    $node = (Get-Command node -ErrorAction Stop).Source
    $inventory = @{ CliVersion = '2.1.272'; VSCodeVersion = $null }

    # A mock Azure CLI for this host: az.cmd on Windows (found through PATHEXT), an sh script elsewhere.
    $mockDir = Join-Path $work 'mock-az'
    [void][IO.Directory]::CreateDirectory($mockDir)
    if ($posixHost) {
        $mockAz = Join-Path $mockDir 'az'
        Write-ClientText $mockAz @'
#!/bin/sh
d=$(dirname "$0")
echo "[$AZURE_CONFIG_DIR] $*" >> "$d/calls.log"
case "$1 $2" in
  "login "*) echo LOGIN-OUTPUT-NOT-A-TOKEN; echo signed-in > "$d/session"; exit 0;;
  "logout "*) rm -f "$d/session"; exit 0;;
  "account show") [ -f "$d/session" ] || { echo "AADSTS50076 interaction required." >&2; exit 1; }; echo developer@example.test; exit 0;;
  "account get-access-token") [ -f "$d/session" ] || { echo "AADSTS50076 interaction required." >&2; exit 1; }; echo eyJ.mock.token; exit 0;;
esac
exit 99
'@.Replace("`r`n", "`n") -UnixMode 448
    } else {
        $mockAz = Join-Path $mockDir 'az.cmd'
        Write-ClientText $mockAz "@echo off`r`necho eyJ.mock.token`r`n"
    }
    function Use-MockAzOnPath([scriptblock]$Body) { $saved = $env:PATH; $env:PATH = "$mockDir$([IO.Path]::PathSeparator)$saved"; try { & $Body } finally { $env:PATH = $saved } }
    function Read-AzCalls { $log = Join-Path $mockDir 'calls.log'; if (Test-Path $log) { $c = @(Get-Content $log); Remove-Item $log -Force; return $c }; return @() }

    Test-Case 'the default configuration path off Windows is $XDG_CONFIG_HOME/ClaudeGateway, else ~/.config/ClaudeGateway' {
        $saved = @{ CCOF_CONFIG_FILE = $env:CCOF_CONFIG_FILE; XDG_CONFIG_HOME = $env:XDG_CONFIG_HOME }
        try {
            $env:CCOF_CONFIG_FILE = $null
            $home2 = Join-Path $work 'home'
            $env:XDG_CONFIG_HOME = $null
            Assert ((Get-ClientDefaultConfigPath -OnWindows:$false -HomePath $home2) -ceq (Join-Path $home2 '.config/ClaudeGateway/config.json')) 'Unset XDG_CONFIG_HOME must use ~/.config'
            $env:XDG_CONFIG_HOME = 'relative/dir'
            Assert ((Get-ClientDefaultConfigPath -OnWindows:$false -HomePath $home2) -ceq (Join-Path $home2 '.config/ClaudeGateway/config.json')) 'A relative XDG_CONFIG_HOME must be ignored'
            $xdg = Join-Path $work 'xdg'
            $env:XDG_CONFIG_HOME = $xdg
            Assert ((Get-ClientDefaultConfigPath -OnWindows:$false -HomePath $home2) -ceq (Join-Path $xdg 'ClaudeGateway/config.json')) 'An absolute XDG_CONFIG_HOME must be used'
            $env:CCOF_CONFIG_FILE = $configPath
            Assert ((Get-ClientDefaultConfigPath -OnWindows:$false -HomePath $home2) -ceq $configPath) 'CCOF_CONFIG_FILE must win'
        } finally { foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] -ErrorAction SilentlyContinue; if ($null -eq $saved[$k]) { Remove-Item "env:$k" -ErrorAction SilentlyContinue } } }
    }

    $good = @{ TenantId = $config.tenantId; Scope = $config.scope; AzureConfigDir = (Join-Path $work "az prof'ile `$HOME") ; AzureCliPath = $mockAz }
    Test-Case 'the sh helper refuses an unsafe tenant, scope or path, and single-quotes every value' {
        $text = New-ClientAzureCliPosixTokenShim @good
        Assert ($text.StartsWith("#!/bin/sh`n")) 'Not an sh script'
        Assert (-not $text.Contains("`r")) 'sh scripts must use LF line endings'
        Assert ($text.Contains("AZ='" + $mockAz.Replace("'", "'\''") + "'")) 'Azure CLI not pinned by its full path in single quotes'
        Assert ($text.Contains("AZURE_CONFIG_DIR='" + $good.AzureConfigDir.Replace("'", "'\''") + "'")) "Profile folder not quoted for sh: $(($text -split "`n") -match '^AZURE_CONFIG_DIR')"
        Assert ($text -match '(?m)^export AZURE_CONFIG_DIR AZURE_CORE_LOGIN_EXPERIENCE_V2$') 'Profile folder not exported to az'
        foreach ($bad in @(@{ TenantId = 'common' }, @{ TenantId = "$($config.tenantId)';id;'" }, @{ Scope = "$($config.scope)';id;'" },
            @{ Scope = 'api://x/a$(id)' }, @{ Scope = 'api://x/a b' }, @{ AzureConfigDir = 'relative/az' }, @{ AzureConfigDir = (Join-Path $work "a`nb") },
            @{ AzureCliPath = 'az' }, @{ AzureCliPath = (Join-Path $work "a`rb/az") })) {
            $values = $good.Clone(); foreach ($k in $bad.Keys) { $values[$k] = $bad[$k] }
            Refuses { New-ClientAzureCliPosixTokenShim @values } 'tenant|scope|folder|Azure CLI path'
        }
    }

    Test-Case 'off Windows the Azure CLI is found as az (not az.cmd), and a missing one names the macOS/Linux install page' {
        Assert ((Use-MockAzOnPath { Resolve-ClientAzureCliPath -OnWindows:$false }) -ceq $mockAz) 'The az on PATH was not resolved'
        $saved = $env:PATH; $env:PATH = Join-Path $work 'empty-path'
        try {
            try { Resolve-ClientAzureCliPath -OnWindows:$false; throw 'no refusal' } catch {
                Assert ($_.Exception.Message -match '^azure_cli_missing:' -and $_.Exception.Message -match 'learn\.microsoft\.com/cli/azure/install-azure-cli' -and $_.Exception.Message -notmatch 'installazurecliwindows') "Missing Azure CLI message: $($_.Exception.Message)"
            }
        } finally { $env:PATH = $saved }
    }

    Test-Case 'off Windows the verifier finds ~/.claude/ccof-token' {
        $home3 = Join-Path $work 'home3'
        Assert ($null -eq (Resolve-ClientTokenHelperPath -OnWindows:$false -HomePath $home3)) 'A helper was reported where none exists'
        Write-ClientText (Join-Path $home3 '.claude/ccof-token.cmd') '@echo off'
        Assert ($null -eq (Resolve-ClientTokenHelperPath -OnWindows:$false -HomePath $home3)) 'A Windows helper must not be used off Windows'
        Write-ClientText (Join-Path $home3 '.claude/ccof-token') '#!/bin/sh'
        Assert ((Resolve-ClientTokenHelperPath -OnWindows:$false -HomePath $home3) -ceq (Join-Path $home3 '.claude/ccof-token')) 'The POSIX helper was not found'
    }

    $claudeHome = Join-Path $work 'home/.claude'
    $codeArgs = @{ ConfigPath = $configPath; ClaudeHome = $claudeHome; VSCodeSettingsPath = (Join-Path $work 'home/code/settings.json')
        BackupRoot = (Join-Path $work 'xdg/ClaudeGateway/backups'); Inventory = $inventory; NodePath = $node
        TokenEntryPath = (Join-Path $repo 'client/bin/ccof-token.mjs'); UsageEntryPath = (Join-Path $repo 'client/bin/ccof-usage.mjs'); OnWindows = $false }

    Test-Case 'off Windows a sign-in method other than azure-cli is refused with unsupported_sign_in_method before anything is written' {
        $options = $codeArgs.Clone(); $options.ConfigPath = $msalPath; $options.ClaudeHome = Join-Path $work 'msal-home/.claude'
        Refuses { Set-CcofClaudeCode @options -Confirmed } '^unsupported_sign_in_method:.*azure-cli'
        Assert (-not (Test-Path -LiteralPath $options.ClaudeHome)) 'Files were written for an unsupported sign-in method'
    }

    Test-Case 'off Windows setup writes the sh helper, an sh apiKeyHelper, the Windows env, and /usage and the status line through pwsh' {
        $script:posixResult = Use-MockAzOnPath { Set-CcofClaudeCode @codeArgs -UsageStatusLine -Confirmed } | ConvertFrom-Json -AsHashtable
        $helper = Join-Path $claudeHome 'ccof-token'
        $q = "'" + $helper.Replace("'", "'\''") + "'"
        Assert ($posixResult.event -ceq 'configured' -and $posixResult.signInMethod -ceq 'azure-cli') "Result: $($posixResult | ConvertTo-Json -Compress)"
        Assert ($posixResult.signIn -ceq "$q login") "Sign-in command: $($posixResult.signIn)"
        Assert (-not (Test-Path -LiteralPath (Join-Path $claudeHome 'ccof-token.cmd'))) 'A cmd.exe helper was written off Windows'
        $shim = [IO.File]::ReadAllText($helper)
        Assert ($shim.StartsWith('#!/bin/sh') -and $shim.Contains("AZ='$mockAz'") -and $shim -notmatch '\bnode\b') 'Helper is not the sh Azure CLI helper pinned to az'
        Assert ($shim -match '(?s)silent-token\)\n\s+gettoken 2>/dev/null && exit 0') 'silent-token lets the Azure CLI sign-in error through'
        Assert ($shim.Contains('"$AZ" account show --query user.name --output tsv --only-show-errors 2>/dev/null && exit 0')) 'status lets the Azure CLI sign-in error through'
        Assert ($shim.Contains("AZURE_CONFIG_DIR='" + (Join-Path (Split-Path $configPath -Parent) 'az') + "'")) 'Profile folder is not beside the configuration'
        $settings = Read-ClientJson (Join-Path $claudeHome 'settings.json')
        Assert ($settings.apiKeyHelper -ceq "$q token") "apiKeyHelper: $($settings.apiKeyHelper)"
        Assert ($settings.env.ANTHROPIC_BASE_URL -ceq $config.gatewayUrl -and $settings.env.CCOF_CONFIG_FILE -ceq $configPath) 'Gateway env missing'
        Assert ([int]$settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS -le 240000) 'Helper cache above the Azure CLI refresh floor'
        Assert ($settings.model -ceq 'sonnet-deployment' -and $settings.enforceAvailableModels) 'Models not pinned'
        $wrapperPath = Join-Path $claudeHome 'ccof-usage.ps1'
        $posixWrapper = if ([IO.Path]::DirectorySeparatorChar -eq '\') { $wrapperPath.Replace('\', '/') } else { $wrapperPath }
        $command = 'pwsh -NoProfile -File "' + $posixWrapper + '"'
        Assert ($settings.statusLine.command -ceq "$command --statusline") "Status line: $($settings.statusLine.command)"
        $skill = [IO.File]::ReadAllText((Join-Path $claudeHome 'skills/usage/SKILL.md'))
        Assert ($skill.Contains('!`' + $command + '`')) "Skill does not run the wrapper through pwsh: $skill"
        $grants = @([regex]::Matches(($skill -split '\r?\n---\r?\n')[0], '(?m)^  - (.+)$') | ForEach-Object { $_.Groups[1].Value })
        Assert ($grants.Count -eq 1 -and $grants[0] -ceq ("'" + "Bash($command)".Replace("'", "''") + "'")) "Skill must pre-approve exactly its command for the Bash tool: $($grants -join ' | ')"
        Assert ($skill -notmatch '(?m)^shell:' -and $skill -notmatch 'powershell') 'Skill must use the default shell and no Windows PowerShell'
        Assert ($posixResult.usageSkillShell -ceq 'bash') "usageSkillShell: $($posixResult.usageSkillShell)"
        $wrapper = [IO.File]::ReadAllText($wrapperPath)
        Assert ($wrapper.Contains("`$env:CCOF_TOKEN_HELPER = '" + $helper.Replace("'", "''") + "'")) 'Usage wrapper does not pin the sh helper'
    }

    if ($posixHost) {
        Test-Case 'files setup writes are 600, the helper 700, and folders it creates (and the Azure CLI profile) 700' {
            foreach ($f in 'settings.json', 'ccof-usage.ps1', 'skills/usage/SKILL.md') { Assert ((Get-Mode (Join-Path $claudeHome $f)) -ceq '600') "$f is $(Get-Mode (Join-Path $claudeHome $f))" }
            Assert ((Get-Mode (Join-Path $claudeHome 'ccof-token')) -ceq '700') "helper is $(Get-Mode (Join-Path $claudeHome 'ccof-token'))"
            foreach ($d in (Join-Path $claudeHome 'skills'), (Join-Path $claudeHome 'skills/usage'), (Join-Path (Split-Path $configPath -Parent) 'az'), $codeArgs.BackupRoot) {
                Assert ((Get-Mode $d) -ceq '700') "$d is $(Get-Mode $d)"
            }
            $snapshot = Join-Path $codeArgs.BackupRoot $posixResult.changeId
            Assert ((Get-Mode (Join-Path $snapshot 'snapshot.json')) -ceq '600') 'Backup manifest readable by others'
        }

        $planted = Join-Path $work 'untrusted project'
        [void][IO.Directory]::CreateDirectory($planted)
        Write-ClientText (Join-Path $planted 'az') "#!/bin/sh`necho planted >> '$planted/planted.log'`necho eyJ.planted.token`n" -UnixMode 448
        function Invoke-Helper([string]$Helper, [string[]]$Arguments) {
            $r = Invoke-CcofChild -FilePath $Helper -Arguments $Arguments -WorkingDirectory $planted -TimeoutSeconds 30 -Environment @{ PATH = "$planted$([IO.Path]::PathSeparator)$env:PATH" }
            return @{ exitCode = $r.ExitCode; stdout = $r.Stdout.Trim(); stderr = $r.Stderr.Trim() }
        }
        Test-Case 'sh helper: one interactive sign-in, its own profile, only the token on stdout, and login/status/logout' {
            $helper = Join-Path $work 'h1/ccof-token'
            Write-ClientText $helper (New-ClientAzureCliPosixTokenShim @good) -UnixMode 448
            Remove-Item (Join-Path $mockDir 'session') -Force -ErrorAction SilentlyContinue; $null = Read-AzCalls
            $first = Invoke-Helper $helper @('token')
            Assert ($first.exitCode -eq 0 -and $first.stdout -ceq 'eyJ.mock.token') "First token call: $($first | ConvertTo-Json -Compress)"
            Assert ($first.stderr -match 'LOGIN-OUTPUT-NOT-A-TOKEN') 'az login output was not kept off stdout'
            $calls = Read-AzCalls
            Assert ($calls.Count -eq 3 -and $calls[0] -match ' account get-access-token ' -and $calls[1] -match ' login ' -and $calls[2] -match ' account get-access-token ') "Expected token, login, token: $($calls -join ' | ')"
            Assert (@($calls | Where-Object { -not $_.StartsWith("[$($good.AzureConfigDir)] ") }).Count -eq 0) "Azure CLI ran outside the gateway profile: $($calls -join ' | ')"
            Assert ($calls[1] -match "--tenant $($config.tenantId) --scope $([regex]::Escape($config.scope)) --allow-no-subscriptions") "Sign-in arguments: $($calls[1])"
            Assert ($calls[0] -match "--tenant $($config.tenantId) --scope $([regex]::Escape($config.scope)) --query accessToken --output tsv") "Token arguments: $($calls[0])"
            $again = Invoke-Helper $helper @()
            Assert ($again.stdout -ceq 'eyJ.mock.token' -and (Read-AzCalls).Count -eq 1) 'A cached token must not sign in again'
            $status = Invoke-Helper $helper @('status')
            Assert ($status.exitCode -eq 0 -and $status.stdout -match 'developer@example\.test') "status: $($status | ConvertTo-Json -Compress)"
            $out = Invoke-Helper $helper @('logout')
            Assert ($out.exitCode -eq 0 -and -not $out.stdout -and -not (Test-Path (Join-Path $mockDir 'session'))) 'logout did not sign out quietly'
            $notIn = Invoke-Helper $helper @('status')
            Assert ($notIn.exitCode -eq 4 -and $notIn.stderr -match 'login') "status while signed out: $($notIn | ConvertTo-Json -Compress)"
            $login = Invoke-Helper $helper @('login')
            Assert ($login.exitCode -eq 0 -and -not $login.stdout -and $login.stderr -match 'Signed in') "login printed to stdout: $($login | ConvertTo-Json -Compress)"
            $bad = Invoke-Helper $helper @('bogus')
            Assert ($bad.exitCode -eq 2 -and -not $bad.stdout) 'An unknown command must exit 2 with nothing on stdout'
            $null = Read-AzCalls
            Assert (-not (Test-Path (Join-Path $planted 'planted.log'))) 'The az in the start folder or first on PATH ran instead of the pinned Azure CLI'
        }
        Test-Case 'sh helper: silent-token never opens a sign-in, and a missing Azure CLI exits 3' {
            $helper = Join-Path $work 'h2/ccof-token'
            Write-ClientText $helper (New-ClientAzureCliPosixTokenShim @good) -UnixMode 448
            Remove-Item (Join-Path $mockDir 'session') -Force -ErrorAction SilentlyContinue; $null = Read-AzCalls
            $silent = Invoke-Helper $helper @('silent-token')
            $calls = @(Read-AzCalls)
            Assert ($silent.exitCode -eq 4 -and -not $silent.stdout -and $calls.Count -eq 1 -and $calls[0] -match ' account get-access-token ') "silent-token while signed out: $($silent | ConvertTo-Json -Compress) calls: $($calls -join ' | ')"
            Assert ($silent.stderr -match 'Not signed in to the Claude gateway.*login' -and $silent.stderr -notmatch 'AADSTS|az login') "silent-token must print only CCOF's sign-in remedy: $($silent.stderr)"
            $status = Invoke-Helper $helper @('status')
            Assert ($status.exitCode -eq 4 -and -not $status.stdout -and $status.stderr -match 'Not signed in.*login' -and $status.stderr -notmatch 'AADSTS|az login') "status must print only CCOF's sign-in remedy: $($status.stderr)"
            $values = $good.Clone(); $values.AzureCliPath = Join-Path $work 'uninstalled/az'
            $gone = Join-Path $work 'h3/ccof-token'
            Write-ClientText $gone (New-ClientAzureCliPosixTokenShim @values) -UnixMode 448
            $missing = Invoke-Helper $gone @('token')
            Assert ($missing.exitCode -eq 3 -and -not $missing.stdout -and $missing.stderr -match 'install-azure-cli') "Missing Azure CLI: $($missing | ConvertTo-Json -Compress)"
            Assert (-not (Test-Path (Join-Path $planted 'planted.log'))) 'A planted az ran when the pinned Azure CLI was missing'
        }
        Test-Case 'the apiKeyHelper command line runs under /bin/sh even with a quote and a space in the home path' {
            $odd = Join-Path $work "it's home/.claude"
            $options = $codeArgs.Clone(); $options.ClaudeHome = $odd; $options.UsageEntryPath = $null
            $result = Use-MockAzOnPath { Set-CcofClaudeCode @options -Confirmed } | ConvertFrom-Json -AsHashtable
            $settings = Read-ClientJson (Join-Path $odd 'settings.json')
            Write-ClientText (Join-Path $mockDir 'session') 'signed-in'
            $r = Invoke-CcofChild -FilePath '/bin/sh' -Arguments @('-c', $settings.apiKeyHelper) -WorkingDirectory $planted -TimeoutSeconds 30
            Assert ($r.ExitCode -eq 0 -and $r.Stdout.Trim() -ceq 'eyJ.mock.token') "apiKeyHelper under sh: exit $($r.ExitCode) $($r.Stderr)"
            Assert ($result.signIn -ceq ("'" + (Join-Path $odd 'ccof-token').Replace("'", "'\''") + "' login")) "signIn: $($result.signIn)"
        }
        Test-Case 'the inventory finds a Claude Code CLI without a file extension' {
            $bin = Join-Path $work 'fake-claude'
            Write-ClientText (Join-Path $bin 'claude') "#!/bin/sh`necho '9.8.7 (Claude Code)'`n" -UnixMode 448
            $saved = $env:PATH; $env:PATH = "$bin$([IO.Path]::PathSeparator)$saved"
            try { $found = Get-CcofClientInventory } finally { $env:PATH = $saved }
            Assert ($found.CliVersion -ceq '9.8.7' -and $found.CliPath -ceq (Join-Path $bin 'claude')) "Inventory: $($found | ConvertTo-Json -Compress)"
        }
        Test-Case 'Set-ClaudeCodeGateway.ps1 runs end to end with the default configuration folder, and Restore-ClaudeCodeGateway.ps1 undoes it' {
            $home4 = Join-Path $work 'home4'
            $cfg = Join-Path $home4 '.config/ClaudeGateway/config.json'
            Write-ClientJson $cfg $config
            $loose = Join-Path $home4 '.config/ClaudeGateway/az'
            [void][IO.Directory]::CreateDirectory($loose); [IO.File]::SetUnixFileMode($loose, [IO.UnixFileMode]493)
            $bin = Join-Path $work 'fake-claude'
            $envs = @{ HOME = $home4; XDG_CONFIG_HOME = ''; CCOF_CONFIG_FILE = ''; PATH = "$mockDir$([IO.Path]::PathSeparator)$bin$([IO.Path]::PathSeparator)$env:PATH" }
            $set = Invoke-CcofChild -FilePath (Join-Path $repo 'scripts/client/Set-ClaudeCodeGateway.ps1') -Arguments @('-UsageStatusLine', '-Confirmed') -WorkingDirectory $work -TimeoutSeconds 120 -Environment $envs
            $line = try { $set.Stdout.Trim() | ConvertFrom-Json -AsHashtable } catch { @{} }
            Assert ($set.ExitCode -eq 0 -and $line.event -ceq 'configured' -and $line.statusLine -ceq 'set') "Setup: exit $($set.ExitCode) $($set.Stdout) $($set.Stderr)"
            $settings = Read-ClientJson (Join-Path $home4 '.claude/settings.json')
            Assert ($settings.env.CCOF_CONFIG_FILE -ceq $cfg) "Default configuration not used: $($settings.env.CCOF_CONFIG_FILE)"
            Assert ((Get-Mode (Join-Path $home4 '.config/ClaudeGateway/az')) -ceq '700') 'Azure CLI profile folder not created 700'
            $backup = Join-Path $home4 ".config/ClaudeGateway/backups/$($line.changeId)"
            $restore = Invoke-CcofChild -FilePath (Join-Path $repo 'scripts/client/Restore-ClaudeCodeGateway.ps1') -Arguments @('-BackupPath', $backup, '-Confirmed') -WorkingDirectory $work -TimeoutSeconds 60 -Environment $envs
            Assert ($restore.ExitCode -eq 0 -and -not (Test-Path (Join-Path $home4 '.claude/settings.json')) -and -not (Test-Path (Join-Path $home4 '.claude/ccof-token'))) "Restore: exit $($restore.ExitCode) $($restore.Stdout) $($restore.Stderr)"
            $msalHome = Join-Path $work 'home5'
            Write-ClientJson (Join-Path $msalHome '.config/ClaudeGateway/config.json') $msalConfig
            $envs.HOME = $msalHome
            $refused = Invoke-CcofChild -FilePath (Join-Path $repo 'scripts/client/Set-ClaudeCodeGateway.ps1') -Arguments @('-Confirmed') -WorkingDirectory $work -TimeoutSeconds 60 -Environment $envs
            Assert ($refused.ExitCode -ne 0 -and "$($refused.Stdout)$($refused.Stderr)" -match 'unsupported_sign_in_method' -and -not (Test-Path (Join-Path $msalHome '.claude'))) "msal off Windows: exit $($refused.ExitCode) $($refused.Stderr)"
        }
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "$script:passed passed, $script:failed failed"
if ($script:failed) { exit 1 }
