# 3. Deploy: Stages 0–8

Nine stages, run in order from Azure Cloud Shell or from PowerShell 7 (`pwsh`) on Windows or macOS
([install the tools](02-prerequisites.md#install-the-tools)). Every stage first **previews** and changes nothing;
the same command with `-Apply` makes the change and then reads it back. A stage that fails its read-back stops
with `verify_failed: <reason>` and records nothing, so it can be run again.

The captures on this page come from one demo deployment on 2026-10-24
([evidence](../evidence/2026-10-24-demo/README.md)). Names and IDs in them are hypothetical replacements of the
real ones, in the same format. Every setting and the Portal way of each stage: [staged guide](../STAGED-DEPLOYMENT-GUIDE.md#4-stages-0-to-8).

## Before Stage 0: get the code and write the configuration

On your own computer, sign in first in `pwsh`: `az login --tenant '<tenant-id>'`. Cloud Shell is already signed in.

```powershell
cd $HOME; git clone https://github.com/naveenneog/CCOF.git ccof; cd ccof
npm ci --ignore-scripts --include=dev
az account set --subscription '<subscription-id>'
New-Item -ItemType Directory -Force $HOME/ccof-private | Out-Null
Copy-Item infra/staged/staged.config.example.json $HOME/ccof-private/staged.config.json
code $HOME/ccof-private/staged.config.json
$cfg = "$HOME/ccof-private/staged.config.json"
$run = "infra/staged/Invoke-StagedDeployment.ps1"
```

Without VS Code on a Mac, use `nano $HOME/ccof-private/staged.config.json` (Ctrl+O saves, Ctrl+X exits).

Set the main deployment values first:

```json
{
  "tenantId": "<tenant-guid>",
  "subscriptionId": "<subscription-guid>",
  "resourceGroup": "ccof-lab-rg",
  "location": "eastus2",
  "stage1": {
    "prefix": "ccoflab",
    "foundry": {
      "create": true,
      "accountName": "<unique-foundry-name>"
    }
  },
  "network": {
    "mode": "create"
  }
}
```

This is an example of the main choices, not a complete configuration file. Keep the copied template and fill every
applicable `REPLACE-` value, including backend and group settings. With `network.mode: create` the three
`network.existing` subnet IDs are not used and can keep their `REPLACE-` values. `workbook.resourceName` takes a
new GUID: `[guid]::NewGuid()`. Use `network.mode: create` only for a lab.

**Stage 1 is create-only.** Once Stage 1 has run, its `stage1` values cannot be changed in that resource group;
a different value means a new resource group. Check these before the first `-Apply`:

| Setting | Template | Lab (2026-10-24 and 2026-10-25 runs) | Why |
| --- | --- | --- | --- |
| `stage1.approveNewPublicApimBootstrap` | `false` | `true`, with `apimPublisherEmail` and `apimPublisherName` | `false` creates no API Management; then `apim.existing` must name one ([existing API Management](existing-api-management.md)). Stage 0 refuses neither or both |
| `stage1.functionsPublicNetworkAccess` | `Disabled` | `Enabled` | `Disabled` closes the apps and their deployment (SCM) endpoint to the internet ([App Service access restrictions](https://learn.microsoft.com/azure/app-service/overview-access-restrictions)): Stage 7 publishing and the admin console then need a machine on the VNet ([network](../NETWORK.md)) |
| `stage1.cosmosLocations` | `eastus2` + `centralus`, zone-redundant | `isZoneRedundant: false`, or one region with `cosmosCapacityMode: serverless` | Zone-redundant Cosmos DB capacity was refused in East US 2 ([guide 2.6](../STAGED-DEPLOYMENT-GUIDE.md#26-cosmos-db-redundancy)) |
| `stage1.foundry.deployments` | Claude 4.5 and 5 | Deployments that match free quota ([prerequisites](02-prerequisites.md#microsoft-foundry-models)) | Quota differs per subscription |
| `backends[].privateEndpoint` (the backend for the new Foundry account) | `false` | `true` | `stage1.foundry.publicNetworkAccess: Disabled` leaves the gateway only a private endpoint to Foundry. Stage 0 refuses the two disagreeing |

These settings are not create-only, but the template's values differ from what the README describes:

| Setting | Template | For dollar budgets |
| --- | --- | --- |
| `resolver.budgetEnforcement` | `token-limits-only` (token limits, no dollar budget) | `budget-state` ([budgets](../operate/budgets-and-guard.md)) |
| `reconciler.timerEnabled` | `false` | `true`: the reconciler prices usage on its schedule |
| `groups[].budget.perUser` | `25000` `CCU` | For example `100` `USD` |

The template turns on the audit archive and shows chargeback history switched off
([prerequisites, Decide before you start](02-prerequisites.md#decide-before-you-start)):

| Setting | Template | Effect |
| --- | --- | --- |
| `audit.archive.enabled` | `true` | Stage 5 creates a storage account with a copy of every gateway request log ([audit archive](../operate/audit-archive.md)). `false` creates nothing |
| `audit.chargebackHistory.enabled` | `false` | `true`: Stage 2 creates the Cosmos DB container `chargebackDaily` for daily chargeback totals ([chargeback history](../operate/chargeback-history.md)). `true` needs `reconciler.timerEnabled: true`, which the template leaves off, so Stage 0 refuses `true` alone; set both to `true` together. `false` creates nothing |

Every key, with create-new and reuse-existing JSON, the allowed values and a complete sample: [configuration reference](configuration.md). The full key reference is [guide 3.3](../STAGED-DEPLOYMENT-GUIDE.md#33-configuration-file). For each stage, run
without `-Apply`, review the preview with its owner, then run with `-Apply`. Each preview ends with
`stage N preview only: nothing changed. Rerun with -Apply.`; Stage 0 is read-only and has no `-Apply` step.

**Developer sign-in method.** Chosen in [prerequisites, Decide before you start](02-prerequisites.md#decide-before-you-start):
`client.signInMethod` (`msal` or `azure-cli`), and for `azure-cli` also `entra.allowAzureCliClient: true`, set
before Stage 4 ([guide 6.6](../STAGED-DEPLOYMENT-GUIDE.md#66-azure-cli-developer-sign-in)). Developers run the
same setup and sign-in commands either way.

---

## Stage 0 — Preflight (read-only)

**Who:** platform engineer · **Time:** about 1 minute · **Changes:** nothing in Azure

```powershell
pwsh -File $run -Stage 0 -ConfigPath $cfg
```

**Expected:** providers `Registered`, the region, the planned Foundry deployments, the operator, and the last line
`stage 0 completed and verified in … s`.

![Expected Stage 0 output](../evidence/2026-10-24-demo/terminal-stage0.png)

## Stage 1 — Resources

**Who:** platform engineer · **Time:** about 5 minutes · **Creates:** the resource group, Log Analytics, Application
Insights, Cosmos DB account, storage, managed identities, four Function Apps, API Management, the Foundry account and
its Claude deployments. No settings, data or role assignments yet.

```powershell
pwsh -File $run -Stage 1 -ConfigPath $cfg          # preview
pwsh -File $run -Stage 1 -ConfigPath $cfg -Apply
```

**Expected:** `deployed stage1-services (…)` and `stage 1 completed and verified in … s`.

![Expected Stage 1 output](../evidence/2026-10-24-demo/terminal-stage1.png)
![Expected in the Portal: the resource group's Deployments, one per stage](../evidence/2026-10-24-demo/portal-01-rg-deployments.png)
![Expected in the Portal: the Foundry account with its Claude deployments](../evidence/2026-10-24-demo/portal-01-foundry-overview.png)

## Stage 2 — Cosmos DB schema

**Who:** platform engineer · **Time:** about 3 minutes · **Creates:** the `ccof` database and its containers.

```powershell
pwsh -File $run -Stage 2 -ConfigPath $cfg          # preview
pwsh -File $run -Stage 2 -ConfigPath $cfg -Apply
```

**Expected:** `deployed stage2-schema (…)` and `stage 2 completed and verified in … s`. With chargeback history on,
`$HOME/ccof-private/.staged-state/evidence/stage2.verify.json` lists the `chargebackDaily` container.

![Expected Stage 2 output](../evidence/2026-10-24-demo/terminal-stage2.png)

## Stage 3 — Runtime role assignments

**Who:** access administrator · **Time:** about 6 minutes · **Creates:** each managed identity's Azure and Cosmos DB
roles, and Cognitive Services User for API Management on the Foundry account. Not Microsoft Graph permissions.

```powershell
pwsh -File $run -Stage 3 -ConfigPath $cfg          # preview
pwsh -File $run -Stage 3 -ConfigPath $cfg -Apply
```

**Expected:** `deployed stage3-grants (…)` and `stage 3 completed and verified in … s`.

![Expected Stage 3 output](../evidence/2026-10-24-demo/terminal-stage3.png)
![Expected in the Portal: Foundry, Access control (IAM), API Management with Cognitive Services User](../evidence/2026-10-24-demo/portal-03-foundry-iam.png)

## Stage 4 — Entra applications and groups

**Who:** Entra administrator · **Time:** about 1 minute · **Creates or updates:** the three app registrations
([prerequisites](02-prerequisites.md#entra-applications)) and, when the configuration names them, the groups.

```powershell
pwsh -File $run -Stage 4 -ConfigPath $cfg          # preview
pwsh -File $run -Stage 4 -ConfigPath $cfg -Apply
```

**Expected:** one line per application (`reuse existing …` or `created …`) and `stage 4 completed and verified in … s`.
For each reused application the preview lists what the apply changes (redirect URIs, rewritten scopes,
`create service principal`, `require user assignment`) or prints `no change`. Review it with the application's owner
before `-Apply`; Stage 4 never removes entries.

![Expected Stage 4 output](../evidence/2026-10-24-demo/terminal-stage4.png)

## Stage 5 — Configuration

**Who:** platform engineer · **Time:** about 2 minutes · **Writes:** every app's settings, the resolver's
authentication, the gateway API, its policy (as policy fragments), the `/usage` operation and the chargeback
workbook.

```powershell
pwsh -File $run -Stage 5 -ConfigPath $cfg          # preview
pwsh -File $run -Stage 5 -ConfigPath $cfg -Apply
```

**Expected:** a JSON line with the policy digests; one `audit archive: <account> in <region>, blobs …;
diagnostic setting ccof-gateway-archive (GatewayLogs, GatewayLlmLogs); workspace retention …` line, or
`audit archive: off; an existing ccof-gateway-archive diagnostic setting keeps exporting` when the archive is off
(the off preview also prints the manual deletion command; `<region>` is as API Management reports it, for example
`East US 2`); `deployed stage5-config (…)`; with the archive on and `-Apply`, `audit archive:
<account> network public-enabled (…), trusted services allowed` (or `public-disabled` when a storage policy turned
public network access off); and `stage 5 completed and verified in … s`. The demo capture below predates the archive and has no `audit archive:`
line. Checks for the archive: [audit archive](../operate/audit-archive.md#check-it-works).

![Expected Stage 5 output](../evidence/2026-10-24-demo/terminal-stage5.png)
![Expected in the Portal: API Management, the Claude Messages API](../evidence/2026-10-24-demo/portal-05-apim-apis-preview.png)
![Expected in the Portal: API Management, one policy fragment per policy section](../evidence/2026-10-24-demo/portal-05-apim-policy-fragments.png)
![Expected in the Portal: the resolver requires authentication](../evidence/2026-10-24-demo/portal-05-resolver-auth.png)

## Stage 6 — Network

**Who:** network team · **Time:** about 15 minutes (API Management VNet integration) · **Creates or checks:**
private endpoints, DNS zone links, Function App and API Management VNet integration. In `verify` mode it only checks.

```powershell
pwsh -File $run -Stage 6 -ConfigPath $cfg          # preview
pwsh -File $run -Stage 6 -ConfigPath $cfg -Apply
```

**Expected:** `… integrated with snet-functions` per app, the API Management wait, and `stage 6 completed and verified in … s`.

![Expected Stage 6 output](../evidence/2026-10-24-demo/terminal-stage6.png)
![Expected in the Portal: Foundry networking, public access disabled, private endpoint](../evidence/2026-10-24-demo/portal-06-foundry-networking.png)
![Expected in the Portal: a Function App's outbound VNet integration](../evidence/2026-10-24-demo/portal-06-function-networking.png)

## Stage 7 — Code and initial data

**Who:** platform engineer · **Time:** about 25 minutes · **Publishes** the four Function App packages, **seeds**
the backend and the groups in the configuration, **applies** a membership snapshot, and writes the developer
client file. One Stage 7 at a time per checkout.

Before publishing, Stage 7 tries a short read-only check of the group documents. When the operator can reach Cosmos DB
and a group differs, the apply stops before publishing unless `stage7.keepDifferingGroups: true`. Otherwise it warns
and continues; the seed step still checks for drift after publishing.

```powershell
pwsh -File $run -Stage 7 -ConfigPath $cfg          # preview
pwsh -File $run -Stage 7 -ConfigPath $cfg -Apply
```

**Expected**, in this order:

- [ ] three `Deploying the … package … (OneDeploy)` lines and a `Built …/admin.zip sha256=…` line;
- [ ] `Seeding … documents`, then `… : created` for the backend and for each group (groups are stored in the
      `projects` container);
- [ ] a `ccof.sync.run.v1` line with `"outcome":"succeeded"`, `"membersAdmitted"` above 0 and `"writeFailures":0`;
- [ ] `Configure this machine: pwsh -File scripts/client/Set-ClaudeCodeGateway.ps1 …`, the command for developers;
- [ ] the last line `stage 7 completed and verified in … s`.

A rerun prints `present-equal` instead of `created` for documents that already exist. A document that differs is
never overwritten. A group document that differs (edited in the admin console) stops the stage with
`seed_documents_differ`, naming each group and the differing fields; set `stage7.keepDifferingGroups: true` to keep
the console's version, and the stage then ends with a `kept N console-edited group(s): …` line
([configuration reference](configuration-reference-2.md#groups)). Any other document that differs always stops the
stage ([Staged.Groups.ps1](../../infra/staged/Staged.Groups.ps1) `Invoke-StgSeed`).
A first run right after Stage 6 can stop with a storage `403`; rerun after about five minutes
([troubleshooting](../operate/troubleshooting.md)).

![Expected Stage 7 output](../evidence/2026-10-24-demo/terminal-stage7.png)
![Expected in the Portal: the resolver's functions after publishing](../evidence/2026-10-24-demo/portal-07-functions-list.png)

## Stage 8 — Acceptance

**Who:** platform engineer, signed in as a member of an onboarded group · **Time:** about 3 minutes ·
**Calls the gateway:** without a token (`401`), with allowed models (`200`), with a model no group admits (`403`);
checks the admin console and that every request reached the usage ledger, charged to the expected group.

```powershell
pwsh -File $run -Stage 8 -ConfigPath $cfg          # preview
pwsh -File $run -Stage 8 -ConfigPath $cfg -Apply
Get-Content "$HOME/ccof-private/.staged-state/evidence/stage8.verify.json"
```

**Expected:** `stage 8 completed and verified in … s`; the evidence shows `anonymous.status 401`, each allowed
model `200` with the reply `STAGED OK`, the denied model `403`, and the telemetry rows.

![Expected Stage 8 output](../evidence/2026-10-24-demo/terminal-stage8.png)

Next: [onboard an Entra group](04-onboard-a-group.md).
