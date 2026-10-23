# Current work

## Group-centric onboarding

**Active packet:** G-LIMIT — budget and group acceptance ([ROADMAP](ROADMAP.md)).

### Owner acceptance request (2026-10-23)

- G-LIMIT: test model-family restrictions, overlapping memberships, higher-spend selection, exhaustion, streaming,
  retries and concurrent requests. Reproduce reviewed monetary-enforcement gaps without billing first. The authorized
  live consumption ceiling is USD 10 across this request, not USD 10 per scenario; requests need a conservative
  worst-case cost bound before being sent. Report reconciled usage separately from Marketplace billing.
- G-LABEL: an administrator can name the individual chargeback tag (for example WBS ID); the name is persisted,
  appears in tagging and filtering, and labels the column in downloaded chargeback reports. Existing API field
  names remain compatible.
- G-WALK: follow the staged guide with Playwright, record actual Portal prerequisites and deployment outcomes,
  capture sanitized screenshots, and fix unclear or incorrect steps. No writes to the protected checkout or its
  existing deployments. Missing access is a documented blocked step, never evidence of a successful deployment.
- Budget review found a dropped resolver monetary ceiling and streamed-cache undercounting. A strict dollar cap
  requires atomic worst-case reservations, not a token-rate setting; current reconciliation/cache behavior does not
  provide that guarantee. See G-L1 through G-L4 in [UNKNOWNS](UNKNOWNS.md).
- Current evidence: [budget acceptance](status/BUDGET-ACCEPTANCE-2026-10-23.md). Direct Foundry smoke and cold/warm
  streamed cache calls total USD 0.011476 at list rates; USD 10 was not consumed. Full gateway testing is blocked by
  developer-client sign-in/consent and the need to deploy this checkout separately from the existing shared labs.
- Corrections: monetary ceiling retained, zero refused, old cached decisions invalidated; complete-accounting opt-in
  for person and strict-group state. New tests: 67/67, eight mutations caught with baseline count preserved.
  A nonbillable concurrency experiment admitted all 20 requests against the same USD 9.90 snapshot: still no strict cap.
- G-LABEL: deployment-wide field name defaults to User tag, is editable as WBS ID, uses audited ETag-protected
  settings and labels CSV headings without changing machine keys. Focused 36/36, admin 166/166, seven mutations
  caught. Actual local UI/APIs with in-memory stores: Playwright 21 checks, persisted label, saved-tag assignment,
  filter and downloaded CSV verified; no outbound requests. Report telemetry in that browser run was a fixture,
  not live chargeback data. [ADR-0037](adr/0037-deployment-user-tag-label.md).
- Council: Architect, Coder and Security PASS; QA and UX PASS-WITH-NOTES on live validation. Separate security
  review PASS (95 focused tests). Local browser follow-up completed afterward; full Azure acceptance remains blocked.
- Validation: full root suite, strict root/admin typechecks, root/admin builds and packet gate pass. Staged
  configuration: 451 checks. The guide walkthrough checked four images, 16 anchors and 84 local links; seven
  PowerShell blocks parsed. Sanitized Portal sign-in and local admin screenshots are linked in the guide.
- Local implementation commits: G-LIMIT `7df518e`, G-LABEL `711b9f2`. Root Node results: 1,182 passed, six
  opt-in live tests skipped, zero failed. Those skips are not live deployment or spend acceptance.

### G-HA — Cosmos DB redundancy and consistency (complete offline)

- Owner: "a cosmos with consistency model ... so its not a single point of failure". `stage1.cosmosLocations` (regions in
  failover order, `isZoneRedundant`), `stage1.cosmosConsistency`; two or more regions turn on service-managed failover;
  configuration checks and a Stage 1 read-back ([Staged.Cosmos.ps1](../infra/staged/Staged.Cosmos.ps1)); the resolver
  reads in `COSMOS_PREFERRED_REGIONS` order, set by Stage 5. Example: two zone-redundant regions (`eastus2`,
  `centralus`), provisioned autoscale, Session. [ADR-0036](adr/0036-cosmos-redundancy-and-consistency.md), guide 2.6.
- Tests: staged 446 checks; network DNS 5 (the real network check against a fake `az`); resolver config and Cosmos
  options 26; root 1168 pass, 0 fail; strict typecheck 0. Mutants 16/16 caught (two first survived because one test
  broke two rules at once; it was split). Read-backs run on the live Lab A account and endpoint: a single-region
  configuration passes; a two-region one names the missing region, the failover setting and the DNS name.
