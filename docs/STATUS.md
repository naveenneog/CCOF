# Current work

## Group-centric onboarding

**Active packet:** G-NOVICE — first-time reader deployment from the README (complete; [ROADMAP](ROADMAP.md), [evidence](evidence/2026-10-25-novice/README.md)).

### G-NOVICE — first-time reader deployment (complete, 2026-10-25)

- Acceptance: a reader following only the README and get-started pages reaches Stage 8 and a working developer
  setup with `signInMethod: azure-cli`; each failure met is captured, and is either refused at Stage 0 with the fix
  named or explained where it is met; developers have one sign-in step for both methods.
- Live: attempt 1 (`ccof-nov-rg`) stopped at Stage 3 and was deleted (Stage 1 is create-only; Foundry account
  purged to free 20 + 20 DataZone units). Attempt 2 (`ccof-nov2-rg`) passed Stages 0-8; Stage 8 anonymous `401`,
  Haiku `200`, Opus `403`. Developer setup from page 5 in a scratch profile: `claude -p` answered, `/usage` showed
  USD 0 of 100. The interactive sign-in window was replaced by a copy of an already signed-in profile.
- Code fixes (each failing first): Stage 0 refuses no API Management and a private Foundry account without a private
  endpoint; Stage 1 create-only messages; Stage 6 read-back skips Foundry zones it did not create and redeploys its
  own network after a failed read-back; changed-config errors name every affected stage; ARM errors lead with
  resource, code and innermost message; setup prints `signInMethod` and `signIn`.
- Council: round 1 Architect BLOCK (Stage 6 recovery trusted any succeeded `stage6-network` deployment); Coder and
  QA PASS-WITH-NOTES (same guard, duplicate AZ-05 row); UX PASS-WITH-NOTES (Desktop sign-in wording, capture omitted
  the model notice); Security PASS (hardening note on the same guard). Fixed with failing tests first: the guard now
  requires create mode, this VNet's `vnetId` output, unchanged `network.create` and a non-shared resource group
  (verified on the live deployment), [ADR-0042](adr/0042-stage0-refusals-and-stage6-recovery.md). Round 2: Architect
  PASS, UX PASS-WITH-NOTES (Desktop links, fixed).
- Open: CC-01 (Claude Code model-catalog notice), next packet G-CCMODEL. Decision record:
  [ADR-0042](adr/0042-stage0-refusals-and-stage6-recovery.md).

**Previous packet:** G-AZCLI — Azure CLI developer sign-in (complete; [ADR-0041](adr/0041-azure-cli-developer-sign-in.md)).

### G-AZCLI — Azure CLI developer sign-in (complete, 2026-10-25)

Acceptance:
- Given `signInMethod: azure-cli`, Claude Code setup writes `ccof-token.cmd` that runs `az login` once when no
  cached token exists, in the profile `<config folder>\az`, and prints only the token; `settings.json` points
  `apiKeyHelper` at it with a cache time of at most 240 s.
- Claude Desktop setup writes a `helper-script` profile using the same helper, even when `external-idp` is
  supported.
- `/usage` gets its token from that helper.
- Unsafe tenant, scope or folder values are refused before any file is written.
- Stage 7 writes `signInMethod` only when Stage 4 allowed the Azure CLI; Stage 4 reads back the preauthorization.
- Live: the helper's token is accepted by the gateway (HTTP 200) and its claims match AZ-01.

Result:
- Checks: client Node 77/77; client PowerShell 46/46 (a planted `az.cmd` in the working folder or first on `PATH`
  never runs; a signed-out `silent-token` makes one token call and no sign-in); staged checks 478; full `npm test`
  with a logged-out isolated Azure CLI profile; `node .ironclad/gate.mjs --stage packet` PASS (22 passed, 3
  warnings: uncommitted size before this commit, file-size budget on files this packet does not touch, open G-R3 and
  E2E-01). Mutation checks on the helper generator and the Stage 7 ordering were caught.
