# Chargeback history

Daily chargeback totals kept in Cosmos DB after Log Analytics has deleted the request rows, so a month older than
the workspace retention can still be exported. Keys: [configuration reference](../get-started/configuration-reference-3.md#chargeback-history).
Decision and limits: [ADR-0044](../adr/0044-chargeback-history-in-cosmos.md). Reports for the months Log Analytics
still holds: [chargeback and user tags](chargeback-and-tags.md).

## What it keeps

The chargeback reports read the usage ledger in Log Analytics. Log Analytics keeps it for the **effective
retention**: `audit.workspaceRetentionDays` if set, else `stage1.retentionInDays` (30 in the template). With
`audit.chargebackHistory.enabled: true`:

- **What is kept.** The reconciler writes one document per UTC day, tag value, group, person and model to the
  Cosmos DB container `chargebackDaily`: request counts, token totals and the list-price amount
  ([src/reconciler/history.ts](../../src/reconciler/history.ts)). The tag value is the one each request carried:
  the person's user tag, or the group's chargeback ID when the person has none.
- **Who writes it.** Only the reconciler's timer run writes history. History needs `reconciler.timerEnabled: true`;
  the configuration check refuses `audit.chargebackHistory.enabled: true` with `reconciler.timerEnabled: false`.
- **When a day is final.** A day closes `closeAfterDays` whole days after it ends; later ledger rows for it are not
  added. Until then its document is refreshed at most once an hour. A total is never lowered.
- **What it does not hold.** Per-request diagnostics: failed requests, duplicate copies, cache savings and the
  backend. Those columns are empty for history rows, and a `backend` filter is refused for those months.
- **Where it starts.** <!-- CODE-NOTE: first-run backfill of the current month; replace this sentence with the
  behaviour the code settles on. --> Days before history was turned on are not in it.
- **How long.** `ttlDays: null` keeps documents until someone deletes them; a number deletes each day's document
  that many days after its last write.

## Which export uses it

History is read only by the usage export API, `GET /api/v3/export/usage`
([admin/src/export.ts](../../admin/src/export.ts), [admin API](../ADMIN-API.md#export-for-power-bi-adminsrcexportts)).
The console tabs, their **Export CSV** button and the workbook show only what Log Analytics holds.

For a period that starts before the first whole month Log Analytics still holds, the export reads that part from
`chargebackDaily` and the rest from Log Analytics, one row per tag value, group and person. The current month
always comes from Log Analytics. The history part must start and end at 00:00 UTC. The JSON lists the parts in
`sources` (`chargebackHistory`, `logAnalytics`); the CSV header uses the tag field name set in **User tags**.

<!-- CODE-NOTE: incomplete coverage. Name the JSON field and the CSV column (or the refusal error) that report days
history does not cover, and what a reader should do. -->

Example: on a hypothetical 19 October with 30-day retention, `period=previous` (September) comes from history; a
custom range 15 September to 10 October reads 15-30 September from history and 1-10 October from Log Analytics.

## Download an old month

The export needs a delegated token for the admin API. History is not read by the console's **Export CSV** button,
so an old month is downloaded with a script. This route uses the Azure CLI as the client; it has not been run
against a live deployment yet.

1. **Once per deployment: allow the Azure CLI client.** Add the Azure CLI's public client ID to
   `admin.extraAllowedClientIds`: `["04b07795-8ddb-461a-bbee-02f9e1bf7b46"]`. Preview and apply Stage 4 (Entra
   administrator: preauthorizes the client for the `Projects.Manage` scope) and Stage 5 (platform engineer: adds
   it to the admin app's allowed clients). If Stage 7 or 8 then refuses with `stage_dependency_changed`, rerun it.
   This lets an Azure CLI sign-in call the admin API; the role check below is unchanged.
2. **The person downloading** needs the `CCOF.Projects.Read` (or `CCOF.Projects.Write`) app role on the CCOF Admin
   application (`entra.adminReaders`), and a network path to the admin app. With
   `stage1.functionsPublicNetworkAccess: Disabled`, run from a machine on the VNet ([network](../NETWORK.md)).
3. **Download**, from a workstation signed in with `az login` (`period=previous` also works for last month):

```powershell
$rg = 'ccoflab-rg'
$adminApp = az functionapp list -g $rg --query "[?ends_with(name, '-admin')].name | [0]" -o tsv
$adminHost = az functionapp show -g $rg -n $adminApp --query defaultHostName -o tsv
$adminAppId = az functionapp config appsettings list -g $rg -n $adminApp --query "[?name=='ADMIN_AUDIENCE'].value | [0]" -o tsv
$token = az account get-access-token --scope "api://$adminAppId/Projects.Manage" --query accessToken -o tsv
$url = "https://$adminHost/api/v3/export/usage?period=custom&from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z&format=csv"
Invoke-WebRequest $url -Headers @{ Authorization = "Bearer $token" } -OutFile usage-2026-08.csv
```

`ADMIN_AUDIENCE` is the CCOF Admin application (client) ID, also shown in the Entra admin center → **App
registrations**. Reading the app settings needs a role that can list them, such as Website Contributor; otherwise
ask the platform engineer for the two values. A custom range may span at most 62 days
(`ADMIN_CHARGEBACK_MAX_QUERY_DAYS`); download longer periods month by month. At most 5,000 rows are returned; the
`x-ccof-truncated` header says whether more matched.

## Turn on in an existing deployment

1. `git pull` in the checkout used for the deployment. Keep the same configuration file and its `.staged-state`
   folder.
2. Add the `audit.chargebackHistory` block from
   [staged.config.example.json](../../infra/staged/staged.config.example.json) and set
   `reconciler.timerEnabled: true`.
3. Preview, then apply, in this order:
   - Stage 2 (platform engineer): creates `chargebackDaily`.
   - Stage 3 (access administrator): grants the reconciler write access and the admin app read access to it.
   - Stage 5 (platform engineer): writes the reconciler and admin settings, and turns the reconciler timer on.
   - Stage 7 (platform engineer): publishes the reconciler and admin code from the updated checkout.
   - Stage 8 (platform engineer): acceptance.

A stage run out of order refuses with `stage_config_changed` (its inputs changed) or `stage_dependency_changed`
(an earlier stage was rerun); the message names the stage to preview and apply next
([staged guide](../STAGED-DEPLOYMENT-GUIDE.md)). Stages 1, 4 and 6 are not rerun.

## Check it works

- **Stage 2 evidence.** `$HOME/ccof-private/.staged-state/evidence/stage2.verify.json` lists `chargebackDaily`.
- **Reconciler runs.** In the Portal, open the deployment's Log Analytics workspace → **Logs** and run:

```kusto
union isfuzzy=true FunctionAppLogs, AppTraces
| where TimeGenerated > ago(1d) and Message has "ccof.reconciler.run.v1"
| extend r = parse_json(Message)
| project TimeGenerated, outcome = tostring(r.outcome), historyOutcome = tostring(r.historyOutcome),
    historyReason = tostring(r.historyReason), historyWritten = toint(r.historyWritten)
| top 20 by TimeGenerated
```

  Expected: `historyOutcome` is `written` after requests have been made. Empty `historyOutcome` means the reconciler
  has no history settings: rerun Stages 5 and 7. `failed` gives a `historyReason`; the run retries on its next tick.
- **Documents.** The template sets `stage1.cosmosPublicNetworkAccess: Disabled`, so Data Explorer in the Portal
  shows `chargebackDaily` only from a machine on the VNet.
- **Export.** Once the first month is older than the effective retention, download it as above; the JSON
  (`format=json`) lists `chargebackHistory` in `sources`.

## Cost

| Item | Estimate |
| --- | --- |
| Writes | About 5 RU per write of a document under 1 KB ([request units](https://learn.microsoft.com/en-us/azure/cosmos-db/request-units)). A document is rewritten at most once an hour while its day is open, plus one closing write: at most 25 writes a day. For a hypothetical 1,000 active people using 2 models: 1,000 × 2 × 25 × 5 = 250,000 RU a day at most |
| Price per RU (serverless) | USD 0.25 per million RU, the rate billed for the lab's serverless account (bill of 2026-10-24). The example is at most about USD 0.06 a day, under USD 2 a month |
| Reads | Each run reads the month's stored totals, cached for 60 minutes per host. Their cost grows with the number of documents and is not estimated here; check the account's **Metrics** → Total Request Units after a week |
| Storage | Under 1 KB per document: about 62 MB a month in the example. Cosmos DB storage is USD 0.25 per GB per month ([retail price, East US 2](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Azure%20Cosmos%20DB%27%20and%20armRegionName%20eq%20%27eastus2%27%20and%20meterName%20eq%20%27Data%20Stored%27), retrieved 2026-10-25), so a year of history is about 0.75 GB, about USD 0.19 a month |
| Provisioned throughput | No per-RU charge: the writes count against the account's RU/s |

Prices are USD list prices; agreements and regions differ. The estimate comes from
[ADR-0044](../adr/0044-chargeback-history-in-cosmos.md) and is not measured.

## Turn off

Set `enabled: false` and preview and apply the stages the refusal messages name; Stage 5 then removes the history
settings and the reconciler stops writing. The container and its documents stay; delete the container in the
Portal (Cosmos DB account → **Data Explorer**, from the VNet) if the history is no longer needed.

<!-- CODE-NOTE: confirm what `enabled: false` changes in the stage records and what remains after turning off. -->
