#Requires -Version 7.0
<#
.SYNOPSIS
    Offline contract tests for chargeback history in Cosmos DB (ADR-0044): the Stage 2 container, the Stage 3
    grants, the Stage 5 settings, the driver's validation of audit.chargebackHistory and the stage hashes. No Azure call.
#>
[CmdletBinding()]
param([string]$BicepPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $BicepPath) {
    $command = Get-Command bicep -ErrorAction SilentlyContinue
    if ($command) { $BicepPath = $command.Source }
    elseif (Test-Path (Join-Path $HOME '.azure\bin\bicep.exe')) { $BicepPath = Join-Path $HOME '.azure\bin\bicep.exe' }
    else { throw 'Offline Bicep CLI required. Supply -BicepPath; this test does not install tools or call Azure.' }
}
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:passed++ }
function Build-Arm([string]$Relative) {
    $out = & $BicepPath build (Join-Path $root $Relative) --stdout 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Bicep compilation failed: $Relative" }
    return ($out -join "`n") | ConvertFrom-Json -AsHashtable -Depth 100
}
$reader = '00000000-0000-0000-0000-000000000001'

# Stage 2: the container exists only when enabled, partitioned on /month, indexing only the queried fields, with the
# configured time to live; the quickstart's container list (compared with Stage 2's) is unchanged.
$schemaText = Get-Content -Raw (Join-Path $root 'infra\staged\stage2-schema.bicep')
$schema = Build-Arm 'infra\staged\stage2-schema.bicep'
Assert-Contract ($schema.parameters.ContainsKey('chargebackHistory') -and $schema.parameters.chargebackHistory.defaultValue.Count -eq 0) 'Stage 2 must default to no chargeback history.'
Assert-Contract ($schemaText -match "var historyContainers = historyEnabled \? \[\{ name: 'chargebackDaily', partitionKey: '/month' \}\] : \[\]") 'Stage 2 must add chargebackDaily (/month) only when history is enabled.'
Assert-Contract ($schemaText -match 'concat\(cosmosContainers, adminContainers, historyContainers\)') 'Stage 2 must create the history container with the others.'
Assert-Contract (-not (($schema.variables.cosmosContainers | ConvertTo-Json -Compress) -match 'chargebackDaily')) 'chargebackDaily must stay out of the quickstart-compared container list.'
Assert-Contract ($schemaText -match "defaultTtl: historyTtlDays \* 86400" -and $schemaText -match 'historyTtlDays == null \? \{\}') 'Stage 2 must set defaultTtl from ttlDays, and none when ttlDays is null.'
foreach ($path in '/day/?', '/chargebackId/?', '/projectId/?', '/classification/?', '/personId/?', '/model/?') {
    Assert-Contract ($schemaText.Contains("{ path: '$path' }")) "Stage 2 must index $path on chargebackDaily."
}
Assert-Contract ($schemaText -match "excludedPaths: \[\{ path: '/\*' \}\]") 'Stage 2 must exclude every other path from the chargebackDaily index.'

