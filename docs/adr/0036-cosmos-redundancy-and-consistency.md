# ADR-0036: Cosmos DB redundancy and consistency

Status: Accepted (owner request 2026-10-23: "a cosmos with consistency model ... so its not a single point of failure").
Owner asked, unavailable: the defaults below are chosen and can be changed in the staged configuration.

## Context

The staged deployment created one serverless Cosmos DB account in one region, with no zone redundancy and no
failover (`infra/staged/main.bicep`). Every component reads or writes it. The gateway keeps serving a person's
last decision for up to `lastKnownGoodGraceSeconds` (3600 s in the example) when the resolver cannot read Cosmos,
but new and expired decisions fail, and sync, cost runs, the admin console and `/usage` stop.

A consistency level alone does not remove the single point of failure. Redundancy does; the consistency level then
sets how much recent data a regional failover can lose.

## Facts (Microsoft Learn)

- A serverless account runs in one Azure region ([serverless](https://learn.microsoft.com/en-us/azure/cosmos-db/serverless)).
- Serverless zone redundancy can be set only when the account is created; on an existing account, zone redundancy
  comes with adding a region ([reliability](https://learn.microsoft.com/en-us/azure/reliability/reliability-cosmos-db)).
- Single write region, several regions: a read-region outage is handled by the SDK, which "routes future operations
  to the next available region in the preference list"; a write-region outage loses writes "until a region offline
  operation or service-managed failover completes" (same page).
- RPO for a region outage: Session, consistent prefix, eventual "less than 15 minutes"; bounded staleness K and T;
  strong 0 (same page).
- Bounded staleness across regions needs at least 100,000 writes or 300 seconds; strong consistency across regions
  more than 5,000 miles apart is blocked by default
  ([consistency levels](https://learn.microsoft.com/en-us/azure/cosmos-db/consistency-levels)).
- A Cosmos private endpoint gets one address per account region, and the private DNS zone updates when regions are
  added or removed ([private endpoints](https://learn.microsoft.com/en-us/azure/cosmos-db/how-to-configure-private-endpoints)).
- `@azure/cosmos` 4.10.1 matches `preferredLocations` against region names without spaces or case, so ARM names such
  as `eastus2` work (`normalizeEndpoint`), and endpoint discovery is on by default.

## Options

1. Zone-redundant serverless, one region: survives a datacentre (zone) failure, not a region outage.
2. Provisioned autoscale, two regions, service-managed failover: survives a region outage.
3. Option 2 with zone redundancy in each region (chosen for the example): survives both.
4. Multiple write regions: not chosen; the components do not need multi-region writes, and conflict resolution
   would become part of the design.

## Decision

- `stage1.cosmosLocations` lists regions in failover order with `isZoneRedundant`; the first is the write region and
  must be the deployment location. Two or more regions turn on service-managed failover. Absent: the previous single
  region without zone redundancy, so existing configurations deploy as before.
- `stage1.cosmosConsistency` sets the consistency level; the example uses **Session**, the Cosmos default and the
  level the components were written for (each writer reads its own writes). Strong would add cross-region latency to
  every write; Bounded Staleness is accepted with the multi-region minimums.
- Configuration checks: serverless with one region only; the two capacity-mode settings must agree; region names,
  uniqueness, consistency values and bounded-staleness minimums (Staged.Cosmos.ps1).
- Stage 1 reads the account back: regions in order, zone redundancy, failover and consistency (with the
  bounded-staleness bounds). Stage 6 requires the Cosmos private endpoint to carry the global DNS name and one
  `<account>-<region>` name per region, in every network mode (checked against a live single-region endpoint:
  `<account>` and `<account>-eastus2`).
- The resolver, the component on every Claude request's path, gets `COSMOS_PREFERRED_REGIONS` (the regions in
  failover order) from Stage 5, so its reads move to the next region during an outage before any failover.

## Consequences

- Stage 1 is create-only: an existing deployment keeps its single-region account. Moving to the new layout means a
  new resource group (or a reviewed migration of the account), not a rerun.
- Provisioned throughput is billed in every region. Zone-redundant regions carry a premium, which Learn states is
  waived for autoscale throughput (the example's mode) and for multi-region writes
  ([reliability, Cost](https://learn.microsoft.com/en-us/azure/reliability/reliability-cosmos-db);
  [pricing](https://azure.microsoft.com/pricing/details/cosmos-db/)). Serverless is not used for a multi-region account.
- Writes (sync, reconciler, admin console) stop during a write-region outage until service-managed failover
  completes; the resolver's reads continue from the second region.
- The second region must be one where the private endpoint's virtual network can resolve and reach the account; the
  endpoint in the deployment VNet carries addresses for every region.
- The quickstart, Core and manual paths still create a single-region account.
- Zone-redundant capacity is not always available. On 2026-10-23 the lab subscription was refused `eastus2` (with
  and without zone redundancy) and zone-redundant `westus3` with `ServiceUnavailable` ("high demand"); zone-redundant
  `centralus` plus `westus3` without zone redundancy deployed (a Cosmos-only Bicep file), and the Stage 1 read-back
  function, called directly, returned no problems for it.
  The guide's section 2.6 records the steps (region access request at <https://aka.ms/cosmosdbquota>, or another
  region).
