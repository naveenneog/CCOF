# Regions, provisioned Cosmos DB and the failover region

Read this before Stage 0 when `location` is not a US region, or when you plan a second Cosmos DB region. The worked
example is a deployment in Central India ([evidence](../evidence/2026-10-26-central-india/README.md)).

To protect services against a zone outage within a region, [check and add high availability](high-availability.md).
This is separate from the regional recovery guidance below.

## 1. Where the Claude models run

Claude models in Microsoft Foundry are offered only in some Azure regions, with two deployment types: **Global
Standard** (all Claude models) and **Data Zone Standard (US)** for some of them
([Claude models in Foundry](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/claude-models)).
Check a region with the model list from the [prerequisites](02-prerequisites.md#microsoft-foundry-models), with
`-l <region>`. In the lab subscription on 2026-10-26 it listed Claude in `eastus`, `eastus2`, `centralus`,
`northcentralus`, `southcentralus`, `westus` and `westus3` (Global and US Data Zone) and `swedencentral` (Global
only), and none in `centralindia`, `southindia`, `westindia`, `southeastasia` or `japaneast`. Offers change; Stage 0
reads them again.

When `location` offers no Claude models, keep everything else in `location` and put the Foundry account in a Claude
region with `stage1.foundry.location`:

```json
"location": "centralindia",
"stage1": {
  "foundry": { "create": true, "accountName": "ccoflabfoundry1026", "location": "eastus2", "publicNetworkAccess": "Disabled",
    "deployments": [ { "name": "claude-haiku-5-5", "model": "claude-haiku-5-5", "version": "2", "sku": "GlobalStandard", "capacity": 10 } ],
    "modelProviderData": { "organizationName": "Contoso Ltd", "countryCode": "IN", "industry": "technology" } }
}
```

Without it, Stage 0 stops with `model … is not offered in centralindia for this subscription. Claude is offered only
in some regions: set stage1.foundry.location …`. Run the quota command for the Foundry region (`-l eastus2`), not for
`location`. `stage1.foundry.location` is create-only, like every `stage1` key. An existing account in any region can be
used instead (`stage1.foundry.create: false`, [Foundry and backends](configuration-resources.md#foundry-and-backends)).

What this means:

| Topic | Effect |
| --- | --- |
| Where prompts are processed | Global Standard: "may be processed in any Azure region"; Data Zone Standard: only within the US data zone. Data stored at rest stays in the Foundry account's geography (here the United States) ([deployment types](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/deployment-types)). There is no India data zone for Claude, so prompts leave India either way. `deploymentInferenceGeo` is `global` for Global Standard and `us` for Data Zone Standard |
| Latency | Each request crosses from the gateway's region to the Foundry region and back: about 200 ms round trip (median) between Central India and East US 2 ([Azure network latency](https://learn.microsoft.com/azure/networking/azure-network-latency)), small next to the model's own time (the 2026-10-26 Stage 8 request: 2.9 s in total, 2.5 s at the backend) |
| Private Foundry | `publicNetworkAccess: Disabled` with `backends[].privateEndpoint: true`: Stage 6 creates the private endpoint in the VNet's region (`location`) for the account in the other region. A private endpoint may be in a different region from its resource ([Private Link](https://learn.microsoft.com/azure/private-link/private-endpoint-overview#private-endpoint-properties)); traffic stays on the Microsoft network |
| Public Foundry | `publicNetworkAccess: Enabled` with `privateEndpoint: false`: the gateway calls the public endpoint. Local keys stay disabled; API Management signs in with its managed identity |
| Quota | Quota lines are per Foundry region and deployment type; deleted accounts in that region hold quota until purged |

## 2. Provisioned Cosmos DB

The template uses provisioned autoscale: `stage1.cosmosCapacityMode: provisioned` with `cosmos.capacityMode:
provisioned-autoscale` and `cosmos.autoscaleMaxThroughput: 1000`. Stage 2 puts the 1,000 RU/s maximum on the `ccof`
database, shared by all its containers. Autoscale bills, per region and hour, the highest throughput used, at least
10% of the maximum ([autoscale](https://learn.microsoft.com/azure/cosmos-db/provision-throughput-autoscale)). A
second region bills the same throughput again. `serverless` (one region only) bills per request instead.

| Layout (list prices, USD) | Idle (100 RU/s) | At the maximum (1,000 RU/s) |
| --- | --- | --- |
| Central India only | 0.0137 an hour, about 10 a month | 0.137 an hour, about 100 a month |
| Central India + South India | 0.0262 an hour, about 19 a month | 0.262 an hour, about 191 a month |

Prices: meter `AP1 100 RUs` (autoscale, per 100 RU/s per hour), USD 0.0137 in Central India and USD 0.0125 in South
India, from the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Azure%20Cosmos%20DB%27%20and%20armRegionName%20eq%20%27centralindia%27%20and%20meterName%20eq%20%27AP1%20100%20RUs%27),
retrieved 2026-10-26; storage is USD 0.285 per GB per month in Central India. The zone-redundancy premium is waived for
autoscale ([Cosmos DB reliability, Cost](https://learn.microsoft.com/azure/reliability/reliability-cosmos-db)).

## 3. The failover region

By default CCOF fails over only Cosmos DB: `stage1.cosmosLocations` lists the regions in failover order, and two or more turn
on service-managed failover ([guide 2.6](../STAGED-DEPLOYMENT-GUIDE.md#26-cosmos-db-redundancy)). The other
resources are in one region.

Choose the second Cosmos DB region in this order:

1. **The same geography**, when data residency applies. Azure keeps almost every region pair in one geography
   ([region pairs](https://learn.microsoft.com/azure/reliability/regions-paired)).
2. **The paired region**: recovery is prioritised for one region of each pair, and planned updates are staggered
   across a pair. Central India is paired with South India.
3. **Zone redundancy where the region has availability zones.** `isZoneRedundant` is set per region; a region
   without zones uses `isZoneRedundant: false` ([Cosmos DB reliability](https://learn.microsoft.com/azure/reliability/reliability-cosmos-db)).
   South India has no availability zones; India South Central (Hyderabad, `indiasouthcentral`) has three and is
   paired one way with Central India ([list of regions](https://learn.microsoft.com/azure/reliability/regions-list)).
   Check: `az account list-locations --query "[?name=='southindia'].availabilityZoneMappings"` (empty: no zones).
4. **Capacity in your subscription.** Zone-redundant Cosmos DB accounts can be refused for high demand; the 2026-10-26
   run was refused zone redundancy in Central India and used `false` ([troubleshooting](../operate/troubleshooting.md)).

For Central India:

```json
"cosmosLocations": [
  { "locationName": "centralindia", "isZoneRedundant": false },
  { "locationName": "southindia", "isZoneRedundant": false }
]
```

Use `true` for `centralindia` when your subscription has zone-redundant capacity there. `indiasouthcentral` with
`isZoneRedundant: true` is the alternative when zones matter more than the pair.

The stages create no standby for the other parts. If you need one, plan it yourself:

| Part | In the stages | Recovery option (not created by CCOF) |
| --- | --- | --- |
| API Management Standard v2 | One region | Multi-region gateways need the Premium (classic) tier ([API Management reliability](https://learn.microsoft.com/azure/reliability/reliability-api-management)); otherwise deploy again in the paired region |
| Function Apps, storage, Log Analytics | One region | Wait for regional recovery, then verify networking and run Stage 8. A replacement stack in another region creates a new Cosmos DB account; it does not attach to the surviving replica. Data migration, identities, endpoints and client cutover need a separate recovery plan |
| Foundry account | One account by default | Opt into a second account and a circuit-breaker priority pool with [Foundry account failover](foundry-failover.md). Groups keep the same backend ID. Global and Data Zone deployments are affected when their primary region has an interruption ([deployment types](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/deployment-types)) |

## 4. Outage and a planned failover drill

If a Cosmos read region fails, the SDK reads from the next reachable preferred region. If the write region fails,
writes fail until that region is taken offline or service-managed failover completes. Service-managed failover
"might take one hour or more"; Microsoft recommends a region offline operation
([forced failover](https://learn.microsoft.com/azure/cosmos-db/how-to-manage-database-account#perform-forced-failover-for-your-azure-cosmos-db-account))
and not changing the write region during the outage. Without strong consistency, unreplicated writes can be lost
only if the region suffers permanent data loss
([Cosmos DB reliability](https://learn.microsoft.com/azure/reliability/reliability-cosmos-db), retrieved 2026-10-27).
With `isZoneRedundant: false`, Cosmos DB can place a region's replicas in one availability zone, so a single-zone
issue can make that region unavailable and lead to the same failover.
Global Standard inference "may be processed in any Azure region"
([deployment types](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/deployment-types)); that does not
help when the Foundry account's own endpoint or the private endpoint path to it is unavailable. A second Foundry
account (table above) does.
The gateway and Function Apps are single-region: when their region is unavailable the gateway remains unavailable,
even if Cosmos survives. Check Azure Service Health; after recovery verify the private network (Stage 6 in `verify`
mode), then run Stage 8. Do not delete the Cosmos account or assume rerunning Stage 1 moves existing services.

For an approved maintenance window on a healthy **two-region, single-write** account, the following commands
**change the write region**; they are not a preview. Use the account's subscription, resource group and name.
Include every configured region with a unique priority; priority 0 is the writer
([CLI reference](https://learn.microsoft.com/cli/azure/cosmosdb#az-cosmosdb-failover-priority-change), checked 2026-10-27).

```powershell
$sub = '<subscription-id>'; $rg = '<resource-group>'; $account = '<cosmos-account>'
az cosmosdb show --subscription $sub -g $rg -n $account --query "{state:provisioningState,writes:writeLocations[].locationName,reads:readLocations[].locationName}"
az cosmosdb failover-priority-change --subscription $sub -g $rg -n $account --failover-policies southindia=0 centralindia=1
# Wait for Succeeded and confirm writeLocations names South India; run Stage 8 and check a group in the console.
az cosmosdb show --subscription $sub -g $rg -n $account --query "{state:provisioningState,writes:writeLocations[].locationName}"
# Switch back only after the drill checks and both regions are healthy.
az cosmosdb failover-priority-change --subscription $sub -g $rg -n $account --failover-policies centralindia=0 southindia=1
```

Confirm `Succeeded` and Central India as writer again, then rerun Stage 8. Stage 1's read-back checks the configured
priority order, so do not run it while the drill has reversed that order. Stage 8 proves end-to-end access but
does not prove reads used South India: the resolver normally still prefers Central India. To verify read routing, use
Cosmos DB's **Total Requests**, filtered by region and operation, during an isolated test
([monitoring](https://learn.microsoft.com/azure/cosmos-db/monitor-reference)); unrelated traffic can share those
metrics. A healthy manual writer switch is not a simulation of losing the gateway's region.

For a **read-route drill**, save the resolver app's `COSMOS_PREFERRED_REGIONS`, set it to `southindia,centralindia`
in Function App Configuration (restarts the app), then run Stage 8 and check regional read metrics. Afterwards
restore the saved value, wait for the restart, and repeat Stage 8. This tests a preference change, not an outage.

Next: [deploy](03-deploy.md).