- Council round 1: ARCHITECT, QA BLOCK (Stage 6 accepted a Cosmos endpoint without every regional DNS name); notes on
  the bounded-staleness read-back, capacity pairs and cost wording. Round 2: all PASS (QA note: executable test for the
  verify-mode check, added).
- Public release 5: `d4a73ff`, public CI passes (Node 22 and 26).
- Live (2026-10-23, Lab A, throwaway RG `ccof-g9-cosmosha-rg`, deleted): `eastus2` was refused with and without
  zone redundancy and zone-redundant `westus3` was refused (`ServiceUnavailable`, "high demand"); zone-redundant
  `centralus` plus `westus3` without zones deployed with service-managed failover and Session (a Cosmos-only Bicep file,
  not a full Stage 1 run). The Stage 1 read-back function, called directly, reported 0 problems for the matching
  configuration, "Cosmos has 1 region(s); the configuration has 2" for the partial account, and the zone mismatch when
  `westus3` was configured zone-redundant. A data-plane check of the resolver's preferred regions was not run: the
  account's public network access stayed `Disabled` after two `az cosmosdb update` calls, as a tenant policy that
  enforces it would cause. Guide 2.6 records the capacity steps. The full staged deployment with two regions still
  needs a new resource group.

### G-FIX — client restore and Graph grant fixes

