# ADR-0042: Stage 0 refuses unusable configurations; Stage 6 recovers its own network

Status: Accepted (2026-10-25).

## Context

A first-time deployment that followed only the README and get-started pages
([evidence](../evidence/2026-10-25-novice/README.md)) met two configurations that cannot work but were refused only
after Stage 1, which is create-only:

| Configuration | Where it failed | Cost |
| --- | --- | --- |
| `stage1.approveNewPublicApimBootstrap: false` and no `apim.existing` (the template's defaults) | Stage 3: `apim_missing`. Stage 1 had reported success without a gateway | The resource group had to be deleted and the run restarted, because Stage 1 values cannot change |
| A new Foundry account with `publicNetworkAccess: Disabled` and its backend's `privateEndpoint: false` | Stage 6 read-back (a bug read Foundry DNS zones that were never created); otherwise Stage 8, because the gateway has no route to the account | One failed Stage 6 |

After that Stage 6 read-back failure, a rerun in `network.mode: create` threw `network_create_existing_vnet`: the
VNet existed but Stage 6 had recorded nothing. That guard exists so create mode never rewrites the subnet list of a
VNet it does not own ([Staged.Common.ps1](../../infra/staged/Staged.Common.ps1) `Get-StgNetworkAction`).

## Options

1. Document the combinations and leave the checks where they are.
2. Refuse the two configurations in configuration validation, which every stage runs, so Stage 0 reports them.
3. For the Stage 6 rerun: keep refusing; or redeploy when any `stage6-network` deployment succeeded; or redeploy only
   when this resource group's succeeded create-mode `stage6-network` deployment produced this VNet from the same
   `network.create` settings.

## Decision

- Option 2. `Read-StgConfig` refuses "no API Management" (neither `approveNewPublicApimBootstrap: true` nor a
  complete `apim.existing`) and a new private Foundry account whose backend has no private endpoint
  (`network.mode` `create` or `existing`). The template keeps its private defaults; a reader must now choose the
  gateway explicitly.
- Option 3, the narrowest form. `Test-StgOwnNetworkDeployment` counts a VNet as Stage 6's own only when a
  `stage6-network` deployment in the resource group succeeded, recorded `network.mode: create`, has a `vnetId`
  output equal to this VNet, and recorded the same `network.create` settings as the current configuration. A shared
  resource group (`sharedResourceGroup: true`) never counts. Redeploying then changes nothing, so it is the
  recovery. Everything else is still refused.

## Consequences

- The shipped template no longer validates until the gateway is chosen. Tests that read the template fill in
  `apim.existing`.
- A create-mode Stage 6 rerun after a failed read-back needs no manual state edit. A configuration that changed
  `network.create` since that deployment is still refused.
- Checks: [Test-StagedStages.ps1](../../tests/Test-StagedStages.ps1) (refusals; own, other VNet, failed, no output,
  existing mode, changed subnet, shared resource group); verified against the live `stage6-network` deployment of
  the 2026-10-25 lab (same settings: own; changed subnet prefix: not own).
