# Current work

## Group-centric onboarding

**Active packet:** G9 — live verification, partial ([ROADMAP](ROADMAP.md)).

### G9 — live verification (partial, 2026-10-23, Contoso)

Isolated `AZURE_CONFIG_DIR` per tenant; no Azure or Entra resource was created or changed.

- Admin group directory ([group-directory.ts](../admin/src/group-directory.ts)) run against Microsoft Graph with a
  delegated token: search `ccof` returned 8 security groups; hyphenated (`CCOF-CONLAB1`, 2) and partial (`conlab`, 4)
  terms matched; group read with `members/$count` returned the member count (1); unknown ID `not_found`; disabled
  flag `disabled`; negative control with an invalid token `permission_required` (Graph 401).
- Stage 0 with a configuration derived from the example (new keys included): a backend without deployments stopped
  with `verify_failed: backend con1020 lacks deployments` (negative); with `stage1.foundry.create: true` it completed
  and verified in 60 s (providers registered, Flex in eastus2, planned deployments listed).
- `stage5-config.bicep` builds with `ADMIN_GROUP_SEARCH_ENABLED` from `admin.groupSearchEnabled`.
- Not done: the admin identity's Graph grants (needs a Privileged Role Administrator); deploying the group-centric
  packages to a lab and gateway calls with group decisions, surfaces and chargeback ID (models are in FDPO, whose
  profile needs an interactive `az login`). The Contoso lab `ccof-stdv2-20261020-rg` has no Claude deployments and
  its staged state is not in this checkout.

### G-DOC — staged deployment guide (complete)

- [STAGED-DEPLOYMENT-GUIDE.md](STAGED-DEPLOYMENT-GUIDE.md): roles per stage, network, Entra applications (the
  settings Stage 4 applies), Graph permissions per identity, Foundry; Cloud Shell setup; per stage the command,
  Portal workbook sections and success check; group onboarding; Graph grant helper; rollback. Linked from README
  and the staged runbook.
- Checks: 6/6 PowerShell blocks parse; every relative link and anchor resolves.
- Council (fact check against code): round 1 BLOCK with 8 errors (wrong state path `completed` for `stages`,
  `-Stage <n>` not runnable, Stage 6 `existing` described as creating the network, missing APIM NSG and
  Azure Monitor egress, Stage 6 WARNs presented as checked, timers described as always off, Stage 1 non-empty
  RG rule, cleanup deleting reused Entra objects) and 3 notes. All fixed against the cited code.

### G-STAGE — staged settings for groups (complete)

- `gateway.surfaceClients` (Stage 5 writes `entra.surfaceClients`, IDs lower-cased) and `admin.groupSearchEnabled`
  (`ADMIN_GROUP_SEARCH_ENABLED`) in the staged configuration ([Staged.Application.ps1](../infra/staged/Staged.Application.ps1),
  [stage5-config.bicep](../infra/staged/stage5-config.bicep)). Both default off.
- Tests: `tests/Test-StagedStages.ps1` 360/360. Mutants 4/4 caught.
- Council: CODER PASS; ARCHITECT, QA, SECURITY, UX PASS-WITH-NOTES. Notes: the staged path admits only the gateway
  app and Azure CLI, so only those can be mapped (documented); `groupSearchEnabled` is ignored without the admin
  app (documented); the admin Graph grants are manual (guide section 6.1); new checks are source-level.

### G8 — admin UI for groups (complete, admin 3.3.0)

- Groups page, four-step onboarding (Entra search, budget with auto-scale/cap estimate, access and models,
  cache suggestion with evidence, budget assistant), group detail (edit, retire), Chargeback IDs view and filter,
  Help topics ([ADMIN-V3.md](ADMIN-V3.md) 3.3.0).
