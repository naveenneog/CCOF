# Configuration: Entra applications and groups

Part of the [configuration reference](configuration.md). Every Entra object can be created by Stage 4 or reused. All
values are hypothetical. Stage 4 is `Invoke-Stage4` in [Staged.Entra.ps1](../../infra/staged/Staged.Entra.ps1);
`Read-StgConfig` in [Staged.Common.ps1](../../infra/staged/Staged.Common.ps1) validates the keys first.

## Entra applications

Three registrations: the gateway (`gateway`), the resolver API (`resolver`) and, when `stage1.includeAdmin` is `true`,
the admin console (`admin`). Each is decided on its own through `Resolve-StgApp`:

| `entra.existing` has `<kind>AppId` | Stage 4 does | Output line |
| --- | --- | --- |
| Yes | Reads the application by `appId`; changes are merged into it, never replaced. A missing or unreadable ID stops with `entra_app_not_found` | `reuse existing gateway application 'CCOF Gateway' (00000000-0000-4000-8000-000000000004)` |
| No, and an application named `entra.<kind>AppDisplayName` exists | Reuses it. Two with the same name stop with `entra_ambiguous` | `reuse application 'CCOF Gateway' (00000000-0000-4000-8000-000000000004)` |
| No, and no such name | Creates a single-tenant application | `created application 'CCOF Gateway' (00000000-0000-4000-8000-000000000004)` |

A preview (no `-Apply`) prints `preview: create application 'CCOF Gateway' (single tenant)` instead of creating.
`entra.existing.gatewayAppId`, `entra.existing.resolverAppId` and `entra.existing.adminAppId` are independent and each
optional. Each is the **Application (client) ID**, not the object ID, and must be a GUID. `adminAppId` is read only when
`stage1.includeAdmin` is `true`. A display name given for a reused kind is not read.

Create all three:

```json
"entra": {
  "gatewayAppDisplayName": "CCOF Gateway",
  "resolverAppDisplayName": "CCOF Resolver API",
  "adminAppDisplayName": "CCOF Admin",
  "allowAzureCliClient": false,
  "adminEditors": ["@me"],
  "adminReaders": []
}
```

Reuse all three (the display names stay in the file and are not read):

```json
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
}
```

Mixed: reuse the gateway, create the resolver and admin applications:

```json
"entra": {
  "gatewayAppDisplayName": "CCOF Gateway",
  "resolverAppDisplayName": "CCOF Resolver API",
  "adminAppDisplayName": "CCOF Admin",
  "allowAzureCliClient": true,
  "adminEditors": ["@me"],
  "adminReaders": [],
  "existing": { "gatewayAppId": "00000000-0000-4000-8000-000000000004" }
}
```

Stage 4 prints `reuse existing gateway application ...`, then `created application 'CCOF Resolver API' (...)` and
`created application 'CCOF Admin' (...)`.

**Rules from `Read-StgConfig`.** Each given ID must be a GUID (`entra.existing.<kind>AppId must be a GUID`). Display
names written to Entra, for kinds without an ID, hold letters, digits, space and `. _ -` only. A newly created admin
application needs at least one `entra.adminEditors` entry (an object ID, or `@me` for the operator), because assignment
is required on it.

**Where the IDs are.** Portal: Microsoft Entra ID > App registrations > All applications > the application > Overview >
Application (client) ID. Command:

```powershell
az ad app list --display-name "CCOF Gateway" --query "[].{name:displayName, appId:appId}" -o table
```

**What Stage 4 changes on a reused application** (merge, existing entries stay):

| Application | Changes |
| --- | --- |
| Gateway | Identifier URI `api://<appId>`; scope `access_as_user`; v2 access tokens; public client redirects `http://localhost` and the broker URI; fallback public client on; itself preauthorized for the scope, and the Azure CLI client when `entra.allowAzureCliClient` is `true` |
| Resolver | Identifier URI `api://<appId>`; v2 access tokens. No redirects or secrets |
| Admin | Identifier URI; scope `Projects.Manage`; app roles `CCOF.Projects.Read` and `CCOF.Projects.Write`; SPA redirects `/api/console` and `/api/console-v3` on the admin host; v2 tokens; itself and `admin.extraAllowedClientIds` preauthorized; assignment required on its service principal; `entra.adminEditors` and `adminReaders` get the write and read roles |

Each change is a Graph `PATCH` ([Staged.Entra.ps1](../../infra/staged/Staged.Entra.ps1) lines 75-114), so the operator
needs to update each reused application: an owner of it, or the Application Administrator role
([Learn](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#application-administrator)).
Creating applications needs permission to register them ([Learn](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app)).

## Groups

`groups[]` entries with `"kind": "group"` ([Staged.Groups.ps1](../../infra/staged/Staged.Groups.ps1)). One of `groups[].groupId` and
`groups[].groupDisplayName` is required. With `groupId`, Stage 4 reads that group and Stage 0 refuses one that is not a
security group (`group <id> is not a security group`); membership is managed in Entra, and the sync reads direct
members only ([guide 6.1](../STAGED-DEPLOYMENT-GUIDE.md#61-graph-grants-group-search-names-and-sync)). Without it, Stage 4
looks the group up by name and creates a security group when none exists, then adds the `members` that are missing
(`@me` is the operator).

Reuse an existing group:

```json
"groups": [
  {
    "kind": "group",
    "groupId": "00000000-0000-4000-8000-000000000007",
    "displayName": "Engineering",
    "backendId": "foundry-eastus2",
    "chargebackId": "CC-ENG-1001"
  }
],
"client": { "group": "00000000-0000-4000-8000-000000000007", "signInMethod": "azure-cli" }
```

Create (or reuse by name) a group with members:

```json
"groups": [
  {
    "kind": "group",
    "groupDisplayName": "CCOF-PILOT01",
    "members": ["@me"],
    "displayName": "Pilot 01",
    "backendId": "foundry-eastus2",
    "chargebackId": null
  }
],
"client": { "group": "CCOF-PILOT01", "signInMethod": "msal" }
```

These snippets show the identity keys only; the other `groups[]` keys keep their template values
([reference](configuration-reference-2.md#groups)). Output: `created group CCOF-PILOT01 (00000000-0000-4000-8000-000000000007)`
when it did not exist; a reused group prints nothing. `client.group` names exactly one entry, by `groupDisplayName` or
`groupId` (`client_selection_invalid` otherwise, [Staged.Groups.ps1](../../infra/staged/Staged.Groups.ps1)).

| Where the value is | Command or Portal path |
| --- | --- |
| Group object ID | `az ad group show --group "Engineering" --query id -o tsv`; Portal: Microsoft Entra ID > Groups > the group > Object Id |
| Operator object ID (`adminEditors`) | `az ad signed-in-user show --query id -o tsv` |

Next: [resources](configuration-resources.md) · [reference](configuration-reference.md).
