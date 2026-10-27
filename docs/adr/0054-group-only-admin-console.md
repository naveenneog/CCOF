# ADR-0054: Manage only groups in the current admin console

Date: 2026-10-27
Status: Proposed — paused pending expanded migration contract
Packet: G-GROUPS-ONLY

## Context

Owner subsequently expanded the decision: all new deployments are group-based,
and older project-based deployments should be decommissioned rather than
maintained indefinitely. The coordinator is defining decommission and contract
scope. The narrower proposal below records the original UI-only brief, not approval
to retain legacy server support permanently or to delete any Azure resources.
Implementation is paused until explicit resume. No runtime/server changes have
been made.

New deployments use Entra group registrations exclusively. The console's Legacy
projects navigation and classification controls suggest a second onboarding model
that these deployments do not use. Older deployments and historical accounting
records can still contain legacy project scopes.

## Options

1. Keep both management interfaces, with classification controls.
2. Make the current console group-only while retaining server compatibility.
3. Delete legacy server support as well as its console interface.

## Decision

Choose option 2. Remove legacy management pages, navigation, help and controls from
admin/ui-v3. Old project bookmarks display a short explanation and a Groups link.
GUID scopes link to Groups; historical non-GUID identifiers remain plain text.
Budget selection uses group registrations only. Foundry lists linked groups only.
Local demo data exercises group registrations rather than legacy documents.

Keep actual API field names, permission identifiers and historical accounting
values intact. This is a console boundary change, not a storage migration.

## Consequences and follow-up

The current console no longer creates or edits legacy projects. Existing documents
continue to be enforced by server-side legacy support: /api/projects*, v2/v3 project
endpoints, src/sync/projects.ts, resolver/reconciler classification handling, the
staged driver's projects/client.projectId selection, and KQL classification fields.
Shared contracts, Cosmos schema and gateway policy do not change.

Removing those server paths requires an inventory/data check and a reviewed
migration plan first (roadmap G-LEGACY-SERVER-MIGRATION). The archived quickstart and
older deployments can still produce or contain legacy documents. Do not equate
removal of console controls with permission to stop enforcing their entitlements.