- Test contract change: `tests/Test-AdminHandWorkbook.ps1` pinned the whole original workbook by hash, while
  `tests/manual-guide.test.ts` requires its nine hand-copy client source blocks to equal `client/`. The first client
  change since 2026-10-16 made the two contradict. The hash now covers the original text with those nine blocks
  replaced by a placeholder; the digest is identical at `28a0bad` and after this change. A prose edit and a source
  drift each still fail.
- Live, demo lab 2026-10-25 (Azure CLI 2.91.0): token claims as AZ-01; `/usage` returned the developer's groups;
  `POST /v1/messages` HTTP 200; `claude -p` with the generated `settings.json` answered `OK`, including from a
  folder holding a planted `az.cmd`, which did not run.
- Council round 1: Security HIGH (helper ran `az.cmd` by bare name, so a planted `az.cmd` in the project folder
  could run); Coder High (the status line could open a browser sign-in on every refresh); UX BLOCK (`/usage` turned
  every helper failure into "sign in first"); two Medium (Desktop-only helper path, late Stage 7 check). Each fixed
  with a failing test first. Round 2: Architect PASS-WITH-NOTES (the 240 s cap relies on the Azure CLI 2.91.0
  refresh floor, recorded in AZ-02); Coder PASS; QA PASS; UX PASS; Security PASS.

### G-DOCS-R2 — novice reader fixes (complete, 2026-10-24)

- Acceptance (novice review items 1-7): developer setup starts with getting the code; the stale capture note is
  gone; Stages 1-8 each show the preview command before `-Apply` and the preview's last line; the console names
  the earlier-model page **Legacy projects**; Stage 7 has a plain success checklist; the lab route gives a sourced
  rough daily cost and how to check actual spend; 13 earlier guides are in `docs/archive/` with a README. Item 8
  (the separate older repository) is out of scope by the owner's decision.
- Scope: documentation, one console label and tests; no Azure deployment. The 2026-10-24 console captures predate
  the label; the onboarding page, evidence README and ADMIN-V3 say so.
- Checks: reader docs 13/13 (5 new; each new detector negative-tested: a removed preview line, a former
  `docs/` path and a mis-rewritten archive link each fail it); admin 167/167; `npm build` of the console; full
  `npm test` with a logged-out isolated Azure CLI profile passed; repo-wide relative-link scan 35 broken before and
  after, all pre-existing (targets never committed). `node .ironclad/gate.mjs --stage packet` PASS (23 passed,
  2 pre-existing warnings: file-size budget on files this packet does not touch, and the open G-R3 and E2E-01
  unknowns; 1 skipped).
- Council: Architect PASS; Coder PASS (runtime paths in tests resolve; cited line numbers unchanged because the
  archive rewrites replace lines in place); QA PASS-WITH-NOTES (preview and archive tests tightened per section and
  for inbound paths; cost links now point at the filtered price queries); UX PASS-WITH-NOTES (screenshot label
  note added to the onboarding page); Security PASS (no exploitable findings in the diff, admin API authorization,
  CSV export, gateway enforcement or client token storage; no real identifiers in the diff).
- Source commits: `3de09e8`, `adb7005`, `921a192` and the ledger commit, local `main`.

### G-DOCS-R1 — first-time reader follow-up (complete, 2026-10-24)

- Acceptance: key deployment values shown; measured single-subscription lab route includes duration, permissions and
  charges; onboarding guide uses the readable review screen; exhausted-budget output uses the current status-line
  formatter; README summary uses reader-facing language. Complete.
- Scope: documentation and evidence only; no Azure deployment or product behavior changes. The screenshot was
  refreshed from the saved usage response; no paid model request was made.
- Checks: reader docs and pseudonymisation 13/13; client usage 16/16; `node .ironclad/gate.mjs --stage packet`
  PASS (23 passed, 2 pre-existing warnings for G-R3 and E2E-01, 1 skipped). Gate's full `npm test` passed.
- Council: Architect PASS (no architecture changes); Coder PASS (focused documentation and recorded output);
  QA PASS (new reader assertions and existing status-line regression); UX PASS (cost/permissions surfaced and
  field labels readable); Security PASS (configured identifier scan clean, no secrets or live calls).