# Stage 3: reconciler writer + reader and admin reader on chargebackDaily, only when enabled; no delete.
$grants = Build-Arm 'infra\staged\stage3-grants.bicep'
$history = @($grants.variables.cosmosAssignments | Where-Object container -CEQ 'chargebackDaily')
$byId = @{}; foreach ($a in $history) { $byId[$a.id] = $a }
Assert-Contract ($history.Count -eq 3 -and @($history | Where-Object when -CNE 'chargebackHistory').Count -eq 0) 'Stage 3 must hold exactly three chargebackDaily grants, all conditional on chargeback history.'
Assert-Contract ($byId['reconciler-history-writer'].principal -ceq 'reconciler' -and $byId['reconciler-history-writer'].role -ceq 'custom:reconcilerStateWriter') 'The reconciler must write chargebackDaily with its state-writer role.'
Assert-Contract ($byId['reconciler-history-reader'].principal -ceq 'reconciler' -and $byId['reconciler-history-reader'].role -ceq $reader) 'The reconciler must query chargebackDaily with the built-in Data Reader.'
Assert-Contract ($byId['admin-history-reader'].principal -ceq 'admin' -and $byId['admin-history-reader'].role -ceq $reader) 'The admin app must only read chargebackDaily.'
$writer = @($grants.variables.cosmosRoleDefinitions | Where-Object key -CEQ 'reconcilerStateWriter')[0]
Assert-Contract (-not ($writer.dataActions -match '/delete$')) 'The reconciler writer role must not delete.'
Assert-Contract ($grants.parameters.chargebackHistoryEnabled.defaultValue -eq $false -and $grants.variables.activeAssignments -match "equals\(lambdaVariables\('a'\)\.when, 'chargebackHistory'\), parameters\('chargebackHistoryEnabled'\)") 'Stage 3 must apply the history grants only when enabled.'
Assert-Contract (@($grants.variables.cosmosAssignments | Where-Object { $_.principal -ceq 'admin' -and $_.container -cnotin 'projects', 'adminConfig' -and $_.role -cne $reader }).Count -eq 0) 'The admin app may only read containers other than projects and adminConfig.'

# Stage 5: reconciler and admin settings only when enabled.
$settingsText = Get-Content -Raw (Join-Path $root 'infra\quickstart\modules\app-settings.bicep')
$stage5Text = Get-Content -Raw (Join-Path $root 'infra\staged\stage5-config.bicep')
$appText = Get-Content -Raw (Join-Path $root 'infra\staged\Staged.Application.ps1')
Assert-Contract ($settingsText -match "RECONCILER_HISTORY_CONTAINER: 'chargebackDaily'" -and $settingsText -match 'RECONCILER_HISTORY_CLOSE_AFTER_DAYS: string\(chargebackHistory\.closeAfterDays\)' -and $settingsText -match 'union\(reconcilerSettings, reconcilerGuardSettings, reconcilerHistorySettings\)') 'Stage 5 must write the reconciler history settings.'
Assert-Contract ($settingsText -match "reconcilerHistorySettings = \(chargebackHistory\.\?enabled \?\? false\) \?") 'The reconciler history settings must be written only when enabled.'
# ADR-0044 decision 9: the reconciler gives each document a time to live ending ttlDays after its month, so it needs ttlDays.
Assert-Contract ($settingsText -match "chargebackHistory\.\?ttlDays == null \? \{\} : \{ RECONCILER_HISTORY_TTL_DAYS: string\(chargebackHistory\.ttlDays\) \}") 'Stage 5 must write RECONCILER_HISTORY_TTL_DAYS when ttlDays is set, and nothing when it is null.'
Assert-Contract ($stage5Text -match "ADMIN_CHARGEBACK_HISTORY_CONTAINER: 'chargebackDaily'" -and $stage5Text -match 'chargebackHistory: chargebackHistory') 'Stage 5 must write the admin history setting and pass history to the settings module.'
# The admin chargeback reports use the effective retention and the held-from instant with history on or off: only the
# container setting depends on audit.chargebackHistory.enabled.
$historyVar = [regex]::Match($stage5Text, '(?ms)^var adminHistorySettings = .*?^(var|resource)').Value
$retentionVar = [regex]::Match($stage5Text, '(?ms)^var adminRetentionSettings = .*?^(var|resource)').Value
Assert-Contract ($historyVar -and $historyVar -notmatch 'ADMIN_LOG_RETENTION') 'The admin retention settings must not be inside the history-only settings.'
Assert-Contract ($retentionVar -match 'ADMIN_LOG_RETENTION_DAYS: string\(logRetention\.days\)' -and $retentionVar -match 'ADMIN_LOG_RETENTION_HELD_FROM: logRetention\.heldFrom' -and $retentionVar -notmatch 'chargebackHistory') 'Stage 5 must write ADMIN_LOG_RETENTION_DAYS (and the held-from instant when recorded) from logRetention, whatever audit.chargebackHistory says.'
Assert-Contract ($stage5Text -match '\}, adminRetentionSettings, adminHistorySettings\)') 'The admin settings must include the retention settings on every Stage 5 run.'
Assert-Contract ($appText -match 'logRetention = Get-StgLogRetentionSettings -Cfg \$Cfg -HeldFrom \$heldFrom') 'Stage 5 must pass the retention settings to the admin app on every run.'
Assert-Contract ($appText -match '\$history = Get-StgChargebackHistory \$Cfg' -and $appText -match 'chargebackHistory = \$history \?\? @\{\}') 'Stage 5 must pass the validated history configuration.'

