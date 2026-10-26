# Staged deployment: group entries (ADR-0034). A `groups` entry with kind "group" is an Entra group
# onboarded as its own entity: no projectId or classification. Stage 4 creates or finds the Entra group,
# Stage 5 adds it to the workbook, and Stage 7 seeds its group document (src/contracts/group-registration.ts)
# through the sync app's registrySeed function, which checks it with the group contract before any write.
# Baseline entries (projectId + classification) keep the quickstart path. Dot-sourced; not run directly.

function Test-StgGroupEntry { param($Entry) return ($Entry.kind -ceq 'group') }

# The Stage 4 key of an entry: project/classification, or group/<display name or lower-case object ID>.
function Get-StgGroupKey {
    param($Entry)
    if (-not (Test-StgGroupEntry $Entry)) { return "$($Entry.projectId)/$($Entry.classification)" }
    $name = if ($Entry.groupId) { ([string]$Entry.groupId).ToLowerInvariant() } else { [string]$Entry.groupDisplayName }
    return "group/$name"
}

function Get-StgGroupEntryProblems {
    param($Entry, [string[]]$BackendIds)
    if (Test-StgGroupEntry $Entry) {
        if ($Entry.Contains('projectId') -or $Entry.Contains('classification')) { "group entry $(Get-StgGroupKey $Entry) has no projectId or classification (ADR-0034)" }
        if ($PSBoundParameters.ContainsKey('BackendIds') -and $BackendIds -cnotcontains [string]$Entry.backendId) { "group entry $(Get-StgGroupKey $Entry) names backendId '$($Entry.backendId)', which is not in backends" }
    }
    elseif (-not $Entry.projectId -or -not $Entry.classification) { 'every group needs projectId and classification, or kind group' }
    if (-not $Entry.groupId -and -not $Entry.groupDisplayName) { "group $(Get-StgGroupKey $Entry) needs groupId or groupDisplayName" }
}

function Select-StgBaselineGroups { param($Groups) @($Groups | Where-Object { $_ -and -not (Test-StgGroupEntry $_) }) }

# The group documents of the group entries, with the Entra object IDs Stage 4 recorded. Configuration-only
# fields (groupDisplayName, members) stay out; chargebackId and restrictedFamiliesApproved default to none.
function New-StgGroupDocuments {
    param($Groups, [Collections.IDictionary]$EntraGroups)
    foreach ($g in @($Groups | Where-Object { $_ -and (Test-StgGroupEntry $_) })) {
        $key = Get-StgGroupKey $g
        $entra = $EntraGroups[$key]
        if (-not $entra -or [string]$entra.id -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw "group_not_resolved: $key has no Entra group in Stage 4 state; rerun Stage 4." }
        $id = ([string]$entra.id).ToLowerInvariant()
        [ordered]@{
            id = $id; kind = 'group'; groupId = $id; projectId = $id
            displayName = $(if ($g.displayName) { $g.displayName } else { $entra.displayName })
            status = 'active'; retiredAt = $null; backendId = $g.backendId; priority = $g.priority
            chargebackId = $(if ($g.chargebackId) { $g.chargebackId } else { $null })
            budget = $g.budget; restrictedFamiliesApproved = ($g.restrictedFamiliesApproved -eq $true)
            familyPolicy = $g.familyPolicy; surfaces = @($g.surfaces); cacheProfile = $g.cacheProfile
        }
    }
}

# Workbook directory rows in the wire scope the gateway writes (projectId = group ID, code group).
function Get-StgGroupWorkbookRows {
    param($Documents)
    foreach ($d in @($Documents)) { [ordered]@{ projectId = $d.id; classification = 'group'; groupId = $d.id; displayName = $d.displayName } }
}

# Seeding is create-only, so a group document cannot be corrected through Stage 7 once written. Each
# group is read from Graph again right before the seed: an Entra group deleted, or changed to a
# non-security group, since Stage 4 stops Stage 7 before any registry write.
function Assert-StgGroupsExist {
    param($Documents)
    foreach ($d in @($Documents)) {
        $found = try { Get-StgGraph "groups/$($d.id)?`$select=id,securityEnabled" } catch { $null }
        if (-not $found -or ([string]$found.id) -ine $d.id -or $found.securityEnabled -ne $true) {
            throw "group_missing: Entra group $($d.id) ($($d.displayName)) no longer exists as a security group; rerun Stage 4 before Stage 7. Nothing was seeded."
        }
    }
}

