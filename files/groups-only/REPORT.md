# G-GROUPS-ONLY — paused inventory

## Status

Branch `feature/groups-only-console`, base `e8d9353`, isolated worktree.
Paused immediately on owner's expanded group-only migration decision.
Only the navigation test harness/tests and draft ADR/ledger changed.
No production UI, demo, source/runtime/server, Azure resource or deployment changed.
No files removed/moved. No push or merge.

Focused RED run: 13 tests loaded, 2 pass, 11 fail, zero skipped/cancelled.
Failures explicitly reproduce legacy destinations, navigation, controls and selection.
Root/admin npm ci succeeded; both report two existing high dependency findings.
Mutation/browser/full build/typecheck/root/admin suite/final packet gate are not run.

## Remaining legacy UI surfaces found

- `admin/ui-v3/lib/nav.ts`, `main.tsx`: Legacy projects navigation and all project
  list/create/detail/subtab routes.
- Exclusive legacy modules: `pages/projects.tsx`, `project-detail.tsx`,
  `new-project.tsx`, `components/onboarding.tsx`; related HELP topics and
  `components/shell.tsx` helpKey/breadcrumb cases.
- Shared helpers must move before deletion: PagerLite, ChangeList and applyPatch
  from project-detail (applyPatch is used by group-fields); useDebounced from projects.
- `components/cost-breakdown.tsx`: legacy registry/tag toggles, project cost query,
  classification drill-down and legacy management destinations.
- `pages/budgets.tsx`: mixed-scope links, conditional Legacy classification column,
  project/classification burn-down selector and legacy registration fallback.
- `pages/chargeback.tsx`: Projects breakdown, Groups/Projects rank toggle, Project
  filter, Project tags, legacy registry query, project-only labels and filters.
- Overview/Audit shared links, Reconciler filter state and snapshot table; Foundry's
  legacy list request/linked scopes; health/help/cost-definition wording;
  LimitsEditor retains legacy classification branching.
- `admin/dev/serve.ts` and `demo-data.ts` seed or shape legacy projects.
- Existing legacy UI assertions in `ui-v3.test.ts`, `v3-bug-bash.test.ts` require
  deliberate behavior replacements; they have not been edited yet.
- Console docs ADMIN-V3/ADMIN-API and onboarding/operations guidance remain unchanged.

## Remaining API/source/deployment surfaces found (inventory, not deletion list)

- `admin/src/function-app.ts` registers GET/POST `/api/projects`, GET
  `/api/projects/{projectId}`, classification part updates, settings PUT and retire
  POST. Their handlers/validation/storage/client exports live in `api.ts`,
  `validation.ts`, `cosmos-store.ts`, `client-config.ts`, `export.ts`.
- `admin/src/v2.ts`: paged/filterable project listing.
  `admin/src/v3.ts`: project/classification read/shaping and project-tag resolution.
  `chargeback.ts`, history/change-log and operations also carry project-era scopes.
  Some of these are shared with groups: their identifiers alone do not prove they
  can be deleted.
- `src/sync/projects.ts`, registry-seed, membership, plan/types/run/telemetry
  retain legacy document and classification paths.
- `src/resolver/decide.ts`, select-membership, HTTP/refusal/freshness/my-usage paths
  retain project/classification scope semantics.
- `src/reconciler/registry.ts`, documents, ledger, reconciliation/price rows,
  history, Azure/run/telemetry retain project/classification accounting.
- `src/contracts` includes shared model-family and group-registration contracts;
  these and Cosmos schema/gateway policy need an explicit migration contract.
- `infra/staged/Staged.Application.ps1`, `Staged.Groups.ps1`, archived
  `infra/quickstart/Deploy-Quickstart.ps1`: project selection/seeding and client
  projectId paths remain.
- `analytics` KQL/workbooks/alerts retain project/classification dimensions.

## Tests replaced and why (draft only)

The navigation harness's previous assertions that historical IDs link to project
pages, legacy classifications remain editable, legacy budgets read classifications,
and Foundry includes projects were replaced with the opposite group-only behavior
specified in the original brief. Server compatibility tests were not touched.
New tests add old-bookmark notice/navigation, no removed-page imports/controls,
GUID-only scope destinations and group-only fixtures.

## Resume prerequisites

Coordinator defines the expanded decommission and migration contract and explicitly
authorizes resuming. ADR-0054 is a paused proposal; GO-3 is open. Do not delete Azure
resource groups, alter production, or remove enforcement based on this inventory.
On resume finish/review RED fixtures, implement the authorized packet, replace
remaining obsolete UI assertions, mutation-check guards with full test counts,
run Edge demo navigation and all requested checks; then hold five-role council.
