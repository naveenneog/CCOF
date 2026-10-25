# Configuration: Foundry, network, API Management and Cosmos DB

Part of the [configuration reference](configuration.md). Each resource is created by the stages or reused; both forms
are shown as complete JSON fragments of the configuration root. All values are hypothetical. The checks are in
`Read-StgConfig` ([Staged.Common.ps1](../../infra/staged/Staged.Common.ps1)) and, against Azure, in Stage 0
([Staged.Resources.ps1](../../infra/staged/Staged.Resources.ps1)).

## Foundry and backends

`backends[]` lists the Foundry accounts the gateway calls. `groups[].backendId` names one by `backends[].id`.

**Create new** (Stage 1 creates the account and the deployments). `stage1.foundry.accountName` equals
`backends[].accountName`; `deploymentInferenceGeo` keys equal the deployment names (`global` for `GlobalStandard`,
`us` for `DataZoneStandard`). A new account with `publicNetworkAccess: Disabled` in `create` or `existing` network mode
needs `privateEndpoint: true`; Stage 0 refuses the mismatch ([ADR-0042](../adr/0042-stage0-refusals-and-stage6-recovery.md)).

```json
"stage1": {
  "foundry": {
    "create": true,
    "accountName": "ccoflabfoundry1025",
    "publicNetworkAccess": "Disabled",
    "deployments": [
      { "name": "claude-haiku-5-5", "model": "claude-haiku-5-5", "version": "2", "sku": "DataZoneStandard", "capacity": 7 }
    ],
    "modelProviderData": { "organizationName": "Contoso Ltd", "countryCode": "US", "industry": "technology" }
  }
},
"backends": [
  {
    "id": "foundry-eastus2",
    "subscriptionId": "00000000-0000-4000-8000-000000000002",
    "resourceGroup": "ccof-lab-rg",
    "accountName": "ccoflabfoundry1025",
    "url": "https://ccoflabfoundry1025.services.ai.azure.com/anthropic",
    "resource": "https://cognitiveservices.azure.com",
    "deploymentInferenceGeo": { "claude-haiku-5-5": "us" },
    "assignCognitiveServicesUser": true,
    "privateEndpoint": true
  }
]
```

Stage 0 prints the backend as `"account": "ccoflabfoundry1025 (created in Stage 1)"` and checks that each model, version
and `sku` is offered in the region. `modelProviderData` needs a real `organizationName` (a `REPLACE` value is refused).

**Reuse existing** (an account that already has the deployments). `stage1.foundry.create` is `false`; the other
`stage1.foundry` keys are not read.

```json
"stage1": { "foundry": { "create": false } },
"backends": [
  {
    "id": "foundry-shared",
    "subscriptionId": "00000000-0000-4000-8000-000000000002",
    "resourceGroup": "ai-shared-rg",
    "accountName": "contoso-foundry",
    "url": "https://contoso-foundry.services.ai.azure.com/anthropic",
    "resource": "https://cognitiveservices.azure.com",
    "deploymentInferenceGeo": { "claude-sonnet-5-5": "us" },
    "assignCognitiveServicesUser": true,
    "privateEndpoint": false
  }
]
```

- Stage 0 reads the account and its deployments. A `deploymentInferenceGeo` key that is not a deployment name stops it
  with `backend foundry-shared lacks deployments: <names>`.
- `privateEndpoint: true` makes Stage 6 create a private endpoint, only for an account in the deployment subscription
  and resource group; other combinations are refused (`Read-StgConfig`). A public account uses `false`; a private account
  elsewhere needs a path from the VNet built by its owner.
- Stage 3 assigns Cognitive Services User on the account to the API Management identity when
  `assignCognitiveServicesUser` is not `false`; the operator needs role-assignment rights on that account
  ([Learn](https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal)).

**Several backends**: one `backends[]` entry per account, each with its own `id`; each group picks one with
`groups[].backendId`. Entries from both snippets above can be listed together.

## Network

`network.mode` selects who builds the network ([stage6-network.bicep](../../infra/staged/stage6-network.bicep),
[network](../NETWORK.md)).

**Create new** (`create`, lab only): the driver also creates the VNet and the zones.

```json
"network": {
  "mode": "create",
  "create": {
    "vnetName": "ccoflab-vnet",
    "addressSpace": "10.64.0.0/16",
    "apimNsgName": "ccoflab-nsg-apim",
    "subnets": {
      "apim": { "name": "snet-apim", "prefix": "10.64.1.0/24" },
      "privateEndpoints": { "name": "snet-private-endpoints", "prefix": "10.64.2.0/24" },
      "functions": { "name": "snet-functions", "prefix": "10.64.3.0/24" }
    }
  }
}
```

**Reuse existing** (`existing`): the driver creates private endpoints and VNet integrations in the given subnets of a
VNet built beforehand. Zone IDs are full Private DNS zone resource IDs. `privateDnsZoneIds.cosmos` and `.blob` are
always required; the three `foundry` zones (`privatelink.cognitiveservices.azure.com`, `privatelink.openai.azure.com`,
`privatelink.services.ai.azure.com`) only when a backend has `privateEndpoint: true`.

