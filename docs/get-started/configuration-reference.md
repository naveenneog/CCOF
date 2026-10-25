# Configuration reference: target, Stage 1, network, Cosmos DB, API Management, backends

Part of the [configuration reference](configuration.md). Every key of these sections in
[staged.config.example.json](../../infra/staged/staged.config.example.json): **Req** is whether the file must set it (`Yes`;
`If` with the condition; `No` keeps the template value), **Template** is the value in the template. `Read-StgConfig` is in
[Staged.Common.ps1](../../infra/staged/Staged.Common.ps1); `main.bicep` is [infra/staged/main.bicep](../../infra/staged/main.bicep).
Stage 1 keys are create-only ([deploy](03-deploy.md#before-stage-0-get-the-code-and-write-the-configuration)).

## Target

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `schemaVersion` | Yes | `1` | Must be `1` | `Read-StgConfig` |
| `tenantId` | Yes | `REPLACE-...` | GUID; Stage 0 checks the subscription is in it. `az account show --query tenantId -o tsv` | `Read-StgConfig`, Stage 0 |
| `subscriptionId` | Yes | `REPLACE-...` | GUID. `az account show --query id -o tsv` | `Read-StgConfig` |
| `resourceGroup` | Yes | `REPLACE-new-empty-resource-group` | 1-90 letters, digits, `_ . -`; a new empty group | `Read-StgConfig` |
| `location` | Yes | `eastus2` | Region; Flex Consumption must be offered; first `stage1.cosmosLocations` entry equals it | Stage 0, `Get-StgCosmosProblems` |
| `tags.workload` | No | `claude-code-on-foundry` | Tag value on created resources | `main.bicep` `tags` |
| `tags.deployment` | No | `staged` | Tag value on created resources | `main.bicep` `tags` |
| `sharedResourceGroup` | No | `false` | `true` or `false`; `true` marks a resource group that holds other resources: Stage 1 refuses any Delete and any Modify of resources it does not own | `Read-StgConfig`, `Get-StgUnsafeSharedChanges` |

## Stage 1 resources

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `stage1.prefix` | No | `ccofstg` | 3-8 lowercase letters or digits; prefix of created names | `Read-StgConfig`, `main.bicep` |
| `stage1.includeAdmin` | No | `true` | Creates the admin console service; `false` skips the admin application in Stage 4 | `main.bicep`, Stage 4 |
| `stage1.cosmosCapacityMode` | No | `provisioned` | `serverless` or `provisioned`; agrees with `cosmos.capacityMode` | `Get-StgCosmosProblems` |
| `stage1.cosmosLocations[].locationName` | No | `eastus2`, `centralus` | ARM region name; first is the write region and equals `location`; no duplicates | `Get-StgCosmosProblems` |
| `stage1.cosmosLocations[].isZoneRedundant` | No | `true` | `true` or `false` | `Get-StgCosmosProblems` |
| `stage1.cosmosConsistency.defaultConsistencyLevel` | No | `Session` | `Strong`, `BoundedStaleness`, `Session`, `ConsistentPrefix`, `Eventual`; `BoundedStaleness` also needs `maxStalenessPrefix` and `maxIntervalInSeconds` | `Get-StgCosmosProblems` |
| `stage1.cosmosPublicNetworkAccess` | No | `Disabled` | `Disabled` or `Enabled` | `main.bicep` |
| `stage1.storagePublicNetworkAccess` | No | `Disabled` | `Disabled` or `Enabled` | `main.bicep` |
| `stage1.functionsPublicNetworkAccess` | No | `Disabled` | `Disabled` or `Enabled`; `Disabled` also closes the deployment (SCM) endpoint | `main.bicep` |
| `stage1.storageSku` | No | `Standard_LRS` | `Standard_LRS` or `Standard_ZRS` | `main.bicep` |
| `stage1.retentionInDays` | No | `30` | 30-730; log retention | `main.bicep` |
| `stage1.maximumInstanceCount` | No | `40` | 40-1000; Function App instances | `main.bicep` |
| `stage1.instanceMemoryMB` | No | `2048` | `512`, `2048` or `4096` | `main.bicep` |
| `stage1.approveNewPublicApimBootstrap` | Yes | `false` | `true` creates API Management; `false` needs `apim.existing` | `Read-StgConfig` |
| `stage1.apimPublisherEmail` | If new APIM | empty | Publisher e-mail | `main.bicep` |
| `stage1.apimPublisherName` | If new APIM | empty | Publisher name | `main.bicep` |
| `stage1.apimSku` | No | `StandardV2` | `BasicV2` or `StandardV2` | `main.bicep` |
| `stage1.apimUnits` | No | `1` | 1 or more | `main.bicep` |
| `stage1.foundry.create` | Yes | `false` | `true` creates the account | `Read-StgConfig` |
| `stage1.foundry.accountName` | If create | `REPLACE-...` | 3-64 lowercase letters, digits, `-`; equals `backends[].accountName` | `Read-StgConfig` |
| `stage1.foundry.publicNetworkAccess` | If create | `Disabled` | `Disabled` or `Enabled`; `Disabled` needs `backends[].privateEndpoint: true` | `Read-StgConfig` |
| `stage1.foundry.deployments[].name` | If create | `claude-haiku-4-5` | Unique deployment name | `Read-StgConfig` |
| `stage1.foundry.deployments[].model` | If create | `claude-haiku-4-5` | Model name from `az cognitiveservices model list` | Stage 0 |
| `stage1.foundry.deployments[].version` | If create | `20251001` | Model version, offered in the region | Stage 0 |
| `stage1.foundry.deployments[].sku` | If create | `GlobalStandard` | `GlobalStandard` or `DataZoneStandard` | `Read-StgConfig` |
| `stage1.foundry.deployments[].capacity` | If create | `10` | Whole number, 1 up to free quota ([prerequisites](02-prerequisites.md#microsoft-foundry-models)) | `Read-StgConfig` |
| `stage1.foundry.modelProviderData.organizationName` | If create | `REPLACE-...` | Legal name; `REPLACE` values refused | `Read-StgConfig` |
| `stage1.foundry.modelProviderData.countryCode` | If create | `US` | Two capital letters (ISO 3166 alpha-2) | `Read-StgConfig` |
| `stage1.foundry.modelProviderData.industry` | If create | `technology` | `technology`, `finance`, `healthcare`, `education`, `retail`, `manufacturing`, `government`, `media`, `other` | `Read-StgConfig` |

`stage1.cosmosLocations`, `stage1.foundry.deployments` and `stage1.foundry.modelProviderData` are objects or lists of the
keys above; also `stage1.foundry` accepts `modelDeploymentsBlocked` (a reason, instead of deployments).

## Network

Forms: [network section](configuration-resources.md#network).

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `network.mode` | No | `verify` | `verify`, `existing`, `create` | `Read-StgConfig`, Stage 6 |
| `network.modeNote` | No | text | Comment; not read | none |
| `network.existing.functionsSubnetId` | If verify or existing | `REPLACE-...` | Full subnet resource ID | `Read-StgConfig` |
| `network.existing.privateEndpointSubnetId` | If verify or existing | `REPLACE-...` | Full subnet resource ID | `Read-StgConfig` |
| `network.existing.apimSubnetId` | If new Standard v2 APIM | `REPLACE-...` | Full subnet resource ID | `Read-StgConfig`, Stage 6 |
| `network.existing.privateDnsZoneIds.cosmos` | If existing | absent | Full zone resource ID | `Read-StgConfig` |
| `network.existing.privateDnsZoneIds.blob` | If existing | absent | Full zone resource ID | `Read-StgConfig` |
| `network.existing.privateDnsZoneIds.foundry.cognitiveServices` | If existing and private Foundry | absent | Zone ID of `privatelink.cognitiveservices.azure.com` | `Read-StgConfig`, `stage6-network.bicep` |
| `network.existing.privateDnsZoneIds.foundry.openAi` | If existing and private Foundry | absent | Zone ID of `privatelink.openai.azure.com` | as above |
| `network.existing.privateDnsZoneIds.foundry.aiServices` | If existing and private Foundry | absent | Zone ID of `privatelink.services.ai.azure.com` | as above |
| `network.create.vnetName` | If create | `ccofstg-vnet` | VNet name | `stage6-network.bicep` |
| `network.create.addressSpace` | If create | `10.64.0.0/16` | CIDR | as above |
| `network.create.apimNsgName` | If create | `ccofstg-nsg-apim` | NSG name | as above |
| `network.create.subnets.apim.name` | If create | `snet-apim` | Subnet name | as above |
| `network.create.subnets.apim.prefix` | If create | `10.64.1.0/24` | CIDR inside the address space | as above |
| `network.create.subnets.privateEndpoints.name` | If create | `snet-private-endpoints` | Subnet name | as above |
| `network.create.subnets.privateEndpoints.prefix` | If create | `10.64.2.0/24` | CIDR | as above |
| `network.create.subnets.functions.name` | If create | `snet-functions` | Subnet name | as above |
| `network.create.subnets.functions.prefix` | If create | `10.64.3.0/24` | CIDR | as above |

## Cosmos DB

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `cosmos.databaseName` | Yes | `ccof` | Database name | `Read-StgConfig`, `stage2-schema.bicep` |
| `cosmos.capacityMode` | No | `provisioned-autoscale` | `serverless` or `provisioned-autoscale`; pairs with `stage1.cosmosCapacityMode` | `Get-StgCosmosProblems` |
| `cosmos.autoscaleMaxThroughput` | No | `1000` | Maximum RU/s of the autoscale containers | `stage2-schema.bicep` |
| `cosmos.roleNames.syncWriter` | No | `ccof sync entitlement writer` | Cosmos DB custom role name | `stage3-grants.bicep` |
| `cosmos.roleNames.reconcilerWriter` | No | `ccof reconciler budget writer` | Role name | `stage3-grants.bicep` |
| `cosmos.roleNames.projectWriter` | No | `ccof onboarding project writer` | Role name | `stage3-grants.bicep` |
| `cosmos.roleNames.adminEditor` | No | `ccof admin project editor` | Role name | `stage3-grants.bicep` |

## API Management

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `apim.existing` | If not new | `null` | `null`, or `{ name, subscriptionId, resourceGroup }` | `Read-StgConfig` |
| `apim.existing.name` | If reused | absent | Name of the API Management instance | `Read-StgConfig` |
| `apim.existing.subscriptionId` | If reused | absent | Its subscription GUID | `Read-StgConfig` |
| `apim.existing.resourceGroup` | If reused | absent | Its resource group | `Read-StgConfig` |
| `apim.apiId` | No | `claude-messages` | API ID | `stage5-config.bicep` |
| `apim.apiPath` | No | `anthropic` | URL path of the API | `stage5-config.bicep` |
| `apim.apiDisplayName` | No | `Claude Messages (staged)` | Portal name | `stage5-config.bicep` |

## Backends

Forms: [Foundry and backends](configuration-resources.md#foundry-and-backends). `backends[].deploymentInferenceGeo` is a map
from deployment name to `global` or `us`; its row is `backends[].deploymentInferenceGeo.<deployment>`.

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `backends[].id` | Yes | `REPLACE-backend-id` | Name that `groups[].backendId` refers to | `Read-StgConfig` |
| `backends[].subscriptionId` | Yes | `REPLACE-...` | Subscription of the account | `Read-StgConfig` |
| `backends[].resourceGroup` | Yes | `REPLACE-foundry-rg` | Resource group of the account | `Read-StgConfig` |
| `backends[].accountName` | Yes | `REPLACE-foundry-account` | Account name | `Read-StgConfig` |
| `backends[].url` | Yes | `https://REPLACE-....services.ai.azure.com/anthropic` | Anthropic endpoint of the account | `Read-StgConfig` |
| `backends[].resource` | No | `https://cognitiveservices.azure.com` | Not validated by `Read-StgConfig`; the template value is the Azure AI Services audience | backend object in `stage5-config.bicep` `backends` |
| `backends[].deploymentInferenceGeo.<deployment>` | Yes | `global` | Per deployment name: `global` or `us`; names equal real deployments | Stage 0 |
| `backends[].assignCognitiveServicesUser` | No | `true` | `false` skips the Stage 3 role assignment | `stage3-grants.bicep` |
| `backends[].privateEndpoint` | No | `false` | `true`: Stage 6 creates a private endpoint (same subscription and resource group only) | `Read-StgConfig`, Stage 6 |

Next: [identity, client, limits and reports](configuration-reference-2.md).
