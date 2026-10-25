# Troubleshooting

Each row was met in a live deployment or test; the evidence column links to where.

## Deployment

| Symptom | Cause | Fix | Evidence |
| --- | --- | --- | --- |
| Stage 0 or 1: `InsufficientQuota` for a Claude deployment | The subscription's Claude quota in the region is used by other deployments | Check free quota with the command in [prerequisites](../get-started/02-prerequisites.md#microsoft-foundry-models); lower `capacity`, use another model, `sku` or region, or free quota | [guide](../STAGED-DEPLOYMENT-GUIDE.md#walkthrough-evidence-2026-10-24) |
| Stage 0: "no API Management: set stage1.approveNewPublicApimBootstrap to true … or name an existing one in apim.existing" | The configuration creates no gateway and names none | For a lab set `approveNewPublicApimBootstrap: true` with `apimPublisherEmail` and `apimPublisherName`; otherwise fill `apim.existing` | [novice run](../evidence/2026-10-25-novice/README.md) |
| Stage 1: `ServiceUnavailable`, "high demand … zonal redundant" for Cosmos DB | No zone-redundant Cosmos capacity in that region for the subscription | Request region access at <https://aka.ms/cosmosdbquota>, or another region or `isZoneRedundant: false`. The failed account blocks a rerun ("is in a failed provisioning state … delete the previous instance"): delete it first with `az cosmosdb delete -g <resource-group> -n <account> --yes` (several minutes), then rerun Stage 1 | [guide 2.6](../STAGED-DEPLOYMENT-GUIDE.md#26-cosmos-db-redundancy), [novice run](../evidence/2026-10-25-novice/README.md) |
| `stage_config_changed: stage1 values changed after Stage 1 was verified`, or `stage1_parameters_changed` | Stage 1 is create-only: it never redeploys over a verified Stage 1 | Restore the `stage1` values it ran with, or deploy to a new resource group with a new prefix and its own state folder. Deleting the old resource group stops its charges; a deleted Foundry account keeps its model quota until it is purged (`az cognitiveservices account purge`) | [novice run](../evidence/2026-10-25-novice/README.md) |
| Stage 0: "stage1.foundry.publicNetworkAccess is Disabled, so the gateway reaches … only through a private endpoint" | The new Foundry account is private but its `backends` entry asks for no private endpoint | Set `privateEndpoint: true` on that backend; Stage 6 then creates the endpoint and its DNS zones | [novice run](../evidence/2026-10-25-novice/README.md) |
| Stage 6: `ParentResourceNotFound … privateDnsZones/privatelink.cognitiveservices.azure.com` | Older code read Foundry DNS zones that were never created (no Foundry private endpoint requested) | Update the checkout and rerun Stage 6; it redeploys its own network after a failed read-back | [novice run](../evidence/2026-10-25-novice/README.md) |
| Stage 4: "The directory object quota limit for the Principal has been exceeded" | The operator owns the maximum number of directory objects (deleted ones count until purged) | Use existing apps (`entra.existing`) and existing groups (`groupId`), or an Entra administrator creates them | [guide](../STAGED-DEPLOYMENT-GUIDE.md#walkthrough-evidence-2026-10-24) |
| Stage 5: "Policy size exceeds allowed limit of 16 KB" | Older code: the API policy was one document | Current code deploys policy fragments; update the checkout | [ADR-0039](../adr/0039-gateway-policy-fragments.md) |
| Stage 7: package upload `403 (This request is not authorized to perform this operation.)` | Private endpoints and VNet integration from Stage 6 are minutes old | Wait about five minutes and rerun Stage 7 | [guide](../STAGED-DEPLOYMENT-GUIDE.md#walkthrough-evidence-2026-10-24) |
| Stage 7: `npm ci` EPERM in `admin/node_modules` | Two Stage 7 runs from one checkout at the same time | One Stage 7 at a time per checkout | [runs](../archive/STAGED-STDV2-RUNS-2026-10-20.md) |
| Graph grant script: `app_role_missing` | Older script under `pwsh -File` passed `-Permissions A,B,C` as one string | Update the checkout | [CHANGELOG](../CHANGELOG.md) |
| Graph grant script: "REFUSED: … no active Privileged Role Administrator" | The role is eligible in PIM but not active | Activate it in Entra → Privileged Identity Management → My roles, sign in to `az` again, rerun | [guide 6.1](../STAGED-DEPLOYMENT-GUIDE.md#61-graph-grants-group-search-names-and-sync) |

## Access and requests

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401 authentication_error` | No token, an expired token, or a token for another audience | Sign in again with the CCOF helper ([CLIENTS.md](../CLIENTS.md)) |
| `403` "You are not entitled …" | The person is not a direct member of an onboarded group, or the sync has not run since they were added | Add them to the Entra group; wait for the sync (timer) or apply a snapshot |
| `403` "The requested model family is not available …" | The model is not in the group's admitted models | Use an admitted model, or add the family in the group's **Access and models** |
| `403` "Your CCU budget … is used up" | Recorded or projected spend reached the person's budget | Raise the budget in the admin console, or wait for the next month |
| `429` with `Retry-After` | A token limit (per person, group or family) or the budget guard's rate limit | Wait; check `/usage` for a warning; raise the limit or `overshootPercent` if appropriate |
| A new user tag does not appear on requests | With `sync.mode: delegated-snapshot` the tag reaches requests when a snapshot is applied | Apply a [fresh complete snapshot](users-and-groups.md#snapshot-mode-after-console-changes), or turn on the sync timer after the Graph grants |
| `/usage` shows "no figures for this month yet" | The reconciler has not run for this person this month, or its timer is off | Set `reconciler.timerEnabled: true` and rerun Stage 5 |

## Reports

| Symptom | Cause | Fix |
| --- | --- | --- |
| Developer row shows "unpriced usage" while Foundry throttled | A request Foundry refused with `429` is counted with unknown tokens (an open question recorded in [UNKNOWNS](../UNKNOWNS.md): whether Foundry bills such requests) | None needed for budgets (spend is a lower bound) |
| Spend stays at zero for groups | Older ledger query: group IDs are typed `guid` in Log Analytics | Update the checkout and rerun Stages 5 and 7 ([CHANGELOG](../CHANGELOG.md)) |
