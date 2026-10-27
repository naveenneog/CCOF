# ADR-0052: opt-in zone redundancy in the create-only resource stage

Date: 2026-10-27. Status: accepted. Packet: G-HA-ZONES.

## Context

The staged deployment creates a single-region gateway and four Flex apps. Cosmos already has per-region zone
settings. Zone protection must be explicit, cost-visible, verified and compatible with existing state hashes.
Existing APIM instances remain owner-managed (ADR-0045). Research is recorded as HAZ-1 through HAZ-4 in UNKNOWNS.

## Options

1. Duplicate every existing resource setting under a new HA profile: rejected because two conflicting sources could
   silently override storage, units and Cosmos settings.
2. Add just the missing toggles and reuse the existing resource settings: chosen.
3. Reconfigure existing services from Stage 1: rejected; that stage is create-only and v2 APIM zones are immutable.

## Decision

Optional root `ha` accepts only `apim.zoneRedundant` and `functions.zoneRedundant` JSON booleans. Existing
`stage1.apimUnits` selects capacity (recommend at least two; one is supported), `stage1.storageSku` selects LRS,
ZRS or GZRS, and `stage1.cosmosLocations[].isZoneRedundant` remains the Cosmos contract. No defaults are inserted
into read configurations. `ha` enters only Stage 0/1 input hashes when present and only then becomes a Stage 1
template parameter; absent-key hashes and effective non-HA deployment settings remain unchanged.

APIM v2 uses automatic `properties.zoneRedundant`, not numbered classic Premium zones; enable it only for a new
StandardV2/PremiumV2 service. Flex sets the hosting plan property, requires ZRS/GZRS host/deployment storage, and
does not add an application always-ready override: Azure manages its minimum. Stage 0 reads target region and
Cosmos failover region/pair zone mappings, plus Flex's service-specific list, and prints configured state and
actionable suggestions. It refuses impossible regional requests, not a recommendation declined by the owner.
Service capacity is not guaranteed by regional mappings.

Stage 1 reads back the APIM flag and units, every Flex plan flag and every host storage SKU, alongside the existing
Cosmos per-region check. Legacy configurations do not acquire a new plan read dependency.

## Consequences and migration

Zone redundancy is not regional disaster recovery. The gateway, apps, workspace and private network remain in
one region. A region-wide outage still needs a separately planned deployment, data migration and client cutover.
Foundry endpoint failover is a separate packet.

Set these options before Stage 1. An existing customer must keep the original config/state intact and plan a new
prefix/resource group with separate state; migrate data, identities, network and client endpoints under a reviewed
cutover plan. Do not delete the original Cosmos account or rerun Stage 1 hoping it changes zones.
Azure supports some storage/Cosmos migrations, but CCOF does not orchestrate them. APIM v2 zone configuration
requires recreation; this option is never applied to `apim.existing`.

## Initial-creation capacity refusal

The existing failed-deployment recovery guard is not an in-place migration of a succeeded Stage 1. When first
creation fails before Cosmos has a data endpoint, no Stage 1/2 completion or Stage 2 deployment exists, and the
operations corroborate failed account creation, an owner may approve deleting only that new uninitialized failed
account and retrying an approved layout with the same state folder. The guarded what-if must allow only this
deployment's recorded resources. Never use a failed database-list call alone as proof that an account is empty.

Central India refused zonal Cosmos twice on 2026-10-27 (also observed on 2026-10-26). The coordinator approved
nonzonal Central India + South India Cosmos while preserving APIM/Flex/ZRS zone protection for the live proof.
Requesting zonal capacity or retrying later remains the path to zonal Cosmos; India South Central is an alternative
with zones, not a capacity guarantee. This is a documented platform limit and explicit operator choice, not
automatic HA downgrading. See [the customer recovery steps](../get-started/high-availability.md).

## Exact APIM SKU regression contract

The prior stage-template regression pinned exactly BasicV2/StandardV2. The requested PremiumV2 support expands
that exact set to BasicV2/StandardV2/PremiumV2, while StandardV2 remains the default. Update the equality contract,
not its strictness: deleting PremiumV2 or admitting classic Premium must both fail the suite. This reconciles
the old assertion with the accepted feature; it is not permission to accept arbitrary SKUs or bypass the gate.

## Client aliases before publication

The lab's first Stage 7 published successfully but spent 1,368 seconds before export rejected copied Sonnet
aliases on a Haiku-only backend. Extract the existing exact alias/admission guard for reuse, retaining its call
at export. Stage 0 and Stage 7 validate configured selection/aliases before Azure reads, context construction or
publishing, including preview mode. Admission remains the selected group's family models intersected with the
selected backend's configured deployment names, ordinal/case-sensitive. Baseline project/classification selectors
retain their one-backend default; named group selectors do not need Stage 4 resolution for this pure check.
Refusals retain the existing error prefix/message and append aliases plus admitted deployment names.
