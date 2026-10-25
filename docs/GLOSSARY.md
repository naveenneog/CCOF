# Glossary

| Term | Meaning |
| --- | --- |
| **CCOF** | Claude Code on Foundry: this repository's gateway, services and admin console. |
| **Gateway** | The Azure API Management API that every Claude request goes through. It checks the caller's Entra token, applies limits and forwards the request to Foundry ([GATEWAY.md](GATEWAY.md)). |
| **Foundry** | Microsoft Foundry: the Azure service that hosts the Claude model deployments the gateway calls. |
| **Onboarded group** | An existing Entra security group registered in the admin console with its own budget, models, limits and chargeback ID. Each group is a separate entity ([ADR-0034](adr/0034-group-centric-onboarding.md)). |
| **Member** | A user who is a direct member of an onboarded group. Membership is read from Entra; CCOF never changes the group. |
| **Sync** | The function that reads group membership from Entra and writes each person's entitlement ([SYNC.md](SYNC.md)). |
| **Entitlement** | One record per person listing the onboarded groups the person belongs to. The gateway admits only what it lists. |
| **Selector** | The optional `x-ccof-project` request header naming one of the caller's groups. Without it, the group with the higher spend this month is used. |
| **Resolver** | The function the gateway asks, for each request, which group applies and what is allowed. Only the gateway can call it. |
| **Model family** | Haiku, Sonnet, Opus, Fable or Mythos. A group lists the families and the exact model IDs it admits, with optional token limits per family. |
| **CCU** | The Foundry Claude billing unit: 100 CCU = USD 1 ([COST-MODEL.md](COST-MODEL.md)). Budgets can be set in USD or CCU. |
| **Budget** | Per person per month. **Auto-scale**: every member gets it. **Cap**: members share one group total as well. |
| **Reconciler** | The timer function that prices the usage ledger at the rate card and writes each person's spent and remaining budget. |
| **Usage ledger** | The per-request usage records in Log Analytics that the reconciler and the chargeback reports read. |
| **Budget guard** | Projects spend that is not yet recorded, warns a person at 80% and slows requests, and limits how fast a budget can be spent so the overshoot stays small ([ADR-0040](adr/0040-budget-guard.md)). |
| **Chargeback ID** | A group's default cost code. |
| **User tag** | A person's own cost code (for example a WBS element), which replaces the group's chargeback ID for that person. The admin chooses the field name, for example **WBS ID**. |
| **Retire** | Ends a group's onboarding. The next sync removes every member's access; the Entra group itself is not changed. |
| **Stage** | One step of the staged deployment, 0 to 8. Each previews first and changes nothing until it is run with `-Apply` ([deploy](get-started/03-deploy.md)). |
| **Audit archive** | An optional storage account that keeps a copy of every gateway request log for years ([audit archive](operate/audit-archive.md)). |
| **Chargeback history** | Optional daily chargeback totals kept in Cosmos DB after Log Analytics has deleted the request rows ([chargeback history](operate/chargeback-history.md)). |
| **RU (request unit)** | The Cosmos DB unit of read and write cost; a serverless account is billed per million RU ([request units](https://learn.microsoft.com/en-us/azure/cosmos-db/request-units)). |
| **Lease** | A small Cosmos DB document that one function instance holds for a limited time so that two instances never do the same work at once, for example `ccof-chargeback-history` for chargeback history. |
| **Coverage record** | The document (`id: "coverage"`) per month in `chargebackDaily` listing the days chargeback history holds, `open` or `closed`, and when they expire ([ADR-0044](adr/0044-chargeback-history-in-cosmos.md)). |
| **Effective retention** | How long Log Analytics keeps the usage ledger: `audit.workspaceRetentionDays` if set, else `stage1.retentionInDays`. |
| **Unlocked / locked immutability policy** | A time-based retention policy on a storage container: blobs cannot be changed or deleted until it expires. An administrator can shorten or remove an unlocked policy; a locked policy can only be lengthened ([immutable storage](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-time-based-retention-policy-overview)). |
| **Trusted Microsoft services** | A storage firewall exception that lets listed Azure services, such as Azure Monitor, reach an account whose firewall otherwise denies traffic ([trusted services](https://learn.microsoft.com/en-us/azure/storage/common/storage-network-security-trusted-azure-services)). |
| **`/usage`** | The Claude Code command that shows a person's own spend, budget and warning ([USAGE.md](USAGE.md)). |
