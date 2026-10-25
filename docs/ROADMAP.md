# Deployment packets

## Group-centric onboarding (ADR-0034)

- [x] G-LIMIT-offline: reproduce budget bypasses, retain the monetary TPM ceiling, add complete-accounting admission,
  and test family restrictions and higher-spend selection. Strict atomic reservations remain unimplemented (ADR-0038).
- [x] G-LIMIT-live: isolated updated gateway acceptance completed; measured spend and overshoot are recorded in
  [the live report](status/BUDGET-ACCEPTANCE-2026-10-23.md).
- [x] G-LABEL: admin-defined individual tag label (for example WBS ID), persisted and present in tagging, filters and
  downloadable chargeback report headers; existing API properties remain compatible.
- [x] G-WALK: Playwright walkthrough of the staged guide, prerequisites and stage-specific permissions; live
  Stages 0-8 verified. Reader-facing pseudonymised captures are part of G-DOCS.
- [x] G-DOCS: short README, documentation index and glossary, get-started and operate pages; fresh deployment,
  expected-outcome screenshots with hypothetical identifiers, usage states, chargeback CSV and offline doc checks.
- [x] G-DOCS-R2: novice reader fixes: clone step, preview commands, Stage 7 checklist, sourced lab cost, Legacy
  projects label, earlier guides archived.
