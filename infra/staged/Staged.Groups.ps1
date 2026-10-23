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
    $ids = @($Row.projectIds | ForEach-Object { ([string]$_).ToLowerInvariant() })
    if ([int]$Row.requests -ne $Requests -or $ids.Count -ne 1 -or $ids[0] -cne $ExpectedGroupId.ToLowerInvariant()) {
        throw "verify_failed: requests without a selector were charged to $($ids -join ', ') ($($Row.requests) of $Requests traced), expected group $ExpectedGroupId"
    }
}

# Stage 7 seed: the quickstart's baseline documents (checked against onboarding's schema, as Invoke-QsSeed
# does) plus the group documents, through the sync app's registrySeed function, which checks each group
# document with the group contract and writes nothing if one fails.
function Invoke-StgSeed {
    param([Parameter(Mandatory)] $Ctx, $GroupDocuments)
    if (-not @($GroupDocuments).Count) { return Invoke-QsSeed $Ctx }
    $docs = New-QsSeedDocuments -P $Ctx.P -ClassificationGroupDisplayNames $Ctx.State.completed['1'].outputs.classificationGroupDisplayNames
    foreach ($project in @($docs.projects)) {
        try { $null = ConvertTo-OnboardingProjectDocument -Project ($project | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable) }
        catch { throw "seed_document_invalid: the projects document $($project.id) fails onboarding Stage 3's schema: $($_.Exception.Message)" }
    }
    $docs.projects = @($docs.projects) + @($GroupDocuments)
    return Invoke-QsSeedThroughFunction -Ctx $Ctx -Documents $docs
}

# Stage 7 client file. client.group names one group entry (groupDisplayName or groupId); the selector
# value is the group's object ID, which is its scope ID on the wire. Otherwise the quickstart selection.
function Invoke-StgClient {
    param([Parameter(Mandatory)] $Ctx, [Parameter(Mandatory)] $Cfg, [Collections.IDictionary]$EntraGroups)
    $sel = $Cfg.client
    if ($sel -isnot [Collections.IDictionary] -or -not $sel.Contains('group')) { return Invoke-QsClient $Ctx }
    if (@($sel.Keys | Where-Object { $_ -cnotin 'group', 'models' }).Count) { throw 'client_selection_invalid: client.group takes only models beside it.' }
    $entry = @($Cfg.groups | Where-Object { $_ -and (Test-StgGroupEntry $_) -and ($_.groupDisplayName -ceq $sel.group -or ($_.groupId -and ([string]$_.groupId) -ieq [string]$sel.group)) })
    if ($entry.Count -ne 1) { throw 'client_selection_invalid: client.group must name exactly one group entry by groupDisplayName or groupId.' }
    $doc = @(New-StgGroupDocuments -Groups $entry -EntraGroups $EntraGroups)[0]
    $restricted = @($doc.familyPolicy.families.Keys | Where-Object { $_ -in 'fable', 'mythos' })
    if ($restricted.Count -and -not $doc.restrictedFamiliesApproved) { throw 'client_selection_invalid: Fable and Mythos need restrictedFamiliesApproved on the group.' }
    return New-QsClientFiles -Ctx $Ctx -ProjectId $doc.id -FamilyPolicy $doc.familyPolicy -BackendId $doc.backendId -Aliases $sel.models
}
