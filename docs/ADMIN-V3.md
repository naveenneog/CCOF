# Admin console V3: settings, permissions, upgrade and rollback

Release source: `feat/admin-console-v2`; package version **3.4.0**. Design: [ADMIN-V3-DESIGN.md](ADMIN-V3-DESIGN.md).
One ZIP serves both consoles. V2 stays at `/api/console` and is unchanged; V3 is at
`/api/console-v3` and is served only when `ADMIN_V3_ENABLED=true`. This is an
**admin-app-only** upgrade up to 3.1.0: no gateway, sync or reconciler change, no new Entra app, roles or scopes.
3.2.0 also needs the sync package for retirement and removal limits to take effect (below).

**3.1.0:** current Entra user names appear beside full object IDs in Overview, Chargeback,
Budgets/Reconciler and Audit/Activity. The admin managed identity needs Graph application
`User.Read.All` with tenant admin consent, plus `ADMIN_USER_NAMES_ENABLED=true`.
The [step-by-step VDI upgrade](ADMIN-V3-VDI-UPGRADE.md) covers the manual grant, private publishing,
settings, verification and rollback. Names are memory-only; filters and exports retain object IDs.

**Current console** ([ADR-0054](adr/0054-group-only-admin-console.md)): group-only.
New deployments use groups; obsolete project-based deployments are separately
decommissioned. Legacy projects navigation/editors, classification controls,
project tags and the Projects chargeback breakdown/rank toggle are removed.
Old `#/projects/...` bookmarks show a short explanation with a Groups link.
Historical non-GUID scopes stay visible as text, while GUIDs link to Groups.
Server APIs, schema and runtime handling are unchanged in this console-only packet.

**3.3.0** ([ADR-0034](adr/0034-group-centric-onboarding.md)): group-centric onboarding.

- **Groups** page (`#/groups`): onboarded Entra groups with status, chargeback ID, budget mode,
  surfaces and priority; Usage CSV (this month) and Groups CSV downloads
  ([ADMIN-API.md](ADMIN-API.md), "Export for Power BI").
- The 2026-10-24 console captures show a **Projects** sidebar entry that no longer
  exists. Use **Groups** for all current onboarding and management.
- **Onboard a group** (`#/groups/new`): search Entra security groups (direct member count shown),
  set the per-user budget and auto-scale or a monthly group cap (with an estimate for the current
  members), allowed surfaces, chargeback ID, priority, models and limits (Fable/Mythos only with
  approval), expected cache-read share (suggested from the surfaces with its evidence class), and the
  budget assistant seeded with that share. Group detail (`#/groups/{id}`) edits and retires a group.
