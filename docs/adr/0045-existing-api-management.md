# ADR-0045: Deploying into an existing API Management instance

Status: Accepted (2026-10-26).

## Context

Customers often run a shared API Management instance and want CCOF's API in it rather than a new one. The staged
configuration has supported this since the start (`stage1.approveNewPublicApimBootstrap: false` and
`apim.existing { name, subscriptionId, resourceGroup }`), but the path was never deployed end to end, and reading the
code showed gaps:

- The resource-log diagnostic setting `ccof-gateway-logs` (GatewayLogs and GatewayLlmLogs to CCOF's workspace,
  resource-specific tables) is created only for an instance Stage 1 creates (`infra/staged/apim-service.bicep`). With
  an existing instance nothing sends gateway logs to CCOF's workspace: Stage 8's telemetry check fails, and budgets,
  `/usage` and chargeback have no data.
- Stage 0 checked only that `apim.existing` was filled in. A missing system-assigned identity surfaced at Stage 3;
  an unsupported tier, an API path already in use, a backend name already in use, a full set of diagnostic settings
  or a missing network route surfaced at Stage 5 or Stage 8, or not at all.
- Stage 5 redeployed the `azuremonitor` logger, rewriting the owner's logger description.
- Stage 6 integrates only an instance Stage 1 created into the VNet.

Research: [UNKNOWNS](../UNKNOWNS.md) EXA-1 to EXA-7.

## Options

1. Document the gaps; the owner adds the diagnostic setting by hand. Rejected: a first-time reader fails at Stage 8
   with no data, and nothing checks the hand-made setting.
2. Stage 5 adds the diagnostic setting and read-back; Stage 0 checks the instance before anything is created; CCOF
   never changes the instance's networking, identity, tier, global policy, other APIs or the owner's diagnostic
   settings. Chosen.
3. As 2, plus an opt-in (`apim.existing.vnetIntegration`) for Stage 6 to integrate the owner's instance into the
   VNet. Rejected for now: integration sends every API's outbound calls through the subnet, Learn does not say
   whether enabling it interrupts traffic (EXA-3), and the owner's network team owns that change.

## Decision

1. **Configuration.** Exactly one of `stage1.approveNewPublicApimBootstrap: true` or `apim.existing` (both set is
   refused: Stage 1 would create a new instance and the existing one would be ignored). `apim.existing.subscriptionId`
   must be a GUID.
2. **Stage 0 checks the existing instance** (`infra/staged/Staged.ApimExisting.ps1`), read-only, each refusal with a
   next step:
   - readable (`apim_existing_unreadable`); system-assigned identity on (`apim_identity_missing`); tier BasicV2,
     StandardV2 or PremiumV2 (`apim_existing_sku`, EXA-2);
   - `apim.apiId` free, or already this CCOF API (same path and display name: a rerun); another API using
     `apim.apiPath` is refused (`apim_existing_api_conflict`, `apim_existing_path_taken`);
   - each `backends[].id` free or already pointing at the same URL (`apim_existing_backend_conflict`);
   - room for CCOF's diagnostic settings: the owner's settings plus `ccof-gateway-logs` (and `ccof-gateway-archive`
     with `audit.archive`) at most five (`apim_existing_diagnostic_settings_full`, EXA-1);
   - network: when a Foundry backend or the Function Apps are private, the instance must already have a virtual
     network (`virtualNetworkType` External or Internal); otherwise `apim_existing_no_private_route`. With a virtual
     network Stage 0 warns that it cannot prove the route and DNS; Stage 8 proves them;
   - warnings, not refusals: the global (all-APIs) policy is printed for review (EXA-4); the operator's missing
     permissions on the instance and its resource group are named (EXA-6).
3. **Stage 5 sends the gateway logs to CCOF's workspace.** For an existing instance it creates the diagnostic setting
   `ccof-gateway-logs` (GatewayLogs and GatewayLlmLogs, resource-specific) on the instance
   (`infra/staged/stage5-gateway-logs.bicep`), unless a setting already sends both categories to CCOF's workspace in
   resource-specific mode, which is then reused. A setting that sends either category to CCOF's workspace in another
   form is refused (`apim_gateway_logs_conflict`): Azure refuses the same category to the same workspace twice. The
   read-back records the setting, its workspace and categories in `stage5.verify.json` and prints
   `gateway logs: ...`.
4. **The `azuremonitor` logger** of an existing instance is referenced, not redeployed, when present (EXA-7).
5. **Stage 6 does not change an existing instance** and its preview says so.
6. **What CCOF adds to the owner's instance:** the API `apim.apiId` (operations `create-message` and
   `get-my-usage`, its policy), policy fragments named `<apiId>-<section>-<hash>`, one backend per `backends[].id`,
   the API's `azuremonitor` diagnostic, the logger if absent, the diagnostic settings `ccof-gateway-logs` and (with
   the archive) `ccof-gateway-archive`. Nothing else is changed.

## Consequences

- A first-time reader can deploy into an existing instance with the same stages; Stage 0 reports what the owner
  must fix or approve before any resource is created.
- The owner approves: CCOF's API on their gateway, the global policy running for it, every API's gateway logs going
  to CCOF's workspace as well (ingestion cost; another LLM API's rows appear as unattributed usage, EXA-5), and the
  role grants for Stage 5 (API Management Service Contributor and Monitoring Contributor on the instance, deployment
  write on its resource group).
- Private Foundry or private Function Apps need the owner's network route; CCOF does not create it.
- Removal is manual: delete the API, its fragments, backends and the two diagnostic settings (listed in
  [Use an existing API Management](../get-started/existing-api-management.md)).
