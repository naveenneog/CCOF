# Audit archive

A long-term copy of the gateway's request log in a storage account, separate from the Log Analytics workspace that
the chargeback reports read. Decision and limits: [ADR-0043](../adr/0043-long-term-audit-archive.md). Keys:
[configuration reference](../get-started/configuration-reference-3.md#audit-archive).

## What Stage 5 creates

With `audit.archive.enabled: true`, Stage 5 ([Staged.Audit.ps1](../../infra/staged/Staged.Audit.ps1),
[stage5-audit-archive.bicep](../../infra/staged/stage5-audit-archive.bicep)) creates or updates:

| Resource | Settings |
| --- | --- |
| Storage account `<prefix><suffix>aud` in the deployment resource group | The Stage 1 storage names with `aud` instead of `res`, for example `ccoflab4f2kq7xz3m6bwaud`. Region of the API Management service. StorageV2, HTTPS only, TLS 1.2, no blob public access, Shared Key (account-key access) disabled. Firewall: default action Deny; "Allow Azure services on the trusted services list" on, which lets Azure Monitor write; no IP or VNet rule |
| Containers `insights-logs-gatewaylogs`, `insights-logs-gatewayllmlogs` | With `immutabilityDays`: an unlocked time-based retention policy (see [Immutability](#immutability-turning-off-removal)) that still lets Azure Monitor append to the hourly blobs ("protected append writes") |
| Lifecycle rule `ccof-audit-retention` | Deletes log blobs `retentionDays` after their last write; disabled when `retentionDays` is `null` |
| Diagnostic setting `ccof-gateway-archive` on the API Management service | GatewayLogs and GatewayLlmLogs to the account. Stage 1's `ccof-gateway-logs` keeps sending them to the workspace |

With `audit.workspaceRetentionDays`, Stage 5 also sets the workspace retention (30-730 days) with
`az monitor log-analytics workspace update --retention-time`. Lowering it later removes workspace data older than
the new value ([data retention](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure)),
and the chargeback reports then cover fewer days. Stage 5 reads every item back; the result is in
`stage5.verify.json` under `audit`.

The preview and the apply print one line, for example:

```text
audit archive: ccoflab4f2kq7xz3m6bwaud in eastus2, blobs deleted after 2555 days, no immutability, Standard_LRS; diagnostic setting ccof-gateway-archive (GatewayLogs, GatewayLlmLogs); workspace retention unchanged
```

With the archive off the line is `audit archive: off; workspace retention unchanged`. The account and setting exist
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
4. Stage 7 and then Stage 8 refuse with `stage_dependency_changed` because Stage 5 was rerun: preview and apply
   Stage 7, then Stage 8.

Stage 1 is not rerun.

## Check it works

1. After the Stage 5 apply, the evidence file `$HOME/ccof-private/.staged-state/evidence/stage5.verify.json`
   (next to the configuration file) holds an `audit` block, for example:

   ```json
   { "enabled": true, "account": "ccoflab4f2kq7xz3m6bwaud", "location": "eastus2", "retentionDays": 2555,
     "immutabilityDays": null, "diagnosticSetting": "ccof-gateway-archive", "workspaceRetentionDays": null }
   ```

2. In the Portal, API Management → **Monitoring** → **Diagnostic settings** lists `ccof-gateway-logs` (to the
   workspace) and `ccof-gateway-archive` (to the archive account).
3. Stage 5 does not wait for blobs. After at least one request (Stage 8 sends some) and about 90 minutes, with the
   read access below, this count is above 0:
   `az storage blob list --account-name $account -c insights-logs-gatewaylogs --auth-mode login --query "length(@)"`.

If there are still no blobs: check that `ccof-gateway-archive` sends GatewayLogs and GatewayLlmLogs to the archive
account, and that the account's **Networking** page has "Allow Azure services on the trusted services list" on.
Whether Azure Monitor writes with Shared Key disabled is not yet proven (see below).

## Where the blobs land

One blob per category and hour ([resource logs](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/resource-logs)):

```text
insights-logs-gatewaylogs/resourceId=/SUBSCRIPTIONS/00000000-0000-4000-8000-000000000002/RESOURCEGROUPS/CCOFLAB-RG/PROVIDERS/MICROSOFT.APIMANAGEMENT/SERVICE/CCOFLAB-APIM/y=2026/m=10/d=25/h=14/m=00/PT1H.json
```

Each `PT1H.json` is an append blob with one JSON record per line (`time`, `resourceId`, `category`, `operationName`,
`properties`). Records are filed by the hour they were received, so a blob can hold a few records from the previous
hour. Azure documents resource logs as not completely lossless: the archive is a retained copy of the gateway log,
not a transactional record. Prompts and completions are not logged
([stage5-api-telemetry.bicep](../../infra/staged/stage5-api-telemetry.bicep)), so the records hold metadata and token counts.

## Read the archive

Reading needs a data role on the account and a network path to it: the account's firewall admits only trusted
Azure services.

1. **Grant the reader role.** Someone with Owner, User Access Administrator or Role Based Access Control
   Administrator on the account runs:

   ```powershell
   $rg = 'ccoflab-rg'
   $account = az storage account list -g $rg --query "[?ends_with(name, 'aud')].name | [0]" -o tsv
   $accountId = az storage account show -g $rg -n $account --query id -o tsv
   az role assignment create --role "Storage Blob Data Reader" --assignee '<reader sign-in name or object ID>' --scope $accountId
   ```

   A new role assignment can take up to 10 minutes to apply
   ([troubleshoot Azure RBAC](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)).
2. **Open a network path.** For regular reading, add a private endpoint for the `blob` sub-resource in a network
   you reach ([private endpoints for Azure Storage](https://learn.microsoft.com/en-us/azure/storage/common/storage-private-endpoints));
   Stage 6 does not create one for this account. For a one-off read, add your public IP as a temporary rule. This
   needs Storage Account Contributor (or another role with `Microsoft.Storage/storageAccounts/write`) on the
   account. Cloud Shell's outbound IP changes between sessions, so look it up in the session that reads:

   ```powershell
   $myIp = Invoke-RestMethod https://api.ipify.org
   az storage account network-rule add -g $rg --account-name $account --ip-address $myIp
   ```

3. **List and download one day.** The path starts with the API Management resource ID in upper case. With
   `apim.existing`, use its resource group in `az apim list`.

   ```powershell
   $apimId = az apim list -g $rg --query "[0].id" -o tsv
   $prefix = "resourceId=$($apimId.ToUpper())/y=2026/m=10/d=25/"
   az storage blob list --account-name $account -c insights-logs-gatewaylogs --auth-mode login --prefix $prefix --query '[].name' -o tsv
   az storage blob download --account-name $account -c insights-logs-gatewaylogs --auth-mode login -n '<name from the list>' -f PT1H.json
   Get-Content PT1H.json | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object time, operationName -First 5
   ```

   `m=` appears twice in the path: first the month (`m=10`), then the minute, which is always `m=00`.
4. **Remove the IP rule:** `az storage account network-rule remove -g $rg --account-name $account --ip-address $myIp`.
   The next Stage 5 run also removes IP rules.

Property names follow the API Management tables
[ApiManagementGatewayLogs](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apimanagementgatewaylogs) and
[ApiManagementGatewayLlmLog](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apimanagementgatewayllmlog).

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

Example, assuming about 1 KB per request across both categories (an estimate, not measured): one million requests
is about 1 GB, under USD 0.25 to export and about USD 0.02 per month to keep on LRS. Azure Monitor appends to each
hourly blob many times; the number of appends is not documented. If it were once a minute per category, writes
would add about 86,400 operations, about USD 0.43, a month on LRS. Measure your own size after a day with
`--query "sum([].properties.contentLength)"` on the blob list. Append blobs cannot move to Cool or Archive, so the
account stays at the Hot rate.

## Not yet verified live

These points are assumptions until a live run proves them ([UNKNOWNS](../UNKNOWNS.md), audit archive rows): that
Azure Monitor writes to an account with Shared Key disabled; that appends continue under an immutability policy;
that Stage 5 works on an existing API Management that already has five diagnostic settings; and that the Stage 5
roles listed above are enough. If Stage 5 fails because the service has too many diagnostic settings, delete an
unused one: Azure allows five per resource.

## Immutability, turning off, removal

- `immutabilityDays` sets an **unlocked** policy: blobs cannot be changed or deleted, but an administrator can
  shorten or remove the policy. Locking it (`az storage container immutability-policy lock --account-name <account>
  -c <container> --if-match <etag from immutability-policy show>`) is irreversible; Stage 5 then
  leaves the locked policy as it is and checks it is at least `immutabilityDays`. A locked policy blocks deleting the
  account until every blob's retention has expired.
- Lifecycle deletion does not act on blobs in a container with an immutability policy, so with `immutabilityDays`
  the `retentionDays` rule deletes nothing: delete expired blobs yourself. This needs Storage Blob Data Contributor
  on the account and the network path above. For example, blobs last written more than `retentionDays` (here 2555)
  days ago (repeat for `insights-logs-gatewayllmlogs`; blobs still inside their immutability period are refused):

  ```powershell
  $cutoff = (Get-Date).ToUniversalTime().AddDays(-2555).ToString('yyyy-MM-ddTHH:mmZ')
  az storage blob delete-batch --account-name $account -s insights-logs-gatewaylogs --auth-mode login --if-unmodified-since $cutoff
  ```

- `enabled: false` stops nothing that exists. To stop exports:
  `az monitor diagnostic-settings delete --name ccof-gateway-archive --resource <API Management resource ID>`.
- Setting `immutabilityDays` back to `null` does not remove an existing unlocked policy. Remove it in the Portal:
  storage account → **Containers** → the container → **Access policy** → delete the time-based retention policy.
