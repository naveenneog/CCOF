# Reading the audit archive

For the [audit archive](audit-archive.md) that Stage 5 creates.

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

## When a policy turns public network access off

Some tenants assign an Azure Policy with the `modify` effect that sets `publicNetworkAccess: Disabled` on every new
storage account, seconds after Stage 5 creates it. Stage 5 still deploys public network access Enabled, since many
tenants have no such policy, and accepts the changed account in its read-back (`network public-disabled`), as long as
the default action is Deny, the trusted-services bypass is on and there is no IP or VNet rule. What this means:

- **The archive still receives logs.** In a live run (2026-10-26) with public network access Disabled, the
  trusted-services bypass on and Shared Key disabled, the account's metrics showed `AppendBlock` and `PutBlob`
  successes with `OAuth` authentication within the hour (about 61 KB appended). Use the metrics check in
  [Check it works](audit-archive.md#check-it-works).
- **Reading needs a private endpoint**, or a machine in a network the account allows. A temporary IP rule does not
  open a path: with public network access Disabled, traffic is allowed only through a private endpoint
  ([default access rule](https://learn.microsoft.com/en-us/azure/storage/common/storage-network-security-set-default-access)), and `az storage blob list`
  answers that the request may be blocked by network rules. Stage 6 does not create a private endpoint for this
  account.
- **The policy's own exclusions** decide whether an account is changed, and are the policy owner's to set. The
  policy seen live (a custom management-group definition, `StorageAccount_PublicNetwork_Modify`) skips accounts
  whose resource or resource group carries a tag (by default `SecurityControl` = `Ignore`), and accounts governed
  by a Network Security Perimeter (`publicNetworkAccess: SecuredByPerimeter`). Stage 5 does not add such a tag and
  refuses `SecuredByPerimeter`; ask the policy owner before changing either. Exemptions are made on the policy
  assignment, by its owner.

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
   Stage 6 does not create one for this account. For a one-off read, add your public IP as a temporary rule (this
   does not work when [a policy turned public network access off](#when-a-policy-turns-public-network-access-off)). This
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
