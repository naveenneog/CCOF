# Use an existing API Management

Read this if your organization already runs an Azure API Management instance and wants CCOF's API in it instead of
a new one. Everything else in [Deploy, Stages 0–8](03-deploy.md) stays the same.

CCOF adds one API to the instance and sends the instance's gateway logs to CCOF's Log Analytics workspace. It does
not change the instance's tier, identity, networking, global policy, other APIs or the owner's diagnostic settings
([ADR-0045](../adr/0045-existing-api-management.md); a live run with the output of every stage:
[evidence](../evidence/2026-10-26-existing-apim/README.md)).

## 1. What the instance needs

| Requirement | Why | How to check (Portal: the API Management service) |
| --- | --- | --- |
| Tier **Basic v2, Standard v2 or Premium v2** | The Anthropic token limits run only in the v2 tiers ([llm-token-limit](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy)) | **Overview** → Tier |
| **System-assigned managed identity** on | The gateway calls Foundry and the CCOF resolver with it | **Security** → **Managed identities** → **System assigned** → Status **On** |
| The API path free (`apim.apiPath`, default `anthropic`) and the API ID free (`apim.apiId`, default `claude-messages`) | CCOF creates that API | **APIs** → no API with that URL suffix |
| A backend name free for each `backends[].id` | CCOF creates one backend per Foundry account | **APIs** → **Backends** |
| At most **four** diagnostic settings (three with `audit.archive` on) | Azure allows five per resource; CCOF adds `ccof-gateway-logs` (and `ccof-gateway-archive`) ([diagnostic settings](https://learn.microsoft.com/azure/azure-monitor/data-collection/diagnostic-settings)) | **Monitoring** → **Diagnostic settings** |
| A network route, **only if** Foundry or the Function Apps are private | The gateway must reach them privately; CCOF does not change the instance's networking | **Deployment + infrastructure** → **Network**: a virtual network that reaches them and resolves their private DNS names ([virtual network integration](https://learn.microsoft.com/azure/api-management/integrate-vnet-outbound)) |

Simplest path: keep Foundry and the Function Apps public (`stage1.foundry.publicNetworkAccess: Enabled`,
`backends[].privateEndpoint: false`, `stage1.functionsPublicNetworkAccess: Enabled`). The gateway then reaches them
over the internet with its managed identity, and the instance needs no network change.

## 2. What the instance's owner approves

- [ ] CCOF's API on their gateway, at `https://<instance>.azure-api.net/<apiPath>`.
- [ ] Their **global (all APIs) policy runs for CCOF's API too**. Stage 0 prints it. A global policy that checks
      subscription keys or tokens, rewrites `Authorization`, or returns early breaks CCOF.
- [ ] **Every API's gateway logs** also go to CCOF's workspace: a diagnostic setting covers the whole instance, not
      one API. This adds Log Analytics ingestion cost for the other APIs' traffic. LLM logs of another AI API on
      the same instance would show as unattributed usage in CCOF's reports.
- [ ] Access for whoever runs Stage 5 (or the owner runs Stage 5):
      **API Management Service Contributor** and **Monitoring Contributor** on the instance, and
      `Microsoft.Resources/deployments/write` on its resource group (for example API Management Service
      Contributor assigned on the resource group) ([built-in roles](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/integration)).
      Stage 0 needs only Reader.

## 3. Configuration

In your copy of `staged.config.example.json`:

```json
"stage1": { "approveNewPublicApimBootstrap": false },
"apim": {
  "existing": { "name": "contoso-apim", "subscriptionId": "00000000-0000-4000-8000-000000000002", "resourceGroup": "shared-apim-rg" },
  "apiId": "claude-messages",
  "apiPath": "anthropic",
  "apiDisplayName": "Claude Messages (staged)"
}
```

`name` is the instance name (Overview), `subscriptionId` and `resourceGroup` are where it lives (Overview →
Subscription ID, Resource group). Keep `approveNewPublicApimBootstrap: false`: with both a new and an existing
instance, Stage 0 stops with `both a new API Management ... and apim.existing are set`. The instance may be in
another resource group or subscription than CCOF; Stage 1 still needs its own new resource group.

## 4. What each stage does to the instance

| Stage | On the instance |
| --- | --- |
| 0 | Reads it (see below). Changes nothing |
| 1, 2, 4, 7 | Nothing |
| 3 | Grants its managed identity **Cognitive Services User** on CCOF's Foundry accounts (on the Foundry accounts, not on the instance) |
| 5 | Adds the API (`create-message`, `get-my-usage`, its policy), policy fragments `<apiId>-<section>-<hash>`, one backend per `backends[].id`, the API's `azuremonitor` diagnostic (the instance's `azuremonitor` logger is reused), and the diagnostic setting `ccof-gateway-logs` (GatewayLogs and GatewayLlmLogs to CCOF's workspace). With `audit.archive` also `ccof-gateway-archive` |
| 6 | Nothing: `... is not changed: CCOF does not change the networking of an existing API Management.` |
| 8 | Sends test requests through CCOF's API |

## 5. Stage 0 output

Stage 0 prints the global policy and a summary line, for example:

```text
WARNING: the global (all APIs) policy of contoso-apim also runs for the CCOF API (its inbound section starts with <base />). Review it below; Stage 5 does not change it.
global policy of contoso-apim:
<policies> ... </policies>
existing API Management contoso-apim: StandardV2, system-assigned identity on, 1 APIs, 1 diagnostic settings; CCOF adds API claude-messages at /anthropic
```

When the instance is not ready, Stage 0 stops before anything is created:

| Stage 0 says | Do this |
| --- | --- |
| `apim_existing_unreadable` | Check the three `apim.existing` values; ask the owner for **Reader** on the instance |
| `apim_identity_missing` | The owner turns on the system-assigned identity (table in section 1) |
| `apim_existing_sku` | Use a v2 instance, or let Stage 1 create one (`approveNewPublicApimBootstrap: true`, `apim.existing: null`) |
| `apim_existing_api_conflict` or `apim_existing_path_taken` | Choose an unused `apim.apiId` and `apim.apiPath` |
| `apim_existing_backend_conflict` | Rename `backends[].id` and every group's `backendId` |
| `apim_existing_diagnostic_settings_full` | The owner removes a diagnostic setting, or set `audit.archive.enabled: false` |
| `apim_existing_no_private_route` | The owner connects the instance to a virtual network that reaches Foundry and the Function Apps, or keep them public (section 1) |
| `WARNING: you cannot run Stage 5 on ... yet` | Ask the owner for the roles in section 2, or have the owner run Stage 5 |

## 6. Stage 5 output

```text
gateway logs: diagnostic setting ccof-gateway-logs on contoso-apim sends GatewayLogs and GatewayLlmLogs to <workspace> (resource-specific); the owner's other settings are not changed
gateway logs: ccof-gateway-logs on contoso-apim verified: GatewayLlmLogs, GatewayLogs to <workspace> (resource-specific)
```

If the owner already sends both categories to CCOF's workspace in resource-specific mode, Stage 5 reuses that
setting (`gateway logs: reusing diagnostic setting ...`). If a setting sends them to CCOF's workspace in another
form, Stage 5 stops with `apim_gateway_logs_conflict` naming it: Azure refuses the same category to the same
workspace twice.

## 7. Removing CCOF from the instance

Deleting CCOF's resource group does not touch the instance. Remove CCOF's parts from it by hand (Portal, or
`az apim api delete`, `az apim backend delete` and `az monitor diagnostic-settings delete`; fragments in the Portal):

1. the API `apim.apiId`;
2. policy fragments whose names start with `<apiId>-` (**APIs** → **Policy fragments**);
3. the backends named in `backends[].id`;
4. the diagnostic settings `ccof-gateway-logs` and `ccof-gateway-archive`.