# Driver: validation, the normalised value each stage receives, and the stage hashes.
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
$base = @{ location = 'eastus2'; stage1 = @{ retentionInDays = 30 }; cosmos = @{ capacityMode = 'serverless' }; reconciler = @{ timerEnabled = $true } }
function New-Cfg($History) {
    $c = $base | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    if ($null -ne $History) { $c.audit = @{ chargebackHistory = $History } }
    return $c
}
$problemsOf = { param($History) @(Get-StgCosmosProblems (New-Cfg $History) | Where-Object { $_ -match 'audit\.chargebackHistory' }) }
Assert-Contract ((& $problemsOf $null).Count -eq 0 -and $null -eq (Get-StgChargebackHistory (New-Cfg $null))) 'An absent audit.chargebackHistory is valid and means off.'
Assert-Contract ((& $problemsOf @{ enabled = $false }).Count -eq 0 -and $null -eq (Get-StgChargebackHistory (New-Cfg @{ enabled = $false }))) 'enabled false needs no other key and means off.'
$good = @{ enabled = $true; closeAfterDays = 2; ttlDays = $null }
Assert-Contract ((& $problemsOf $good).Count -eq 0) 'enabled, closeAfterDays 2 and ttlDays null is valid.'
$normal = Get-StgChargebackHistory (New-Cfg $good)
Assert-Contract ($normal.enabled -eq $true -and $normal.closeAfterDays -eq 2 -and $null -eq $normal.ttlDays -and $normal.logRetentionDays -eq 30) 'Stages receive enabled, closeAfterDays, ttlDays and the workspace retention.'
Assert-Contract ((Get-StgChargebackHistory (New-Cfg @{ enabled = $true; closeAfterDays = 3; ttlDays = 2557 })).ttlDays -eq 2557) 'ttlDays is passed through.'
foreach ($bad in @(
        @{ enabled = 'true'; closeAfterDays = 2; ttlDays = $null },
        @{ enabled = $true; ttlDays = $null },
        @{ enabled = $true; closeAfterDays = 0; ttlDays = $null },
        @{ enabled = $true; closeAfterDays = 8; ttlDays = $null },
        @{ enabled = $true; closeAfterDays = '2'; ttlDays = $null },
        @{ enabled = $true; closeAfterDays = 2; ttlDays = 30 },
        @{ enabled = $true; closeAfterDays = 2; ttlDays = 24856 },
        @{ enabled = $true; closeAfterDays = 2; ttlDays = $null; keepForever = $true },
        'yes')) {
    Assert-Contract ((& $problemsOf $bad).Count -eq 1) "audit.chargebackHistory must be refused: $($bad | ConvertTo-Json -Compress)"
}

# ttlDays sets the container's defaultTtl in seconds, a 32-bit number: 24855 days is the most it can hold.
Assert-Contract ((& $problemsOf @{ enabled = $true; closeAfterDays = 2; ttlDays = 24855 }).Count -eq 0) 'ttlDays 24855 (the largest 32-bit defaultTtl) must be accepted.'
Assert-Contract ((& $problemsOf @{ enabled = $true; closeAfterDays = 2; ttlDays = 24856 }) -match '24855') 'ttlDays above 24855 must be refused naming the limit.'

