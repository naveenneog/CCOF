# Configuration file reference

The staged driver reads one JSON file. The template is [staged.config.example.json](../../infra/staged/staged.config.example.json).
The file in use is kept outside the repository, for example `$HOME/ccof-private/staged.config.json`, because it holds
tenant, subscription and Entra object IDs ([deploy, Before Stage 0](03-deploy.md#before-stage-0-get-the-code-and-write-the-configuration)).
`Read-StgConfig` in [Staged.Common.ps1](../../infra/staged/Staged.Common.ps1) checks the values on every stage, so Stage 0 reports
invalid ones before anything is created. All values on these pages are hypothetical.

**Stage 1 is create-only.** The `stage1` values cannot change after Stage 1 has run in a resource group
(`stage_config_changed`, [Staged.Common.ps1](../../infra/staged/Staged.Common.ps1)); the decisions are in the
[Stage 1 table](03-deploy.md#before-stage-0-get-the-code-and-write-the-configuration).

## Pages

| Page | Content |
| --- | --- |
| This page | Commands for the values, the choices, and a [complete sample](#complete-sample) |
| [Entra applications and groups](configuration-identity.md) | Create new and reuse existing, as JSON, with the lines Stage 4 prints |
| [Foundry, network, API Management, Cosmos DB](configuration-resources.md) | Create new and reuse existing, as JSON |
| [Reference: target, Stage 1, network, Cosmos DB, API Management, backends](configuration-reference.md) | Every key: required, template value, allowed values, reader |
| [Reference: Entra, groups, client](configuration-reference-2.md) | Same, for these sections |
| [Reference: resolver, sync, reconciler, gateway, reports](configuration-reference-3.md) | Same, for these sections |

## Choices

| Choice | Create new | Reuse existing | Keys |
| --- | --- | --- | --- |
| Entra applications | Stage 4 creates them from display names | `entra.existing.gatewayAppId`, `resolverAppId`, `adminAppId`, each on its own | [identity](configuration-identity.md#entra-applications) |
| Entra group | `groups[].groupDisplayName` with `members` | `groups[].groupId` | [identity](configuration-identity.md#groups) |
| Foundry account | `stage1.foundry.create: true` | `stage1.foundry.create: false` | [resources](configuration-resources.md#foundry-and-backends) |
| Network | `network.mode: create` with `network.create` | `network.mode: existing` or `verify` with `network.existing` | [resources](configuration-resources.md#network) |
| API Management | `stage1.approveNewPublicApimBootstrap: true` | `apim.existing` | [resources](configuration-resources.md#api-management) |
| Cosmos DB | `stage1.cosmosCapacityMode` and `stage1.cosmosLocations` (always created) | none | [resources](configuration-resources.md#cosmos-db) |

## Commands for the values

```powershell
[guid]::NewGuid()                                                    # workbook.resourceName
az account show --query "{tenant:tenantId, subscription:id}" -o json  # tenantId, subscriptionId
az group exists -n ccof-lab-rg                                       # false: the resource group name is free
az ad group show --group "Engineering" --query id -o tsv             # groups[].groupId
az ad app list --display-name "CCOF Gateway" --query "[].{name:displayName, appId:appId}" -o table
az cognitiveservices usage list -l eastus2 -o json | ConvertFrom-Json |
  Where-Object { $_.name.value -like '*claude*.Azure' } |
  Select-Object @{ n = 'quota'; e = { $_.name.value } }, currentValue, limit
```

Free quota is `limit` minus `currentValue` ([prerequisites](02-prerequisites.md#microsoft-foundry-models)). Portal paths: tenant ID
under Microsoft Entra ID > Overview; subscription under Subscriptions; application IDs under Microsoft Entra ID > App
registrations > Application (client) ID; group IDs under Microsoft Entra ID > Groups > Object Id.

`network.existing` (a customer-built network) and `network.create` (a lab network the driver builds) are alternatives; the
unused block is not read.

## Complete sample

One lab configuration: reused Entra applications and group, an existing public Foundry account, a pre-built network
(`network.mode: existing`), a new API Management instance, dollar budgets (`budget-state`) and Azure CLI sign-in. A test
runs this block through `Read-StgConfig` ([tests/docs-reader-pages.test.ts](../../tests/docs-reader-pages.test.ts)), so it
stays valid. Stage 0 additionally needs the account, its deployments and the applications to exist.

```json
{
  "schemaVersion": 1,
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "subscriptionId": "00000000-0000-4000-8000-000000000002",
  "resourceGroup": "ccof-lab-rg",
  "location": "eastus2",
  "tags": { "workload": "claude-code-on-foundry", "deployment": "staged" },
  "stage1": {
    "prefix": "ccoflab",
    "includeAdmin": true,
    "cosmosCapacityMode": "serverless",
    "cosmosLocations": [{ "locationName": "eastus2", "isZoneRedundant": false }],
    "cosmosConsistency": { "defaultConsistencyLevel": "Session" },
    "cosmosPublicNetworkAccess": "Disabled",
    "storagePublicNetworkAccess": "Disabled",
    "functionsPublicNetworkAccess": "Enabled",
    "storageSku": "Standard_LRS",
    "retentionInDays": 30,
    "maximumInstanceCount": 40,
    "instanceMemoryMB": 2048,
    "approveNewPublicApimBootstrap": true,
    "apimPublisherEmail": "alex.admin@contoso.com",
    "apimPublisherName": "CCOF lab",
    "apimSku": "StandardV2",
    "apimUnits": 1,
    "foundry": { "create": false }
  },
  "network": {
    "mode": "existing",
    "existing": {
      "functionsSubnetId": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/virtualNetworks/ccoflab-vnet/subnets/snet-functions",
      "privateEndpointSubnetId": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/virtualNetworks/ccoflab-vnet/subnets/snet-private-endpoints",
      "apimSubnetId": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/virtualNetworks/ccoflab-vnet/subnets/snet-apim",
      "privateDnsZoneIds": {
        "cosmos": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.documents.azure.com",
        "blob": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net"
      }
    }
  },
  "cosmos": {
    "databaseName": "ccof",
    "capacityMode": "serverless",
    "roleNames": {
      "syncWriter": "ccof sync entitlement writer",
      "reconcilerWriter": "ccof reconciler budget writer",
      "projectWriter": "ccof onboarding project writer",
      "adminEditor": "ccof admin project editor"
    }
  },
  "apim": {
    "existing": null,
    "apiId": "claude-messages",
    "apiPath": "anthropic",
    "apiDisplayName": "Claude Messages (staged)"
  },
  "backends": [
    {
      "id": "foundry-shared",
      "subscriptionId": "00000000-0000-4000-8000-000000000002",
      "resourceGroup": "ai-shared-rg",
      "accountName": "contoso-foundry",
      "url": "https://contoso-foundry.services.ai.azure.com/anthropic",
      "resource": "https://cognitiveservices.azure.com",
      "deploymentInferenceGeo": { "claude-haiku-5-5": "us", "claude-sonnet-5-5": "us" },
      "assignCognitiveServicesUser": true,
      "privateEndpoint": false
    }
  ],
  "entra": {
    "gatewayAppDisplayName": "CCOF Gateway",
    "resolverAppDisplayName": "CCOF Resolver API",
    "adminAppDisplayName": "CCOF Admin",
    "allowAzureCliClient": true,
    "adminEditors": ["@me"],
    "adminReaders": [],
    "existing": {
      "gatewayAppId": "00000000-0000-4000-8000-000000000004",
      "resolverAppId": "00000000-0000-4000-8000-000000000005",
      "adminAppId": "00000000-0000-4000-8000-000000000006"
    }
  },
  "groups": [
    {
      "kind": "group",
      "displayName": "Engineering",
      "backendId": "foundry-shared",
      "priority": 100,
      "chargebackId": "CC-ENG-1001",
      "budget": {
        "mode": "autoScale",
        "perUser": { "amount": 100, "currency": "USD", "period": "monthly" },
        "groupCap": null
      },
      "restrictedFamiliesApproved": false,
      "familyPolicy": {
        "aggregateLimits": {
          "person": { "tokensPerMinute": 200000, "tokenQuota": 500000, "tokenQuotaPeriod": "Daily" },
          "group": { "tokensPerMinute": null, "tokenQuota": 2000000, "tokenQuotaPeriod": "Daily" }
        },
        "families": {
          "haiku": {
            "models": ["claude-haiku-5-5"],
            "person": { "tokensPerMinute": null, "tokenQuota": null, "tokenQuotaPeriod": null },
            "group": { "tokensPerMinute": null, "tokenQuota": null, "tokenQuotaPeriod": null }
          },
          "sonnet": {
            "models": ["claude-sonnet-5-5"],
            "person": { "tokensPerMinute": null, "tokenQuota": null, "tokenQuotaPeriod": null },
            "group": { "tokensPerMinute": null, "tokenQuota": null, "tokenQuotaPeriod": null }
          }
        }
      },
      "surfaces": ["code"],
      "cacheProfile": { "expectedCacheReadPercent": 85, "basis": "suggested" },
      "groupId": "00000000-0000-4000-8000-000000000007"
    }
  ],
  "client": {
    "group": "00000000-0000-4000-8000-000000000007",
    "signInMethod": "azure-cli",
    "models": {
      "default": "claude-sonnet-5-5",
      "sonnet": "claude-sonnet-5-5",
      "haiku": "claude-haiku-5-5",
      "opus": "claude-sonnet-5-5"
    }
  },
  "resolver": {
    "budgetEnforcement": "budget-state",
    "requireCompleteUsage": false,
    "cosmosRequestTimeoutMs": 2000,
    "cosmosRetryAttempts": 2,
    "cosmosRetryMaxWaitSeconds": 2,
    "requestDeadlineMs": 4000,
    "usageGroupTotals": false
  },
  "sync": {
    "mode": "delegated-snapshot",
    "schedule": "0 */1 * * * *",
    "leaseSeconds": 300,
    "maxRemovalsPerRun": 5,
    "maxRemovalFraction": "0.1",
    "memberTypes": "user",
    "graphMaxRetries": 3,
    "graphMaxRetryAfterSeconds": 30,
    "graphTimeoutSeconds": 30,
    "writeMode": "apply"
  },
  "syncTimerEnabled": false,
  "reconciler": {
    "timerEnabled": true,
    "schedule": "0 */2 * * * *",
    "validitySeconds": 600,
    "leaseSeconds": 300,
    "ledgerTimeoutSeconds": 60,
    "ledgerMaxRows": 100000,
    "maxStates": 10000,
    "writeConcurrency": 8,
    "logAnalyticsEndpoint": "https://api.loganalytics.io",
    "budgetGuard": { "warnPercent": 80, "overshootPercent": 5, "projectionMinutes": 5 }
  },
  "budgetState": { "graceSeconds": 900, "hardLimitSeconds": 3600 },
  "gateway": {
    "configurationId": "ccof-staged-gateway-1",
    "surfaceClients": [],
    "admission": {
      "perPerson": { "calls": 120, "renewalPeriodSeconds": 60 },
      "resolverMisses": { "calls": 200, "renewalPeriodSeconds": 1, "maxConcurrent": 100 },
      "usage": { "calls": 10, "renewalPeriodSeconds": 60 }
    },
    "resolverTimeoutSeconds": 10,
    "projectHeaderName": "x-ccof-project",
    "keyVersion": 1,
    "entitlementCache": {
      "cachingType": "internal",
      "allowTtlSeconds": 120,
      "refusalTtlSeconds": 30,
      "lastKnownGoodGraceSeconds": 3600,
      "refreshBackoffSeconds": 30,
      "unavailableRetryAfterSeconds": 5
    },
    "tokenLimits": {
      "estimatePromptTokens": false,
      "headers": {
        "personRemainingQuota": "x-ccof-person-quota-remaining",
        "personRemainingTokens": "x-ccof-person-tokens-remaining",
        "groupRemainingQuota": "x-ccof-group-quota-remaining",
        "groupRemainingTokens": "x-ccof-group-tokens-remaining",
        "tokensConsumed": "x-ccof-tokens-consumed"
      }
    },
    "defaultAnthropicVersion": "2023-06-01"
  },
  "rateCard": { "path": "config/rate-card.json", "contractSchedulePath": "config/contract-schedule.json" },
  "workbook": {
    "resourceName": "00000000-0000-4000-8000-000000000008",
    "displayName": "Claude gateway chargeback (staged)",
    "readerPrincipalIds": [],
    "settings": {
      "defaultProjectId": "*",
      "maxRows": 1000,
      "topUsers": 25,
      "maxQueryDays": 62,
      "budgetLookbackDays": 31
    }
  },
  "admin": {
    "v3Enabled": true,
    "extraAllowedClientIds": [],
    "groupSearchEnabled": false,
    "userNamesEnabled": false
  },
  "acceptance": {
    "allowed": [{ "model": "claude-haiku-5-5" }],
    "denied": [
      {
        "model": "claude-opus-5-5",
        "expectedStatus": 403,
        "reason": "opus is not in the group's model families"
      }
    ]
  },
  "sharedResourceGroup": false
}
```