- Source commit: `032aeb1` (`docs: clarify first-time setup and evidence`), local `main`; no Azure deployment.
- Public release 11: `fcb187c` on `naveenneog/CCOF` `main`, applied to `public-main` as the `2f84715..53bac48` diff.
  Scans of the published tree, 2026-10-24: release 11 adds no scrub-rule match. The scrub check reports 6 matches,
  all the hypothetical `lab-a.com` alias in `docs/evidence/2026-10-24-demo/README.md` (1) and
  `tests/docs-pseudonymise.test.ts` (5), published in release 10. The private-literal scan matches only the public
  repository name `naveenneog/CCOF` (clone URL in `docs/get-started/03-deploy.md`, CI links in ROADMAP/STATUS). The
  three GUIDs in `usage-03-refused.txt` are pseudonyms; none of the raw capture's GUIDs appear in `origin/main`.
  gitleaks clean; docs tests 13/13 on the public tree; public CI run `40110954891` success.

### G-DOCS — documentation refresh (2026-10-24, complete)

- Acceptance: short role-based pages, prerequisites and stages with expected outputs, live Portal and console
  captures with consistent hypothetical identifiers, own-usage states and chargeback CSV; links checked offline.
- Fresh `ccof-demo-rg` deployment: Stages 0-8 verified on their first runs. Product onboarded in the deployed
  console; 44 screenshots, with names and IDs replaced before capture.
- Demo guard 80 / 25 / 5: USD 2 person budget ended at USD 2.14 recorded (7% over); 71 succeeded, 95 throttled,
  69 refused. This is not a strict dollar ceiling. [Evidence](evidence/2026-10-24-demo/README.md).
- Live capture exposed an exhausted-status-line omission. RED: expected refusal text was absent; GREEN:
  client 68/68. Root 1206 pass and strict typecheck clean before recovery.
- Council round 1 found rehashed pseudonyms on repeat capture, unpinned developer login configuration and incorrect
  snapshot/cache instructions. Regression tests failed first; capture now restores the live DOM even on failure.
  Login uses the supplied absolute config; snapshot mode lists all registered groups explicitly.
- Council round 2: ARCHITECT, CODER, QA, UX and SECURITY PASS. Ten docs/capture tests pass; nine mutations caught
  with all five tests loading in each targeted suite. Client 68/68; exported suite 1212 pass, six opt-in live tests
  skipped, zero failed; strict typecheck and packet gate pass. Fifteen reader-facing PowerShell blocks parse.
- All 44 images checked with local Windows OCR: no configured real-name or known live-GUID matches. Staged secret
  scan clean; 656 tracked text files checked against eight known live IDs, with a deliberate leak rejected.
