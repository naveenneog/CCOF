# Novice walkthrough: Central India, 2026-10-26

A fifth first-time deployment, from release 17, into **Central India** with **provisioned Cosmos DB** in two regions.
The reader also had to find, from the README and the guides, which region to use for failover. Claude models are
not offered in any India region, so the Foundry account went to East US 2 and everything else stayed in Central India.
The `fail-*` images show the output before the fix, `fix-*` what the reader sees now, `ok-*` the checks that passed.

Names and identifiers in the images are hypothetical, in the same format as the
[2026-10-24 demo](../2026-10-24-demo/README.md). Previous run: [2026-10-26](../2026-10-26-novice/README.md).
The guidance this run produced: [regions, provisioned Cosmos DB and the failover region](../../get-started/region-and-failover.md).

## Route

| Item | Value |
| --- | --- |
| Pages | README -> 01 -> 02 -> 03 with the configuration pages and [guide 2.6](../../STAGED-DEPLOYMENT-GUIDE.md#26-cosmos-db-redundancy) -> 05 |
| Subscription, region | One subscription; `location: centralindia`, `network.mode: create`; Foundry account in `eastus2` (row 1) |
| Cosmos DB | Template capacity (`provisioned` with `provisioned-autoscale`, 1,000 RU/s maximum on the database); `centralindia` then `southindia`, both `isZoneRedundant: false` (row 2) |
| Models | `claude-haiku-5-5` and `claude-sonnet-5-5`, `GlobalStandard`, capacity 10 each, `deploymentInferenceGeo: global` (no India data zone for Claude) |
| Identity | Existing gateway and resolver registrations (Stage 4 preview: `no change`); a new admin registration for this lab; one existing group (`groupId`) |
| Attempts | One resource group; Stage 1 and Stage 7 each needed a second apply (rows 2 and 3) |

## What failed, and what changed

| # | Stage | What the reader saw | Cause | Now | Image |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | `verify_failed: model claude-haiku-5-5@2 (GlobalStandard) is not offered in centralindia for this subscription` | Claude is offered only in some US regions and Sweden Central; Stage 1 created the Foundry account only in `location`, and no page said so | `stage1.foundry.location` puts the account in a Claude region; Stage 0 checks models, quota and deleted accounts there, and the refusal names the key | `fail-01-claude-not-in-centralindia.png`, `fix-01-stage0-foundry-in-eastus2.png` |
| 2 | 1 | `ServiceUnavailable: … high demand in Central India region for the zonal redundant (Availability Zones) accounts` after 156 s | No zone-redundant Cosmos DB capacity for the subscription; the template asks for it | The troubleshooting row matched: `az cosmosdb delete` (69 s), `isZoneRedundant: false`, Stage 1 again. The deploy page now names Central India as well as East US 2 | `fail-02-cosmos-zonal-centralindia.png` |
| 3 | 7 | `BlobUploadFailedException: … 403 (This request is not authorized to perform this operation.)` | The documented first-run storage `403` right after Stage 6 | Rerun as the page says; passed | `fail-03-stage7-storage-403.png` |

Before Stage 0 the reader could not find the failover region in the guides: guide 2.6 said only "a second region with
availability zones". Central India's pair, South India, has none, and India South Central has zones but is paired
one way. Nothing mentioned data residency or where the prompts go. The guidance page above now covers this.

## Stage timings

| Stage | Preview | Apply | Notes |
| --- | --- | --- | --- |
| 0 | — | 50 s (row 1), 134 s | |
| 1 | 7 s | 156 s (row 2), 571 s | Foundry account in `eastus2`, the rest in `centralindia` (`ok-01-stage1-centralindia.png`) |
| 2 | 28 s | 230 s | |
| 3 | 25 s | 872 s | Longer than the page's 6 minutes |
| 4 | 11 s | 58 s | |
| 5 | 45 s | 120 s | `audit archive: … in Central India`, `network public-disabled (policy or private)` |
| 6 | 29 s | 812 s | Foundry private endpoint in Central India for the East US 2 account, approved |
| 7 | 7 s | 327 s (row 3), 1,264 s | `"outcome":"succeeded"`, `"membersAdmitted":1`, `"writeFailures":0` |
| 8 | 3 s | 340 s | Anonymous `401`, `claude-haiku-5-5` `200` (`STAGED OK`), `claude-opus-5-5` `403`, admin console `200`, the ledger row charged to the group (`ok-02-stage8.png`) |

Successful applies took 73 minutes; the two failed applies and the Cosmos DB deletion added 9 minutes.

## Success run

- **Regions**: Cosmos DB in Central India (priority 0) and South India (priority 1), service-managed failover on,
  autoscale maximum 1,000 RU/s at 100 RU/s when idle; Foundry account in East US 2 with its private endpoint in
  Central India (`ok-05-cosmos-regions-and-foundry.png`). Stage 5 set `COSMOS_PREFERRED_REGIONS` to
  `centralindia,southindia` on the resolver.
- **Developer setup** ([page 5](../../get-started/05-developer-setup.md)) in a scratch user profile with the Azure CLI
  sign-in: `claude -p` answered through the gateway (`ok-03-claude-through-gateway.png`, with the model-catalog
  notice CC-01); the usage script and the status line printed USD 0.00 of USD 100.00
  (`ok-04-usage-and-status-line.png`). The interactive sign-in window was not opened: the helper's profile folder
  received a copy of an Azure CLI profile already signed in to the same tenant.
- **Latency**: the Stage 8 request took 2.9 s at the gateway, 2.5 s of it at the East US 2 backend.

## Open items

- A Cosmos DB region failover was not exercised (no manual failover was triggered).
- The Stage 0 report and the Stage 1 preview do not show the Foundry account's region.
- Stage 7's first successful seed printed `present-equal`, not `created`, for both documents.
- Interactive `/usage` and the model-catalog notice (CC-01 in [UNKNOWNS](../../UNKNOWNS.md)), as in the previous run.

## Rating from a first-time reader

| | Before this run's fixes | After |
| --- | --- | --- |
| Reaching a working deployment in Central India from the README alone | 3/10: Stage 0 refused with no way forward, and no page said Claude is unavailable in India | 8/10: the refusal names `stage1.foundry.location`, the regions page explains it, and the documented Cosmos DB recovery worked |
| Choosing the failover region | 3/10: "a second region with availability zones" excluded the paired region and said nothing on data residency | 8/10: same geography, the pair (South India), zones per region, capacity, with sources; the parts without failover are listed |
| Provisioned Cosmos DB | 6/10: the template was already provisioned, but no cost was given | 8/10: the regions page gives the hourly and monthly list prices for one and two regions |
| Remaining | Open items above | |
