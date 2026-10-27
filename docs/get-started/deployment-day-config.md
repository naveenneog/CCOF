# Fill in your configuration

Private `staged.config.json`: replace hypothetical values; keep `.staged-state`.
**Merge objects; replace arrays; never duplicate keys.**
[Checklist](deployment-day.md) · [reference](configuration.md).

## Region — where may resources and prompts run?

Resource group/Foundry → Overview; `az cognitiveservices model list -l eastus2`.
**Central India/East US 2** or **approved pair**:

```json
{"location":"centralindia","stage1":{"foundry":{"location":"eastus2"}}}
```
```json
{"location":"eastus2","stage1":{"foundry":{"location":"eastus2"}}}
```

Claude requires approved inference outside India. [Regions](region-and-failover.md).

## API Management — new or existing?

**New:** approved publisher/bootstrap:

```json
{"stage1":{"approveNewPublicApimBootstrap":true,"apimPublisherEmail":"alex.admin@contoso.com","apimPublisherName":"Contoso AI","apimSku":"StandardV2","apimUnits":4},"apim":{"existing":null}}
```

**Existing:** IDs: APIM → JSON view. Owner manages HA/network; **remove `ha.apim`**:

```json
{"stage1":{"approveNewPublicApimBootstrap":false},"apim":{"existing":{"name":"contoso-apim","subscriptionId":"00000000-0000-4000-8000-000000000002","resourceGroup":"gateway-rg"}}}
```

Keep `apim` fields. [Approvals](existing-api-management.md).

## Network — who builds private paths?

**Verify (production):** owner builds paths. **Existing:** CCOF adds endpoints/integrations.
IDs: Virtual networks → Subnets / Private DNS zones → JSON view:

```json
{"network":{"mode":"verify"}}
```
```json
{"network":{"mode":"existing"}}
```

**Create (lab):** replace `network`; approved non-overlapping CIDRs:

```json
{"network":{"mode":"create","create":{"vnetName":"ccofday-vnet","addressSpace":"10.64.0.0/16","apimNsgName":"ccofday-apim-nsg","subnets":{"apim":{"name":"snet-apim","prefix":"10.64.1.0/24"},"privateEndpoints":{"name":"snet-private-endpoints","prefix":"10.64.2.0/24"},"functions":{"name":"snet-functions","prefix":"10.64.3.0/24"}}}}}
```

**Workstation on the VNet?** Decide before Stage 1 (create-only). Private SCM/admin:

```json
{"stage1":{"functionsPublicNetworkAccess":"Disabled"}}
```

Approved public **lab** only (Functions/SCM/admin; still authenticated):

```json
{"stage1":{"functionsPublicNetworkAccess":"Enabled"}}
```