# History is written only by the reconciler's timer run: enabled history with the timer off is refused, naming both keys.
$timerOff = New-Cfg $good; $timerOff.reconciler.timerEnabled = $false
$timerProblems = @(Get-StgCosmosProblems $timerOff | Where-Object { $_ -match 'audit\.chargebackHistory\.enabled' -and $_ -match 'reconciler\.timerEnabled' })
Assert-Contract ($timerProblems.Count -eq 1) 'Enabled chargeback history with reconciler.timerEnabled false must be refused naming both keys.'
$timerAbsent = New-Cfg $good; $timerAbsent.Remove('reconciler')
Assert-Contract (@(Get-StgCosmosProblems $timerAbsent | Where-Object { $_ -match 'reconciler\.timerEnabled' }).Count -eq 1) 'An absent reconciler.timerEnabled is off and must be refused with enabled history.'
$offTimerOff = New-Cfg @{ enabled = $false }; $offTimerOff.reconciler.timerEnabled = $false
Assert-Contract (@(Get-StgCosmosProblems $offTimerOff).Count -eq 0) 'History off needs no reconciler timer.'

# The workspace keeps the ledger for audit.workspaceRetentionDays when set (Stage 5 applies it, ADR-0043), otherwise for
# stage1.retentionInDays: that one value is the export's boundary (ADMIN_LOG_RETENTION_DAYS) and the ttlDays floor.
function New-RetentionCfg($Stage1, $Workspace, $Ttl) {
    $c = New-Cfg @{ enabled = $true; closeAfterDays = 2; ttlDays = $Ttl }
    $c.stage1.retentionInDays = $Stage1
    if ($null -ne $Workspace) { $c.audit.workspaceRetentionDays = $Workspace }
    return $c
}
$retentionProblems = { param($c) @(Get-StgCosmosProblems $c | Where-Object { $_ -match 'audit\.chargebackHistory' }) }
foreach ($case in @(
        @{ name = 'stage1 only'; stage1 = 90; workspace = $null; effective = 90 },
        @{ name = 'raised by audit.workspaceRetentionDays'; stage1 = 30; workspace = 400; effective = 400 },
        @{ name = 'lowered by audit.workspaceRetentionDays'; stage1 = 90; workspace = 30; effective = 30 })) {
    $e = $case.effective
    Assert-Contract ((Get-StgLogRetentionDays (New-RetentionCfg $case.stage1 $case.workspace $null)) -eq $e) "Effective retention ($($case.name)) must be $e days."
    Assert-Contract ((Get-StgChargebackHistory (New-RetentionCfg $case.stage1 $case.workspace $null)).logRetentionDays -eq $e) "ADMIN_LOG_RETENTION_DAYS ($($case.name)) must be $e."
    Assert-Contract ((& $retentionProblems (New-RetentionCfg $case.stage1 $case.workspace $e)) -match "more than the $e days") "ttlDays $e ($($case.name)) must be refused: not more than the workspace keeps."
    Assert-Contract ((& $retentionProblems (New-RetentionCfg $case.stage1 $case.workspace ($e + 1))).Count -eq 0) "ttlDays $($e + 1) ($($case.name)) must be accepted."
}
# History off with a raised retention: the admin app still receives the effective retention and the held-from instant.
$historyOff = New-Cfg @{ enabled = $false }; $historyOff.audit.workspaceRetentionDays = 400
$offRetention = Get-StgLogRetentionSettings -Cfg $historyOff -HeldFrom '2026-09-10T00:00:00.000Z'
Assert-Contract ($null -eq (Get-StgChargebackHistory $historyOff) -and $offRetention.days -eq 400 -and $offRetention.heldFrom -ceq '2026-09-10T00:00:00.000Z') 'History off with a raised retention must still give the admin app the retention days and the held-from instant.'
Assert-Contract ((Get-StgLogRetentionSettings -Cfg (New-Cfg $null) -HeldFrom $null).days -eq 30 -and (Get-StgLogRetentionSettings -Cfg (New-Cfg $null) -HeldFrom $null).heldFrom -ceq '') 'Without audit settings the admin app receives stage1.retentionInDays and no held-from instant.'

