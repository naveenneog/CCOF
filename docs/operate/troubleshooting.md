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
| Azure Cloud Shell closed during Stage 6 or 7 (the API Management wait takes up to 45 minutes) | Cloud Shell ends a session after 20 minutes without keyboard input ([Cloud Shell FAQ](https://learn.microsoft.com/azure/cloud-shell/faq-troubleshooting)); the Azure operations continue | Reopen the shell; wait until the `stage6-network` deployment and API Management show `Succeeded`, then preview and rerun the stage. Run Stages 6 and 7 from a workstation, or press a key every 10-15 minutes | Live run 2026-10-25 |
| Cloud Shell without persistent storage lost the checkout, the configuration and `.staged-state` | Without a storage account, `$HOME` is not kept between sessions | Clone again; use the saved configuration (or copy `location`, `tags` and `stage1` from the `stage1-services` deployment parameters, and `workbook.resourceName` from `stage5-config`); run Stage 0, then each stage in order. Stage 1 prints `verify-only: matching succeeded Stage 1 deployment found`; later stages find their resources and finish | Live run 2026-10-25 |
| Stage 1 after lost state: `verify_failed: … VNet subnet is '…/snet-functions', expected '' for completed stages` | Older code: Stage 6 had integrated the apps before the state was lost, and the read-back accepted only no integration | Update the checkout (`git pull`) and rerun Stage 1; it now also accepts the Functions subnet the configuration names | Live run 2026-10-25 |
| Stage 4: "The directory object quota limit for the Principal has been exceeded" | The operator owns the maximum number of directory objects (deleted ones count until purged) | Use existing apps (`entra.existing`) and existing groups (`groupId`), or an Entra administrator creates them | [guide](../STAGED-DEPLOYMENT-GUIDE.md#walkthrough-evidence-2026-10-24) |
| Stage 5: "Policy size exceeds allowed limit of 16 KB" | Older code: the API policy was one document | Current code deploys policy fragments; update the checkout | [ADR-0039](../adr/0039-gateway-policy-fragments.md) |
| Stage 2: `chargeback_history_ttl_transition` | `ttlDays` changed between `null` and a number on an existing `chargebackDaily` | Restore it, or follow the [procedure](chargeback-history-changes.md) | [Test-ChargebackHistory.ps1](../../tests/Test-ChargebackHistory.ps1) |
| Stage 0: "audit.chargebackHistory.enabled is true but reconciler.timerEnabled is not …" | Chargeback history is written only by the reconciler's timer run; the template leaves the timer off | Set `reconciler.timerEnabled: true` with history, or `audit.chargebackHistory.enabled: false` ([chargeback history](chargeback-history.md)) | [Test-ChargebackHistory.ps1](../../tests/Test-ChargebackHistory.ps1) |
| Stage 7: package upload `403 (This request is not authorized to perform this operation.)` | Private endpoints and VNet integration from Stage 6 are minutes old | Wait about five minutes and rerun Stage 7 | [guide](../STAGED-DEPLOYMENT-GUIDE.md#walkthrough-evidence-2026-10-24) |
| Stage 7: `npm ci` EPERM in `admin/node_modules` | Two Stage 7 runs from one checkout at the same time | One Stage 7 at a time per checkout | [runs](../archive/STAGED-STDV2-RUNS-2026-10-20.md) |
| Stage 7: `seed_documents_differ: these group documents differ from the configuration …` | A group was edited in the admin console after the first seed; `groups[]` seeds a group once | Change groups in the console. To keep the console's version, set `stage7.keepDifferingGroups: true` and rerun Stage 7 | [Test-Stage7GroupDrift.ps1](../../tests/Test-Stage7GroupDrift.ps1) |
| Stage 7: `seed_documents_differ: these existing documents differ from the parameters …` | A backend or baseline document differs from the configuration | Correct the configuration; Stage 7 never replaces a document | [Test-QuickstartSeed.ps1](../../tests/Test-QuickstartSeed.ps1) |
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

## Chargeback history

Usage export of an old month and the reconciler's history step ([chargeback history](chargeback-history.md)). These
rows come from the code and its tests ([admin/tests/history.test.ts](../../admin/tests/history.test.ts),
[tests/reconciler-history-run.test.ts](../../tests/reconciler-history-run.test.ts),
[tests/reconciler-history.test.ts](../../tests/reconciler-history.test.ts)), not yet from a live deployment.

Export responses ([admin/src/export.ts](../../admin/src/export.ts), [admin/src/history.ts](../../admin/src/history.ts)):

| Response | Cause | Next step |
| --- | --- | --- |
| `400` `history_range_not_whole_days` | The part of the range before the first whole month Log Analytics holds does not start and end at 00:00 UTC | Use `period=previous`, or `from` and `to` at 00:00 UTC |
| `400` `backend_filter_not_in_history` | A `backend` filter on a range with a history part; history has no backend | Remove `backend`, or keep the range inside the months Log Analytics holds |
| `400` `unknown_parameter` | A parameter the export does not take, such as `tags`, `offset` or `limit` (all exports) | Remove it |
| `409` `history_not_covered` after a [deletion](chargeback-history-changes.md#delete-history) | The month was deleted | Expected |
| `409` `history_not_covered` with `uncoveredDays` | Days the reconciler never recorded: before the month history was turned on, while the reconciler was stopped, or not yet written because of the write limit | Narrow the range to covered days. Days left by the write limit are covered by a later run: retry then |
| `409` `history_expired` with `expiredDays` and `expiresAt` | With `audit.chargebackHistory.ttlDays`, a month's documents expire `ttlDays` days after the month ends; the export refuses its days from one day before `expiresAt` | Narrow the range to later months. The expired totals cannot be recovered; the [audit archive](audit-archive.md), if it was on, still holds the request log |
| `503` `chargeback_history_not_configured` | The admin app has the history container setting but no Cosmos DB connection | Rerun Stage 5, then Stage 7, from the deployment's checkout |
| `503` `chargeback_history_settings_invalid` | `ADMIN_CHARGEBACK_HISTORY_CONTAINER` is not a valid container name, or `ADMIN_LOG_RETENTION_DAYS` is not a whole number 1-4383 | Rerun Stage 5; it writes both. Do not edit them by hand |

Run line (`ccof.reconciler.run.v1`, query in [check it works](chargeback-history.md#check-it-works);
[history-run.ts](../../src/reconciler/history-run.ts)). A failed `historyOutcome` also carries `historyErrorCode`
when the Azure error had one.

| Value | Meaning | Next step |
| --- | --- | --- |
| `historyOutcome: skipped`, `historyReason: history_lease_held` | Another run holds the history lease `ccof-chargeback-history` | None; the next run writes |
| `history_time_budget` (`failed`) | Half the run interval (at least 15 seconds) was spent; writes already made stay, no read or write starts after that, so the coverage record may not be updated this run | None if later runs write. If it repeats, check the Cosmos DB account's throttled requests (status 429) in **Metrics** |
| `history_lease_unavailable` (`failed`) | The lease container could not be read or written | Check the reconciler's Cosmos DB access (Stage 3) and network path |
| `history_read_failed`, `history_write_failed` (`failed`) | A read or write in `chargebackDaily` failed; `historyErrorCode` gives the status, for example `403` (rerun Stage 3) or `429` (throughput) | Fix the cause; the next run retries |
| `history_ledger_read_failed` (`failed`) | The extra Log Analytics query for the previous month's last days failed | As for a failed ledger read; the next run retries |
| `history_conflict` (`failed`) | Another writer changed a document after it was read | None; the next run reads it again |
| `lease_lost` (`failed`) | The history lease expired during the run | None; the next run retries |
| `history_store_missing` (`failed`) | The reconciler has history settings but no history store | Rerun Stage 7 from the deployment's checkout |
| `historyClosedRefused` above 0 | Usage arrived for a day already closed; it is not in history (still in Log Analytics while the workspace keeps it) | If frequent, raise `closeAfterDays` |
| `historyShrinkRefused` above 0 | A day's recomputed total is lower than the stored one (a partial read, or rows the workspace has deleted); not written, the day stays open | None if it clears; a day that stays open is listed in `openDays` |
| `historyBudgetDeferred` above 0 | Writes over the 1,000 per run limit, left for the next run; those days are not yet covered | None; it falls to 0 |
| `historyCoverageWritten` | Months whose coverage record this run updated | Information only |

## Old policy fragments

Stage 5 deploys the gateway policy as policy fragments whose names end with a hash of their content
([ADR-0039](../adr/0039-gateway-policy-fragments.md)). When a Stage 5 run renders a changed policy, the fragments of
the previous policy stay in API Management; nothing uses them, and Stage 5 does not delete them ([roadmap](../ROADMAP.md)).
To remove them, after Stage 5 has verified, with Azure CLI and API Management Contributor:

```powershell
$apim = az apim show -g <resource group> -n <API Management name> --query id -o tsv
$v = 'api-version=2024-05-01'
az rest --method get --url "$apim/policyFragments?$v" --query "value[].name" -o tsv
# For each fragment named <apiId>-<section>-<12 hex characters> that the current policy does not include:
az rest --method post --url "$apim/policyFragments/<name>/listReferences?$v" --query "length(value)"
az rest --method delete --url "$apim/policyFragments/<name>?$v"   # only when listReferences returned 0
```

The current policy's fragment names are in `.staged-state/generated/gateway/<apiId>.policy.deployment.json` under
`fragments` (each `id`). A fragment that an API revision still includes is listed by `listReferences`; keep it
([list references](https://learn.microsoft.com/en-us/rest/api/apimanagement/policy-fragment/list-references)).