- **Chargeback**: a "Chargeback IDs" breakdown and a chargeback ID filter.
- Needs: the gateway, resolver, sync and reconciler packages from the same release (group documents
  are read by all four), Graph application `Group.ReadBasic.All` and `GroupMember.ReadBasic.All` on the
  admin managed identity with `ADMIN_GROUP_SEARCH_ENABLED=true` for search (without them, paste the
  group's Object ID), and `entra.surfaceClients` in the gateway configuration to enforce surfaces.

**3.4.0** (owner decisions 2026-10-23): user tags and precedence by spend.

- **User tags** page (`#/user-tags`): tag a person (Entra object ID) with a chargeback ID such as a WBS
  element; a new tag is saved and suggested while typing; the list filters by tag; clearing a tag returns
  the person to the group's chargeback ID ([ADMIN-API.md](ADMIN-API.md), "User tags").
- **Tag field name** (G-LABEL, [ADR-0037](adr/0037-deployment-user-tag-label.md)): editors can save
  one deployment-wide name such as **WBS ID** on User tags. It names tagging fields, filters and
  chargeback CSV column headings; the default is **User tag**. Existing saved/suggested values,
  JSON / Power BI `chargebackId` and `userTag` keys and Groups CSV stay unchanged. Settings
  use the existing `adminConfig` container, audit and ETag protections; failed reads/writes surface
  errors instead of silently reverting the name. No new application settings or permissions.
- **Chargeback**: the filter is "User tag" with suggestions; the Developers view and its CSV have a
  User tag column; the former "Chargeback IDs" view is "User tags".
- **Groups**: help and hints state the precedence rule (higher month-to-date spend, then lower priority).
- Needs: the sync package from the same release (it copies tags into memberships and rewrites any membership that
  still carries the earlier `perUserBudget` field), the resolver package (precedence by month-to-date spend, read
  from the reconciler's `budgetState`), `ADMIN_CONFIG_CONTAINER` on the admin app and
  `SYNC_LIMITS_CONTAINER` on the sync app (both `adminConfig`; the staged Stage 3/5 set them with the
  admin app).

**3.2.0:**

- **Historical API behavior, not a current console control:** retiring a project through the legacy API. The project document gets
  `status: "retired"` and `retiredAt`; the project becomes read-only (edits return 409 `project_retired`).
  The entitlement sync removes all its memberships at its next run, outside the removal limits
  ([SYNC.md](SYNC.md)). The Entra groups are not changed.
- **Removal limits** page: an override of the sync's `SYNC_MAX_REMOVALS_PER_RUN` and
  `SYNC_MAX_REMOVAL_FRACTION`, with a reason and an expiry of up to 90 days.
- **Change record**: every admin change (project create, settings, limits, family policy, retire, cost
  definitions, removal limits) is written to the `adminConfig` container before it is applied, then
  completed with its result. If the record cannot be written, the change is refused with 503
  `change_log_unavailable` and nothing is modified (`admin/src/change-log.ts`). Audit and Activity read it;
  the telemetry audit (refused attempts included) stays available as a second source.

A sync older than 3.2.0 treats a retired project as frozen (`status:not_active`): nothing is removed,
and the override is not read. Upgrade the sync package together with the admin package.

## What V3 adds

| Page | What it shows | Data |
| --- | --- | --- |
| Overview | **Cost breakdown**: overall known cost and group picker; group donut (top 7 + "N more"), users (top 8, Entra Object IDs) and models follow the selected group. No classification or project-tag controls. Unknown cost is never zero. Also model-family trend, budget alerts, telemetry/reconciler facts and recent changes | `/api/v3/chargeback/{groups,developers,models,trend,totals,coverage}`, `/api/v2/budgets`, `/api/v3/reconciler/runs`, `/api/v2/health`, `/api/v3/audit` |
| Groups / Onboard a group / Group detail | List, onboard, edit and retire Entra groups; budgets, surfaces, models, limits, priority and chargeback settings | `/api/groups` and `/api/groups/{id}` |
| Chargeback | Totals, coverage, rate-card version, observation time, list price not invoice; cost trend, token categories, top groups and budget burn-down; breakdown tabs (groups, developers, user tags, models, families, unpriced, diagnostics), paging and CSV export | `/api/v3/chargeback/{view}` |
| Budgets | Group and person counts, spend, capped use; burn-down selects only GUID group scopes and reads their group registration; snapshots (groups or people), no classification column | `/api/groups/{id}`, `/api/v3/reconciler/{summary,snapshots}`, `/api/v2/budgets` |
| Reconciler | Run freshness, states written, ingestion delay, unattributed/unpriced; snapshot search by period, scope, group, person, snapshot and budget state | `/api/v3/reconciler/{runs,snapshots}` |
| Foundry | Accounts and deployments, gateway backends with linked groups, missing accounts with affected groups | `/api/v2/inventory`, `/api/v2/deployments`, `/api/groups` |
| Health | Reconciler freshness, telemetry freshness, admin version, endpoint probes, configured integrations — as separate signals | `/api/v2/health`, `/api/v3/{reconciler/runs,chargeback/coverage,version,capabilities}` |
| Audit | Source: **Change record** (default) or **Telemetry** (includes refused attempts). Filter by group, actor, operation, outcome and UTC dates; before → after; paged | `/api/v3/audit/changes`, `/api/v3/audit` |
| Removal limits | Current override state, values, expiry, reason, who changed it; edit with review | `/api/v3/sync/removal-limits` |
| Cost definitions | Rate card in USD or CCU per MTok (exact, 100 CCU = USD 1), families, effective dates, geography multipliers, prompt tiers, cache categories; **Load from file**, **Edit prices** (reprice from a future date), server review, save with ETag; export JSON; model mappings, retail meters, billed cost | `/api/v2/catalog`, `/api/v3/rate-card/review`, `/api/v2/{prices,billed-cost}` |
| Help | All help topics, permissions matrix, runbooks; every page also has a contextual Help drawer | static |

Shell: collapsible sidebar (240 px / 56 px icon rail with tooltips, remembered), overlay drawer under
820 px, breadcrumb, Help toggle, Light / Dark / System theme (remembered; System follows
`prefers-color-scheme`), signed-in user and role. Both themes keep text at 4.5:1 or better
(checked by `admin/tests/ui-v3.test.ts`).

## One query builder for the workbook and the console

`analytics/workbooks/chargeback-queries.ts` builds the chargeback KQL for both the workbook build and
the admin app. The workbook build is unchanged byte for byte (`tests/chargeback-shared-queries.test.ts`
pins the content digests; `admin/tests/chargeback-queries.test.ts` proves the console's options only
add backend/family filter lines, hourly bins and row paging). Workbook parameters (`{Period:base64}`,
`{TimeRange:start}`, …) are bound on the server by the workbook's own renderer (`render.ts`): every
filter value is validated, then reaches KQL base64-encoded. The browser never sends KQL.

The packaged `kql/` folder holds copies of `analytics/ledger.kql`, `analytics/workbooks/pricing.kql`
and `analytics/workbooks/budgets.kql`, made by `npm run build`.

Limits: custom ranges ≤ `ADMIN_CHARGEBACK_MAX_QUERY_DAYS` (default 62), UTC half-open `[from, to)`;
series capped at 2,000 points; row pages ≤ 500; Log Analytics calls time out after 30 s; identical
requests are cached for 60 s per filter set and rate card; the browser cancels a request when filters
change.

## Settings

| Setting | Needed for | Value |
| --- | --- | --- |
| `ADMIN_V3_ENABLED` | V3 console and `/api/v3/*` | `true` to serve; anything else returns 404 (V2 unaffected) |
| `ADMIN_USER_NAMES_ENABLED` | Entra user labels | `true`; admin managed identity Graph `User.Read.All` application permission with consent. No changes to sync or telemetry. |
| `ADMIN_GATEWAY_RESOURCE_ID` | Chargeback, Overview cost | Full ARM ID of the APIM instance (`_ResourceId` of `ApiManagementGatewayLogs`) |
| `ADMIN_CHARGEBACK_WORKSPACE_ID` | Chargeback (optional) | Workspace GUID holding the gateway logs; defaults to `ADMIN_WORKSPACE_ID` |
| `ADMIN_CHARGEBACK_MAX_QUERY_DAYS` | Chargeback (optional) | 31–366, default 62 |
| `ADMIN_LOG_RETENTION_DAYS` | Chargeback (optional) | Workspace retention, default 90 (staged Stage 5 always writes the effective retention); earlier periods are flagged `retention_truncated` |
| `ADMIN_LOG_RETENTION_HELD_FROM` | Chargeback (optional) | ISO 8601 instant written by staged Stage 5 after it raised the retention (ADR-0043); earlier periods are flagged `retention_truncated` |
| `ADMIN_WORKSPACE_ID`, `ADMIN_LOG_RESOURCE_IDS` | Reconciler, Budgets, Audit (as V2) | Workspace GUID; comma-separated originating resource IDs (include the reconciler app) |
| `ADMIN_RECONCILER_RESOURCE_ID` | Reconciler (optional) | Reconciler Function App ID; when set, only it is read for runs and snapshots |
| `ADMIN_RECONCILER_INTERVAL_MINUTES` | Reconciler freshness (optional) | Timer interval matching `RECONCILER_SCHEDULE`, default 5 |
| `ADMIN_BUDGET_LOOKBACK_DAYS` | Reconciler (optional) | 1–93, default 31 |
| `ADMIN_AUDIT_WORKSPACE_ID` | Audit (as V2) | Admin app's own workspace when it differs |
| `ADMIN_CLIENT_ID` | Onboarding downloads | Application (client) ID of the CCOF client app registration developers sign in with |
| `ADMIN_CLIENT_TENANT_ID` | Onboarding downloads (optional) | Entra tenant GUID for the client; defaults to `ADMIN_TENANT_ID` |
| `ADMIN_CLIENT_SCOPE` | Onboarding downloads (optional) | Token scope; defaults to `api://<ADMIN_CLIENT_ID>/access_as_user` |
| `ADMIN_GATEWAY_URL` | Onboarding downloads | Gateway base URL the client calls, `https://…` without `/v1` (same value as the client's `gatewayUrl`) |
| `ADMIN_PROJECT_HEADER` | Onboarding downloads (optional) | Project selector header, default `x-ccof-project` |
| `ADMIN_CONFIG_CONTAINER` | Saving cost definitions (as V2); change record and removal limits (3.2.0) | Cosmos container (`adminConfig`); when a catalog is saved, chargeback and the budget assistant use its rate card. When set, a change that cannot be recorded here is refused |
| `ADMIN_BACKENDS` | Onboarding and editing groups | JSON `[{"id","deployments"}]` written by Stage 5: the backends a group may use and the models deployed on each ([ADR-0046](adr/0046-admin-checks-backends-and-models.md)). Without it, onboarding is refused |

A missing or invalid setting disables only its feature, which then shows its capability state
(`disabled`, `permission_required`, `unavailable`) with the reason and the permission that enables it.
The client-download settings above apply only to retained legacy API endpoints,
not a console Onboarding tab. Those APIs still list missing settings and write
`REPLACE-…` placeholders that the client's validator refuses. Current group client
configuration is exported by the staged deployment.

## Permissions

All belong to the **admin Function App managed identity**; none are granted by the deployment.

| Feature | Needs | Without it |
| --- | --- | --- |
| Groups, limits, budgets | Existing Cosmos registry data role (the container is still named `projects`) | Console unavailable |
| Chargeback, Overview cost | Log Analytics Reader on the gateway telemetry workspace | Chargeback shows `disabled` or `permission_required` |
| Budgets, Reconciler | Log Analytics Reader on `ADMIN_WORKSPACE_ID` with the reconciler's logs | Those panels show their state |
| Audit, Activity | Log Analytics Reader on the admin app's workspace | Audit disabled |
| Foundry inventory | Reader on APIM and Foundry accounts | Inventory disabled; type backend IDs |
| Billed cost, retail meters, group search | As V2 | As V2 |
| Budget assistant | None | Always available |
| User names (3.1.0) | Graph application `User.Read.All`, admin consent, `ADMIN_USER_NAMES_ENABLED=true` | Full IDs remain visible with disabled/permission/unavailable/missing-user state |
| Change record, removal limits (3.2.0) | The existing admin role on `adminConfig` (read, query, create, replace; no delete) | Change record and removal limits show `disabled`; Activity uses telemetry |
| Override reaches the sync (3.2.0) | **Sync** identity: Cosmos DB Built-in Data Reader on `adminConfig`; sync setting `SYNC_LIMITS_CONTAINER=adminConfig` | The sync uses its app settings |

People: reading needs `CCOF.Projects.Read` (or `ADMIN_READER_IDS`); changes need `CCOF.Projects.Write`
(or `ADMIN_EDITOR_IDS`). Existing review steps, ETag protections and audit behavior are
unchanged: group onboarding has a review step, and group detail saves use If-Match.

## New API

| Route | Behavior |
| --- | --- |
| `POST /api/v3/directory/users` | Authenticated admin readers/editors; body `{"objectIds":["<GUID>"]}` with 1-100 GUIDs, no extra keys/parameters. Returns current display names/UPNs and object IDs; Graph batches of 20, five-minute bounded memory cache, no-store HTTP response. No directory writes or persisted names. |
| `GET /api/v3/chargeback/{view}` | `view`: totals, groups, developers, models, families, projects, classifications (project × classification), trend, coverage, unpriced, diagnostics. Query: `period` (month, previous, custom), `from`/`to` (UTC, custom only; with `month` or `previous` they return 400 `from_to_require_custom_period`; a custom range must start before now and end at most 31 days ahead, otherwise 400 `range_out_of_bounds`), `project`, `group` and `developer` (Object IDs), `model`, `backend` (request-time `backendId`), `family`, `classification`, `tags` (comma-separated, ≤ 10, all must match; resolved to project IDs from the registry, refused with 400 `tag_matches_too_many_projects` above 2,000 projects; no match selects nothing), `interval` (hour, day), `limit` (1–500, default 100), `offset`. Unknown or repeated parameters return 400. |
| `GET /api/v3/projects/{id}/client-config?classification=STD` | Reader. Returns `config` (validates with `client/src/config.mjs`: tenant, client, scope, gateway URL, the classification's models by family, a stable Desktop profile ID, `project {id, selectorHeader}`), `onboarding` (Entra group, models, install paths, steps), `missing` and `complete`. No secrets. 400 invalid classification, 404 unknown project or classification, 409 classification without models. |
| `GET /api/v3/reconciler/runs` | Latest run per outcome and reason, with `ageMinutes` and `freshness` against the interval |
| `GET /api/v3/reconciler/snapshots`, `/summary` | `period`, `scope` (person, group), `project`, `classification`, `person`, `state` (current, expired, historical, invalid_event), `budgetState`, `limit`, `offset`; exact USD equivalents |
| `GET /api/v3/audit` | `project`, `actor`, `operation`, `outcome`, `from`, `to` (≤ 93 days, default last 31), `limit`, `offset` |
| `GET /api/v3/audit/changes` | Same parameters; reads the change record. Outcomes: `created`, `updated`, `retired`, `refused` (ETag race or conflict; not applied), `unconfirmed` (the write raised an error such as a timeout; it may have been applied, so check the item), `pending` (the result was never recorded) |
| `GET /api/v3/sync/removal-limits` | Reader. The override (`enabled`, `maxRemovalsPerRun`, `maxRemovalFraction` text with ≤ 6 decimals, `expiresAt`, `reason`, `updatedAt`, `updatedBy`), its ETag and state: `none`, `disabled`, `expired`, `in_effect`, `invalid` |
| `PUT /api/v3/sync/removal-limits` | Editor. Body: the five editable fields only. First save needs `If-None-Match: *`, later saves `If-Match`. Validated with the sync's own rules plus expiry in the future and ≤ 90 days; 422 `invalid_removal_limits` with `problems` |
| `POST /api/projects/{id}/retire` | Editor, `If-Match`, body exactly `{"confirmProjectId":"<id>"}`. 409 when already retired. Retained legacy API; no current console control |
| `GET /api/v3/plan` | In-force models by family, geography multipliers, rate card version and source |
| `POST /api/v3/plan` | Budget assistant: `monthlyBudget {amount, currency USD/CCU}`, `members`, `geography`, `sizing`, `mix`, `families[{family, model?, budgetPercent}]`, working days/hours, burst. Pure; no writes. 422 with `detail` on invalid input. |
| `POST /api/v3/rate-card/review` | Validates a candidate rate card with the reconciler's parser and the history rules (version must change, recorded entries unchanged, new or closed entries not in the past) and returns added/closed/unchanged. Saving stays `PUT /api/v2/catalog` with If-Match. |
| `GET /api/v3/version`, `/capabilities` | The admin version (`3.4.0`, from [version.ts](../admin/src/version.ts)); which features are configured (including `changeLog`, `removalLimits`) and the caller's role |

`/api/v2/version` and `/api/health` report 3.4.0. `/api/v2/projects` accepts `tags` (comma-separated, all
must match, up to 10) and `classification`.

## Upgrade from the VDI

The full manual procedure is [Admin V3.1 VDI upgrade](ADMIN-V3-VDI-UPGRADE.md).
The shorter V3 migration outline follows [ADMIN-V2.md](archive/ADMIN-V2.md) "VDI build and upgrade":

1. Build `ccof-admin-v3.1.0.zip` with `admin\Build-AdminPackage.ps1 -OutFile <path>`. Keep the 2.0.x ZIP
   as the rollback package. The ZIP adds `ui-dist-v3/` and `kql/`.
2. Add the SPA redirect URI `https://<admin-host>/api/console-v3` to the existing **CCOF Admin** app
   registration (Authentication → Single-page application). No new app, roles or scopes.
3. Publish with the same private `az functionapp deployment source config-zip` route.
4. Leave `ADMIN_V3_ENABLED` unset first: confirm `/api/console` (V2) works and `/api/health` reports
   `3.1.0`; `/api/console-v3` returns 404.
5. Set `ADMIN_V3_ENABLED=true` (and the chargeback settings above when approved). Open
   `/api/console-v3` from the VDI, sign in, and check each page's state against the settings you set.
   For names, grant `User.Read.All` to the admin managed identity and set
   `ADMIN_USER_NAMES_ENABLED=true` as described in the full guide.
6. Acceptance: reader cannot edit; editor reviews and saves a test limit (audit line appears); the
   chargeback totals for this month match the workbook's for the same filters and rate-card version.

## Rollback

- **To V2 only:** set `ADMIN_V3_ENABLED` to `false` (or remove it). V3 routes return 404; V2 is untouched.
  No redeploy, no data change.
- **To a previous group-capable package:** publish its retained ZIP with `config-zip`.
  This console-only packet does not change group documents, server contracts or schema.
  Do not assume a pre-group 2.0.x package can manage group registrations.
- Group and catalog writes are real changes. Reverse them through their supported,
  ETag-guarded API or console, never by restoring the database. A retired group stays retired.
- Retained legacy API/document handling remains server-side only; this rollback
  guidance does not reintroduce a legacy console management workflow.

## Local demo

`cd admin; npm run build; $env:PORT=7272; node dev/serve.ts` serves both consoles with synthetic
data (`dev/demo-data.ts`: chargeback ledger aggregates, reconciler runs, person and group budgets,
inventory, audit). Demo only: it is not packaged and never used in Azure.
