# Check and add high availability

Availability zones are separate datacentres within one Azure region. Zone redundancy keeps a service running when
one zone fails. It does **not** make a single-region deployment survive losing the whole region. Decide before
Stage 1: the resource stage is create-only.

## 1. What to protect, and what it costs

| Component | Configuration | Protection and cost |
| --- | --- | --- |
| API Management | `ha.apim.zoneRedundant: true`; `stage1.apimSku: StandardV2` or `PremiumV2` | Azure distributes units automatically across zones; do not specify numbered zones. Two units are recommended for surviving-zone capacity, not required. Going from one to two units adds an additional-unit hourly charge, which can differ from the first unit's price |
| All Function Apps, including admin | `ha.functions.zoneRedundant: true` and ZRS/GZRS storage | Flex Consumption distributes instances across zones. Azure maintains and bills **at least two always-ready instances per scaling function/group**, even if you have not configured always-ready instances. This creates a running compute cost instead of scaling entirely to zero |
| Function host and deployment storage | `stage1.storageSku: Standard_ZRS` or `Standard_GZRS` | ZRS copies synchronously across zones. GZRS also copies asynchronously to another region; regional recovery still needs a storage failover plan. Both cost more than LRS |
| Cosmos DB | `stage1.cosmosLocations[].isZoneRedundant: true` per supported region | Replicas across zones in that region. Autoscale's zone premium is waived. A second region still adds that region's throughput and storage charges |

