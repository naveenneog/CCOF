# Staged deployment guide

This guide deploys CCOF (Claude Code on Foundry) in nine stages, 0 to 8, and then onboards Entra
groups. Each stage has a **Cloud Shell** way (one script command) and a **Portal (UI)** way (the
equivalent screens), and the same configuration file drives both. Every stage previews first and
changes nothing until it is run with `-Apply`.

| Part | Contents |
| --- | --- |
| [1. What gets deployed](#1-what-gets-deployed) | Components and the order of the stages |
| [2. Prerequisites](#2-prerequisites) | People and roles, network, Entra applications, Graph permissions, Foundry models |
| [3. Cloud Shell setup](#3-cloud-shell-setup) | Source code, sign-in, configuration file |
| [4. Stages 0 to 8](#4-stages-0-to-8) | Per stage: purpose, who, Cloud Shell command, Portal steps, how to check it |
| [5. Onboard groups](#5-onboard-groups) | Admin console steps after Stage 8 |
| [6. Optional features](#6-optional-features) | Group search, surface enforcement, Power BI export |
| [7. Rerun, rollback and cleanup](#7-rerun-rollback-and-cleanup) | |
| [8. References](#8-references) | |

Detailed background for each stage is in the [staged deployment runbook](runbooks/STAGED-DEPLOYMENT-V2.md)
and the [Portal workbook](runbooks/AZURE-PORTAL-DEPLOYMENT.md). This guide is the short path through them.

---

## 1. What gets deployed

| Component | Azure resource | Role |
| --- | --- | --- |
| Gateway | API Management (Standard v2) | Validates the caller's Entra token, asks the resolver who may call what, applies limits, forwards to Foundry, writes usage telemetry ([GATEWAY.md](GATEWAY.md)) |
| Resolver | Function App (Flex Consumption) | Turns a person into an entitlement decision: group, models, limits, surfaces, budget state |
| Sync | Function App | Reads Entra group membership and writes each person's entitlement document ([SYNC.md](SYNC.md)) |
| Reconciler | Function App | Prices usage at the rate card and writes budget state ([COST-MODEL.md](COST-MODEL.md)) |
| Admin console | Function App | Onboards groups, sets budgets and limits, shows chargeback, exports ([ADMIN-V3.md](ADMIN-V3.md)) |
| Registry | Cosmos DB (serverless) | Group documents, entitlements, budget state, admin change record |
| Telemetry | Log Analytics, Application Insights, workbook | Usage ledger and the chargeback workbook ([CHARGEBACK.md](CHARGEBACK.md)) |
| Models | Microsoft Foundry account with Claude deployments | Existing or created by Stage 1 |

Stage order and what each one needs:

```text
0 preflight ─▶ 1 resources ─▶ 2 schema ─▶ 3 grants ─▶ 4 Entra ─▶ 5 configuration ─▶ 6 network ─▶ 7 code and data ─▶ 8 acceptance ─▶ onboard groups
  read-only     Azure only     Azure only   RBAC        Graph       Azure only           VNet          needs the VNet       model calls      admin console
```

Stages 2 to 5 do not need the network, so the network team can build it while they run. Stage 7 needs
a verified Stage 6, because the apps reach their private storage and Cosmos only through the VNet
([runbook](runbooks/STAGED-DEPLOYMENT-V2.md), "Stages and permission boundaries").

---

## 2. Prerequisites

### 2.1 People and roles

Several people can share the work; each stage names who runs it.

| Stage | Who | Least role that works |
| --- | --- | --- |
| 0 | Platform engineer | Reader on the subscription, resource group and Foundry accounts; directory read of groups |
| 1 | Platform engineer | Contributor on the resource group, and `Microsoft.Resources/resourceGroups/write` on the subscription to create it. Marketplace purchase rights if Stage 1 creates Claude deployments |
| 2 | Platform engineer | Contributor on the Cosmos DB account |
| 3 | Access administrator | Role Based Access Control Administrator (or Owner) on the resource group, the Cosmos account and each Foundry account |
| 4 | Entra administrator | Application Administrator (or owner of existing apps) and Groups Administrator (or owner of existing groups) |
| 5 | Platform engineer | Website Contributor on the Function Apps, API Management Service Contributor, workbook write |
| 6 | Network team | Reader (verify mode). Network Contributor and Private DNS Zone Contributor in `existing`/`create` modes |
| 7 | Platform engineer | Website Contributor (publish); delegated read of the registered groups |
| 8 | Platform engineer | A gateway caller identity in an onboarded group; Log Analytics Reader |
| Graph grants (section 6.1) | Privileged Role Administrator or Global Administrator | Tenant-wide admin consent for application permissions |

Source: [runbook permission table](runbooks/STAGED-DEPLOYMENT-V2.md) and [PERMISSIONS.md](PERMISSIONS.md).

### 2.2 Network

The default (`network.mode: verify`) expects the customer's network team to build the network and has
Stage 6 check it without changing it. In `existing` mode Stage 6 uses the customer's subnets and DNS
zones and creates only the private endpoints, DNS zone groups and VNet integrations. In `create` mode
(labs) it also creates the VNet, subnets, NSG and DNS zones
([stage6-network.bicep](../infra/staged/stage6-network.bicep); [NETWORK.md](NETWORK.md)).

| Item | Requirement |
| --- | --- |
| Virtual network | One VNet in the deployment region (a region where Flex Consumption is available) |
| Functions subnet | Delegated to `Microsoft.App/environments`; used by all four Function Apps for outbound VNet integration |
| Private endpoint subnet | No delegation; holds every private endpoint |
| APIM subnet | Delegated to `Microsoft.Web/serverFarms`, with an NSG; used by Standard v2 APIM outbound VNet integration |
| Private endpoints | Cosmos DB (`Sql`), each Function App's storage account (`blob`), each private Foundry account (`account`) |
| Private DNS zones | `privatelink.documents.azure.com`, `privatelink.blob.core.windows.net`, and for Foundry `privatelink.cognitiveservices.azure.com`, `privatelink.openai.azure.com`, `privatelink.services.ai.azure.com`; each linked to the VNet, with a DNS zone group on each endpoint |
| Outbound from the Function Apps | HTTPS to Microsoft Entra ID, Microsoft Graph, Log Analytics and Application Insights (Azure Monitor). VNets created after 2026-03-31 have no default outbound access, so a NAT gateway or firewall provides it ([network.bicep](../infra/prereqs/network.bicep)) |
| APIM subnet NSG | Microsoft's minimum rules for APIM VNet integration. Inbound: Internet 80/443, `ApiManagement` 3443, `AzureLoadBalancer` 6390, `AzureTrafficManager` 443. Outbound: Internet 80 (certificate validation), `Storage` 443, `SQL` 1433, `AzureKeyVault` 443, `AzureMonitor` 443 and 1886 ([network.bicep](../infra/prereqs/network.bicep)) |
| Outbound from the operator's shell | HTTPS to Azure Resource Manager, Microsoft Graph, GitHub and the npm registry |

Stage 6 does not test firewall or route-table (UDR) egress. A missing egress path shows up later as a
Stage 7 or Stage 8 failure.

Cloud Shell runs on a public host. It can deploy and verify configuration, but it cannot test private
DNS resolution or routing from inside the VNet ([CLOUD-SHELL-QUICKSTART.md](runbooks/CLOUD-SHELL-QUICKSTART.md)).

### 2.3 Entra applications

Stage 4 creates these registrations, or merges settings into existing ones named in `entra.existing`
([infra/staged/Staged.Entra.ps1](../infra/staged/Staged.Entra.ps1)). The table lists what each one
needs, so an Entra administrator can also create them by hand (Portal path: **Microsoft Entra ID →
App registrations**).

| Application | Purpose | Settings Stage 4 applies |
| --- | --- | --- |
| **CCOF Gateway** (developer sign-in) | The audience of a developer's token, and the client that signs developers in | Application ID URI `api://<appId>`; access tokens v2; delegated scope `access_as_user`; public client redirect URIs `http://localhost` and `ms-appx-web://microsoft.aad.brokerplugin/<appId>`; "Allow public client flows" on; preauthorizes itself (and Azure CLI when `entra.allowAzureCliClient` is true) |
| **CCOF Resolver API** | Audience of the token APIM's managed identity presents to the resolver | Application ID URI `api://<appId>`; access tokens v2; no redirect URIs, no secrets |
| **CCOF Admin** | The admin console (single-page app) and its API | Delegated scope `Projects.Manage`; app roles `CCOF.Projects.Read` and `CCOF.Projects.Write` (users); SPA redirect URIs `https://<admin-app>.azurewebsites.net/api/console` and `/api/console-v3`; "Assignment required" on; preauthorizes itself; editors and readers from `entra.adminEditors`/`adminReaders` are assigned their role |

No application secret is created. APIM and the Function Apps use managed identities.

**Groups.** Each team that uses Claude is an existing Entra **security** group, created by the
customer's identity team (Portal: **Microsoft Entra ID → Groups → New group**, type Security). The
sync reads **direct** members only; nested groups are not expanded ([SYNC.md](SYNC.md)). The pilot
group is seeded by Stage 7; additional groups are onboarded in the admin console after Stage 8
([section 5](#5-onboard-groups)). The staged
configuration's `groups` list holds the pilot group used by the Stage 8 acceptance test. In the
example it is a group entry (`"kind": "group"`): its own budget, models, surfaces, priority and
chargeback ID, with no project or classification ([section 3.3](#33-configuration-file)).

### 2.4 Microsoft Graph application permissions

Granted to managed identities by a Privileged Role Administrator or Global Administrator, after
Stage 1 has created the identities. None is required to finish Stages 0 to 8.

| Identity | Permission | Why | Needed when |
| --- | --- | --- | --- |
| Sync | `GroupMember.Read.All` | Read the direct members of onboarded groups | The sync timer is turned on (`sync.mode: application-permission`). Without it, Stage 7 loads members from a delegated snapshot |
| Sync | `User.Read.All`, `Application.Read.All` | Detect disabled and deleted members | Same |
| Admin | `User.Read.All` | Show names beside object IDs (`admin.userNamesEnabled`, which sets `ADMIN_USER_NAMES_ENABLED=true`) on the User tags page and Developers view | Optional ([ADR-0032](adr/0032-admin-directory-user-labels.md)) |
| Admin | `Group.ReadBasic.All`, `GroupMember.ReadBasic.All` | Search Entra groups and show the member count when onboarding (`admin.groupSearchEnabled`) | Optional; without it the admin pastes the group's Object ID ([ADMIN-API.md](ADMIN-API.md)) |

Least-privilege sources: [List group members](https://learn.microsoft.com/en-us/graph/api/group-list-members?view=graph-rest-1.0)
and [List groups](https://learn.microsoft.com/en-us/graph/api/group-list?view=graph-rest-1.0). The
grant helper is in [section 6.1](#61-graph-grants-group-search-names-and-sync).

### 2.5 Foundry models

Either an existing Foundry account with Claude deployments (listed under `backends`), or Stage 1
creates one (`stage1.foundry.create: true`), which requires a subscription that can purchase the Claude
offer from Azure Marketplace. A sandbox subscription cannot ([run report](STAGED-STDV2-RUNS-2026-10-20.md)).

---

## 3. Cloud Shell setup

Azure Portal → **Cloud Shell** (top bar) → **PowerShell**.

### 3.1 Source code

```powershell
$repo = '<repository-url>'       # the Git URL of this repository
cd $HOME
if (-not (Test-Path ccof)) { git clone $repo ccof }
cd $HOME/ccof
git pull --ff-only
npm ci --ignore-scripts --include=dev
```

Expected: `npm ci` finishes without errors. The group-centric version described here is not in the
public `naveenneog/ccof-bicep` repository, whose history ends before ADR-0034.

### 3.2 Sign-in and subscription

```powershell
$tenant = '<tenant-id>'          # Microsoft Entra ID > Overview > Tenant ID
$sub    = '<subscription-id>'
az account set --subscription $sub
az account show --query "{tenant:tenantId, subscription:id, user:user.name}" -o table
```

Expected: the target tenant and subscription. Cloud Shell drops variables after a timeout; this
block is pasted again after a reconnect.

### 3.3 Configuration file

```powershell
New-Item -ItemType Directory -Force $HOME/ccof-private | Out-Null
Copy-Item infra/staged/staged.config.example.json $HOME/ccof-private/staged.config.json
code $HOME/ccof-private/staged.config.json
$cfg = "$HOME/ccof-private/staged.config.json"
```

The driver refuses the file until every `REPLACE-` placeholder is replaced. The sections, and the
stages that read them, are listed in the [runbook](runbooks/STAGED-DEPLOYMENT-V2.md#configuration-file).
Settings added for group onboarding:

| Key | Default | Meaning |
| --- | --- | --- |
| `groups[]` with `"kind": "group"` | example pilot | An Entra group onboarded as its own entity: `groupDisplayName` (Stage 4 creates or reuses it) or `groupId`, `members`, `displayName`, `backendId`, `priority`, `chargebackId` (or `null`), `budget` (`autoScale` with `groupCap: null`, or `cap` with a cap), `restrictedFamiliesApproved`, `familyPolicy`, `surfaces`, `cacheProfile`. No `projectId` or `classification`. Stage 7 seeds it as a group document; the sync app's `registrySeed` function checks it against the group contract ([group-registration.ts](../src/contracts/group-registration.ts)) and writes nothing if it fails. Entries with `projectId` and `classification` keep the earlier project model |
| `client.group` | `CCOF-PILOT01` | The group entry (by `groupDisplayName` or `groupId`) the developer client file is written for, with `client.models`. The client sends the group's object ID as the project selector |
| `acceptance` | no `project` | Stage 8 requests without a project selector, and checks in the usage trace that every request was charged to the pilot group. With more than one group entry, `acceptance.expectedGroup` names the expected one (`groupDisplayName` or `groupId`) |
| `admin.groupSearchEnabled` | `false` | Sets `ADMIN_GROUP_SEARCH_ENABLED` on the admin app (Stage 5). Requires the admin Graph grants in section 6.1; without them the admin API answers `502 group_directory_permission_required`. Ignored when `stage1.includeAdmin` is `false` |
| `admin.userNamesEnabled` | `false` | Sets `ADMIN_USER_NAMES_ENABLED` on the admin app (Stage 5): people's names beside object IDs (User tags page, Developers view). Requires the admin identity's `User.Read.All` (section 6.1); without it the console shows object IDs only |
| `gateway.surfaceClients` | `[]` | `[{ "clientAppId": "<guid>", "surface": "code" }]`: maps a client application to `chat`, `code`, `cowork`, `design` or `m365`. Empty means surfaces are not enforced. Each client must be admitted by the gateway. In the staged path the admitted clients are the CCOF Gateway app (Stage 4) and, when `entra.allowAzureCliClient` is `true`, Azure CLI (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) ([Staged.Application.ps1](../infra/staged/Staged.Application.ps1)). Any other client ID stops Stage 5 with `render_failed` and the message "`<id>` is not in delegatedClientAppIds or testIdentities.clientAppIds" ([config.ts](../infra/gateway/config.ts)) |

The state of each stage is written next to the configuration file in `.staged-state/state.json`. One
state folder belongs to one tenant, subscription and resource group.

The common command, shown for Stage 1 (the stage number changes per stage):

```powershell
pwsh -File infra/staged/Invoke-StagedDeployment.ps1 -Stage 1 -ConfigPath $cfg            # preview
pwsh -File infra/staged/Invoke-StagedDeployment.ps1 -Stage 1 -ConfigPath $cfg -Apply     # change, then verify
```

A stage that fails its read-back stops with `verify_failed: <reason>` and records nothing, so it can be
run again after the cause is fixed.

---

## 4. Stages 0 to 8

Each stage lists: what it does, who runs it, the Cloud Shell command, the Portal equivalent (section
numbers of the [Portal workbook](runbooks/AZURE-PORTAL-DEPLOYMENT.md)), and how to see that it worked.

### Stage 0: preflight (read-only)

- **Does:** checks the tenant, provider registrations, an empty or approved resource group, Flex
  Consumption in the region, the Foundry deployments and the groups. Changes nothing.
- **Who:** platform engineer (Reader).
- **Cloud Shell:** `pwsh -File infra/staged/Invoke-StagedDeployment.ps1 -Stage 0 -ConfigPath $cfg`
- **Portal:** workbook sections 01 and 02 (subscription, resource providers, resource group); 07 for
  Foundry deployments.
- **Worked when:** the output ends with the operator, providers `Registered`, every existing backend
  deployment found, and for a Foundry account that Stage 1 will create, the planned model and SKU
  available in the region. `state.json` holds stage `0`.

### Stage 1: resources

- **Does:** creates the resource group, Log Analytics and Application Insights, the Cosmos DB account,
  storage, managed identities, the resolver, sync, reconciler and admin Function Apps, optionally APIM
  and a Foundry account. No settings, schema, role assignments, network attachments or code.
- **Who:** platform engineer.
- **Cloud Shell:** preview, then `-Apply` (common command, `-Stage 1`).
- **Portal:** workbook sections 04, 05, 07 (optional Foundry), 08 (Cosmos account), 09, 10, 11.
- **Worked when:** the read-back reports every app with zero settings, keyless storage, no database
  and zero role assignments ([STAGE1-LIVE-VERIFICATION.md](STAGE1-LIVE-VERIFICATION.md)).

### Stage 2: Cosmos schema

- **Does:** creates the `ccof` database and eight containers: `entitlement`, `projects` (group
  documents live here), `subscriptionIndex`, `budgetState`, `aggregateBudgetState`, `syncLease`,
  `reconcilerLease`, `backends`; plus `adminConfig` when the admin app is included
  ([stage2-schema.bicep](../infra/staged/stage2-schema.bicep)).
- **Who:** platform engineer.
- **Cloud Shell:** `-Stage 2`, preview then `-Apply`.
- **Portal:** workbook section 08 (Cosmos DB → Data Explorer).
- **Worked when:** every container exists with its partition key, and there are still no data-plane
  role assignments.

### Stage 3: runtime grants

- **Does:** gives each managed identity the least access it needs: storage and metrics for each app,
  Cosmos SQL roles per container, Log Analytics Reader for the reconciler and admin, and Cognitive
  Services User for APIM on each Foundry account
  ([runbook grant list](runbooks/STAGED-DEPLOYMENT-V2.md)).
- **Who:** access administrator.
- **Cloud Shell:** `-Stage 3`, preview then `-Apply`.
- **Portal:** workbook section 15 (Access control (IAM) per resource; Cosmos data-plane roles through
  the Cloud Shell block shown there, because the Portal has no screen for them).
- **Worked when:** the read-back lists every assignment by principal and scope and finds none for
  other principals.

### Stage 4: Entra applications and the pilot group

- **Does:** creates or updates the three applications in [section 2.3](#23-entra-applications), and the
  pilot group from the configuration's `groups` list with its members.
- **Who:** Entra administrator.
- **Cloud Shell:** `-Stage 4`, preview then `-Apply`.
- **Portal:** workbook section 06 (App registrations: Expose an API, App roles, Authentication;
  Enterprise applications: Users and groups; Groups).
- **Worked when:** the read-back confirms the identifier URI, v2 tokens, the `access_as_user` scope
  and the admin app's preauthorized clients.

### Stage 5: configuration

- **Does:** renders and deploys the gateway policy, the APIM API, backends and diagnostics; writes
  every Function App's settings and the resolver's authentication; deploys the chargeback workbook.
  Sets `ADMIN_GROUP_SEARCH_ENABLED` from `admin.groupSearchEnabled` and `entra.surfaceClients` from
  `gateway.surfaceClients`. Timer state follows `syncTimerEnabled` and `reconciler.timerEnabled`
  (both `false` in the example). The sync timer is turned on only after its Graph grant
  ([section 6.1](#61-graph-grants-group-search-names-and-sync)).
- **Who:** platform engineer.
- **Cloud Shell:** `-Stage 5`, preview then `-Apply`.
- **Portal:** workbook sections 17 (Function Apps → Environment variables, Authentication), 19 (APIM →
  APIs, Policies, Backends), 20 (Diagnostic settings and workbook).
- **Worked when:** each app lists its settings, the resolver answers `401` without a token, and the
  API path and policy hash match.

### Stage 6: network

- **Does:** with `network.mode: verify`, checks the network from [section 2.2](#22-network) and changes
  nothing. With `existing`, creates the private endpoints and VNet integrations in the customer's
  subnets; with `create` (labs only), also creates the VNet, subnets and DNS zones.
- **Who:** network team.
- **Cloud Shell:** `-Stage 6`, preview then `-Apply` (in verify mode, `-Apply` only runs the check).
- **Portal:** workbook sections 03 and 12 (Virtual networks, Private endpoints, Private DNS zones,
  Function App → Networking, APIM → Network).
- **Worked when:** the stage completes, and `.staged-state/evidence/stage6.verify.json` shows correct
  subnet delegations, every endpoint Approved in the private endpoint subnet with a DNS zone group,
  the zones linked to the VNet, and every app and the Standard v2 APIM VNet-integrated. In verify
  mode an endpoint in the wrong subnet or without a DNS zone group is a `WARN`, which does not stop
  the stage; every `WARN` in the evidence is resolved before Stage 7.

### Stage 7: code and initial data

- **Does:** publishes the four Function App packages, seeds the registry (backends and the pilot
  group's group document), loads the pilot group's members from a delegated snapshot through the
  sync app, and writes the developer client file for `client.group`.
- **Who:** platform engineer.
- **Cloud Shell:** `-Stage 7`, preview then `-Apply`. One Stage 7 at a time per checkout.
- **Portal:** workbook sections 18 (Deployment Center), 21 (registry seed), 22 (client configuration).
- **Worked when:** every app lists its functions, the seed reports each document `created` (or
  `present-equal` on a rerun), the snapshot is applied and the client file passes the validator. A
  group entry that fails the group contract stops the seed with `seed_refused` and the field paths,
  and nothing is written. Before any write, Stage 7 reads each group from Graph again and stops with
  `group_missing` if one was deleted since Stage 4.
- **Limits and recovery:** the seed is create-only and travels in one app setting of at most 96 KiB
  of base64 (7,000 characters when `az` runs on Windows, so Cloud Shell is used for more than a few
  groups) ([registry-seed.ts](../src/sync/registry-seed.ts), [Deploy-Quickstart.ps1](../infra/quickstart/Deploy-Quickstart.ps1)).
  A document already present is reported `present-equal`, or `present-differs` with the field names,
  and is never replaced; a pilot group that needs a change after seeding is edited in the admin
  console. A rerun of Stage 7 after a failure seeds only what is missing.

### Stage 8: acceptance

- **Does:** calls the gateway: without a token (`401`), as an allowed caller (`200`), for a model
  that is not allowed (`403`); calls the admin endpoints; and finds every accepted call in
  `ApiManagementGatewayLlmLog`. With the example configuration the requests carry no project
  selector, so the caller's group with the higher month-to-date spend applies ([ADR-0034](adr/0034-group-centric-onboarding.md));
  Stage 8 reads the `ccof.usage.v1` trace and stops with `verify_failed` unless every request was
  charged to the expected pilot group.
- **Who:** platform engineer with a caller identity in the pilot group.
- **Cloud Shell:** `-Stage 8`, preview then `-Apply`.
- **Portal:** workbook section 22 (acceptance) and Log Analytics → Logs.
- **Worked when:** `stage8.verify.json` shows the full `401`/`200`/`403` matrix and the telemetry rows.

---

## 5. Onboard groups

Done in the admin console by an editor (role `CCOF.Projects.Write`), after Stage 8. The console is at
`https://<admin-app>.azurewebsites.net/api/console-v3`. Each step is described in the console's Help
panel and in [ADMIN-V3.md](ADMIN-V3.md) (3.4.0).

| Step | Screen | What is decided |
| --- | --- | --- |
| 1 | **Groups → Onboard a group → Find the group** | The Entra security group (search, or paste its Object ID), its display name and the Foundry backend |
| 2 | **Budget** | Per-user monthly budget (USD or CCU). **Auto-scale**: every member gets it and the group has no total. **Cap**: members share one monthly total. The screen shows the total for the current direct members |
| 3 | **Access and models** | Allowed surfaces; the group's default chargeback ID (used for members without a user tag); priority (when a person is in several groups and names none, the group where they have the higher spend this month wins, then the lower priority); model families and rate limits; restricted families (Fable, Mythos) only when approved; expected cache-read share (suggested from the surfaces, with its evidence); the budget assistant |
| 4 | **Review** | The request that is sent. **Onboard group** saves it |
| 5 | **User tags → Tag a person** | Each member's own chargeback ID (for example a WBS element), by Entra object ID. Saved tags are suggested while typing |

Members get access, and their user tags, at the next entitlement sync: when the sync timer is on, or
after a delegated snapshot as in Stage 7. A group is retired on its detail page; the next sync removes
every member's access and the Entra group itself is not changed.

The rules behind these settings are in [ADR-0034](adr/0034-group-centric-onboarding.md). Precedence
(higher month-to-date spend, then lower priority), user tags and removal by retirement are owner decisions
of 2026-10-23 ([UNKNOWNS](UNKNOWNS.md) G-A1 to G-A3).

---

## 6. Optional features

### 6.1 Graph grants: group search, names and sync

A Privileged Role Administrator or Global Administrator runs the grant helper in Cloud Shell. It
refuses to run without an active privileged role, skips grants that exist and prints the rollback
([infra/quickstart/Grant-SyncGraphPermissions.ps1](../infra/quickstart/Grant-SyncGraphPermissions.ps1)).
The principal IDs are in `.staged-state/state.json` under `stages` → `1` → `outputs` → `principals`
(keys `admin` and `sync`):

```powershell
$state = Get-Content "$HOME/ccof-private/.staged-state/state.json" -Raw | ConvertFrom-Json -AsHashtable
$state.stages['1'].outputs.principals['admin']
$state.stages['1'].outputs.principals['sync']
```

```powershell
# Admin console: group search and member counts (onboarding, User tags member picker) and people's names
# (User tags page, Developers view). Then set admin.groupSearchEnabled and admin.userNamesEnabled to true
# in the configuration and rerun Stage 5, which writes ADMIN_GROUP_SEARCH_ENABLED and ADMIN_USER_NAMES_ENABLED.
pwsh -File infra/quickstart/Grant-SyncGraphPermissions.ps1 -SyncPrincipalId '<admin principal id>' -Permissions Group.ReadBasic.All,GroupMember.ReadBasic.All,User.Read.All -PlanOnly
pwsh -File infra/quickstart/Grant-SyncGraphPermissions.ps1 -SyncPrincipalId '<admin principal id>' -Permissions Group.ReadBasic.All,GroupMember.ReadBasic.All,User.Read.All

# Sync: read group members on a timer (then set syncTimerEnabled to true and rerun Stage 5)
pwsh -File infra/quickstart/Grant-SyncGraphPermissions.ps1 -SyncPrincipalId '<sync principal id>' -PlanOnly
pwsh -File infra/quickstart/Grant-SyncGraphPermissions.ps1 -SyncPrincipalId '<sync principal id>'
```

`-PlanOnly` prints what would be granted and changes nothing. The helper refuses with "REFUSED: the signed-in
account holds no active Privileged Role Administrator or Global Administrator role" when the role is not active;
after activating it in PIM, `az login` again so the new token carries the role. Graph application permissions
reach the app as roles in its managed identity token, which the platform caches for about 24 hours; a new grant
can take several hours to take effect, and a token refresh cannot be forced
([Learn: limitation of using managed identities for authorization](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/managed-identity-best-practice-recommendations#limitation-of-using-managed-identities-for-authorization)).
Until then group search answers `502 group_directory_permission_required` and names show as object IDs.

Portal equivalent: workbook section 16. A managed identity has no API-permissions page in the
Portal, so the Portal path is: activate the role in **Privileged Identity Management → My roles**,
then run the same helper in Cloud Shell. Without the sync grant, the sync timer stays off and members
are loaded from a delegated snapshot, as in Stage 7.

### 6.2 Surface enforcement

The gateway identifies a surface from the token's client application (`azp`/`appid`), which a client
cannot change. Claude Code and the Claude Office add-ins (through an LLM gateway) can be routed through
CCOF; Cowork runs on Anthropic's servers and Microsoft 365 Copilot's own Claude models do not pass
through a customer gateway ([UNKNOWNS](UNKNOWNS.md) G-R2). To enforce surfaces, list each admitted
client application in `gateway.surfaceClients`, rerun Stage 5, and allow the surfaces per group in the
console. A group request from an unmapped client is then refused `403 surface_not_allowed`.
Deployment order: resolver and sync packages first (Stage 7), gateway policy second (Stage 5 rerun).

### 6.3 Chargeback and Power BI

The chargeback workbook and the console's **User tags** view list usage per user tag (chargeback ID)
and developer; the **Developers** view shows each developer's tags, and the **User tag** filter (with
saved-tag suggestions) narrows every view ([CHARGEBACK.md](CHARGEBACK.md)). **Groups → Usage CSV** and **Groups CSV** download the
data for Power BI or a spreadsheet; the API forms are `GET /api/v3/export/usage` and
`GET /api/v3/export/groups` ([ADMIN-API.md](ADMIN-API.md), "Export for Power BI"). A direct Power BI
connection to the API is not yet verified ([UNKNOWNS](UNKNOWNS.md) G-R3).

---

## 7. Rerun, rollback and cleanup

- **Rerun:** every stage can be rerun; deployments are incremental with deterministic names. A Stage 1
  that already succeeded for the same configuration is read-back only. Stage 1 refuses a non-empty
  resource group (`rg_not_empty`) unless `sharedResourceGroup` is `true`; then it applies only when
  what-if shows no Modify or Delete of resources it did not create (`shared_rg_changes`).
- **Changed prerequisite:** a stage refuses to use a prerequisite stage that was rerun with different
  outputs (`stage_dependency_changed`); rerun the later stages in order.
- **Rollback of a group:** retire it in the console. Rollback of Graph grants: the helper prints a
  `DELETE` for each grant it made.
- **Cleanup of a lab:** delete the resource group, and the app registrations and pilot group that
  Stage 4 created (its output prints `created group …`; `stage4.verify.json` lists the IDs). Objects
  named in `entra.existing` or `groups[].groupId`, or found by display name, were reused, not
  created, and are not deleted. The [run report](STAGED-STDV2-RUNS-2026-10-20.md) lists what a lab
  run created.

---

## 8. References

| Topic | Document |
| --- | --- |
| Stage internals, configuration sections, permission boundaries | [runbooks/STAGED-DEPLOYMENT-V2.md](runbooks/STAGED-DEPLOYMENT-V2.md) |
| Every Portal screen, step by step | [runbooks/AZURE-PORTAL-DEPLOYMENT.md](runbooks/AZURE-PORTAL-DEPLOYMENT.md) |
| Cloud Shell quickstart (integrated, not staged) | [runbooks/CLOUD-SHELL-QUICKSTART.md](runbooks/CLOUD-SHELL-QUICKSTART.md) |
| Network design | [NETWORK.md](NETWORK.md) |
| Permissions | [PERMISSIONS.md](PERMISSIONS.md) |
| Gateway behaviour and refusals | [GATEWAY.md](GATEWAY.md) |
| Group model decision | [adr/0034-group-centric-onboarding.md](adr/0034-group-centric-onboarding.md) |
| Admin console and API | [ADMIN-V3.md](ADMIN-V3.md), [ADMIN-API.md](ADMIN-API.md) |
| Chargeback | [CHARGEBACK.md](CHARGEBACK.md) |
| Live run evidence | [STAGED-STDV2-RUNS-2026-10-20.md](STAGED-STDV2-RUNS-2026-10-20.md) |