`create` does not connect your workstation. Keep backends private.
[Network](configuration-resources.md#network).

## Cosmos — zonal capacity granted or not?

<https://aka.ms/cosmosdbquota> approval. **Granted:**

```json
{"stage1":{"cosmosLocations":[{"locationName":"centralindia","isZoneRedundant":true},{"locationName":"southindia","isZoneRedundant":false}]}}
```

**Not granted:** owner-approved nonzonal alternative before successful Stage 1:

```json
{"stage1":{"cosmosLocations":[{"locationName":"centralindia","isZoneRedundant":false},{"locationName":"southindia","isZoneRedundant":false}]}}
```

South India has no zones. [Safe recovery](high-availability.md).

## HA — zone protection on or off?

**On/off:** Stage 0 checks support; owners approve capacity/design; Cosmos separate:

```json
{"ha":{"apim":{"zoneRedundant":true},"functions":{"zoneRedundant":true}},"stage1":{"apimSku":"StandardV2","apimUnits":4,"storageSku":"Standard_ZRS"}}
```
```json
{"ha":{"apim":{"zoneRedundant":false},"functions":{"zoneRedundant":false}},"stage1":{"apimUnits":1,"storageSku":"Standard_LRS"}}
```

Existing APIM: omit `ha.apim`. [Sizing](../operate/sizing.md) · [costs/limits](high-availability.md).
Central India outage stops the gateway.

## Standby — another Foundry endpoint?

**Yes:** example's `backends[0].failover`/`circuitBreaker`; source: Foundry → Overview/Deployments.
Prefer another subscription/region, same tenant; approve quota/grants/network.
**No:** remove both fields. Same-subscription quota is shared.
[Creating standby instead](foundry-failover.md#2-add-the-configuration).

## Audit — raw archive, daily totals, both or neither?

Compliance/cost owner: **both on**:

```json
{"audit":{"archive":{"enabled":true,"retentionDays":2555,"immutabilityDays":null,"storageSku":"Standard_ZRS"},"chargebackHistory":{"enabled":true,"closeAfterDays":2,"ttlDays":null}},"reconciler":{"timerEnabled":true}}
```

**Off / archive only / totals only**:

```json
{"audit":{"archive":{"enabled":false},"chargebackHistory":{"enabled":false}}}
```
```json
{"audit":{"archive":{"enabled":true},"chargebackHistory":{"enabled":false}}}
```
```json
{"audit":{"archive":{"enabled":false},"chargebackHistory":{"enabled":true}},"reconciler":{"timerEnabled":true}}
```

Keep retention; budgets need the reconciler.
[Archive](../operate/audit-archive.md) · [history](../operate/chargeback-history.md).

## Groups — which teams, models and budgets?

Entra → Groups → **Object ID**; approve budget/models/cost code.
One: remove second; more: add unique IDs. **Automatic** (large groups) or **snapshot** (pilot/approved transport):

```json
{"sync":{"mode":"application-permission"},"syncTimerEnabled":true}
```
```json
{"sync":{"mode":"delegated-snapshot"},"syncTimerEnabled":false}
```

[Policies/Graph consent](configuration-identity.md) · [all-group snapshots](../operate/users-and-groups.md).

## Developer sign-in — Windows only or also macOS?

**Azure CLI (both)** or **MSAL (Windows)**. Approved IDs: Entra → App registrations → Overview.

```json
{"client":{"signInMethod":"azure-cli"},"entra":{"allowAzureCliClient":true}}
```
```json
{"client":{"signInMethod":"msal"}}
```

[Developer setup](05-developer-setup.md).

## Complete HA example

Replace IDs/names/attestation/budgets/network IDs. Primary: new East US 2; standby: existing Central US.
Capacities are **not enterprise sizing**. Workbook ID: `[guid]::NewGuid()`.

```json
{
  "schemaVersion":1,
  "tenantId":"00000000-0000-4000-8000-000000000001",
  "subscriptionId":"00000000-0000-4000-8000-000000000002",
  "resourceGroup":"ccof-day-rg","location":"centralindia",
  "tags":{"workload":"claude-code-on-foundry","deployment":"staged"},
  "ha":{"apim":{"zoneRedundant":true},"functions":{"zoneRedundant":true}},
  "stage1":{
    "prefix":"ccofday","includeAdmin":true,
    "cosmosCapacityMode":"provisioned",
    "cosmosLocations":[{"locationName":"centralindia","isZoneRedundant":true},{"locationName":"southindia","isZoneRedundant":false}],
    "cosmosConsistency":{"defaultConsistencyLevel":"Session"},
    "cosmosPublicNetworkAccess":"Disabled","storagePublicNetworkAccess":"Disabled","functionsPublicNetworkAccess":"Disabled",
    "storageSku":"Standard_ZRS","retentionInDays":30,"maximumInstanceCount":40,"instanceMemoryMB":2048,
    "approveNewPublicApimBootstrap":true,"apimPublisherEmail":"alex.admin@contoso.com","apimPublisherName":"Contoso AI",
    "apimSku":"StandardV2","apimUnits":4,
    "foundry":{"create":true,"accountName":"contosodayprimary","location":"eastus2","publicNetworkAccess":"Disabled",
      "deployments":[
        {"name":"claude-haiku-5-5","model":"claude-haiku-5-5","version":"2","sku":"GlobalStandard","capacity":10},
        {"name":"claude-sonnet-5-5","model":"claude-sonnet-5-5","version":"2","sku":"GlobalStandard","capacity":10}
      ],
      "modelProviderData":{"organizationName":"Contoso Research","countryCode":"IN","industry":"technology"}
    }
  },
  "network":{"mode":"verify","existing":{
    "functionsSubnetId":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/day-net-rg/providers/Microsoft.Network/virtualNetworks/day-vnet/subnets/snet-functions",
    "privateEndpointSubnetId":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/day-net-rg/providers/Microsoft.Network/virtualNetworks/day-vnet/subnets/snet-private-endpoints",
    "apimSubnetId":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/day-net-rg/providers/Microsoft.Network/virtualNetworks/day-vnet/subnets/snet-apim",
    "privateDnsZoneIds":{
      "cosmos":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/day-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.documents.azure.com",
      "blob":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/day-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net",
      "foundry":{
        "cognitiveServices":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/day-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.cognitiveservices.azure.com",
        "openAi":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/day-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.openai.azure.com",
        "aiServices":"/subscriptions/00000000-0000-4000-8000-000000000002/resourceGroups/day-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.services.ai.azure.com"
      }
    }
  }},
  "cosmos":{"databaseName":"ccof","capacityMode":"provisioned-autoscale","autoscaleMaxThroughput":1000,
    "roleNames":{"syncWriter":"ccof sync entitlement writer","reconcilerWriter":"ccof reconciler budget writer","projectWriter":"ccof onboarding project writer","adminEditor":"ccof admin project editor"}},
  "apim":{"existing":null,"apiId":"claude-messages","apiPath":"anthropic","apiDisplayName":"Claude Messages"},
  "backends":[{
    "id":"foundry-main","subscriptionId":"00000000-0000-4000-8000-000000000002","resourceGroup":"ccof-day-rg",
    "accountName":"contosodayprimary","url":"https://contosodayprimary.services.ai.azure.com/anthropic",
    "resource":"https://cognitiveservices.azure.com","deploymentInferenceGeo":{"claude-haiku-5-5":"global","claude-sonnet-5-5":"global"},
    "assignCognitiveServicesUser":true,"privateEndpoint":true,
    "failover":{"subscriptionId":"00000000-0000-4000-8000-000000000003","resourceGroup":"day-standby-rg","accountName":"contosodaystandby",
      "url":"https://contosodaystandby.services.ai.azure.com/anthropic","privateEndpoint":true,
      "deploymentInferenceGeo":{"claude-haiku-5-5":"global","claude-sonnet-5-5":"global"}},
    "circuitBreaker":{"count":1,"intervalSeconds":60,"tripDurationSeconds":60,"acceptRetryAfter":true,"statusCodeRanges":[{"min":429,"max":429},{"min":500,"max":599}]}
  }],
  "entra":{"gatewayAppDisplayName":"CCOF Day Gateway","resolverAppDisplayName":"CCOF Day Resolver","adminAppDisplayName":"CCOF Day Admin",
    "allowAzureCliClient":true,"adminEditors":["@me"],"adminReaders":[],
    "existing":{"gatewayAppId":"00000000-0000-4000-8000-000000000004","resolverAppId":"00000000-0000-4000-8000-000000000005","adminAppId":"00000000-0000-4000-8000-000000000006"}},
  "groups":[
    {"kind":"group","groupId":"00000000-0000-4000-8000-000000000007","displayName":"Engineering","backendId":"foundry-main","priority":100,"chargebackId":"CC-ENG-1001",
      "budget":{"mode":"autoScale","perUser":{"amount":100,"currency":"USD","period":"monthly"},"groupCap":null},
      "restrictedFamiliesApproved":false,"surfaces":["code"],"cacheProfile":{"expectedCacheReadPercent":85,"basis":"suggested"},
      "familyPolicy":{"aggregateLimits":{"person":{"tokensPerMinute":200000,"tokenQuota":500000,"tokenQuotaPeriod":"Daily"},"group":{"tokensPerMinute":null,"tokenQuota":2000000,"tokenQuotaPeriod":"Daily"}},
        "families":{"haiku":{"models":["claude-haiku-5-5"],"person":{"tokensPerMinute":null,"tokenQuota":null,"tokenQuotaPeriod":null},"group":{"tokensPerMinute":null,"tokenQuota":null,"tokenQuotaPeriod":null}},
          "sonnet":{"models":["claude-sonnet-5-5"],"person":{"tokensPerMinute":null,"tokenQuota":null,"tokenQuotaPeriod":null},"group":{"tokensPerMinute":null,"tokenQuota":null,"tokenQuotaPeriod":null}}}}},
    {"kind":"group","groupId":"00000000-0000-4000-8000-000000000009","displayName":"Data Science","backendId":"foundry-main","priority":200,"chargebackId":"CC-DS-2001",
      "budget":{"mode":"autoScale","perUser":{"amount":50,"currency":"USD","period":"monthly"},"groupCap":null},
      "restrictedFamiliesApproved":false,"surfaces":["code"],"cacheProfile":{"expectedCacheReadPercent":85,"basis":"suggested"},
      "familyPolicy":{"aggregateLimits":{"person":{"tokensPerMinute":200000,"tokenQuota":500000,"tokenQuotaPeriod":"Daily"},"group":{"tokensPerMinute":null,"tokenQuota":2000000,"tokenQuotaPeriod":"Daily"}},
        "families":{"haiku":{"models":["claude-haiku-5-5"],"person":{"tokensPerMinute":null,"tokenQuota":null,"tokenQuotaPeriod":null},"group":{"tokensPerMinute":null,"tokenQuota":null,"tokenQuotaPeriod":null}}}}}
  ],
  "client":{"group":"00000000-0000-4000-8000-000000000007","signInMethod":"azure-cli","models":{"default":"claude-sonnet-5-5","sonnet":"claude-sonnet-5-5","haiku":"claude-haiku-5-5","opus":"claude-sonnet-5-5"}},
  "resolver":{"budgetEnforcement":"budget-state","requireCompleteUsage":false,"cosmosRequestTimeoutMs":2000,"cosmosRetryAttempts":2,"cosmosRetryMaxWaitSeconds":2,"requestDeadlineMs":4000,"usageGroupTotals":false},
  "sync":{"mode":"application-permission","schedule":"0 */1 * * * *","leaseSeconds":300,"maxRemovalsPerRun":5,"maxRemovalFraction":"0.1","memberTypes":"user","graphMaxRetries":3,"graphMaxRetryAfterSeconds":30,"graphTimeoutSeconds":30,"writeMode":"apply"},
  "syncTimerEnabled":true,
  "reconciler":{"timerEnabled":true,"schedule":"0 */2 * * * *","validitySeconds":600,"leaseSeconds":300,"ledgerTimeoutSeconds":60,"ledgerMaxRows":500000,"maxStates":100000,"writeConcurrency":8,"logAnalyticsEndpoint":"https://api.loganalytics.io","budgetGuard":{"warnPercent":80,"overshootPercent":5,"projectionMinutes":5}},
  "budgetState":{"graceSeconds":900,"hardLimitSeconds":3600},
  "gateway":{"configurationId":"ccof-day-gateway","surfaceClients":[],"admission":{"perPerson":{"calls":120,"renewalPeriodSeconds":60},"resolverMisses":{"calls":200,"renewalPeriodSeconds":1,"maxConcurrent":100},"usage":{"calls":10,"renewalPeriodSeconds":60}},
    "resolverTimeoutSeconds":10,"projectHeaderName":"x-ccof-project","keyVersion":1,"entitlementCache":{"cachingType":"internal","allowTtlSeconds":120,"refusalTtlSeconds":30,"lastKnownGoodGraceSeconds":3600,"refreshBackoffSeconds":30,"unavailableRetryAfterSeconds":5},
    "tokenLimits":{"estimatePromptTokens":false,"headers":{"personRemainingQuota":"x-ccof-person-quota-remaining","personRemainingTokens":"x-ccof-person-tokens-remaining","groupRemainingQuota":"x-ccof-group-quota-remaining","groupRemainingTokens":"x-ccof-group-tokens-remaining","tokensConsumed":"x-ccof-tokens-consumed"}},"defaultAnthropicVersion":"2023-06-01"},
  "rateCard":{"path":"config/rate-card.json","contractSchedulePath":"config/contract-schedule.json"},
  "workbook":{"resourceName":"00000000-0000-4000-8000-000000000008","displayName":"Claude gateway chargeback","readerPrincipalIds":[],"settings":{"defaultProjectId":"*","maxRows":1000,"topUsers":25,"maxQueryDays":62,"budgetLookbackDays":31}},
  "admin":{"v3Enabled":true,"extraAllowedClientIds":["04b07795-8ddb-461a-bbee-02f9e1bf7b46"],"groupSearchEnabled":false,"userNamesEnabled":false},
  "audit":{"archive":{"enabled":true,"retentionDays":2555,"immutabilityDays":null,"storageSku":"Standard_ZRS"},"chargebackHistory":{"enabled":true,"closeAfterDays":2,"ttlDays":null}},
  "acceptance":{"expectedGroup":"00000000-0000-4000-8000-000000000007","allowed":[{"model":"claude-haiku-5-5"}],"denied":[{"model":"claude-opus-5-5","expectedStatus":403,"reason":"not admitted"}]},
  "sharedResourceGroup":false
}
```
