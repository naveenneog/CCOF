# G-GROUPS-ONLY

Branch: `feature/groups-only-console`, base `e8d9353`.
No push, merge, main-worktree changes, Azure operations or production deployment.

## Commits and RED evidence

- `7b94b88` — `test(admin): checkpoint RED group-only contract before migration pause`.
  All 13 tests loaded: 2 passed, 11 failed. Messages included
  "Budgets must not link to removed pages", corresponding Reconciler/Overview/Audit
  failures, "Chargeback must link to the group, not a legacy project", and
  `/projects/PROJECT01/activity` versus expected null. Owner requested a pause;
  work was cleanly committed with no production edits.
- `2683aef` — `feat(admin): make the current console group-only`.
  Owner explicitly resumed; 31 focused tests and all 219 admin tests passed.
- `8c08ca2` — `fix(admin): preserve draft text while entering group IDs`.
  Browser RED: manual GUID entry returned an empty value instead of the typed GUID.
  Draft/validated state separation fixed Overview and Chargeback. Admin build,
  navigation tests and 27 browser checks passed.
- `73a42d2` — `test(admin): prove group-only guards with six full-suite mutations`.
- Final demo/evidence commits record the seeded-directory correction, cleanup,
  checks and completion.

All commits have the required Copilot trailers. ADR-0054 records the accepted
minimal scope and separately coordinated decommission of obsolete deployments.
Active application/network deployments remain untouched.

## Removed files and extracted helpers

Removed:

- `admin/ui-v3/pages/projects.tsx`
- `admin/ui-v3/pages/project-detail.tsx`
- `admin/ui-v3/pages/new-project.tsx`
- `admin/ui-v3/components/onboarding.tsx`

Moved without duplication:

- PagerLite and ChangeList → `admin/ui-v3/components/records.tsx`
- useDebounced → `admin/ui-v3/lib/hooks.ts`
- applyPatch → `admin/ui-v3/lib/limits-patch.ts` (still used by group-fields)

Added shared ScopeLink: GUID IDs link to Groups; historical non-GUID IDs render as
plain text. Removed legacy nav/help/breadcrumb cases, management routes, classification
controls/columns/drill-down, project tags, Projects chargeback breakdown/rank toggle
and project labels. Old bookmarks show a short explanation with a Groups link.
Budgets selects only groups and reads `/api/groups/{id}`; Foundry lists linked groups
only. Demo seeds 26 validated group registrations and derives group telemetry.

## Tests replaced and why

- `ui-navigation.test.ts`: replaced intentional legacy destinations, classification
  preservation, legacy burn-down lookup and Foundry legacy links with group-only
  assertions and plain historical text. Added bookmark/nav/help, mixed/group-only
  fixtures, group deep links, obsolete query-filter rejection and valid demo seeds.
  Test artifacts now use a project-local directory, not the system temporary directory.
- The previous no-Group-heading assertion protected against classification being
  relabelled "Group". The new table legitimately labels its scope identifier Group;
  it now asserts exactly one Group heading and no classification heading/value.
- `ui-v3.test.ts`: replaced Legacy projects sidebar/help expectations and the old
  conditional project route with group-only navigation/ScopeLink assertions.
  Restricted-family approval is still required; no classification escape remains.
- `v3-bug-bash.test.ts`: dropdown checks now inspect groups/group-onboard/group-detail
  rather than deleted project pages, plus Chargeback.
- No server compatibility tests were removed, skipped or weakened.
- Browser regression: seeded groups must resolve in the synthetic directory.
  RED was 404 instead of 200; deriving the directory from the group seed fixes
  detail member lookup and retains unregistered sandbox groups for onboarding.
- Removed six unused CSS rules for the deleted onboarding grid and project-tag toggles.

## Mutation checks

Six mutations caught, zero survivors, zero load-failure credit.
Every run loaded all 219 admin tests; each failed its named assertion(s):

| Guard removed/reversed | Failures |
| --- | --- |
| GUID-only routing | scope paths; historical Chargeback text (2) |
| Group-only burn-down selection | Budgets excludes historical records (1) |
| Foundry backend isolation | Foundry linked groups only (1) |
| Legacy nav removal | bookmark/nav; sidebar/help (2) |
| Bookmark explanation | bookmark/nav; sidebar/help (2) |
| Ignore old classification URL filter | Chargeback deep-link/filter contract (1) |

Production mutations were restored; final baseline 219/219 passed. Detailed names
and counts: `mutation-results.json`. Routing was rerun after strengthening the
case-insensitive historical destination assertion; it is counted once.

## Microsoft Edge browser

`browser-check.cjs` uses playwright-core supplied via PLAYWRIGHT_DIR and the local
demo on port 7179. Browser checks use only synthetic data and no real directory.

- All 12 sidebar pages and group onboarding load without page errors, Classification/Legacy projects
  controls or project destinations.
- Seven real group-link paths open editable group detail: Groups, Overview, Budgets,
  Reconciler, Chargeback, Foundry and Audit telemetry.
- Overview and Chargeback accept a manually typed GUID and query that group.
- All seven Chargeback breakdown tabs load; no Projects tab or Rank toggle.
- Five old bookmark forms (list, new, detail, budgets, activity) show the explanation
  and lead to Groups.
- Final 28 checks, zero page errors, zero legacy project/classification API reads.
- Every seeded group can resolve in the same synthetic directory used by group details.
- Demo process stopped; port 7179 verified not listening.

Evidence: `browser-results.json`.

## Checks

- Root/admin npm ci succeeded; missing dependencies restored without manifest changes.
- Admin tests: 219 passed, 0 failed/skipped.
- Focused rendering/UI tests: 31 passed; navigation harness: 16 passed.
- Admin build: passed.
- Root requested typecheck (`tsconfig.typecheck.json`): exit 0.
- Root npm test: PASS through the packet gate, 411.4 seconds.
- Root default typecheck and build: PASS through the packet gate.
- Packet gate: PASS, 23 passed / 2 warned / 0 failed / 1 skipped.
  Existing warnings: five oversized historical files and three unrelated OPEN
  unknowns (G-R3, E2E-01, CC-01). Lint skipped because no command is declared.
- Added-line leak scan: zero matches; git whitespace checks pass.
- Compact gate evidence: `gate-results.json`; raw outputs are disposable local artifacts.
- Five-role direct council: Architect/Coder/QA/UX PASS; Security PASS-WITH-NOTES for
  existing dependency audit findings. No additional agents launched.

## Follow-up only

Coordinator handles identified obsolete deployment decommission; active deployments
stay untouched. Server/schema compatibility is intentionally retained to avoid a
runtime rewrite: project APIs, sync/resolver/reconciler legacy handling, staged project
selection, shared contracts, Cosmos schema, gateway policy and KQL were not changed.
Any future removal needs the separately approved data/runtime migration plan
(G-LEGACY-SERVER-MIGRATION). Existing two high-severity dependency findings are tracked
as G-DEPENDENCY-AUDIT; existing file-size/open-unknown gate debt is outside this packet.
