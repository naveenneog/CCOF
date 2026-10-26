# Chargeback history

Daily chargeback totals kept in Cosmos DB after Log Analytics has deleted the request rows, so a month older than
the workspace retention can still be exported. Keys: [configuration reference](../get-started/configuration-reference-3.md#chargeback-history).
Decision and limits: [ADR-0044](../adr/0044-chargeback-history-in-cosmos.md). Reports for the months Log Analytics
still holds: [chargeback and user tags](chargeback-and-tags.md).

## What it keeps

The chargeback reports read the usage ledger in Log Analytics. Log Analytics keeps it for the **effective
retention**: `audit.workspaceRetentionDays` if set, else `stage1.retentionInDays` (30 in the template).
After Stage 5 raises `audit.workspaceRetentionDays`, the workspace holds the added days only as new rows age in;
until then the export reads the months it does not hold from history
([ADR-0043](../adr/0043-long-term-audit-archive.md#raising-the-workspace-retention)). With
`audit.chargebackHistory.enabled: true`:

- **What is kept.** The reconciler writes one document per UTC day, tag value, group, person and model to the
  Cosmos DB container `chargebackDaily`: request counts, token totals and the list-price amount
  ([src/reconciler/history.ts](../../src/reconciler/history.ts)). The tag value is the one each request carried:
  the person's user tag, or the group's chargeback ID when the person has none.
- **Who writes it.** Only the reconciler's timer run writes history. With the timer off, the configuration check (Stage 0 and every stage) refuses with:
  `audit.chargebackHistory.enabled is true but reconciler.timerEnabled is not: history is written only by the reconciler timer run; set reconciler.timerEnabled to true or audit.chargebackHistory.enabled to false (ADR-0044)`
  ([Staged.Cosmos.ps1](../../infra/staged/Staged.Cosmos.ps1)). The template has both off; turn them on together.
- **When it runs.** After the run has written the budget states and released the budget lease, and only when that
  budget part wrote its states. History takes its own [lease](../GLOSSARY.md), `ccof-chargeback-history`, in the same lease container,
  and stops after half the run interval (at least 15 seconds) and 1,000 document writes; whole days are written
  oldest first and the rest wait for the next run. A history failure is reported on the run line and never fails
  or delays budgets ([run.ts](../../src/reconciler/run.ts), [history-run.ts](../../src/reconciler/history-run.ts)).
- **When a day is final.** A day is due to close `closeAfterDays` whole days after it ends. If its totals changed
  since the last write, that run writes them still open and the next run (one reconciler interval later) writes the
  day closed; a day already holding its final totals closes at once. Until then an open day is rewritten at most
  once an hour, and a day's total is never lowered. A closed day is frozen: ledger rows that arrive for it later
  are not added (`historyClosedRefused` on the run line); they stay in Log Analytics while the workspace keeps them.
- **What it does not hold.** Per-request diagnostics: failed requests, duplicate copies, cache savings and the
  backend. Those columns are empty for history rows, and a `backend` filter is refused for those months.
- **Where it starts.** The first history run reads the whole current month from Log Analytics, so history covers
  every day of that month from day 1, and, during the first `closeAfterDays` + 1 days of a month, the previous
  month's last `closeAfterDays` + 1 days. Earlier days, and days the reconciler never read while stopped, are never
  filled in: an export that includes them is refused with `history_not_covered`, not shown as zero. The first run holds only what the workspace still keeps: with the minimum 30-day retention, a first run
  on the 31st of a 31-day month may find part of day 1 already deleted.
- **How long.** `ttlDays: null` keeps documents until deleted. With a number, every document of a month expires at
  one instant, `ttlDays` days after the month ends, kept in the month's coverage record as `expiresAt`
  ([ADR-0044 decision 9](../adr/0044-chargeback-history-in-cosmos.md)). From one day before it, the export refuses
  the month's days with `history_expired` (below). A changed `ttlDays` applies to documents written afterwards.
  Changing between `null` and a number, and deleting history: [changes](chargeback-history-changes.md).

## Which export uses it

History is read only by the usage export API, `GET /api/v3/export/usage`
([admin/src/export.ts](../../admin/src/export.ts), [admin API](../ADMIN-API.md#export-for-power-bi-adminsrcexportts)).
The console tabs, their **Export CSV** button and the workbook show only what Log Analytics holds.

For a period that starts before the first whole month Log Analytics still holds, the export reads that part from
`chargebackDaily` and the rest from Log Analytics, one row per tag value, group and person. Every row carries the
whole requested period in `periodStart` and `periodEnd`. The current month always comes from Log Analytics. The
history part must start and end at 00:00 UTC. Every export filter except `backend` (refused there) applies to the
history part too. The
JSON lists the parts in `sources` (`chargebackHistory`, `logAnalytics`); an export read from Log Analytics alone
has no `sources` key. The CSV header uses the tag field name set in **User tags**.

Example: on a hypothetical 19 October with 30-day retention, `period=previous` (September) comes from history; a
custom range 15 September to 10 October reads 15-30 September from history and 1-10 October from Log Analytics.

### Days history does not cover

A day without usage has no document, so each month in `chargebackDaily` also has one [coverage record](../GLOSSARY.md)
(`id: "coverage"`) listing the days history holds, each `open` or `closed`. The reconciler updates it after all of a
run's document writes succeed; days left for the next run by the write limit are added when they are written. A
closed day never becomes open again. Before reading, the export checks every day of the history part
([admin/src/history.ts](../../admin/src/history.ts) `historyCoverage`):

- **A day not covered** refuses the whole request with HTTP 409 and a JSON body (for `format=csv` too), for example
  `{ "error": "history_not_covered", "uncoveredDays": ["2026-07-01", "2026-07-02"] }`. No file with zeros is
  returned. Choose a range of covered days (`period=custom` with whole UTC days). The only other record of older
  days is the gateway request log in the [audit archive](audit-archive.md), if it was on. Other export errors:
  [troubleshooting](troubleshooting.md#chargeback-history).
- **A covered day whose documents expired**, or expire within one day, refuses the whole request with HTTP 409, for
  example `{ "error": "history_expired", "expiredDays": ["2026-07-01"], "expiresAt": "2027-09-05T00:00:00.000Z" }`
  (a hypothetical `ttlDays` of 400). This happens only with `ttlDays`. Choose later months.
- **A covered day not yet closed** is exported; an open day's totals can still rise. The JSON lists such days in
  the `openDays` of the `chargebackHistory` entry in `sources` (usually empty); the CSV response lists them in the
  `X-CCOF-History-Open-Days` header (comma-separated, empty when none).

## Download an old month

The export needs a delegated token for the admin API. History is not read by the console's **Export CSV** button,
so an old month is downloaded with a script. This route uses the Azure CLI as the client, tested live on 2026-10-26.

1. **Once per deployment: allow the Azure CLI client**: its public client ID `04b07795-8ddb-461a-bbee-02f9e1bf7b46`
   in `admin.extraAllowedClientIds` (the turn-on steps below add it; added later, it needs Stage 4, then Stages 5,
   7 and 8). The role check below still applies.
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
   [staged.config.example.json](../../infra/staged/staged.config.example.json) (the template has it switched off),
   and set both `audit.chargebackHistory.enabled` and `reconciler.timerEnabled` to `true`. To download old months
   with the Azure CLI (below), also add `"04b07795-8ddb-461a-bbee-02f9e1bf7b46"` to `admin.extraAllowedClientIds`
   now, so that each stage runs once.
3. Preview, then apply, in this order:
   - Stage 2 (platform engineer): creates `chargebackDaily`.
   - Stage 3 (access administrator): grants the reconciler write access and the admin app read access to it.
   - Stage 4 (Entra administrator), only if you changed `admin.extraAllowedClientIds`.
   - Stage 5 (platform engineer): writes the reconciler and admin settings, and turns the reconciler timer on.
   - Stage 7 (platform engineer): publishes the reconciler and admin code from the updated checkout; history is
     new code, so this is needed even when Stage 7 is not asked to rerun. If a group was edited in the admin console
     since the first seed, Stage 7 stops with `seed_documents_differ`; set `stage7.keepDifferingGroups: true` to keep
     the console's version ([configuration reference](../get-started/configuration-reference-2.md#groups)).
   - Stage 8 (platform engineer): acceptance.

A stage run out of order refuses with `stage_config_changed` (its inputs changed) or `stage_dependency_changed`
(an earlier stage was rerun); the message names the stage to preview and apply next
([staged guide](../STAGED-DEPLOYMENT-GUIDE.md)). Stages 1 and 6 are not rerun.

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

  Expected: `historyOutcome` is `written` after requests have been made. No `historyOutcome` means the reconciler
  has no history settings (rerun Stages 5 and 7) or the budget part of that run did not write (`outcome` is not
  `written`; history waits for a run that does). `skipped` or `failed` gives a `historyReason`; see
    [troubleshooting](troubleshooting.md#chargeback-history). The run retries on its next tick.
- **Documents.** The template sets `stage1.cosmosPublicNetworkAccess: Disabled`, so Data Explorer in the Portal
  shows `chargebackDaily` only from a machine on the VNet.
- **Export.** Once the first month is older than the effective retention, download it as above; the JSON
  (`format=json`) lists `chargebackHistory` in `sources`.

## Cost

| Item | Estimate |
| --- | --- |
| Writes | About 5 RU per write of a document under 1 KB ([request units](https://learn.microsoft.com/en-us/azure/cosmos-db/request-units)). A document is rewritten at most once an hour while its day is open, plus one closing write: at most 25 writes a day. For a hypothetical 1,000 active people using 2 models: 1,000 × 2 × 25 × 5 = 250,000 RU a day at most |
| Price per [RU](../GLOSSARY.md) (serverless) | USD 0.25 per million RU ([retail price, East US 2](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Azure%20Cosmos%20DB%27%20and%20armRegionName%20eq%20%27eastus2%27%20and%20productName%20eq%20%27Azure%20Cosmos%20DB%20serverless%27), meter `1M RUs`, retrieved 2026-10-26). The example is at most about USD 0.06 a day, under USD 2 a month |
| Reads | Each run reads the month's stored totals, cached for 60 minutes per host. Their cost grows with the number of documents and is not estimated here; check the account's **Metrics** → Total Request Units after a week |
| Storage | Under 1 KB per document: about 62 MB a month in the example. Cosmos DB storage is USD 0.25 per GB per month ([retail price, East US 2](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Azure%20Cosmos%20DB%27%20and%20armRegionName%20eq%20%27eastus2%27%20and%20meterName%20eq%20%27Data%20Stored%27), retrieved 2026-10-25), so a year of history is about 0.75 GB, about USD 0.19 a month |
| Provisioned throughput | No per-RU charge: the writes count against the account's RU/s |

Prices are USD list prices; agreements and regions differ. The estimate comes from
[ADR-0044](../adr/0044-chargeback-history-in-cosmos.md) and is not measured.

## Turn off

Set `enabled: false` (or remove the `audit.chargebackHistory` section) and preview and apply Stages 2, 3 and 5. If
Stage 7 or 8 then refuses with `stage_dependency_changed`, rerun it. Stage 5 removes the reconciler's and admin
app's history settings: the reconciler stops writing, and the export reads Log Analytics only. The stages never
delete: the `chargebackDaily` container, its three Stage 3 role assignments and the `ccof-chargeback-history`
lease document remain until removed by hand, with the commands in
[ADR-0044, Rollback](../adr/0044-chargeback-history-in-cosmos.md#rollback).

A section that is only `{ "enabled": false }` is recorded as if it were absent; with any other key beside it, as
in the template, it is part of the Stage 2, 3 and 5 records ([configuration reference](../get-started/configuration-reference-3.md#audit)).