- Reviewed source: `cae4567`. Public release 10: `2f84715`; CI passes on Node 22 and 26, including every tracked
  Bicep template ([run](https://github.com/naveenneog/CCOF/actions/runs/40096140727)). Remote tree verified:
  44 evidence images, zero old live captures.
- Temporary client home removed and the session-owned capture browser stopped. The demo lab was retained and
  remains billable; no Azure resources were changed during recovery.
- Publication retained the hypothetical Lab A aliases in the new reader pages, evidence and capture-test fixture;
  the older real-tenant label substitution was excluded for those aliases. Other identifier rules still ran.

### G-GUARD — budget guard: projected spend, rate guard, 80% warning (2026-10-24)

- Owner: "throttling the user when he is at 80% of his usage notify him ... 15 percent overshoot is too much".
  Reconciler projects hidden spend (last 5 minutes x projection minutes), always limits the rate to the overshoot
  percent of the budget per projection window, warns and slows from the warn percent ([ADR-0040](adr/0040-budget-guard.md)).
  `/usage` and the status line show the warning. Settings `reconciler.budgetGuard` (example 80 / 5 / 5), Stage 5,
  quickstart Bicep and Core D2 parity.
- Tests: guard 5 (mutants 4/4), settings 2, `/usage` 2, client 1, staged contract (467). Root 1201 pass.
- Live: USD 14 budget at 80.4%: warning shown at once; final USD 13.84 (-1.1%), against +12.5% recorded / +19.7%
  list before. Spend USD 2.59. Council round 2 all PASS. Public release 9: `5b82caa`, CI passes (Node 22, 26).
### G-LIMIT live acceptance (2026-10-24)

- New staged deployment from the guide, Stages 0–8 verified, lab subscription, resource group `lab-e2e-rg`
  (prefix `e2e1024`, own Foundry account, existing Entra registrations and two existing groups). Portal walkthrough:
  21 of 21 screens, masked captures (not published in the public repository).
- Through the gateway: 15 of 15 admission and bypass cases; family limit 429 (Beta Haiku, 20,000 TPM); higher-spend
  selection (Alpha at equal spend, Beta after Beta spent more; no fallback); USD 10 Alpha budget used up: exhausted at
  21:24:00 (USD 10.35 recorded), first refusal 21:24:25, final recorded USD 11.25, list-price USD 11.97 (USD 0.72 =
  streamed cache writes the ledger cannot see); 8 of 8 attempts after exhaustion refused or confined to Beta's budget.
  Total estimated spend USD 11.98 against the USD 10 authorised (in-flight overshoot of the test itself).
- Chargeback: `WBS ID` field name, a person's `WBS-1001.01`, suggestion, CSV column and value, in the deployed console.
- Fixed with tests: ledger GUID typing (group usage was never attributed, `d9b6978`); policy fragments for the 16 KB
  API policy limit (ADR-0039, `8773205`); Stage 1 null subnet (`3beb2bb`); BOM read, usage-policy comments, Stage 8
  JSON column (`8773205`); `/usage` rows classified `no-backend-call` in the ledger (`d9b6978`). Mutants: split 3/3 caught; RED shown for
  every other new test.
- Council: round 1 Coder BLOCK (fragment ID bounds), fixed; round 2 all PASS. Public release 8: `66ea82c`, public CI
  passes (Node 22 and 26). The lab stays deployed for inspection.
- Open: E2E-01 (backend 429 shown as unpriced in chargeback; owner decision). Report:
  [BUDGET-ACCEPTANCE-2026-10-23.md](status/BUDGET-ACCEPTANCE-2026-10-23.md).
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
- G-WALK documentation and evidence: `024cec6`. Public release 7: `c987d02`, identifier scan clean, gitleaks clean,
  scrubbed-tree tests and strict typecheck pass. Public CI passes on Node 22 and 26
  ([run](https://github.com/naveenneog/CCOF/actions/runs/39999794528)).

### G-HA — Cosmos DB redundancy and consistency (complete offline)

- Owner: "a cosmos with consistency model ... so its not a single point of failure". `stage1.cosmosLocations` (regions in
  failover order, `isZoneRedundant`), `stage1.cosmosConsistency`; two or more regions turn on service-managed failover;
  configuration checks and a Stage 1 read-back (Staged.Cosmos.ps1); the resolver
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

- `admin.userNamesEnabled` → `ADMIN_USER_NAMES_ENABLED` in Stage 5 (stage5-config.bicep);
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

- A staged `groups` entry with `"kind": "group"` has no project or classification (Staged.Groups.ps1).
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
  (`ADMIN_GROUP_SEARCH_ENABLED`) in the staged configuration (Staged.Application.ps1,
  stage5-config.bicep). Both default off.
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

Verified 2026-10-20 in Lab B and Lab A ([report](archive/STAGED-STDV2-RUNS-2026-10-20.md)).
Open: Portal walkthrough screenshots need a persistent Portal sign-in; Graph application consent
needs PIM activation in Lab A; Claude in Lab A needs a non-sandbox subscription.


## Staged deployment, stages 0-8

**Completed packet:** S2 — staged entry points for stages 2-8 and a live end-to-end run.

Status: verified, 2026-10-20, in the new lab RG `lab-staged-rg`
([report](archive/STAGED-LIVE-RUN-2026-10-20.md)). The Stage 1 RG below was deleted first.

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

Detailed [live report](archive/STAGE1-LIVE-VERIFICATION.md) and
[commands/permissions](runbooks/STAGED-DEPLOYMENT-V2.md).
This packet's commit is the Git change containing this status file.