# enabled false with no other key is off and hashes as if absent; any other present value is a hash input.
$withoutAudit = New-Cfg $null
$offOnly = New-Cfg @{ enabled = $false }
$offWithKeys = New-Cfg @{ enabled = $false; closeAfterDays = 2; ttlDays = $null }
foreach ($stage in 0..8) {
    Assert-Contract ((Get-StgStageInput $withoutAudit $stage) -ceq (Get-StgStageInput $offOnly $stage)) "audit.chargebackHistory { enabled: false } must keep the stage $stage hash of an absent section."
    Assert-Contract (((Get-StgStageInput $withoutAudit $stage) -cne (Get-StgStageInput $offWithKeys $stage)) -eq ($stage -in 2, 3, 5)) "enabled false with other keys is hashed in Stages 2, 3 and 5 only (stage $stage)."
}
$archiveOff = New-Cfg $null; $archiveOff.audit = @{ archive = @{ enabled = $false } }
Assert-Contract ((Get-StgStageInput $withoutAudit 5) -ceq (Get-StgStageInput $archiveOff 5)) 'audit.archive { enabled: false } must keep the Stage 5 hash of an absent section.'
$archiveOffKeys = New-Cfg $null; $archiveOffKeys.audit = @{ archive = @{ enabled = $false; retentionDays = 2555 } }
Assert-Contract ((Get-StgStageInput $withoutAudit 5) -cne (Get-StgStageInput $archiveOffKeys 5)) 'audit.archive enabled false with other keys is a Stage 5 hash input.'

$withHistory = New-Cfg $good
foreach ($stage in 0..8) {
    $changed = (Get-StgStageInput $withoutAudit $stage) -cne (Get-StgStageInput $withHistory $stage)
    Assert-Contract ($changed -eq ($stage -in 2, 3, 5)) "audit.chargebackHistory must change the configuration hash of Stages 2, 3 and 5 only (stage $stage)."
}
$withOtherAudit = New-Cfg $null; $withOtherAudit.audit = @{ other = 1 }
Assert-Contract ((Get-StgStageInput $withoutAudit 2) -ceq (Get-StgStageInput $withOtherAudit 2)) 'Other audit keys must not change the Stage 2 hash.'

