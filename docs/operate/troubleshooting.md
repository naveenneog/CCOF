# Troubleshooting

Each row was met in a live deployment or test; the evidence column links to where.

## Deployment

| Symptom | Cause | Fix | Evidence |
| --- | --- | --- | --- |
| Stage 0 or 1: `InsufficientQuota` for a Claude deployment | The subscription's Claude quota in the region is used by other deployments. `az cognitiveservices usage list -l <region>`; the line ending `.Azure` applies to Foundry Claude deployments | Lower `capacity`, use another model or region, or free quota | [guide](../STAGED-DEPLOYMENT-GUIDE.md#walkthrough-evidence-2026-10-24) |
| Stage 1: `ServiceUnavailable`, "high demand … zonal redundant" for Cosmos DB | No zone-redundant Cosmos capacity in that region for the subscription | Request region access at <https://aka.ms/cosmosdbquota>, or another region or `isZoneRedundant: false`; then rerun Stage 1 | [guide 2.6](../STAGED-DEPLOYMENT-GUIDE.md#26-cosmos-db-redundancy) |
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