- [x] G-AZCLI: Azure CLI developer sign-in (ADR-0041). Given `signInMethod: azure-cli` in the client configuration, the setup scripts write a `ccof-token.cmd` that signs in with `az login` in its own Azure CLI profile and prints only the gateway token; Claude Code `settings.json`, the Claude Desktop helper-script profile and `/usage` use it; Stage 7 writes the key only when Stage 4 allowed the Azure CLI; Stage 4 reads back the Azure CLI preauthorization; a live token reaches the gateway with HTTP 200.
- [x] G-NOVICE: a first-time reader deploys from the README alone ([evidence](evidence/2026-10-25-novice/README.md)); each failure met is recorded with a capture and either refused at Stage 0 or explained on the page where it is met; one developer sign-in step for both sign-in methods.
- [ ] G-CCMODEL: resolve CC-01 (Claude Code model-catalog notice for deployment names).
- [x] G-CONFIG-GUIDE: configuration reference page for every staged configuration key, with a test that follows the template.
- [x] G-CONFIG-GUIDE-2: configuration reference reworked: create-new and reuse-existing JSON per choice, every template key in a table, a validated complete sample.
- [x] G-RESUME: Stage 1 read-back after lost local state accepts the configured Functions subnet when Stage 6 has no record; troubleshooting rows for Cloud Shell timeout and lost `$HOME`.
| Packet | Status | Acceptance |
| --- | --- | --- |
| G0 — Baseline and contract | Complete | ADR-0033 records the baseline model; ADR-0034 records the decision; unknowns logged |
| G1 — Group registration contract | Complete | Given a group document, the parser returns a typed registration or field-path problems; Fable/Mythos only with explicit approval |
| G2 — Sync and reconciler read groups | Complete | A `kind: "group"` document produces memberships for its Entra members and a reconciler scope; memberships carry priority, surfaces and chargeback ID |
| G2b — Resolver and gateway carry group attributes | Complete | Resolver validates and returns surfaces, chargeback ID and approval; APIM admits Fable/Mythos for a group only with approval |
| G3 — Precedence | Complete | No selector and several active groups: lowest priority applies; equal lowest refused; a selector still wins |
| G4 — Surfaces | Complete | Decision carries allowed surfaces; APIM maps client app ID to surface and refuses a surface the group does not allow; no mapping means no enforcement |
| G5 — Cache suggesters | Complete | Suggested cache-read share per surface, with cited sources; group value derived from enabled surfaces |
| G6 — Admin group API | Complete | Search Entra groups, onboard, edit, list and retire group registrations with change records |
| G7a — Chargeback ID in usage and workbook | Complete | Usage trace, ledger KQL and workbook carry chargeback ID and surface; a per-developer view lists the ID |
| G7b — Export for Power BI | Complete | Usage trace, ledger KQL and workbook carry chargeback ID; per-user monthly export (CSV/JSON) for Power BI, filterable by chargeback ID |
| G8 — Admin UI | Complete | Find group, budget helper (per-user, autoScale/cap), limits, models, surfaces, chargeback ID, cache %, export page |
| G-STAGE — Staged settings for groups | Complete | Staged config exposes gateway.surfaceClients and admin.groupSearchEnabled; Stage 5 applies them |
| G-PREC — Precedence by spend | Complete | No selector and several groups: the group with the higher month-to-date spend (reconciler `spentCcu`, current UTC month) applies, then the lower priority; still tied or malformed priority refused; malformed spend `budget_state_invalid` |
| G-REM — Removal | Complete | Removing a group is retirement, as for a project (ADR-0034 decision 9); retired-group removal ignores the removal limits (tested) |
| G-TAG — User tags | Complete | A tag per person (the chargeback ID) set in the console, saved tags suggested while typing; the sync stamps it on the person's group memberships; reports filter by it and show it per user; exports carry it |
| G-PUB — Public repository | Complete | `naveenneog/CCOF` created public from one squashed commit of a scrubbed tree (lab tenant, subscription, resource names replaced; live-run screenshots removed); identifier scan of the pushed tree is clean |
| G-SEED — Staged pilot as a group | Complete | A staged `groups` entry with `kind: "group"` (no project or classification) is created in Stage 4, listed in the workbook (Stage 5), seeded as a group document and given a client file (Stage 7); `registrySeed` checks group documents with the group contract; the example pilot is a group |
| G-HA — Cosmos redundancy | Complete (offline) | Regions in failover order with zone redundancy, service-managed failover, chosen consistency; resolver reads from the next region during an outage ([ADR-0036](adr/0036-cosmos-redundancy-and-consistency.md)) |
| G-USAGE — Own budget in Claude Code | Complete (offline) | `GET /ccof/me/usage` on the gateway (token oid only), resolver `/api/me/usage` (own documents, point reads), `/usage` skill and status line; group totals only when allowed ([USAGE.md](USAGE.md)) |
| G9 — Live verification | Partial | Lab A (admin/Entra) and Lab B (Foundry models) runs with isolated `AZURE_CONFIG_DIR` per tenant. Done: live Graph group directory, Stage 0. Open: end-to-end gateway run (Lab B login needed) |
| G-WIRE — Wire rename | Pending | Replace `projectId`/`classification` wire fields with group fields across resolver, APIM, ledger, workbook |
| G-DOC — Staged deployment guide | Complete | [STAGED-DEPLOYMENT-GUIDE.md](STAGED-DEPLOYMENT-GUIDE.md): prerequisites (network, Entra apps and what creating each needs), Portal steps and Cloud Shell helper scripts per stage, using the staged configuration files |
| G-LIMIT — Live budget and group acceptance | Complete (live) | USD 10 through the gateway, family limit, higher-spend selection, bypass attempts, WBS ID chargeback, guide walkthrough ([report](status/BUDGET-ACCEPTANCE-2026-10-23.md)). Open: E2E-01 |
| G-FRAG — Policy fragment cleanup | Pending | Content-addressed fragments (ADR-0039) from earlier policies stay in API Management. Remove fragments no API policy or revision references, after a deployment verifies |
| G-GUARD — Budget guard | Complete (live) | Projected spend, rate guard, 80% warning in `/usage` and the status line; USD 14 budget ended 1.1% under ([ADR-0040](adr/0040-budget-guard.md)) |
| G-DOCS — Reader documentation | Complete | Role-based short pages, fresh Stages 0-8 lab, 44 pseudonymised screenshots, own-usage and CSV evidence; council, strict typecheck, packet gate and public CI pass (release 10, `2f84715`) |
| G-DOCS-R1 — First-time reader follow-up | Complete | Main deployment values and single-subscription lab route explained; readable review screenshot, current exhausted-budget output and plain-language live summary; public release 11 (`fcb187c`), CI pass |
| G-DOCS-R2 — Novice reader fixes | Complete | Novice review items 1-7; docs tests negative-tested; council and packet gate pass; public release 12 |

Gate follow-ups (existing): split oversized legacy UI/staged files by responsibility; keep the Power BI authentication
and backend-429 billing unknowns open until independently verified. G-DOCS does not change those behaviors.

## Earlier packets

| Packet | Status | Acceptance |
| --- | --- | --- |
| V3-names | Complete | Names plus full IDs across V3; authenticated Graph lookup with explicit failures; admin-only VDI upgrade guide |
| Stage 1 resources-only proof | Complete | Compile and inspect templates, deploy new lab services, verify live properties, document permissions and evidence |
| Later-stage separation | Not started | Separate network, schema, grants, Entra, settings, packages and acceptance into explicit stage interfaces |
| Admin V3 Azure acceptance | Pending | Verify deployed root redirect, Entra sign-in, real telemetry and onboarding settings |
| Admin V3 scale/accessibility | Pending | Measure 10,000-project behavior and perform assistive-technology checks |