# Stage 2 read-back of the time to live.
# ttlDays between null and a number on an existing container (council round 3, R3-3): refused before any change. With
# no defaultTtl, documents carry no expiry and coverage records say "never", so a new defaultTtl would delete documents
# the export reports as covered; removing defaultTtl stops expiry while coverage records still say they expire.
$ttl400 = New-Cfg @{ enabled = $true; closeAfterDays = 2; ttlDays = 400 }
$noTtl = New-Cfg $good
$existing = { param($DefaultTtl) @(@{ name = 'projects'; resource = @{} }, @{ name = 'chargebackDaily'; resource = $(if ($null -ne $DefaultTtl) { @{ defaultTtl = $DefaultTtl } } else { @{} }) }) }
$toNumber = Get-StgChargebackTtlTransitionProblem -Cfg $ttl400 -Containers (& $existing $null)
Assert-Contract ($toNumber -match '^chargeback_history_ttl_transition' -and $toNumber -match 'ttlDays' -and $toNumber -match 'chargeback-history\.md') "null -> 400 days on an existing container must be refused with the procedure: $toNumber"
$toNull = Get-StgChargebackTtlTransitionProblem -Cfg $noTtl -Containers (& $existing 34560000)
Assert-Contract ($toNull -match '^chargeback_history_ttl_transition' -and $toNull -match '400 days' -and $toNull -match '24855' -and $toNull -match 'chargeback-history\.md') "400 days -> null on an existing container must be refused, naming the largest ttlDays: $toNull"
Assert-Contract ($null -eq (Get-StgChargebackTtlTransitionProblem -Cfg $ttl400 -Containers (& $existing 86400000)) -and $null -eq (Get-StgChargebackTtlTransitionProblem -Cfg $noTtl -Containers (& $existing $null))) 'A number -> number or null -> null ttlDays is not a transition.'
Assert-Contract ($null -eq (Get-StgChargebackTtlTransitionProblem -Cfg $ttl400 -Containers @(@{ name = 'projects'; resource = @{} })) -and $null -eq (Get-StgChargebackTtlTransitionProblem -Cfg (New-Cfg @{ enabled = $false }) -Containers (& $existing $null))) 'A new container, or history off, is never refused.'
$stage2Body = (Get-Command Invoke-Stage2).ScriptBlock.ToString()
$checkAt = $stage2Body.IndexOf('Get-StgChargebackTtlTransitionProblem'); $deployAt = $stage2Body.IndexOf('Invoke-StgBicep')
Assert-Contract ($checkAt -ge 0 -and $checkAt -lt $deployAt) 'Stage 2 must refuse a ttlDays transition before it previews or deploys anything.'
# Stage 2 with fakes: the refusal comes before any deployment; a first run (no database yet) deploys.
$script:Deployed = 0; $script:ListAnswer = $null
function Get-StgStage { param($Cfg, $Number) @{ names = @{ cosmosAccount = 'acct' } } }
function Invoke-StgBicep { $script:Deployed++; @{} }
function Invoke-StgAzJson { param([string[]]$Arguments) & $script:ListAnswer }
$ttl400.cosmos.databaseName = 'ccof'; $ttl400.subscriptionId = 's'; $ttl400.resourceGroup = 'r'
$script:ListAnswer = { & $existing $null }
$refusal = try { $null = Invoke-Stage2 -Cfg $ttl400; '' } catch { $_.Exception.Message }
Assert-Contract ($refusal -match '^chargeback_history_ttl_transition' -and $script:Deployed -eq 0) "Stage 2 must refuse null -> 400 days before deploying: $refusal"
$script:ListAnswer = { throw "ERROR: (NotFound) Owner resource does not exist" }
$null = Invoke-Stage2 -Cfg $ttl400
Assert-Contract ($script:Deployed -eq 1) 'Stage 2 must deploy when the database does not exist yet.'
$script:ListAnswer = { throw 'ERROR: (AuthorizationFailed) no access' }
$other = try { $null = Invoke-Stage2 -Cfg $ttl400; '' } catch { $_.Exception.Message }
Assert-Contract ($other -match 'AuthorizationFailed' -and $script:Deployed -eq 1) 'Any other read failure must stop Stage 2.'
. (Join-Path $root 'infra\staged\Invoke-StagedDeployment.ps1') -DotSourceOnly
Assert-Contract ((Test-StgChargebackTtl (New-Cfg $good) $null) -and -not (Test-StgChargebackTtl (New-Cfg $good) 86400)) 'ttlDays null must read back as no defaultTtl.'
$ttlCfg = New-Cfg @{ enabled = $true; closeAfterDays = 2; ttlDays = 400 }
Assert-Contract ((Test-StgChargebackTtl $ttlCfg 34560000) -and -not (Test-StgChargebackTtl $ttlCfg $null) -and -not (Test-StgChargebackTtl $ttlCfg 86400)) 'ttlDays must read back as ttlDays x 86400 seconds.'
Assert-Contract ((Get-Content -Raw (Join-Path $root 'infra\staged\Staged.Resources.ps1')) -match "Assert-Stg \(Test-StgChargebackTtl \`$Cfg \`$m\[0\]\.resource\.defaultTtl\)") 'Stage 2 must verify the chargebackDaily time to live.'

# The example shows history off, as its reconciler timer is off (history needs the timer), with closeAfterDays 2 and ttlDays.
$example = Get-Content -Raw (Join-Path $root 'infra\staged\staged.config.example.json') | ConvertFrom-Json -AsHashtable
Assert-Contract ($example.reconciler.timerEnabled -eq $false -and $example.audit.chargebackHistory.enabled -eq $false -and $example.audit.chargebackHistory.closeAfterDays -eq 2 -and $example.audit.chargebackHistory.ContainsKey('ttlDays')) 'The example must show chargeback history off (its reconciler timer is off) with closeAfterDays 2 and ttlDays.'

Write-Host "Chargeback history contract: $passed assertions passed."
