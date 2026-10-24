# 2. Prerequisites

Tick every line before Stage 0. Each item names who provides it. Details and least-privilege roles:
[staged guide, section 2](../STAGED-DEPLOYMENT-GUIDE.md#2-prerequisites).

## Single-subscription lab path

The 2026-10-24 lab used one Azure subscription and `network.mode: create`; Stage 6 created its own VNet and
integrations. Stages 0–8 took 62 minutes in that run. Times vary. API Management, Cosmos DB and Functions incur
charges while deployed; model calls add usage charges.

**Rough lab cost.** The largest fixed charge is API Management Standard v2: USD 0.96 per hour for one unit, about
USD 23 per day. Each private endpoint is USD 0.01 per hour; the lab has six, about USD 1.44 per day. The lab is
therefore about USD 25 per day before usage-based charges (Functions Flex Consumption, serverless Cosmos DB, storage,
Log Analytics and model tokens). Prices are USD list prices from the Azure Retail Prices API, retrieved 2026-10-24:
[API Management Standard v2, East US 2](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27API%20Management%27%20and%20armRegionName%20eq%20%27eastus2%27%20and%20skuName%20eq%20%27Standard%20v2%27)
(meter `Standard v2 Unit`) and
[Private Link](https://prices.azure.com/api/retail/prices?$filter=productName%20eq%20%27Virtual%20Network%20Private%20Link%27%20and%20armRegionName%20eq%20%27Global%27)
(meter `Standard Private Endpoint`, a Global price). Agreements and regions differ. Actual spend is in the Portal: the resource group → **Cost analysis**. Cost data for EA and MCA
subscriptions typically appears within 8–24 hours, and pay-as-you-go can take up to 72 hours
([Understand Cost Management data](https://learn.microsoft.com/azure/cost-management-billing/costs/understand-cost-mgt-data)).
Deleting the resource group stops these charges.

The lab path still needs a subscription with quota for the selected Claude models, a new empty resource group,
platform Contributor and Role Based Access Control Administrator access, and an Entra administrator or owners of
the three existing app registrations. Existing Entra apps and groups can be reused when approved. Set
`network.mode` to `create` only for a lab; production deployments use a customer-built network and `verify` mode.
The [demo evidence](../evidence/2026-10-24-demo/README.md) records which directory objects were reused.

## People and approvals

- [ ] **Platform engineer** with Contributor on a new, empty resource group (and permission to create it).
- [ ] **Access administrator** with Role Based Access Control Administrator on that resource group (Stage 3).
- [ ] **Entra administrator** for the three app registrations (Application Administrator, or owner of existing apps).
- [ ] **Privileged Role Administrator**, only if Microsoft Graph application permissions are approved (automatic
      group sync, group search, people's names).
- [ ] **Network team**, unless a lab creates its own network (`network.mode: create`).
- [ ] **Cost approval** for API Management Standard v2, Function Apps, Cosmos DB, Log Analytics and model usage.

## Tools (Azure Cloud Shell has them all)

- [ ] PowerShell 7.2 or later, Azure CLI with Bicep, Node.js 22 and npm, Git.

## Microsoft Foundry models

- [ ] Claude deployments that exist, or quota and purchase rights for Stage 1 to create them. Check the quota:

```powershell
az cognitiveservices usage list -l eastus2 -o table   # lines ending ".Azure" are Foundry Claude quota
```

## Network (customer-built mode)

- [ ] A virtual network with three subnets: Functions (delegated to `Microsoft.App/environments`), private
      endpoints, and API Management (delegated to `Microsoft.Web/serverFarms`, with an NSG).
- [ ] Private DNS zones for Cosmos DB, blob storage and Foundry, linked to the VNet.
- [ ] Outbound HTTPS from the Function Apps to Entra ID, Microsoft Graph and Azure Monitor.

Full list with NSG rules: [guide 2.2](../STAGED-DEPLOYMENT-GUIDE.md#22-network).

## Entra applications

Stage 4 creates them, or merges its settings into existing ones (`entra.existing`). What each must show when done:

| Application | Must show |
| --- | --- |
| **CCOF Gateway** | **Expose an API**: `api://<appId>` with the delegated scope `access_as_user` |
| **CCOF Resolver API** | `api://<appId>`, no secrets, no redirect URIs |
| **CCOF Admin** | **App roles** `CCOF.Projects.Read` and `CCOF.Projects.Write`; "Assignment required" on |

![Expected: CCOF Gateway, Expose an API, with the access_as_user scope](../evidence/2026-10-24-demo/portal-04-gateway-expose-api.png)

![Expected: CCOF Admin, App roles CCOF.Projects.Read and CCOF.Projects.Write](../evidence/2026-10-24-demo/portal-04-admin-roles.png)

## Entra groups

- [ ] One existing **security group** per team to onboard, with the developers as **direct members** (nested
      groups and devices are not counted).

![Expected: an existing security group and its direct members](../evidence/2026-10-24-demo/portal-04-group-members.png)

## Decide before you start

| Decision | Options | Where it is set |
| --- | --- | --- |
| How membership is read | **Automatic** (Graph permission granted, sync timer on) or **snapshot** (an operator applies changes) | `sync`, `syncTimerEnabled`; [guide 6.1](../STAGED-DEPLOYMENT-GUIDE.md#61-graph-grants-group-search-names-and-sync) |
| Dollar budgets enforced | `budget-state` (enforced) or `token-limits-only` | `resolver.budgetEnforcement` |
| Budget guard | Example: warn at 80%, rate allowance 5% per projection window; not a strict cap | `reconciler.budgetGuard`; [budgets](../operate/budgets-and-guard.md) |
| Cosmos DB redundancy | One region, or two regions with failover | `stage1.cosmosLocations`; [guide 2.6](../STAGED-DEPLOYMENT-GUIDE.md#26-cosmos-db-redundancy) |

Next: [deploy](03-deploy.md).
