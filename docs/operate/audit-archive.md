# Audit archive

A long-term copy of the gateway's request log in a storage account, separate from the Log Analytics workspace that
the chargeback reports read. Decision and limits: [ADR-0043](../adr/0043-long-term-audit-archive.md). Keys:
[configuration reference](../get-started/configuration-reference-3.md#audit-archive).

## What Stage 5 creates

With `audit.archive.enabled: true`, Stage 5 ([Staged.Audit.ps1](../../infra/staged/Staged.Audit.ps1),
[stage5-audit-archive.bicep](../../infra/staged/stage5-audit-archive.bicep)) creates or updates:

| Resource | Settings |
| --- | --- |
| Storage account `<prefix><suffix>aud` in the deployment resource group | The Stage 1 storage names with `aud` instead of `res`, for example `ccoflab4f2kq7xz3m6bwaud`. Region of the API Management service. StorageV2, HTTPS only, TLS 1.2, no blob public access, Shared Key (account-key access) disabled. Firewall: public network access Enabled, default action Deny; "Allow Azure services on the trusted services list" on, which lets Azure Monitor write; no IP or VNet rule. A storage policy may turn public network access off; see [when a policy turns public network access off](audit-archive-reading.md#when-a-policy-turns-public-network-access-off) |
| Containers `insights-logs-gatewaylogs`, `insights-logs-gatewayllmlogs` | With `immutabilityDays`: an unlocked time-based retention policy (see [Immutability](#immutability-turning-off-removal)) that still lets Azure Monitor append to the hourly blobs ("protected append writes") |
| Lifecycle rule `ccof-audit-retention` | Deletes log blobs `retentionDays` after their last write; disabled when `retentionDays` is `null` |
| Diagnostic setting `ccof-gateway-archive` on the API Management service | GatewayLogs and GatewayLlmLogs to the account. Stage 1's `ccof-gateway-logs` keeps sending them to the workspace |

With `audit.workspaceRetentionDays`, Stage 5 also sets the workspace retention (30-730 days) with
`az monitor log-analytics workspace update --retention-time`. Lowering it later removes workspace data older than
the new value ([data retention](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure)),
and the chargeback reports then cover fewer days. Raising it does not bring back data already deleted: Stage 5
prints `log retention: the workspace holds rows from <instant> ...` and the reports flag earlier periods as
`retention_truncated` until the new retention has filled
([ADR-0043](../adr/0043-long-term-audit-archive.md#raising-the-workspace-retention)). Stage 5 keeps that instant in
`evidence/stage5.retention.json`; if the state folder is lost, it reads it back from the admin app's
`ADMIN_LOG_RETENTION_HELD_FROM` or the deployed workbook. Stage 5 reads every item back; the result is in
`stage5.verify.json` under `audit`.

The preview and the apply print one line, for example (the region as API Management reports it):

```text
audit archive: ccoflab4f2kq7xz3m6bwaud in East US 2, blobs deleted after 2555 days, no immutability, Standard_LRS; diagnostic setting ccof-gateway-archive (GatewayLogs, GatewayLlmLogs); workspace retention unchanged
```

With the archive off the line is `audit archive: off; workspace retention unchanged`. After the read-back, the apply
prints the network mode it found:

```text
audit archive: ccoflab4f2kq7xz3m6bwaud network public-enabled (firewall Deny, no rules), trusted services allowed
```

or, when a policy (or you) turned public network access off,
`audit archive: ccoflab4f2kq7xz3m6bwaud network public-disabled (policy or private), trusted services allowed`.
Any other firewall state (default action Allow, no trusted-services bypass, an IP or VNet rule) stops Stage 5. The
account and setting exist
on the first Stage 5 run; blobs appear within about 90 minutes of the first request
([diagnostic settings](https://learn.microsoft.com/en-us/azure/azure-monitor/data-collection/diagnostic-settings)).

## Turn on in an existing deployment

A new deployment keeps the template's `audit.archive` block, and Stage 5 creates the archive. For a deployment that
already runs:

1. `git pull` in the checkout used for the deployment. Keep the same configuration file and its `.staged-state`
   folder.
2. Add the `audit.archive` block from [staged.config.example.json](../../infra/staged/staged.config.example.json).
3. Preview, then apply, Stage 5 (platform engineer). The archive adds roles to the Stage 5 row of the
   [staged guide's role table](../STAGED-DEPLOYMENT-GUIDE.md): Storage Account Contributor on the resource group and
   Monitoring Contributor on the API Management service; with `audit.workspaceRetentionDays`, Log Analytics
   Contributor on the workspace.
4. Nothing else is needed: the archive needs no new code, and Stage 5's recorded outputs (gateway URL, settings
   list, workbook) do not change, so Stage 7 and Stage 8 are not asked to rerun. If a later Stage 7 or Stage 8 run
   refuses with `stage_dependency_changed` (another Stage 5 change, such as the admin app), preview and apply
   Stage 7, then Stage 8 ([Get-StgStage](../../infra/staged/Staged.Common.ps1)). A Stage 5 run whose rendered
   gateway policy changed leaves the previous policy fragments in API Management; see
   [old policy fragments](troubleshooting.md#old-policy-fragments).

Stage 1 is not rerun.

## Check it works

1. After the Stage 5 apply, the evidence file `$HOME/ccof-private/.staged-state/evidence/stage5.verify.json`
   (next to the configuration file) holds an `audit` block, for example:

   ```json
   { "enabled": true, "account": "ccoflab4f2kq7xz3m6bwaud", "location": "East US 2", "network": "public-enabled",
     "retentionDays": 2555, "immutabilityDays": null, "diagnosticSetting": "ccof-gateway-archive", "workspaceRetentionDays": null }
   ```

2. In the Portal, API Management → **Monitoring** → **Diagnostic settings** lists `ccof-gateway-logs` (to the
   workspace) and `ccof-gateway-archive` (to the archive account).
3. Stage 5 does not wait for the first export. After at least one request (Stage 8 sends some) and up to about
   90 minutes, the account's storage metrics show Azure Monitor's writes: `AppendBlock` or `PutBlob` successes with
   Microsoft Entra (`OAuth`) authentication. This reads metrics only, so it needs Reader or Monitoring Reader on the
   account and no network path:

   ```powershell
   $rg = 'ccoflab-rg'
   $account = az storage account list -g $rg --query "[?ends_with(name, 'aud')].name | [0]" -o tsv
   $accountId = az storage account show -g $rg -n $account --query id -o tsv
   $m = az monitor metrics list --resource "$accountId/blobServices/default" --metric Transactions --interval PT1H --aggregation Total --offset 24h --filter "ApiName eq '*' and Authentication eq 'OAuth' and ResponseType eq 'Success'" -o json | ConvertFrom-Json
   $m.value[0].timeseries | ForEach-Object { $api = $_.metadatavalues[0].value; $_.data | Where-Object total | ForEach-Object { "$($_.timeStamp) $api $($_.total)" } }
   ```

   Expected: lines such as `10/25/2026 22:58:00 AppendBlock 4` and `… PutBlob 2` (one hour each; the time format
   follows your locale). No line means nothing was written in the last 24 hours. With [read access](audit-archive-reading.md#read-the-archive), the
   blob count is above 0:
   `(az storage blob list --account-name $account -c insights-logs-gatewaylogs --auth-mode login -o json | ConvertFrom-Json).Count`.

If nothing is written: check that `ccof-gateway-archive` sends GatewayLogs and GatewayLlmLogs to the archive
account, and that the account's **Networking** page has "Allow Azure services on the trusted services list" on.

## Read the archive

Where the hourly blobs land, how to grant read access and open a network path, and what changes when a storage
policy turns public network access off: [reading the audit archive](audit-archive-reading.md).

## Cost

USD list prices for East US 2 from the Azure Retail Prices API, retrieved 2026-10-25:
[Platform Logs Data Processed](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Azure%20Monitor%27%20and%20armRegionName%20eq%20%27eastus2%27%20and%20meterName%20eq%20%27Platform%20Logs%20Data%20Processed%27)
and [blob storage](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Storage%27%20and%20armRegionName%20eq%20%27eastus2%27%20and%20productName%20eq%20%27General%20Block%20Blob%20v2%27)
(product General Block Blob v2, Hot tier). Agreements and regions differ.

| Item | Price |
| --- | --- |
| Export of GatewayLlmLogs to storage (meter Platform Logs Data Processed). GatewayLogs is not charged ("Costs to export": No, [FAQ](https://learn.microsoft.com/en-us/azure/azure-monitor/data-collection/diagnostic-settings-faq)) | USD 0.25 per GB, once |
| Storage per GB per month, Hot, by `storageSku` | `Standard_LRS` 0.0184, `Standard_ZRS` 0.023, `Standard_GRS` 0.0368, `Standard_GZRS` 0.0414, `Standard_RAGRS` 0.046, `Standard_RAGZRS` 0.05175 |
| Write Operations, per 10,000 | LRS 0.05, ZRS 0.0625, GRS and RA-GRS 0.10, GZRS 0.1125 |
| Read Operations (reading the archive), per 10,000 | 0.004 |
| For comparison: Log Analytics retention beyond the 31 days included in the ingestion price ([data retention](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure)) | USD 0.12 per GB per month |

Example, from the lab run of 2026-10-26: the archive grew by about 6–7 KB per request across both categories
(35,306 bytes appended for 5 streamed requests, 61,203 bytes for 10; storage `Ingress` metric for `AppendBlock`).
One million requests is then about 6.5 GB: at most about USD 1.63 to export (an upper bound, since only the
GatewayLlmLogs part is charged) and about USD 0.12 per month to keep on LRS. Request size, streaming and
message logging change this figure. Azure Monitor appends to each
hourly blob many times; the number of appends is not documented. If it were once a minute per category, writes
would add about 86,400 operations, about USD 0.43, a month on LRS. Measure your own size after a day:
`(az storage blob list --account-name $account -c insights-logs-gatewaylogs --auth-mode login -o json | ConvertFrom-Json).properties.contentLength | Measure-Object -Sum`. Append blobs cannot move to Cool or Archive, so the
account stays at the Hot rate.

## Not yet verified live

These points are assumptions until a live run proves them ([UNKNOWNS](../UNKNOWNS.md), audit archive rows): that
appends continue under an immutability policy; that Stage 5 works on an existing API Management that already has
five diagnostic settings; and that the Stage 5 roles listed above are enough. Verified live on 2026-10-26: Azure
Monitor writes to the account with Shared Key disabled, also with public network access Disabled (storage metrics,
`OAuth` writes). If Stage 5 fails because the service has too many diagnostic settings, delete an
unused one: Azure allows five per resource.

## Immutability, turning off, removal

- `immutabilityDays` sets an **unlocked** policy: blobs cannot be changed or deleted, but an administrator can
  shorten or remove the policy. Locking it (`az storage container immutability-policy lock --account-name <account>
  -c <container> --if-match <etag from immutability-policy show>`) is irreversible; Stage 5 then
  leaves the locked policy as it is and checks it is at least `immutabilityDays`. A locked policy blocks deleting the
  account until every blob's retention has expired.
- Lifecycle deletion does not act on blobs in a container with an immutability policy, so with `immutabilityDays`
  the `retentionDays` rule deletes nothing: delete expired blobs yourself. This needs Storage Blob Data Contributor
  on the account and a network path ([read the archive](audit-archive-reading.md#read-the-archive)). For example, blobs last written more than `retentionDays` (here 2555)
  days ago (repeat for `insights-logs-gatewayllmlogs`; blobs still inside their immutability period are refused):

  ```powershell
  $cutoff = (Get-Date).ToUniversalTime().AddDays(-2555).ToString('yyyy-MM-ddTHH:mmZ')
  az storage blob delete-batch --account-name $account -s insights-logs-gatewaylogs --auth-mode login --if-unmodified-since $cutoff
  ```

- `enabled: false` stops nothing that exists. To stop exports:
  `az monitor diagnostic-settings delete --name ccof-gateway-archive --resource <API Management resource ID>`.
- Setting `immutabilityDays` back to `null` does not remove an existing unlocked policy. Remove it in the Portal:
  storage account → **Containers** → the container → **Access policy** → delete the time-based retention policy.