Sources, checked 2026-10-27: [API Management reliability](https://learn.microsoft.com/azure/reliability/reliability-api-management),
[Functions reliability](https://learn.microsoft.com/azure/reliability/reliability-functions),
[storage redundancy](https://learn.microsoft.com/azure/storage/common/storage-redundancy),
[Cosmos DB reliability](https://learn.microsoft.com/azure/reliability/reliability-cosmos-db).
For example, the Central India USD list meters on 2026-10-27 were `Standard v2 Unit` USD 0.95890/hour and
`Standard v2 Secondary Unit` USD 0.68493/hour. Two units total about USD 1.64/hour, not twice the first-unit rate
([Retail Prices API](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27API%20Management%27%20and%20armRegionName%20eq%20%27centralindia%27%20and%20skuName%20eq%20%27Standard%20v2%27)).
This excludes Functions, private endpoints, storage, Cosmos and logs. Check current prices and your agreement
in the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/).
The [regions page](region-and-failover.md) gives provisioned Cosmos examples.

The storage option covers Function host/package accounts, not the separate optional audit archive. Configure
that account separately with `audit.archive.storageSku` ([archive settings](configuration-reference-3.md)).
Neither storage replication nor Cosmos redundancy backs up data against accidental deletion.

## 2. Check the region

In the signed-in subscription you will deploy into:

```powershell
az account set --subscription '<subscription-id>'
az account list-locations --query "[?name=='centralindia'].availabilityZoneMappings" -o json
az functionapp list-flexconsumption-locations --zone-redundant=true -o table
```

Nonempty zone mappings mean regional zone support, **not guaranteed service capacity**. The second command must
also list the deployment region for zone-redundant Flex. Stage 0 uses the configured subscription explicitly.
Central India has zones; its pair South India has none. You may set Cosmos zones on in Central India and off in
South India. India South Central has zones but is not Central India's reciprocal pair; choose it only after
reviewing [residency, region pairs and capacity](region-and-failover.md#3-the-failover-region).
Check every configured Cosmos region. Azure may refuse an otherwise eligible region because capacity is full.

## 3. Add the options before Stage 1

Merge these fields into your existing configuration; this is **not a complete config**. Keep the rest of `stage1`.
Use an approved new empty resource group and a new prefix for a new deployment.

```json
{
  "location": "centralindia",
  "ha": {
    "apim": { "zoneRedundant": true },
    "functions": { "zoneRedundant": true }
  },
  "stage1": {
    "apimSku": "StandardV2",
    "apimUnits": 2,
    "storageSku": "Standard_ZRS",
    "cosmosLocations": [
      { "locationName": "centralindia", "isZoneRedundant": true },
      { "locationName": "southindia", "isZoneRedundant": false }
    ]
  }
}
```

Keep `stage1.cosmosCapacityMode: provisioned` and matching `cosmos.capacityMode` for multiple Cosmos regions.
Choose `stage1.foundry.location` separately if the deployment region does not offer Claude.
If you use `apim.existing`, do **not** set `ha.apim`: the owner manages that instance's zones, capacity and network.
CCOF does not change it. Leave `ha` out to retain the old deployment settings and state hashes.

```powershell
pwsh -File infra\staged\Invoke-StagedDeployment.ps1 -Stage 0 -ConfigPath .env.staged\staged.config.json
```

Expect these lines for the example (boolean letter case may vary):

```text
HA check: apim zones available=True configured=True
HA check: functions zones available=True configured=True
HA check: storage zones available=True configured=True
HA check: cosmos centralindia zones available=True configured=True; paired region=southindia zones=False
HA check: cosmos southindia zones available=False configured=False; paired region=centralindia zones=True
```

With APIM zones off in a region with zones, Stage 0 suggests:

```text
suggestion: apim zones: centralindia has zones; set ha.apim.zoneRedundant true with stage1.apimSku StandardV2 or PremiumV2; recommend stage1.apimUnits 2 (cost +1 unit from 1)
```

Suggestions are not refusals. An impossible setting stops with the region and the next step: choose a supported
region or explicitly disable the requested option. Do not silently drop HA to get a deployment through.
Run the Stage 1 preview, review units and SKUs, then apply and continue [Stages 2–8](03-deploy.md).
Stage 1 checks the actual APIM flag/units, each Flex hosting plan, storage SKU and Cosmos region settings.
Its `stage1.verify.json` evidence records the read-back.

**If Cosmos returns `ServiceUnavailable` about high demand for zonal accounts:** stop at Stage 1. Regional zone
support does not reserve capacity. Inspect the failed deployment's operations in the Portal and follow Azure's
[region access request](https://aka.ms/cosmosdbquota). Keep the requested settings; do not mark Stage 1 complete or
run later applies against a failed account. Request capacity or retry later; repeated immediate attempts can still
be refused. India South Central is an alternative with zones, subject to its own capacity and the region-pair
trade-off above. Choosing another region or accepting no Cosmos zone protection needs an explicit owner decision.

**Approved fallback after a failed first deployment only:** if Stage 1 never succeeded, the new Cosmos account is
`Failed`, and you have verified it holds no database/data, save the failed deployment's evidence and your config.
Do not delete an existing or healthy account. With approval to keep Cosmos nonzonal, delete only that failed empty
account, then change `stage1.cosmosLocations` to Central India and South India with `isZoneRedundant: false` on both.
Keep APIM zones/units, Functions zones and ZRS storage unchanged.

Azure can refuse the database-list command with `BadRequest` when the account's initial creation failed.
That error alone does not prove it empty: confirm the deployment operations say **account creation failed**,
`documentEndpoint` is null, Stage 1 has never succeeded, and neither Stage 2 deployment nor completed state exists.
If you cannot establish all of that, stop instead of deleting it. Never apply this shortcut to an account that
was previously healthy. Run the checks first, then the approved deletion and recovery:

```powershell
az cosmosdb show -g '<new-resource-group>' -n '<failed-new-cosmos-name>' --query "{state:provisioningState,endpoint:documentEndpoint,regions:locations}"
az cosmosdb sql database list -g '<new-resource-group>' -a '<failed-new-cosmos-name>' --query "[].name"
# Only for the verified Failed, empty NEW account, after owner approval:
az cosmosdb delete -g '<new-resource-group>' -n '<failed-new-cosmos-name>' --yes
pwsh -File infra\staged\Invoke-StagedDeployment.ps1 -Stage 0 -ConfigPath .env.staged\staged.config.json
pwsh -File infra\staged\Invoke-StagedDeployment.ps1 -Stage 1 -ConfigPath .env.staged\staged.config.json
pwsh -File infra\staged\Invoke-StagedDeployment.ps1 -Stage 1 -ConfigPath .env.staged\staged.config.json -Apply
```

Use the **same state folder**. Stage 1's guarded preview must show no unrelated Modify/Delete; it may resume the
resources recorded by the failed deployment. Stop if that guard refuses. After Stage 1 succeeds and verifies,
continue Stages 2–8. This recovery exception does not let you change a previously succeeded Stage 1 deployment.
Stage 0 still prints `suggestion: cosmos zones: centralindia has zones but capacity may be refused`; the warning
does not undo your approved nonzonal choice. Two Cosmos regions still protect against a region outage, with the
recovery limits in the [outage guide](region-and-failover.md#4-outage-and-a-planned-failover-drill).

## 4. Check an existing deployment

Replace the placeholders with names from your Stage 1 state. These commands only read:

```powershell
az rest --method get --url "https://management.azure.com/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.ApiManagement/service/<apim-name>?api-version=2025-03-01-preview" --query "{zones:properties.zoneRedundant,units:sku.capacity}"
az rest --method get --url "https://management.azure.com/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Web/serverfarms/<function-plan-name>?api-version=2025-03-01" --query "{zones:properties.zoneRedundant}"
az storage account show -g '<resource-group>' -n '<host-storage-name>' --query sku.name
az cosmosdb show -g '<resource-group>' -n '<cosmos-name>' --query "locations[].{region:locationName,zones:isZoneRedundant}"
```

Adding `ha` to the old config does **not** upgrade it. Stage 1 refuses changed inputs. APIM v2 zone configuration
cannot change after creation: it needs re-creation ([APIM reliability](https://learn.microsoft.com/azure/reliability/reliability-api-management)).
CCOF also does not automate in-place Flex, storage or Cosmos zone migrations, even where Azure supports them.
Keep the old config/state and resources. Plan a separate new prefix/resource group and state folder, migrate data
and access grants, check networking and model quota, run Stage 8, then arrange client endpoint cutover in an
approved window. Do not delete the original Cosmos account or assume a new stack attaches to its replica.
Retire the old stack only after verification and owner approval.

## 5. What remains single-region

APIM v2, the Function Apps, workspace and private network still run in one region. Zone protection does not create
a standby gateway or route clients to another region. Only classic Premium APIM supports multi-region gateways;
this v2 option does not. Cosmos failover has separate recovery timing and possible data-loss considerations
([outage guide](region-and-failover.md#4-outage-and-a-planned-failover-drill)).

A second Foundry endpoint and a circuit breaker protect a different failure path:
[Foundry failover](foundry-failover.md). They do not rescue a gateway whose own region is down, and a second account
in the same subscription does not add Claude quota.
