# 2. Prerequisites

Tick every line before Stage 0. Each item names who provides it. Details and least-privilege roles:
[staged guide, section 2](../STAGED-DEPLOYMENT-GUIDE.md#2-prerequisites).

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
