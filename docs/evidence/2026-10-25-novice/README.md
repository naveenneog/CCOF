# Novice walkthrough, 2026-10-25

A first-time deployment that followed only the README and the five
[get-started](../../get-started/01-what-it-is.md) pages, with the developer sign-in set to the Azure CLI
(`client.signInMethod: azure-cli`). Each failure was recorded as it appeared, then fixed in the code or the guide.
The `fail-*` images show the output before the fix; the `fix-*` images show what Stage 0 now reports instead.

Names and identifiers in the images use the same hypothetical values as the
[2026-10-24 demo](../2026-10-24-demo/README.md). Lab resource names (`ccofnov-…`, `ccofnv2-…`) are real.

## Route

| Item | Value |
| --- | --- |
| Subscription, region | One subscription, `eastus2`, `network.mode: create` |
| Entra | Existing app registrations (`entra.existing`) and one existing group (`groupId`) |
| Models | `claude-haiku-5-5` and `claude-sonnet-5-5`, `DataZoneStandard`, 20 capacity units each: the only Claude 5.5 quota left in the subscription |
| Developer sign-in | `azure-cli` (`entra.allowAzureCliClient: true`) |
| Attempts | Attempt 1 (`ccof-nov-rg`) stopped at Stage 3 and had to be deleted (Stage 1 is create-only). Attempt 2 (`ccof-nov2-rg`) completed |

## What failed, and what changed

| # | Stage | What the reader saw | Cause | Now | Image |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | `ServiceUnavailable`: "high demand in East US 2 region for the zonal redundant (Availability Zones) accounts", as an exception in a quickstart script with the cause inside escaped JSON | The template's Cosmos DB default (two zone-redundant regions) | Errors lead with `<resource>: <code>: <message>`; the deploy page lists the lab values for every create-only setting | `fail-01-cosmos-zonal-capacity.png` |
| 2 | 1 (rerun) | "is in a failed provisioning state … Please delete the previous instance" | A failed Cosmos DB account blocks a rerun | Troubleshooting gives the delete command | `fail-02-cosmos-failed-account-blocks-rerun.png` |
| 3 | 3 | `apim_missing: Stage 1 deferred APIM and config apim.existing is empty` | Template: `approveNewPublicApimBootstrap: false`, no `apim.existing`; Stage 1 reported success without a gateway | Stage 0 refuses a configuration with no API Management | `fail-03-apim-missing-at-stage3.png`, `fix-01-stage0-refuses-missing-apim.png` |
| 4 | 1 (changed) | `stage_config_changed … preview and apply stage 1 again`; the preview refused the same way | Stage 1 never redeploys once verified | The message says Stage 1 is create-only; the Stage 1 preview of a new resource group says so before the first apply | `fail-04-config-changed-needs-preview.png`, `fail-05-preview-also-refuses.png` |
| 5 | 1 (changed) | `stage1_parameters_changed … Stage 1 is create-only. Use a new prefix/RG` | As 4 | Troubleshooting row; attempt 2 started in a new resource group. The deleted Foundry account held 20 + 20 quota units until purged | `fail-06-stage1-create-only.png` |
| 6 | 6 | `ParentResourceNotFound … privatelink.cognitiveservices.azure.com` after the network deployed | Bug: the read-back looked for Foundry DNS zones although no Foundry private endpoint was requested. The template's private Foundry account (`publicNetworkAccess: Disabled`) with `privateEndpoint: false` was also unreachable | Read-back fixed; Stage 0 refuses a private Foundry account without a private endpoint; Stage 6 redeploys its own network after a failed read-back | `fail-07-stage6-foundry-dns-zone-missing.png`, `fix-02-stage0-refuses-unreachable-foundry.png` |
| 7 | 7 | `stage_config_changed … stage 5`, then on rerun `… stage 3` | The backend change was an input of Stages 3 and 5; each rerun revealed one more | The message names every changed stage at once | `fail-08-stage5-rerun-after-backend-change.png` |

## Attempt 2 stage timings

| Stage | Time | Notes |
| --- | --- | --- |
| 0 | 54 s | |
| 1 | 404 s | First try, with the lab values from the deploy page |
| 2 | 198 s | |
| 3 | 401 s, rerun 61 s | Rerun after the backend change (row 7) |
| 4 | 54 s | Existing app registrations reused |
| 5 | 109 s, rerun 71 s | Rerun after the backend change |
| 6 | read-back failed after 8 m 56 s; rerun 246 s | Row 6 |
| 7 | 1,430 s | `"outcome":"succeeded"`, `"membersAdmitted":1`, `"writeFailures":0` |
| 8 | 337 s | Anonymous `401`, `claude-haiku-5-5` `200` (`STAGED OK`), `claude-opus-5-5` `403` (`ok-02-stage8-accepted.png`) |

Attempt 1 and its cleanup added about 45 minutes; the deleted Foundry account had to be purged before attempt 2 could
use the same model quota.

## Developer setup with the Azure CLI sign-in

Followed [developer setup](../../get-started/05-developer-setup.md) with the client file Stage 7 wrote
(`"signInMethod":"azure-cli"`), in a scratch user profile. Setup printed `"signInMethod":"azure-cli"` and the
`"signIn"` command; the helper reported the signed-in account; `claude -p` answered through the gateway; `/usage`
showed the group budget, USD 0.00 of USD 100.00 (`ok-01-developer-setup-azure-cli.png`).

The interactive sign-in window of step 2 was not opened in this unattended run: the helper's own profile folder
(`<configuration folder>\az`) was given a copy of an Azure CLI profile already signed in to the same tenant, which is
the state the sign-in leaves.

Open: Claude Code 2.1.272 printed `"claude-haiku-5-5" isn't described by this version's model catalog …
[claude-code:unrecognized_model]` before the answer (shown in the capture). The answer was correct; Claude Code suggests a `behavesAs`
mapping. Which catalog model each deployment should map to is recorded as an open question in
[UNKNOWNS](../../UNKNOWNS.md) (CC-01).

## Rating from a first-time reader

| | Before this run's fixes | After |
| --- | --- | --- |
| Reaching a working deployment from the README alone | 3/10: the template's defaults stop at Stage 1 (Cosmos DB capacity), then Stage 3 (no API Management); the way out needs the code, and Stage 1 cannot be changed, so the resource group is deleted and the run restarted | 7/10: Stage 0 refuses the two configurations that cannot work, the deploy page lists every create-only value for a lab, and errors name the failing resource and the next step |
| Developer sign-in | 6/10: two routes, chosen by reading the configuration file | 8/10: one command, printed by setup, for both methods |
| Remaining | Model quota and model names still need the reader to translate quota lines into configuration (now a table); the template is still a 330-line file with production defaults; the Claude Code model-catalog notice (CC-01) | |