```json
"network": {
  "mode": "existing",
  "existing": {
    "functionsSubnetId": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/virtualNetworks/ccoflab-vnet/subnets/snet-functions",
    "privateEndpointSubnetId": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/virtualNetworks/ccoflab-vnet/subnets/snet-private-endpoints",
    "apimSubnetId": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/virtualNetworks/ccoflab-vnet/subnets/snet-apim",
    "privateDnsZoneIds": {
      "cosmos": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.documents.azure.com",
      "blob": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net",
      "foundry": {
        "cognitiveServices": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.cognitiveservices.azure.com",
        "openAi": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.openai.azure.com",
        "aiServices": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.services.ai.azure.com"
      }
    }
  }
}
```

`apimSubnetId` is read for a new Standard v2 API Management instance. Building the VNet, subnets, NSG and the Cosmos and
Blob zones for this mode: [infra/prereqs/network.bicep](../../infra/prereqs/network.bicep) (it creates no Foundry zones):

```powershell
az group create -n ccoflab-net-rg -l eastus2
az deployment group create -g ccoflab-net-rg -f infra/prereqs/network.bicep -p parameters.json
```

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "location": { "value": "eastus2" },
    "tags": { "value": { "workload": "claude-code-on-foundry" } },
    "vnetName": { "value": "ccoflab-vnet" },
    "addressSpace": { "value": "10.64.0.0/16" },
    "apimNsgName": { "value": "ccoflab-nsg-apim" },
    "subnets": { "value": {
      "apim": { "name": "snet-apim", "prefix": "10.64.1.0/24" },
      "privateEndpoints": { "name": "snet-private-endpoints", "prefix": "10.64.2.0/24" },
      "functions": { "name": "snet-functions", "prefix": "10.64.3.0/24" }
    } }
  }
}
```

The module outputs `functionsSubnetId`, `privateEndpointSubnetId`, `apimSubnetId`, `cosmosDnsZoneId` and `blobDnsZoneId`,
which are the values for the keys above. Run it once: it owns the subnet list.

**Existing, checked only** (`verify`, the default): the customer builds everything, including private endpoints and
integrations; Stage 6 only reads them. The three subnet IDs are required (`apimSubnetId` for a new Standard v2 instance),
all in one VNet; zone IDs are not read.

```json
"network": {
  "mode": "verify",
  "existing": {
    "functionsSubnetId": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/virtualNetworks/ccoflab-vnet/subnets/snet-functions",
    "privateEndpointSubnetId": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/virtualNetworks/ccoflab-vnet/subnets/snet-private-endpoints",
    "apimSubnetId": "/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/ccoflab-net-rg/providers/Microsoft.Network/virtualNetworks/ccoflab-vnet/subnets/snet-apim"
  }
}
```

Stage 6 prints, per mode: `preview: network.mode verify: no network resource is created or changed.`; or, for
`existing` and `create`, `<app> integrated with snet-functions` and the APIM integration line.

## API Management

**Create new**: Stage 1 creates an instance with a public gateway endpoint
([main.bicep](../../infra/staged/main.bicep)). `apimSku` is `BasicV2` or `StandardV2` (private Foundry needs
`StandardV2`).

```json
"stage1": {
  "approveNewPublicApimBootstrap": true,
  "apimPublisherEmail": "alex.admin@contoso.com",
  "apimPublisherName": "CCOF lab",
  "apimSku": "StandardV2",
  "apimUnits": 1
},
"apim": { "existing": null, "apiId": "claude-messages", "apiPath": "anthropic", "apiDisplayName": "Claude Messages (staged)" }
```

**Reuse existing**: Stage 1 creates none; Stage 3 and later use the named instance.

```json
"stage1": { "approveNewPublicApimBootstrap": false },
"apim": {
  "existing": { "name": "contoso-apim", "subscriptionId": "00000000-0000-4000-8000-000000000002", "resourceGroup": "ai-shared-rg" },
  "apiId": "claude-messages",
  "apiPath": "anthropic",
  "apiDisplayName": "Claude Messages (staged)"
}
```

With neither, Stage 0 stops: `no API Management: set stage1.approveNewPublicApimBootstrap to true ... or name an
existing one in apim.existing { name, subscriptionId, resourceGroup }`. Portal: API Management services.

## Cosmos DB

`stage1.cosmosCapacityMode` and `cosmos.capacityMode` agree: `serverless` with `serverless`, `provisioned` with
`provisioned-autoscale` ([Staged.Cosmos.ps1](../../infra/staged/Staged.Cosmos.ps1)). The first region equals `location`.

**One region, serverless:**

```json
"stage1": {
  "cosmosCapacityMode": "serverless",
  "cosmosLocations": [ { "locationName": "eastus2", "isZoneRedundant": false } ]
},
"cosmos": { "databaseName": "ccof", "capacityMode": "serverless" }
```

**Two regions, provisioned** (a serverless account runs in one region; [guide 2.6](../STAGED-DEPLOYMENT-GUIDE.md#26-cosmos-db-redundancy)):

```json
"stage1": {
  "cosmosCapacityMode": "provisioned",
  "cosmosLocations": [
    { "locationName": "eastus2", "isZoneRedundant": false },
    { "locationName": "centralus", "isZoneRedundant": false }
  ]
},
"cosmos": { "databaseName": "ccof", "capacityMode": "provisioned-autoscale", "autoscaleMaxThroughput": 1000 }
```

Next: [reference](configuration-reference.md) · [complete sample](configuration.md#complete-sample).
