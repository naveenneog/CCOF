# Deployment packets

## Group-centric onboarding (ADR-0034)

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
| G9 — Live verification | Partial | Lab A (admin/Entra) and Lab B (Foundry models) runs with isolated `AZURE_CONFIG_DIR` per tenant. Done: live Graph group directory, Stage 0. Open: end-to-end gateway run (Lab B login needed) |
| G-WIRE — Wire rename | Pending | Replace `projectId`/`classification` wire fields with group fields across resolver, APIM, ledger, workbook |
| G-DOC — Staged deployment guide | Complete | [STAGED-DEPLOYMENT-GUIDE.md](STAGED-DEPLOYMENT-GUIDE.md): prerequisites (network, Entra apps and what creating each needs), Portal steps and Cloud Shell helper scripts per stage, using the staged configuration files |

## Earlier packets

| Packet | Status | Acceptance |
| --- | --- | --- |
| V3-names | Complete | Names plus full IDs across V3; authenticated Graph lookup with explicit failures; admin-only VDI upgrade guide |
| Stage 1 resources-only proof | Complete | Compile and inspect templates, deploy new lab services, verify live properties, document permissions and evidence |
| Later-stage separation | Not started | Separate network, schema, grants, Entra, settings, packages and acceptance into explicit stage interfaces |
| Admin V3 Azure acceptance | Pending | Verify deployed root redirect, Entra sign-in, real telemetry and onboarding settings |
| Admin V3 scale/accessibility | Pending | Measure 10,000-project behavior and perform assistive-technology checks |
