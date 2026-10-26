# Claude Code on Foundry (CCOF)

CCOF routes **Claude Code through one Azure gateway with private backends**, managed through **existing Entra groups**:
each group has its own models, limits and monthly dollar budget, every person sees their own spend in
Claude Code, and every request is charged to a cost code for chargeback.

[![Architecture: Entra sign-in, API Management gateway, Function Apps, Cosmos DB, Foundry, private network](docs/diagrams/ccof-architecture-overview.svg)](docs/get-started/01-what-it-is.md)

## What you get

| | |
| --- | --- |
| **Onboard existing Entra groups** — budget, models and cost code per group, in a four-step admin console | [How](docs/get-started/04-onboard-a-group.md) |
| **Reconciled dollar budgets** — configurable warning, throttling and refusal; reporting lag can cause overshoot | [How](docs/operate/budgets-and-guard.md) |
| **`/usage` in Claude Code** — each person's own spend, budget and warnings | [How](docs/get-started/05-developer-setup.md#4-check-your-own-budget-usage) |
| **Chargeback per person** — your field name (for example *WBS ID*) in filters and CSV exports | [How](docs/operate/chargeback-and-tags.md) |
| **Long-term audit** — a storage archive of the gateway request log, and chargeback history beyond the Log Analytics retention | [Archive](docs/operate/audit-archive.md) · [History](docs/operate/chargeback-history.md) |
| **Private backends** — private endpoints, managed identities and Entra sign-in | [Architecture](docs/ARCHITECTURE.md) |

## Start here

| Step | Page | Who |
| --- | --- | --- |
| 1 | [What CCOF is](docs/get-started/01-what-it-is.md) | Everyone |
| 2 | [Prerequisites checklist](docs/get-started/02-prerequisites.md) | Platform, Entra and network owners |
| 3 | [Deploy in nine stages](docs/get-started/03-deploy.md), each with the expected output | Platform engineer |
| 4 | [Onboard an Entra group](docs/get-started/04-onboard-a-group.md) | Admin |
| 5 | [Developer setup](docs/get-started/05-developer-setup.md) | Developers |

Then: [users and groups](docs/operate/users-and-groups.md) · [budgets](docs/operate/budgets-and-guard.md) ·
[chargeback](docs/operate/chargeback-and-tags.md) · [regions and failover](docs/get-started/region-and-failover.md) · [troubleshooting](docs/operate/troubleshooting.md) ·
[all documentation](docs/INDEX.md) · [glossary](docs/GLOSSARY.md).

## Live acceptance

Live checks confirmed group-specific model access, refusal after budget exhaustion, and a person's *WBS ID* in the
downloaded chargeback report. The USD 10 test recorded USD 11.25 (USD 11.97 at list rates); a later guarded USD 14
run recorded USD 13.84. The guard reduces overshoot but is not a strict spending cap.

The detailed report records 23 attempts to get around model and budget rules and their outcomes:
[budget and group acceptance](docs/status/BUDGET-ACCEPTANCE-2026-10-23.md). A separate lab passed all nine deployment
stages; its USD 2 demonstration ended at USD 2.14 with a 25% guard setting. Screenshots:
[demo evidence](docs/evidence/2026-10-24-demo/README.md).

Deployment creates billable Azure resources and needs directory and resource permissions. Reported costs are list
price at the rate card, not an Azure invoice.

## Other deployment paths

The single-administrator [quickstart](docs/archive/QUICKSTART.md), [manual deployment](docs/archive/MANUAL-DEPLOYMENT.md) and the
[Portal workbooks](docs/runbooks/README.md) describe earlier paths, kept for existing installations.

## Local verification

Requires Node.js 22, PowerShell 7, Python, Azure CLI with Bicep and, for the Kusto semantic checks, a .NET SDK:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
npx tsc -p tsconfig.typecheck.json
```

`npm test` runs every Node and PowerShell suite offline; no test deploys resources or sends paid model traffic.

## License

License selection is still pending. No license file or grant of reuse rights is added by this source publication;
the package remains marked `UNLICENSED`.