# Read configured group documents before Stage 7 publishes any package. This is best effort because the operator may
# not have a route to the private Cosmos endpoint; Invoke-StgSeed remains the authoritative post-publish check.
function Get-StgGroupSeedDrift {
    param([string]$Endpoint, [string]$DatabaseName, $Documents)
    if (-not @($Documents).Count) { return @() }
    try {
        try { $token = [string](Invoke-QsAz @('account', 'get-access-token', '--scope', 'https://cosmos.azure.com/.default', '--query', 'accessToken', '--output', 'tsv')) }
        catch { throw 'group_preflight_failure: token unavailable' }
        if (-not $token) { throw 'group_preflight_failure: token unavailable' }
        $headers = @{
            Authorization = "type=aad&ver=1.0&sig=$token"
            'x-ms-version' = '2018-12-31'
            'x-ms-date' = [DateTime]::UtcNow.ToString('R', [Globalization.CultureInfo]::InvariantCulture)
        }
        $database = [uri]::EscapeDataString($DatabaseName)
        $drift = @()
        foreach ($document in $Documents) {
            $id = [uri]::EscapeDataString([string]$document.id)
            $headers['x-ms-documentdb-partitionkey'] = ConvertTo-Json -InputObject @([string]$document.id) -Compress
            $uri = "$($Endpoint.TrimEnd('/'))/dbs/$database/colls/projects/docs/$id"
            try { $stored = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 10 }
            catch {
                $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
                if (-not $status -and $_.Exception.Message -match '\bHTTP\s+(\d{3})\b') { $status = [int]$matches[1] }
                if ($status -eq 404) { continue }
                if ($status) { throw "group_preflight_failure: HTTP $status" }
                if ($_.Exception.Message -match '(?i)timeout|timed out') { throw 'group_preflight_failure: timeout' }
                throw 'group_preflight_failure: network error'
            }
            $stored = $stored | ConvertTo-Json -Depth 100 -Compress | ConvertFrom-Json -AsHashtable -Depth 100
            $fields = @()
            foreach ($key in $document.Keys) {
                if (-not $stored.ContainsKey($key)) { $fields += $key; continue }
                $wanted = ConvertTo-StgCanonical $document[$key] | ConvertTo-Json -Depth 100 -Compress
                $actual = ConvertTo-StgCanonical $stored[$key] | ConvertTo-Json -Depth 100 -Compress
                if ($actual -cne $wanted) { $fields += $key }
            }
            if ($fields.Count) { $drift += [ordered]@{ document = "projects/$($document.id)"; fields = @($fields | Sort-Object) } }
        }
        return $drift
    } catch {
        $message = [string]$_.Exception.Message
        $reason = if ($message -match '^group_preflight_failure: (.+)$') { $matches[1] } else { 'read failure' }
        Write-Host "preview/preflight: could not read group documents before publishing ($reason); the seed step checks them after publishing" -ForegroundColor Yellow
        return @()
    }
}

# Stage 8: the group a request without a selector must land in. acceptance.expectedGroup names a group
# entry; otherwise the configuration's single group entry. Null when the acceptance requests name a project.
function Get-StgExpectedGroupId {
    param($Cfg, [Collections.IDictionary]$EntraGroups)
    $allowed = @($Cfg.acceptance.allowed | Where-Object { $_ })
    $named = @($allowed | Where-Object { $_.project }).Count
    if (-not $allowed.Count -or $named -eq $allowed.Count) { return $null }
    if ($named) { throw 'acceptance_mixed_selectors: allowed requests either all name a project or none do; the selected group is verified for requests without one.' }
    $entries = @($Cfg.groups | Where-Object { $_ -and (Test-StgGroupEntry $_) })
    $name = $Cfg.acceptance.expectedGroup
    if ($name) { $entries = @($entries | Where-Object { $_.groupDisplayName -ceq $name -or ($_.groupId -and ([string]$_.groupId) -ieq [string]$name) }) }
    if ($entries.Count -ne 1) { throw 'acceptance_group_ambiguous: requests without a project need one group entry, or acceptance.expectedGroup naming one.' }
    return @(New-StgGroupDocuments -Groups $entries -EntraGroups $EntraGroups)[0].id
}