- Tests: `admin/tests/ui-groups.test.ts` 7/7 (pure form logic); admin 144/144; build OK. Mutants 7/7 caught.
- Browser (Edge via Playwright, demo server): 18/18 checks in light, dark and 390 px; 0 console errors, 0 failed
  requests. The name fix was negative-tested. Script: session file `ui-groups-walk.py`.
- Council: round 1 ARCHITECT and SECURITY PASS; CODER, QA, UX PASS-WITH-NOTES (wrong name or member count after
  re-picking a group; the detail page overwrote the stored cache share; an invalid chargeback filter broke
  queries). Fixed. Round 2: two low notes (re-pick after Back, deep-link filter), fixed and walk-tested.

### G7b — export for Power BI (complete)

- `GET /api/v3/export/usage` (per chargeback ID, group and person; up to 5,000 rows) and `/api/v3/export/groups`
  (group configuration), JSON or CSV with formula-injection guard, truncation headers, and refusal of filters the
  export cannot apply ([admin/src/export.ts](../admin/src/export.ts), [ADMIN-API.md](ADMIN-API.md)).
- Tests: export 7/7; admin suite green. Mutants 13/13 caught (one equivalent mutant removed by simplifying the code).
- Council round 1: CODER BLOCK (`tags` accepted but ignored, so the export was unfiltered). Fixed with truncation
  headers and the explicit rate-card error. Round 2: ARCHITECT, CODER, QA PASS; SECURITY, UX PASS-WITH-NOTES.
- Power BI connector sign-in is unverified (G-R3); CSV/JSON download is the documented path.

### G7a — chargeback ID in usage and workbook (complete)

- Gateway validates and caches the decision's `chargebackId`; the `ccof.usage.v1` trace carries `chargebackId`
  and `surface`; `ledger.kql` exposes both (validated); the workbook and console gain `chargebackIds`
  (chargeback ID by developer, `(none)` when absent); the console filters with `chargeback=`.
  [CHARGEBACK.md](CHARGEBACK.md), [GATEWAY.md](GATEWAY.md).
