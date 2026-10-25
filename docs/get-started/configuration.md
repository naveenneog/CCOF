# Configuration file reference

The staged driver reads one JSON file. The template is [staged.config.example.json](../../infra/staged/staged.config.example.json);
the file in use is kept outside the repository, for example `$HOME/ccof-private/staged.config.json`, because it holds
tenant, subscription and Entra object IDs ([deploy, Before Stage 0](03-deploy.md#before-stage-0-get-the-code-and-write-the-configuration)).
Values are checked by `Read-StgConfig` in [Staged.Common.ps1](../../infra/staged/Staged.Common.ps1) on every stage, so Stage 0 reports
invalid values before anything is created.

**Stage 1 is create-only.** The `stage1` values cannot change after Stage 1 has run in a resource group
(`stage_config_changed`, [Staged.Common.ps1](../../infra/staged/Staged.Common.ps1)). The decisions are in the
[Stage 1 table](03-deploy.md#before-stage-0-get-the-code-and-write-the-configuration). Keys the template does not
list below keep their template values; the full reference is [guide 3.3](../STAGED-DEPLOYMENT-GUIDE.md#33-configuration-file).
Every example here is hypothetical.

Commands used below (Azure CLI signed in to the target tenant):

```powershell
[guid]::NewGuid()                                                   # a new GUID
az account show --query "{tenant:tenantId, subscription:id}" -o json # tenant and subscription IDs
az ad group show --group "Engineering" --query id -o tsv            # group object ID
az group exists -n ccof-lab-rg                                      # false: the name is free
```

## Target

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `tenantId` | Entra tenant. GUID | `az account show`, or Portal > Microsoft Entra ID > Overview > Tenant ID | `00000000-0000-4000-8000-000000000001` |
| `subscriptionId` | Subscription that holds the resources. GUID | `az account show`, or Portal > Subscriptions | `00000000-0000-4000-8000-000000000002` |
| `resourceGroup` | Empty resource group the stages deploy into; letters, digits, `_ . -`, up to 90 characters | A new name; `az group exists` | `ccof-lab-rg` |
| `location` | Region of the deployment. The first `stage1.cosmosLocations` region must equal it | Regions with Claude quota ([prerequisites](02-prerequisites.md#microsoft-foundry-models)) | `eastus2` |

## Stage 1 resources

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `stage1.prefix` | Name prefix of the created resources; 3-8 lowercase letters or digits (`Read-StgConfig`) | A new value per resource group | `ccoflab` |
| `stage1.approveNewPublicApimBootstrap` | `true`: Stage 1 creates an API Management instance. `false`: `apim.existing` must name one; Stage 0 refuses a file with neither ([ADR-0042](../adr/0042-stage0-refusals-and-stage6-recovery.md)) | A decision; a new instance has a public gateway endpoint | `true` |
| `stage1.apimPublisherEmail` | Publisher e-mail of a new API Management instance | The owner's address | `alex.admin@contoso.com` |
| `stage1.apimPublisherName` | Publisher name of a new API Management instance | An organization or team name | `CCOF lab` |
| `stage1.functionsPublicNetworkAccess` | `Enabled` or `Disabled` for the Function Apps and their deployment (SCM) endpoint. `Disabled` needs a machine on the VNet for Stage 7 ([App Service access restrictions](https://learn.microsoft.com/azure/app-service/overview-access-restrictions)) | A decision ([network](../NETWORK.md)) | `Enabled` |
| `stage1.cosmosCapacityMode` | `provisioned` or `serverless`. Must agree with `cosmos.capacityMode` (`provisioned-autoscale` or `serverless`); two or more regions need `provisioned` ([Staged.Cosmos.ps1](../../infra/staged/Staged.Cosmos.ps1)) | [guide 2.6](../STAGED-DEPLOYMENT-GUIDE.md#26-cosmos-db-redundancy) | `provisioned` |
| `stage1.cosmosLocations` | List of `{ locationName, isZoneRedundant }`; the first is the write region. `isZoneRedundant` is `true` or `false`. Zone-redundant capacity was refused in East US 2 | [Azure Cosmos DB regions](https://learn.microsoft.com/azure/cosmos-db/distribute-data-globally) | `[{ "locationName": "eastus2", "isZoneRedundant": false }]` |
| `stage1.foundry.create` | `true`: Stage 1 creates the Foundry account and deployments. `false`: the account in `backends[]` exists | A decision | `true` |
| `stage1.foundry.accountName` | Name of the new Foundry account; 3-64 lowercase letters, digits or `-`; unique in the region. Equals `backends[].accountName` | `az cognitiveservices account list-deleted` and `list` show names in use | `ccoflabfoundry1025` |
| `stage1.foundry.deployments` | List of `{ name, model, version, sku, capacity }`. `sku` is `GlobalStandard` or `DataZoneStandard`; `capacity` is a positive number up to the free quota; names are unique | Quota and model commands in [prerequisites](02-prerequisites.md#microsoft-foundry-models) | `claude-haiku-5-5`, `2`, `DataZoneStandard`, `7` |
| `stage1.foundry.modelProviderData` | Anthropic attestation for the real organization: `organizationName`, `countryCode` (two capital letters), `industry` (`technology`, `finance`, `healthcare`, `education`, `retail`, `manufacturing`, `government`, `media`, `other`) | The organization's legal details | `Contoso Ltd`, `US`, `technology` |
| `stage1.foundry.modelProviderData.organizationName` | Template value `REPLACE-legal-entity-name`; a value starting with `REPLACE` is refused | The organization's legal name | `Contoso Ltd` |

## Network

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `network.mode` | `verify`: the customer builds the network and Stage 6 only checks it. `existing`: Stage 6 creates private endpoints in given subnets. `create`: lab only; Stage 6 also creates the VNet | A decision ([network](../NETWORK.md)) | `create` |
| `network.existing` | Subnet and Private DNS zone IDs of a customer network; read in `verify` and `existing` modes, unused in `create` | The network owner | see the next three rows |
| `network.existing.functionsSubnetId` | Full resource ID of the Function Apps subnet; all subnets in the same VNet | Portal > Virtual networks > Subnets > Resource ID, or `az network vnet subnet show --query id -o tsv` | `/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/net-rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/snet-functions` |
| `network.existing.privateEndpointSubnetId` | Full resource ID of the private endpoint subnet | as above | `.../subnets/snet-private-endpoints` |
| `network.existing.apimSubnetId` | Full resource ID of the API Management subnet; read for a new Standard v2 or Premium v2 instance | as above | `.../subnets/snet-apim` |
| `network.existing.privateDnsZoneIds.cosmos` | `existing` mode only: full Private DNS zone resource ID for Cosmos DB | The network owner ([guide 2.2](../STAGED-DEPLOYMENT-GUIDE.md#22-network)) | `/subscriptions/00000000-0000-4000-8000-000000000003/resourceGroups/net-rg/providers/Microsoft.Network/privateDnsZones/privatelink.documents.azure.com` |
| `network.existing.privateDnsZoneIds.blob` | `existing` mode only: zone ID for Blob storage | as above | `.../privateDnsZones/privatelink.blob.core.windows.net` |
| `network.existing.privateDnsZoneIds.foundry.cognitiveServices`, `.openAi`, `.aiServices` | `existing` mode with a `backends[].privateEndpoint: true` backend: one zone ID each | as above | `.../privateDnsZones/privatelink.cognitiveservices.azure.com` |
| `network.create` | VNet name, address space, NSG name and three subnets; read in `create` mode | Any free address space | `ccoflab-vnet`, `10.64.0.0/16` |

`network.mode: existing` takes a pre-built VNet: the driver creates private endpoints and VNet integrations in the
given subnets, and `Read-StgConfig` requires `functionsSubnetId`, `privateEndpointSubnetId` and the `cosmos` and `blob`
zone IDs (plus the three `foundry` zones for a private backend, and `apimSubnetId` for a new Standard v2 or Premium v2
instance). Layout: [guide 2.2](../STAGED-DEPLOYMENT-GUIDE.md#22-network). In `create` mode the `network.existing` keys are unused.

## API Management

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `apim.existing` | `null` with a new instance; otherwise `{ name, subscriptionId, resourceGroup }` of an existing one ([Staged.Common.ps1](../../infra/staged/Staged.Common.ps1)) | Portal > API Management services | `null` |

## Backends

`backends[]` lists the Foundry accounts the gateway routes to ([Staged.Resources.ps1](../../infra/staged/Staged.Resources.ps1)).

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `backends[].id` | Name of the backend; `groups[].backendId` refers to it | A new name | `foundry-eastus2` |
| `backends[].subscriptionId` | Subscription of the Foundry account | `subscriptionId` for a new account | `00000000-0000-4000-8000-000000000002` |
| `backends[].resourceGroup` | Resource group of the account | `resourceGroup` for a new account | `ccof-lab-rg` |
| `backends[].accountName` | Foundry account name | `stage1.foundry.accountName`, or Portal > Foundry > the account | `ccoflabfoundry1025` |
| `backends[].url` | Anthropic endpoint of the account: `https://<accountName>.services.ai.azure.com/anthropic` | Portal > the account > Keys and Endpoint | `https://ccoflabfoundry1025.services.ai.azure.com/anthropic` |
| `backends[].deploymentInferenceGeo` | Map of deployment name to `global` or `us`: `GlobalStandard` is `global`, `DataZoneStandard` is `us`. Each name is a deployment of the account | [prerequisites](02-prerequisites.md#microsoft-foundry-models) | `{ "claude-haiku-5-5": "us" }` |
| `backends[].privateEndpoint` | `true`: Stage 6 creates a private endpoint to the account (same subscription and resource group). Needed when the new account has `publicNetworkAccess: Disabled` in `create` or `existing` mode; Stage 0 refuses the mismatch ([ADR-0042](../adr/0042-stage0-refusals-and-stage6-recovery.md)) | A decision | `true` |

## Entra

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `entra.existing` | Optional `gatewayAppId`, `resolverAppId`, `adminAppId` (GUIDs) of app registrations to reuse. Absent: Stage 4 creates them from the `*AppDisplayName` keys | Portal > Microsoft Entra ID > App registrations > Application (client) ID | `{ "gatewayAppId": "00000000-0000-4000-8000-000000000004" }` |
| `entra.allowAzureCliClient` | `true` lets the Azure CLI sign in to the gateway; needed for `client.signInMethod: azure-cli` ([guide 6.6](../STAGED-DEPLOYMENT-GUIDE.md#66-azure-cli-developer-sign-in)) | A decision | `true` |
| `entra.adminEditors` | Object IDs, or `@me` for the operator, assigned to the admin console as editors; required when Stage 4 creates the admin registration | `az ad user show --id <upn> --query id -o tsv` | `["@me"]` |

Display names written to Entra (`entra.*AppDisplayName`, and `groups[].groupDisplayName` without `groupId`) may hold
letters, digits, space and `. _ -` only.

## Groups

`groups[]` entries with `"kind": "group"` are Entra groups onboarded as entities ([Staged.Groups.ps1](../../infra/staged/Staged.Groups.ps1)).

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `groups[].groupId` | Object ID of an existing security group. Wins over `groupDisplayName` | `az ad group show` (above), or Portal > Microsoft Entra ID > Groups | `00000000-0000-4000-8000-000000000005` |
| `groups[].groupDisplayName` | Group Stage 4 creates or reuses by name, when `groupId` is absent. One of the two is required | A new name | `CCOF-PILOT01` |
| `groups[].backendId` | `backends[].id` of the group's backend | `backends[].id` | `foundry-eastus2` |
| `groups[].chargebackId` | Cost-center label in usage reports, or `null` ([chargeback](../operate/chargeback-and-tags.md)) | Finance | `CC-ENG-1001` |
| `groups[].budget` | `mode` `autoScale` (with `groupCap: null`) or `cap`; `perUser` `{ amount, currency, period }`. The template's `25000` `CCU` is a compute unit; `USD` is a dollar amount ([budgets](../operate/budgets-and-guard.md)) | A decision | `100` `USD` `monthly` |
| `groups[].familyPolicy` | Token limits per person and group (`aggregateLimits`) and `families` (`haiku`, `sonnet`, ...) with the deployment names each allows. A model outside the families is refused with 403 | Deployment names from `stage1.foundry.deployments` | `"haiku": { "models": ["claude-haiku-5-5"] }` |

## Client

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `client.group` | The one group entry the developer file is written for, by `groupDisplayName` or `groupId` (`client_selection_invalid` otherwise) | `groups[]` | `00000000-0000-4000-8000-000000000005` |
| `client.signInMethod` | `msal` or `azure-cli`; `azure-cli` needs `entra.allowAzureCliClient: true` | [prerequisites](02-prerequisites.md#decide-before-you-start) | `azure-cli` |
| `client.models` | Deployment names for `default`, `sonnet`, `haiku`, `opus` | `stage1.foundry.deployments` | `claude-sonnet-5-5` |

## Budgets and sync

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `resolver.budgetEnforcement` | `token-limits-only` (no dollar budget) or `budget-state` | [budgets](../operate/budgets-and-guard.md) | `budget-state` |
| `reconciler.timerEnabled` | `true`: the reconciler prices usage on its schedule | A decision | `true` |
| `sync.mode` | `delegated-snapshot` (membership applied by an operator, no Graph permission) or `application-permission` (needs `GroupMember.Read.All`) | [guide 6.1](../STAGED-DEPLOYMENT-GUIDE.md#61-graph-grants-group-search-names-and-sync) | `delegated-snapshot` |
| `syncTimerEnabled` | `true` runs the sync on a timer; needs `application-permission` | as above | `false` |

## Reports and acceptance

| Key | What it is | Where to get the value | Lab example |
| --- | --- | --- | --- |
| `workbook.resourceName` | Azure resource name of the chargeback workbook; a GUID, new per deployment ([stage5-config.bicep](../../infra/staged/stage5-config.bicep)) | `[guid]::NewGuid()` | `00000000-0000-4000-8000-000000000006` |
| `acceptance` | Stage 8 requests: `allowed` models answer, `denied` models return `expectedStatus` | Names from `groups[].familyPolicy` | `allowed` `claude-haiku-5-5`; `denied` `claude-opus-5-5`, `403` |

Next: [deploy](03-deploy.md).
