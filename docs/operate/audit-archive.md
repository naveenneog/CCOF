# Audit archive

A long-term copy of the gateway's request log in a storage account, separate from the Log Analytics workspace that
the chargeback reports read. Decision and limits: [ADR-0043](../adr/0043-long-term-audit-archive.md). Keys:
[configuration reference](../get-started/configuration-reference-3.md#audit-archive).

## What Stage 5 creates

With `audit.archive.enabled: true`, Stage 5 ([Staged.Audit.ps1](../../infra/staged/Staged.Audit.ps1),
[stage5-audit-archive.bicep](../../infra/staged/stage5-audit-archive.bicep)) creates or updates:

| Resource | Settings |
| --- | --- |
| Storage account `<prefix><suffix>aud` in the deployment resource group | The Stage 1 storage names with `aud` instead of `res`, for example `ccoflab4f2kq7xz3m6bwaud`. Region of the API Management service. StorageV2, HTTPS only, TLS 1.2, no blob public access, Shared Key disabled. Firewall: default action Deny, trusted Azure services allowed, no IP or VNet rule |
| Containers `insights-logs-gatewaylogs`, `insights-logs-gatewayllmlogs` | With `immutabilityDays`: an unlocked time-based retention policy with protected append writes |
| Lifecycle rule `ccof-audit-retention` | Deletes log blobs `retentionDays` after their last write; disabled when `retentionDays` is `null` |
| Diagnostic setting `ccof-gateway-archive` on the API Management service | GatewayLogs and GatewayLlmLogs to the account. Stage 1's `ccof-gateway-logs` keeps sending them to the workspace |

With `audit.workspaceRetentionDays`, Stage 5 also sets the workspace retention (30-730 days) with
`az monitor log-analytics workspace update --retention-time`. Stage 5 reads every item back; the result is in
`stage5.verify.json` under `audit`.

The preview prints one line, for example:

```text
audit archive: ccoflab4f2kq7xz3m6bwaud in eastus2, blobs deleted after 2555 days, no immutability, Standard_LRS; diagnostic setting ccof-gateway-archive (GatewayLogs, GatewayLlmLogs); workspace retention unchanged
```

The account and setting exist on the first Stage 5 run; blobs appear within about 90 minutes of the first request
([diagnostic settings](https://learn.microsoft.com/en-us/azure/azure-monitor/data-collection/diagnostic-settings)).

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

Reading needs the Storage Blob Data Reader role on the account and a network path: a private endpoint for `blob` in
your network, or a temporary IP rule. The next Stage 5 run removes IP rules.

```powershell
$account = 'ccoflab4f2kq7xz3m6bwaud'
az storage account network-rule add -g ccoflab-rg --account-name $account --ip-address 203.0.113.7
az storage blob list --account-name $account -c insights-logs-gatewaylogs --auth-mode login `
  --prefix 'resourceId=/SUBSCRIPTIONS/00000000-0000-4000-8000-000000000002/RESOURCEGROUPS/CCOFLAB-RG/PROVIDERS/MICROSOFT.APIMANAGEMENT/SERVICE/CCOFLAB-APIM/y=2026/m=10/d=25/' `
  --query '[].name' -o tsv
az storage blob download --account-name $account -c insights-logs-gatewaylogs --auth-mode login -n '<name from the list>' -f PT1H.json
Get-Content PT1H.json | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object time, operationName -First 5
az storage account network-rule remove -g ccoflab-rg --account-name $account --ip-address 203.0.113.7
```

Property names follow the API Management tables
[ApiManagementGatewayLogs](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apimanagementgatewaylogs) and
[ApiManagementGatewayLlmLog](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apimanagementgatewayllmlog).

## Cost

| Item | Price (eastus2 retail, 2026-10-25) |
| --- | --- |
| Export of GatewayLlmLogs to storage ("Costs to export: Yes"; GatewayLogs: No) | USD 0.25 per GB, once ([FAQ](https://learn.microsoft.com/en-us/azure/azure-monitor/data-collection/diagnostic-settings-faq)) |
| Storage, Hot LRS | About USD 0.02 per GB per month |
| For comparison: Log Analytics retention beyond the included period | USD 0.12 per GB per month |

At about 1 KB per request, one million requests is about 1 GB: under USD 0.25 to export and about USD 0.02 per month
to keep. Append blobs cannot move to Cool or Archive, so the account stays at the Hot rate.

## Immutability, turning off, removal

- `immutabilityDays` sets an **unlocked** policy: blobs cannot be changed or deleted, but an administrator can
  shorten or remove the policy. Locking it (`az storage container immutability-policy lock --account-name <account>
  -c <container> --if-match <etag from immutability-policy show>`) is irreversible; Stage 5 then
  leaves the locked policy as it is and checks it is at least `immutabilityDays`. A locked policy blocks deleting the
  account until every blob's retention has expired.
- Lifecycle deletion does not act on blobs in a container with an immutability policy: with immutability, delete
  expired blobs yourself.
- `enabled: false` stops nothing that exists. To stop exports:
  `az monitor diagnostic-settings delete --name ccof-gateway-archive --resource <API Management resource ID>`.
- Setting `immutabilityDays` back to `null` does not remove an existing unlocked policy; remove it in the Portal.
