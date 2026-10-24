# Demo lab run, 2026-10-24

A fresh lab deployed with the [staged guide](../../STAGED-DEPLOYMENT-GUIDE.md) and then used as a reader would use it.
The screenshots on the [get-started](../../get-started/) and [operate](../../operate/) pages come from this run.

**Names and identifiers.** Real tenant, subscription, people and Entra object IDs are replaced with consistent
hypothetical values in the same format before each screenshot (for example `alex.admin@contoso.com`, and a fixed
fake GUID per real GUID, so the same group has the same ID on every image). Lab resource names (`ccofdemo-…`) are
real; the lab remains deployed at this checkpoint and continues to incur Azure charges. Tooling:
[pseudonymise.cjs](../../../tests/playwright/pseudonymise.cjs) replaces values and refuses a new capture if a
configured real literal remains or a frame cannot be checked. This detects configured identifiers, not arbitrary
unknown personal information; the published captures were also inspected visually.

## Lab layout

| Item | Value |
| --- | --- |
| Region | `eastus2` |
| Resource group | `ccof-demo-rg`, prefix `ccofdemo` |
| Entra | Existing app registrations and security groups reused; Stage 4 checked and updated them, rather than creating new directory objects |
| Models | Claude Sonnet 5.5 and Haiku 5.5, 80 capacity units each, backend `foundry-eastus2` |
| Network | `network.mode: create` (lab only): Stage 6 creates the VNet `10.64.0.0/16` with APIM, private-endpoint and Functions subnets, the private endpoints and the VNet integrations |
| Budget enforcement | `budget-state`, reconciler every minute, budget guard 80 / 25 / 5 (`warnPercent` / `overshootPercent` / `projectionMinutes`) |

| Group (display name) | Budget | Chargeback ID | Priority | Notes |
| --- | --- | --- | --- | --- |
| Engineering | USD 100 per user, auto-scale | `CC-ENG-1001` | 100 | Onboarded from the deployment configuration file |
| Data Science | USD 2 per user, USD 20 group cap | `CC-DS-2002` | 200 | Haiku limit 50,000 tokens per minute per person |
| Product | USD 50 per user, auto-scale | `CC-PRD-3003` | 300 | Onboarded through the console wizard (images `console-01` to `console-04`) |

## Stage timings

Every stage passed on its first run.

| Stage | What it does | Time |
| --- | --- | --- |
| 0 | Preflight (read-only) | 75 s |
| 1 | Resources | 320 s |
| 2 | Cosmos DB schema | 201 s |
| 3 | Runtime role assignments | 398 s |
| 4 | Entra applications and groups | 58 s |
| 5 | Configuration | 110 s |
| 6 | Network | 802 s |
| 7 | Code and initial data | 1,429 s |
| 8 | Acceptance | 303 s |

Images: `terminal-stage0.png` to `terminal-stage8.png` (the last lines of each stage's output), and the Azure portal
views `portal-*.png` that the [deploy page](../../get-started/03-deploy.md) references.

## Budget run

One person in Data Science (USD 2 per-user budget) sent Sonnet requests from three parallel clients until the budget
was used up. `/usage` was saved every minute.

| Point | `/usage` | Image |
| --- | --- | --- |
| Normal | USD 0.57 of 2.00 (28%) | `usage-01-normal.png` |
| Warning (projected 84%) | USD 1.20 of 2.00 (60%), requests slowed | `usage-02-warning.png` |
| Used up | USD 2.14 of 2.00 (106%), next request `403 permission_error` | [`usage-03-refused.png`](usage-03-refused.png), [text output](usage-03-refused.txt) |

Result: 71 requests succeeded, 95 were slowed (`429` with `Retry-After`) and 69 were refused (`403`). Final recorded
spend USD 2.14 against USD 2.00, 7% over, within the configured `overshootPercent` of 25. The client's own sum of
response costs was USD 2.13. The run paused for about 50 minutes when the workstation slept; it resumed without
changes.

The refusal screenshot was refreshed by rendering the saved `/usage` response from this run with the current client formatter.
The request amounts and HTTP 403 response are from the recorded run; the refreshed status line shows
`- budget used up, requests refused`.

## Console and chargeback

| Image | Shows |
| --- | --- |
| `console-01-find-group.png` to `console-04-review.png` | The four onboarding wizard steps for Product |
| `console-05-groups.png` | The three onboarded groups with chargeback IDs and priorities |
| `console-06-user-tags.png` | Tag field named **WBS ID**, one person tagged `WBS-1001.01` |
| `console-07-group-detail.png` | The Product group page |
| `console-08-budgets.png` | Group and person budgets from the reconciler |
| `console-09-chargeback.png` | Chargeback, Developers tab, with the WBS ID column |
| `csv-chargeback-developers.png` | The exported CSV, with the WBS ID column |

The console sidebar in these captures shows **Projects**. Release 12 renamed that entry **Legacy projects**; the
page is otherwise unchanged ([ADMIN-V3.md](../../ADMIN-V3.md)).

The CSV shows the group chargeback IDs (`CC-DS-2002, CC-ENG-1001`) for this person's requests: the WBS tag was saved
after those requests, and a tag applies from the next sync
([chargeback and tags](../../operate/chargeback-and-tags.md)).

The developer setup image `terminal-client-setup.png` is a real run of `Set-ClaudeCodeGateway.ps1` against this
lab's client configuration, in a scratch home directory.
