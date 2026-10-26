# Existing API Management: first-time deployment, 2026-10-26

A first-time deployment of CCOF into an API Management instance that already existed, following the README,
[prerequisites](../../get-started/02-prerequisites.md), [use an existing API Management](../../get-started/existing-api-management.md)
and [deploy](../../get-started/03-deploy.md). The deployer ran PowerShell 7 and the Azure CLI on Linux (Ubuntu 24.04 under
WSL), the closest available stand-in for a Mac. The existing instance stood in for a customer's: created outside CCOF
with its own API, an all-APIs policy and its own diagnostic setting.

Names and identifiers in the images are hypothetical (`contoso-apim`, `shared-apim-rg`, subscription and group IDs).
The lab's own resource names (`ccof-nov4-rg`, `ccofnv4…`) are shown; they identify nothing outside the lab.

## Route

| Item | Value |
| --- | --- |
| Pages | README -> 02-prerequisites (API Management decision, owner checklist) -> existing-api-management -> 03-deploy -> 05-developer-setup |
| Existing instance | Standard v2, one unit, system-assigned identity, one API (`contoso-orders`), a global policy setting a header, diagnostic setting `contoso-own-logs` (all logs to the owner's workspace), no virtual network |
| Subscription, region | One subscription, East US 2; CCOF in a new resource group, `network.mode: create` (lab) |
| Identity | Existing gateway and resolver registrations reused (read back unchanged after Stage 4); Stage 4 created a lab admin registration |
| Choices off the template | `stage1.approveNewPublicApimBootstrap: false` and `apim.existing` (existing-api-management, section 3); Foundry public (`publicNetworkAccess: Enabled`, `privateEndpoint: false`), the simplest path in section 1, because the instance has no virtual network |
| Attempts | One deployment. Stage 7 ran five times for reasons of the test machine (below), not of CCOF |

## What failed, and what changed

The gaps were found by reading the code before the run and fixed test-first; the run then followed the fixed
branch. Before the fix, Stage 0 checked only that `apim.existing` was filled in, and nothing sent the instance's
gateway logs to CCOF's workspace, so Stage 8's telemetry check, budgets and `/usage` would have had no data.

| # | Stage | What the reader would have seen | Cause | Now | Image |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | A private Foundry with an instance without a virtual network passed Stage 0 and failed only at Stage 8 | Stage 0 did not look at the instance | Stage 0 refuses with `apim_existing_no_private_route` and both ways out, before anything is created | `fix-01-stage0-private-route.png` |
| 2 | 5, 8 | No gateway logs in CCOF's workspace: Stage 8 telemetry fails; budgets see nothing | The diagnostic setting was created only for a new instance | Stage 5 adds `ccof-gateway-logs` (or reuses an equivalent) and reads it back | `ok-02-stage5-gateway-logs.png` |
| 3 | 5 | The owner's `azuremonitor` logger description rewritten | Stage 5 redeployed the logger | The existing logger is referenced; read back unchanged | `ok-05-owner-items-unchanged.png` |

Stage 0 also refuses: an unreadable instance, no system-assigned identity, a non-v2 tier, the API ID or path or a
backend name already in use, and no room for CCOF's diagnostic settings; it prints the global policy and names
missing Stage 5 permissions.

## Stage timings

| Stage | Time | Notes |
| --- | --- | --- |
| 0 | 52 s | Prints the global policy and `existing API Management contoso-apim: StandardV2, ...` (`ok-01-stage0-existing-apim.png`) |
| 1 | 302 s | No API Management created |
| 2 | 229 s | |
| 3 | 426 s | The instance's identity gets Cognitive Services User on CCOF's Foundry account |
| 4 | 44 s | |
| 5 | 109 s | What-if: only `Create` on the instance (API, operations, policies, four fragments, backend, API diagnostic, `ccof-gateway-logs`, `ccof-gateway-archive`); no `Modify` |
| 6 | 697 s | Preview: `... is not changed: CCOF does not change the networking of an existing API Management.` (`ok-03-stage6-apim-not-changed.png`) |
| 7 | 822 s | Fifth attempt; see below |
| 8 | 278 s | Anonymous 401, allowed 200 `STAGED OK`, denied 403, telemetry from the instance's logs, charged to the group (`ok-04-stage8-acceptance.png`) |

Stage 7, test machine only: the first attempt stopped when Ubuntu's automatic upgrade replaced system libraries
during the run; the next three stopped because the Linux Azure CLI there could not refresh its own tokens (they
were copied from Windows; a Mac signed in with `az login` refreshes them). The first two kept the state folder on
the Windows drive, which made a package build take about 45 minutes instead of 14.

## Success run

After Stage 8: a developer machine (Windows, scratch profile) ran the setup from `client-config.json` with the Azure
CLI sign-in; `claude -p` through the instance answered `NOVICE4 OK`; `/usage` read the group's budget. The usage
ledger in CCOF's workspace held both requests, attributed to the group's chargeback ID. Three requests to the
owner's unrelated API reached CCOF's workspace too, as the page warns.

Substitution: the interactive `az login` window of the developer sign-in was replaced by a copy of an already
signed-in Azure CLI profile.

The owner's items were read before Stage 0 and after Stage 8 (`ok-05-owner-items-unchanged.png`): tier, identity,
networking, the unrelated API and its policy, the global policy, the logger, the service diagnostic and the owner's
diagnostic setting are unchanged; CCOF added only its API, backend, fragments and two diagnostic settings.

## Open items

- Network mode `create` still creates an unused API Management subnet and its network security group when the
  instance is an existing one (lab mode only; no charge).
- A private Foundry behind an existing instance with a virtual network was not run live; Stage 0 warns and Stage 8
  is the proof.
- Removing CCOF from the instance is manual (page section 7).

## Rating from a first-time reader

| | Before this run's fixes | After |
| --- | --- | --- |
| Reaching the promised result from the README alone | 4/10: the configuration was documented, but Stage 8 would fail on missing telemetry and nothing said what the owner must approve | 8/10: one page lists the requirements, approvals and output; Stage 0 stops early with next steps |
| Recovering from a failure | 3/10: problems appeared at Stage 3, 5 or 8 | 8/10: each refusal names the setting or the owner's action |
| The instance's owner | 3/10: no list of what CCOF adds or changes | 8/10: a list per stage, a removal list, and the global policy printed |
| Remaining | Manual removal; no live run with a private Foundry behind a VNet-integrated instance | |