- Local commit `3d4b16f`; public release 6 `baffea8`, CI passed on Node 22 and 26
  ([run](https://github.com/naveenneog/CCOF/actions/runs/39990743201)).
- `Restore-ClientSnapshot` now removes folders the installer created (for example `~/.claude/skills`) when they are
  empty, deepest first; a folder that now holds another file stays; a snapshot without `createdDirectories` (older
  format) still restores. Installer tests 39; mutants caught 2/2 (count equal to the baseline, one failure each).
- `Grant-SyncGraphPermissions.ps1 -Permissions A,B,C` under `pwsh -File` passed one string and failed with
  `app_role_missing` (found live in Lab A, plan-only). Comma lists are now split, trimmed and de-duplicated; a list
  with no names stops with `no_permissions`. Quickstart step tests 34. The plan-only rerun listed all three
  permissions. Initial apply was blocked by inactive PIM; after the owner activated the role, all three assignments
  were applied and verified. This did not grant Azure CLI access to the gateway's delegated developer scope.
- Council: UX BLOCK (guide 2.6 described a Stage 1 read-back and rerun scope the code does not have; imperative
  wording); Coder and QA notes (empty permission list, old-format snapshot). All fixed; Architect, Security PASS.

### G-USAGE — a person's own budget: `/usage` (complete offline; live blocked)

- Gateway `GET /ccof/me/usage` (operation `get-my-usage`, own policy without `<base />`, token checks byte-equal to
  the messages policy, only the token's `oid` sent, per-person `admission.usage`), resolver `POST /api/me/usage`
  (point reads only; group totals behind `RESOLVER_USAGE_GROUP_TOTALS`, absent = hidden), client `ccof-usage` and the
  Claude Code skill `/usage` with an opt-in status line. Stage 5 deploys and reads the operation back.
  [USAGE.md](USAGE.md), [ADR-0035](adr/0035-own-usage-through-the-gateway.md).
- Tests: resolver usage 13 + handler 7; gateway usage 9 (including compiled C# vectors); client 65 (usage 13);
  installer 37, including the generated command run in real PowerShell and real Git Bash; staged 408; root 1166 pass,
  0 fail; strict typecheck (`tsconfig.typecheck.json`, run by public CI) 0 errors, after fixing 9 test and type
  errors left by earlier packets. Mutants 28/28 caught. Negative control, run as a mutation (not a committed test):
  the unquoted backslash command form makes the real Git Bash test fail with the separator loss Claude Code documents.
- Council round 1: all five BLOCK (group spend and cap exposed beyond "remaining"; directory display names in the
  model's context; command not runnable under PowerShell; last month's group figure shown as current; state not
  matched to classification). Round 2: QA BLOCK on the strict typecheck, others PASS. Round 3: QA PASS-WITH-NOTES.
  All fixed with tests.
- Not changed: restore removes `SKILL.md` but leaves an empty `skills\usage` folder.
- Live: not run. Session `c9943014` deployed its own usage implementation from the protected `ccof-public-manual-update`
  checkout to both lab resource groups (`lab-stdv2-rg` Stage 7 at 17:16, `lab-shared-foundry-rg` at 17:48, and
  was still active at 18:29); deploying from here would overwrite that work. Needs the owner to choose a lab.
- Public release 4: `bc435de`, pushed; public CI (`public-source-ci`, Node 22 and 26) passes for the first time, the
  previous three releases failed on the strict typecheck fixed here.

### G-NAMES — staged user names setting (complete)

- `admin.userNamesEnabled` → `ADMIN_USER_NAMES_ENABLED` in Stage 5 ([stage5-config.bicep](../infra/staged/stage5-config.bicep));
  guide section 6.1 grants `User.Read.All` with the group permissions and cites the ~24-hour managed identity token
  cache. Staged 400 checks; the mutant (setting not passed) is caught; template builds offline (isolated az profile).

### G-PUB — public repository (complete)

- `https://github.com/naveenneog/CCOF` (public) holds one commit, `95f0b86`, made from this tree on the orphan
  branch `public-main`: lab tenant, subscription and resource names replaced by neutral labels (21 rules, 168 hits),
  and the 47 live-run screenshots that show lab resource names removed (`docs/images/staged`,
  `docs/images/staged-stdv2`, `docs/runbooks/images/staged-portal`). The 86 middle-masked Portal images stay.
- Checks on the public tree: identifier scan 0 hits; gitleaks 1 commit, 2 findings, both the known false positive
  `projectApi: "v1-compatible"`; root 1132 pass, admin 159, staged 398, resolver auth 36; gate PASS.
- Local `main` keeps the full history and is not pushed. A later release is made on `public-main`:
  `git checkout public-main; git checkout main -- .`, rerun the scrub script (kept outside the repository because it
  lists the lab names it removes), commit, push `public-main:main`.
- History up to `55b816f` remains public in `naveenneog/ccof-bicep`, with the lab names this scrub removed.
- Release 2 (2026-10-23): `eeff307` on `public-main`, pushed to `main`, carries precedence by spend (`7594b8a`).
  Identifier scan 0 hits; gitleaks only the known false positive; root 1137 pass; staged 398. The scrub's
  `git rm` had refused the re-checked-out images (staged files need `-f`); they were removed before the commit,
  and the script now uses `-f` and stops if any image path is still tracked or present.
- Release 3 (2026-10-23): `b72e527`, the user names setting and the Graph grant steps (`670c715`). The script
  removed the images itself; identifier scan 0; gitleaks no findings in the change; staged 400.

### G-TAG — user tags (complete, admin 3.4.0)

- Owner decision 2026-10-23: the chargeback ID is an individual user tag. Per-person tag and saved-tag list in
  `adminConfig` ([src/contracts/user-tags.ts](../src/contracts/user-tags.ts)); admin API `/api/user-tags`
  ([admin/src/user-tags.ts](../admin/src/user-tags.ts)); the sync copies a person's tag into their group
  memberships' `chargebackId` (group's own ID as default; an unreadable tag store keeps stored IDs;
  [src/sync/plan.ts](../src/sync/plan.ts)); the gateway trace, ledger, workbook and exports carry it unchanged.
  Developers view gains `userTag`; console: User tags page (pick a group member through Graph, identity and current
  tag shown, saved tags suggested), chargeback "User tag" filter with suggestions.
- Tests: root suite green (user tags 8, sync run 18); admin 157/157; offline Kusto checker 0 errors on the
  developers query (negative control 1). Mutants: 20 caught (admin API 10, sync/contract/report 9, paging 1);
  one equivalent mutant removed by deleting the redundant guard. Browser (Edge, demo): 15/15 checks in light, dark
  and 390 px, including a two-editor stale save refused; the only console entry is that intended 412.
- Live: Graph member listing not verified; the Lab A token now gets a Continuous Access Evaluation challenge
  (`TokenCreatedWithOutdatedPolicies`) and needs a fresh `az login`.
- Council round 1: ARCHITECT, CODER, QA, UX BLOCK (unbounded sync query; saved list written before the change record;
  edit re-read the ETag at save time; object-ID-only entry); SECURITY PASS. Round 2: QA (previous person's data
  could enable Save), UX (`suggestionSaved: false` not shown), SECURITY (members of any directory group listable)
  BLOCK. Round 3: all five PASS; ARCHITECT note: the sync reads every tag each run (O(tags)), watch RU before
  approaching 200,000. Admin 159/159; 24 mutants caught in total.

### G-PREC and G-REM — precedence by spend, removal as retirement (complete)

- Owner decisions 2026-10-23. Without a selector, a person in several groups gets the group where they have the
  higher month-to-date spend (the reconciler's `spentCcu` in their `budgetState` for that group, current UTC month;
  none counts as zero), then the lower priority; a tie or malformed priority is refused, a malformed spend is
  `budget_state_invalid` ([select-membership.ts](../src/resolver/select-membership.ts)). Console help and hints
  updated.
- Revision (critic review): the first version compared per-user budgets, which is not usage spend. It now reads
  spend; the membership field `perUserBudget` that only the budget rule used is removed from the sync.
- Removal is retirement: group retirement already matched project retirement; a test proves removal ignores
  the removal limits ([sync-group-documents.test.ts](../tests/sync-group-documents.test.ts)).
- Tests: precedence 15/15 (spend order, exact decimals of any length including 500 digits, earlier month, no state,
  missing-state winner refused, ties, exhausted winner refused, malformed spend, failed read, baseline candidate);
  sync: a leftover `perUserBudget` is rewritten away (with a no-write control); root 1137 pass, 0 fail. Mutants 7/7
  caught (one first survived and the baseline test was strengthened); negative controls for a digit cap, a float
  comparison and a comparison that ignores the old field.
- Council (spend version): round 1 ARCHITECT, CODER, QA BLOCK (30-digit cap could reject valid reconciler output;
  missing-state winner untested); round 2 BLOCK on a 400-character cap; round 3 all five PASS.
- Council (first version) round 1: CODER, QA BLOCK (priority above 10,000 could win); fixed with a test. ARCHITECT
  PASS-WITH-NOTES (rollout: bump `gateway.keyVersion`, recorded in ADR-0034), UX and SECURITY PASS.

### G-SEED — staged pilot as a group (complete)

- A staged `groups` entry with `"kind": "group"` has no project or classification ([Staged.Groups.ps1](../infra/staged/Staged.Groups.ps1)).
  Stage 4 creates or finds its Entra group (key `group/<name or id>`; baseline keys unchanged), Stage 5 lists it in
  the workbook, and Stage 7 rechecks the group in Graph, seeds its group document and writes the client file for
  `client.group`. Stage 8 sends no selector and checks in the `ccof.usage.v1` trace that requests were charged to
  the pilot group. `registrySeed` ([registry-seed.ts](../src/sync/registry-seed.ts)) accepts active group documents
  checked by `readGroupRegistration`. The example pilot is `CCOF-PILOT01`.
- Tests: staged 398 checks (was 360); registry seed 67/67; root 1117 pass, 0 fail; quickstart client 19/19 (refactor
  guard); selection KQL 0 errors in the offline checker (negative control 1 error). Mutants 19/19 caught.
- Live (Lab A, read-only): Stage 0 with the new example configuration completed in 59 s.
- Council round 1: ARCHITECT, CODER, QA BLOCK (a group deleted after Stage 4 could be seeded permanently;
  `backendId` not checked for group entries; Stage 8 could pass on another group); UX PASS-WITH-NOTES; SECURITY PASS.
  Round 2: QA BLOCK (mixed selector/no-selector acceptance switched the check off), others PASS. Round 3: QA PASS.
  Each fix has a test and a mutant.

### G9 — live verification (partial, 2026-10-23, Lab A)

Isolated `AZURE_CONFIG_DIR` per tenant; no Azure or Entra resource was created or changed.

- Admin group directory ([group-directory.ts](../admin/src/group-directory.ts)) run against Microsoft Graph with a
  delegated token: search `ccof` returned 8 security groups; hyphenated (`CCOF-LAB1`, 2) and partial (`lab`, 4)
  terms matched; group read with `members/$count` returned the member count (1); unknown ID `not_found`; disabled
  flag `disabled`; negative control with an invalid token `permission_required` (Graph 401).
- Stage 0 with a configuration derived from the example (new keys included): a backend without deployments stopped
  with `verify_failed: backend laba lacks deployments` (negative); with `stage1.foundry.create: true` it completed
  and verified in 60 s (providers registered, Flex in eastus2, planned deployments listed).
- `stage5-config.bicep` builds with `ADMIN_GROUP_SEARCH_ENABLED` from `admin.groupSearchEnabled`.
- Not done: the admin identity's Graph grants (needs a Privileged Role Administrator); deploying the group-centric
  packages to a lab and gateway calls with group decisions, surfaces and chargeback ID (models are in Lab B, whose
  profile needs an interactive `az login`). The Lab A lab `lab-stdv2-rg` has no Claude deployments and
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

Verified 2026-10-20 in Lab B and Lab A ([report](STAGED-STDV2-RUNS-2026-10-20.md)).
Open: Portal walkthrough screenshots need a persistent Portal sign-in; Graph application consent
needs PIM activation in Lab A; Claude in Lab A needs a non-sandbox subscription.


## Staged deployment, stages 0-8

**Completed packet:** S2 — staged entry points for stages 2-8 and a live end-to-end run.

Status: verified, 2026-10-20, in the new lab RG `lab-staged-rg`
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