- Tests: gateway 134/134 (compiled C#), workbook/chargeback suites, admin 131/131; offline KQL checker 0 errors
  on 23 workbook and admin queries (checker shown to fail on a broken query). Full gate PASS.
- Mutants: 10/10 caught. Workbook digests and the quickstart table count updated deliberately.
- Council round 1: CODER and QA BLOCK (`chargebackIds` unreachable through the v3 route). Fixed with a
  route-level test. Round 2: all five PASS.

### G6 — admin group API (complete)

- `/api/groups` list, read, onboard, update (If-Match), retire (confirm ID); Entra group search and member
  count via Graph `Group.ReadBasic.All` and `GroupMember.ReadBasic.All` behind `ADMIN_GROUP_SEARCH_ENABLED`;
  cache suggestion route ([admin/src/groups.ts](../admin/src/groups.ts),
  [admin/src/group-directory.ts](../admin/src/group-directory.ts), [ADMIN-API.md](ADMIN-API.md)).
- The projects API and V2/V3 project lists exclude group documents.
- Tests: admin 129/129, build OK. Mutants 17/17 caught after fixing two vacuous tests.
- Council round 1: ARCHITECT BLOCK (group documents listed as projects; the V3 project page crashed on
  one). Fixed server-side. Round 2: ARCHITECT, CODER, QA, SECURITY, UX PASS.
- Not live-verified: Graph permissions are not granted in any tenant yet (G9).

### G4 — surfaces (complete)

- Gateway setting `entra.surfaceClients` maps admitted client apps (token `azp`/`appid`) to a surface;
  empty means not enforced ([gateway-config.schema.json](../infra/gateway/gateway-config.schema.json),
  [config.ts](../infra/gateway/config.ts)). The policy requires valid `surfaces` on `group` decisions and
  refuses 403 `surface_not_allowed` before any token counter ([claude-messages.template.xml](../infra/gateway/policy/claude-messages.template.xml)).
  Quickstart, Core and manual producers emit an empty list. [GATEWAY.md](GATEWAY.md) documents it.
- Tests: gateway suites 133/133 (vectors run as compiled C#); full packet gate PASS (all PowerShell suites).
- Mutants: 10/10 caught after adding a structural refusal-wiring test and fixing a duplicate-mapping
  test that the schema short-circuited.
- Council: ARCHITECT PASS-WITH-NOTES (deploy the resolver before the policy), CODER PASS, QA PASS,
  SECURITY PASS-WITH-NOTES (one re-resolve per group user at rollout), UX PASS.
- Follow-up: quickstart inputs do not expose `surfaceClients`; the staged configuration does (G-STAGE).

### G5 — cache suggesters (complete)

- [src/contracts/cache-suggestions.ts](../src/contracts/cache-suggestions.ts): per-surface suggestion with evidence
  class (illustrative, analogue, assumed, none) and source; a group's suggestion is the lowest among
  enabled surfaces the gateway carries, returned with the surfaces and classes that set it.
- Tests: `tests/cache-suggestions.test.ts` 6/6. Mutants 5/5 caught.
- Council round 1: labels overstated evidence (`code` marked published; `cowork` used a tuned figure).
  Fixed. Round 2: ARCHITECT and UX PASS-WITH-NOTES (cowork, not gateway-routed, set the minimum:
  now excluded), CODER PASS, QA PASS-WITH-NOTES, SECURITY PASS.

### G3 — precedence (complete)

- No selector and all active memberships are groups: the lowest `priority` applies; ties, malformed
  priorities and baseline candidates keep `project_selection_required`; an exhausted lowest-priority
  group is refused, not skipped ([src/resolver/select-membership.ts](../src/resolver/select-membership.ts)).
- Tests: `tests/resolver-group-precedence.test.ts` 7/7; resolver suites 284 pass, 2 skipped (live).
- Mutants: 3/3 caught.
- Council: ARCHITECT PASS, CODER PASS, QA PASS-WITH-NOTES (two cases added), SECURITY PASS; UX not
  applicable. G-A1 remains ASSUMED pending owner confirmation.

### G2b — resolver and gateway carry group attributes (complete)

- `validateMembership` reads group attributes only under the code `group` and checks the family
  policy with the approval ([src/resolver/freshness.ts](../src/resolver/freshness.ts)); the decision
  returns `surfaces`, `chargebackId`, `restrictedFamiliesApproved` for groups only
  ([src/resolver/decide.ts](../src/resolver/decide.ts)). APIM admits Fable/Mythos for `CYB` or an
  approved group at the fresh, cached and per-request checks
  ([claude-messages.template.xml](../infra/gateway/policy/claude-messages.template.xml)).
- Tests: `tests/resolver-group-membership.test.ts` 4/4; resolver suites 279 pass, 2 skipped (live);
  gateway suites 124/124 with the vectors run as compiled C#.
- Mutants: 9/9 caught (resolver 4, policy 5; one policy mutant first caught only by the structural
  cached/fresh equality test, then confirmed behaviourally by the non-boolean vector).
- Council: ARCHITECT PASS-WITH-NOTES (revocation follows the cache TTL, as for CYB), CODER PASS,
  QA PASS-WITH-NOTES, SECURITY PASS-WITH-NOTES (validate surfaces/chargeback ID in APIM before G4/G7
  use them); UX not applicable.

Open unknowns for the work stream: G-A1 to G-A4, G-R3 ([UNKNOWNS](UNKNOWNS.md)).

## Admin V3 user names

**Completed packet:** V3-names — complete: Admin 3.1.0 displays current Entra names beside full object
IDs. Only admin code/package changed; no gateway, sync or reconciler code, config or deployment.
Manual upgrade: [VDI procedure](ADMIN-V3-VDI-UPGRADE.md); new permission: admin managed identity
Graph application `User.Read.All`, consent, `ADMIN_USER_NAMES_ENABLED=true`.

Evidence:
- 108 admin tests and the admin build pass. Package inspected for admin entry points/UI/KQL.
- Edge demo: names/full IDs on Overview, Developers, Budgets, Reconciler, Audit and Project Activity;
  Light/Dark/mobile; denied/disabled/unavailable/missing users retain IDs and cost figures.
- Integrated server/browser cache tests cover original expiry, clock skew, cache bounds, stalled
  requests and queue recovery. Provider errors are sanitized, with no names/UPNs in logs.
- Five PowerShell guide blocks parse; local links resolve; no guide commands were executed.
- Council: ARCHITECT PASS, CODER PASS, QA PASS, SECURITY PASS (independent reviewers);
  UX PASS (browser checks). Review found layered TTL and stalled-request edge cases; regression
  tests reproduced them before the fixes.
- Repository packet gate passes; existing file-size warnings remain.

Implementation commit: `41c2c2e`. The local ZIP is `ccof-admin-v3.1.0.zip` in this session's files
(SHA-256 `f25438c857b7058ec9bdc8b55c48491dc9d33b2e7f27fa1e0ce472a90e857554`).
No live directory lookup, customer deployment or Graph permission change was performed.

## Standard v2 and Foundry, two tenants (S3, complete with open items)

Verified 2026-10-20 in SASET MSFT FDPO and Contoso ([report](STAGED-STDV2-RUNS-2026-10-20.md)).
Open: Portal walkthrough screenshots need a persistent Portal sign-in; Graph application consent
needs PIM activation in Contoso; Claude in Contoso needs a non-sandbox subscription.


## Staged deployment, stages 0-8

**Completed packet:** S2 — staged entry points for stages 2-8 and a live end-to-end run.

Status: verified, 2026-10-20, in the new lab RG `ccof-staged-20261020-rg`
([report](STAGED-LIVE-RUN-2026-10-20.md)). The Stage 1 RG below was deleted first.

Open items:

- Private-only variant (StandardV2 APIM with VNet integration, private Function endpoints,
  in-network build agent) not run.
- New Entra registrations/groups not exercised (operator directory quota); merge path verified.
- Least-privilege identity per stage, timers, load and 10,000-project scale not tested.
- Admin console shows sub-cent costs as $0.00.


## Stage 1 resources-only live proof

**Completed packet:** S1 — Stage 1 resources-only live proof.

Status: verified, 2026-10-20. No later-stage deployment is active.

Acceptance:

- `infra/staged/main.bicep` and both parameter examples compile.
- Recursive template checks reject network attachments, role assignments, schema,
  application settings and code deployment.
- A new, empty lab resource group receives only the approved resource inventory.
- Live read-back verifies private/keyless settings and identity outputs; an ARM
  success is not runtime acceptance.
- The runbook states operator permissions, inputs, outputs, recovery and deferred work.

Source baseline: `b116f63`. Scope is Stage 1 only. Existing lab/customer resources,
Entra, application packages and permission assignments are outside the write boundary.

See [unknowns](UNKNOWNS.md) and [roadmap](ROADMAP.md).

## Evidence

- Azure deployment `stage1-proof` in the new lab RG succeeded.
- Read-back passed for all four services, private/keyless controls and the
  absence of application settings, schema and grants.
- The existing Bicep templates needed no provider-driven changes.
- A valid forbidden-role fixture was rejected by the existing contract test.
- `node .ironclad/gate.mjs --stage packet --json`: exit 0; full root tests,
  type-check and build pass. The pre-existing file-size warning remains.
- Admin build and all 95 tests pass.
- New runbook's three PowerShell blocks parse and local documentation links resolve.

Detailed [live report](STAGE1-LIVE-VERIFICATION.md) and
[commands/permissions](runbooks/STAGED-DEPLOYMENT-V2.md).
This packet's commit is the Git change containing this status file.