# KQL over the usage trace (ccof.usage.v1, analytics/ledger.kql) for the scope each request was charged to.
function New-StgSelectionQuery {
    param([string[]]$RequestIds)
    foreach ($id in $RequestIds) { if ($id -notmatch '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw "request_id_invalid: $id" } }
    $list = (@($RequestIds | ForEach-Object { "'$_'" })) -join ','
    return "ApiManagementGatewayLogs | where TimeGenerated > ago(2h) | where tolower(tostring(CorrelationId)) in ($list) | mv-expand t = TraceRecords | where tostring(t.source) == 'ccof.usage.v1' | extend p = parse_json(tostring(t.message)) | summarize projectIds = make_set(tostring(p.projectId)), requests = dcount(CorrelationId)"
}

function Assert-StgSelectedGroup {
    param($Row, [string]$ExpectedGroupId, [int]$Requests)
    # The Log Analytics query API returns a dynamic column (make_set) as JSON text.
    $set = if ($Row.projectIds -is [string]) { @([string]$Row.projectIds | ConvertFrom-Json) } else { @($Row.projectIds) }
    $ids = @($set | ForEach-Object { ([string]$_).ToLowerInvariant() })
    if ([int]$Row.requests -ne $Requests -or $ids.Count -ne 1 -or $ids[0] -cne $ExpectedGroupId.ToLowerInvariant()) {
        throw "verify_failed: requests without a selector were charged to $($ids -join ', ') ($($Row.requests) of $Requests traced), expected group $ExpectedGroupId"
    }
}

# Stage 7 seed: the quickstart's baseline documents (checked against onboarding's schema, as Invoke-QsSeed
# does) plus the group documents, through the sync app's registrySeed function, which checks each group
# document with the group contract and writes nothing if one fails. groups[] seeds a group once; afterwards the
# admin console owns it. A group document that differs (edited in the console) stops Stage 7 with
# seed_documents_differ naming each group and field, unless stage7.keepDifferingGroups is true: then the console's
# version is kept and returned in kept. Other differing documents always stop (Invoke-QsSeedThroughFunction).
function Invoke-StgSeed {
    param([Parameter(Mandatory)] $Ctx, $GroupDocuments, [bool]$KeepDifferingGroups)
    if (-not @($GroupDocuments).Count) { return Invoke-QsSeed $Ctx }
    $docs = New-QsSeedDocuments -P $Ctx.P -ClassificationGroupDisplayNames $Ctx.State.completed['1'].outputs.classificationGroupDisplayNames
    foreach ($project in @($docs.projects)) {
        try { $null = ConvertTo-OnboardingProjectDocument -Project ($project | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable) }
        catch { throw "seed_document_invalid: the projects document $($project.id) fails onboarding Stage 3's schema: $($_.Exception.Message)" }
    }
    $docs.projects = @($docs.projects) + @($GroupDocuments)
    $seed = Invoke-QsSeedThroughFunction -Ctx $Ctx -Documents $docs -KeepDiffering @($GroupDocuments | ForEach-Object { "projects/$($_.id)" })
    if (@($seed.kept).Count -and -not $KeepDifferingGroups) {
        throw "seed_documents_differ: these group documents differ from the configuration and were left unchanged: $(Format-StgGroupDrift -Kept $seed.kept -GroupDocuments $GroupDocuments). After the first seed the admin console owns a group: change it there (groups[] is not applied to an existing group). To keep the console's version and continue, set stage7.keepDifferingGroups to true and rerun Stage 7."
    }
    return $seed
}

function Format-StgGroupDrift {
    param($Kept, $GroupDocuments)
    $names = @{}; foreach ($d in @($GroupDocuments)) { $names["projects/$($d.id)"] = $d.displayName }
    return (@($Kept | ForEach-Object { "$($names[$_.document]) ($($_.document)): $(@($_.fields) -join ', ')" }) -join '; ')
}

# The line Stage 7 prints last when stage7.keepDifferingGroups kept groups; $null when none was kept.
function Format-StgKeptGroups {
    param($Kept, $GroupDocuments)
    if (-not @($Kept).Count) { return $null }
    return "kept $(@($Kept).Count) console-edited group(s): $(Format-StgGroupDrift -Kept $Kept -GroupDocuments $GroupDocuments)"
}

# stage7 { keepDifferingGroups }: absent, or a JSON boolean (Invoke-StgSeed).
function Get-StgStage7Problems {
    param($Cfg)
    if (-not $Cfg.Contains('stage7') -or $null -eq $Cfg.stage7) { return }
    $s = $Cfg.stage7
    if ($s -isnot [Collections.IDictionary] -or @($s.Keys | Where-Object { $_ -cne 'keepDifferingGroups' }).Count -or ($s.Contains('keepDifferingGroups') -and $s.keepDifferingGroups -isnot [bool])) {
        'stage7 takes only stage7.keepDifferingGroups, a JSON boolean (keep group documents edited in the admin console when they differ from groups[])'
    }
}

# Stage 7 client file. client.group names one group entry (groupDisplayName or groupId); the selector
# value is the group's object ID, which is its scope ID on the wire. Otherwise the quickstart selection.
function Invoke-StgClient {
    param([Parameter(Mandatory)] $Ctx, [Parameter(Mandatory)] $Cfg, [Collections.IDictionary]$EntraGroups)
    $sel = $Cfg.client
    if ($sel -isnot [Collections.IDictionary] -or -not $sel.Contains('group')) { return Invoke-QsClient $Ctx }
    if (@($sel.Keys | Where-Object { $_ -cnotin 'group', 'models', 'signInMethod' }).Count) { throw 'client_selection_invalid: client.group takes only models and signInMethod beside it.' }
    $entry = @($Cfg.groups | Where-Object { $_ -and (Test-StgGroupEntry $_) -and ($_.groupDisplayName -ceq $sel.group -or ($_.groupId -and ([string]$_.groupId) -ieq [string]$sel.group)) })
    if ($entry.Count -ne 1) { throw 'client_selection_invalid: client.group must name exactly one group entry by groupDisplayName or groupId.' }
    $doc = @(New-StgGroupDocuments -Groups $entry -EntraGroups $EntraGroups)[0]
    $restricted = @($doc.familyPolicy.families.Keys | Where-Object { $_ -in 'fable', 'mythos' })
    if ($restricted.Count -and -not $doc.restrictedFamiliesApproved) { throw 'client_selection_invalid: Fable and Mythos need restrictedFamiliesApproved on the group.' }
    # The Desktop profile names the group (bug bash DEV-16), not the quick-start.
    $name = ([string]$entry[0].groupDisplayName -replace '[\r\n]+', ' ').Trim()
    return New-QsClientFiles -Ctx $Ctx -ProjectId $doc.id -FamilyPolicy $doc.familyPolicy -BackendId $doc.backendId -Aliases $sel.models -ProfileName $(if ($name) { "Claude gateway ($name)" } else { 'Claude gateway' })
}

# ADR-0041: client.signInMethod 'azure-cli' makes the client helper sign in through the Azure CLI. Allowed only
# when Stage 4 preauthorized the Azure CLI on the gateway app; otherwise every token request needs consent.
# Stage 7 runs this before its preview and before any deployment step, so a wrong value stops nothing half-done.
function Assert-StgClientSignInMethod {
    param([Parameter(Mandatory)] $Cfg, [bool]$AzureCliAllowed)
    $sel = $Cfg.client
    if ($sel -isnot [Collections.IDictionary] -or -not $sel.Contains('signInMethod')) { return }
    if ($sel.signInMethod -cnotin 'msal', 'azure-cli') { throw "client_sign_in_invalid: client.signInMethod must be 'msal' or 'azure-cli'." }
    if ($sel.signInMethod -ceq 'azure-cli' -and -not $AzureCliAllowed) { throw 'client_sign_in_invalid: client.signInMethod azure-cli needs entra.allowAzureCliClient true in Stage 4.' }
}

function Set-StgClientSignInMethod {
    param([Parameter(Mandatory)] $Client, [Parameter(Mandatory)] $Cfg, [bool]$AzureCliAllowed)
    Assert-StgClientSignInMethod -Cfg $Cfg -AzureCliAllowed $AzureCliAllowed
    $sel = $Cfg.client
    if ($sel -isnot [Collections.IDictionary] -or -not $sel.Contains('signInMethod')) { return }
    $method = $sel.signInMethod
    foreach ($file in @($Client.clientConfig, $Client.onboardingJson)) {
        $doc = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json -AsHashtable
        $doc.signInMethod = $method
        $doc | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $file -Encoding utf8NoBOM
    }
}
