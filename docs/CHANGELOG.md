# Change log

## 2026-10-26 — Release 17

- Deployment into an existing API Management, the deployer and Claude Code setup on macOS and Linux, and the bug-bash
  fixes below (sections of 2026-10-26).

## 2026-10-26 — Claude Code setup on macOS and Linux (branch fix/macos-client)

- `Set-ClaudeCodeGateway.ps1`, `Restore-ClaudeCodeGateway.ps1` and `Test-ClientGatewayAccess.ps1` run in PowerShell
  7.4+ on macOS and Linux with `signInMethod: azure-cli` ([ADR-0048](adr/0048-claude-code-setup-on-macos-and-linux.md)):
  `~/.claude/settings.json`, an `sh` token helper `~/.claude/ccof-token` with its own Azure CLI profile, and `/usage`
  and the status line through `pwsh`. Files are created owner-only.
- Any other sign-in method stops there with `unsupported_sign_in_method`; Claude Desktop setup stays Windows-only.
- `/usage` and the Node helper name the macOS/Linux install route and helper in their messages.
- Windows behaviour is unchanged.
## 2026-10-26 — Admin bug-bash fixes (fix/bugbash-admin)

- Groups may use only a backend in `ADMIN_BACKENDS` (written by Stage 5) and models deployed on it; the console
  offers only those ([ADR-0046](adr/0046-admin-checks-backends-and-models.md)).
- Exports and chargeback views refuse `from`/`to` without `period=custom`, and a custom range that starts in the
  future (`range_out_of_bounds`); every export error code is listed in ADMIN-API.md, and 409/503 bodies carry
  `requestId`.
- Display names need visible text and no control characters; CSV also neutralises full-width formula characters
  and formulas after leading spaces.
- Console: group wording instead of projects and STD/PRM/CYB; a malformed group link is explained; focus moves to
  the first problem after a failed Continue or Save; loading regions are `aria-busy`.
- Docs: version 3.4.0 in ADMIN-V3.md (checked by a test), role changes apply at the next token, chargeback-history
  errors confirmed live.

## 2026-10-26 — macOS deployer (branch fix/macos)

- The deployment (Stages 0-8) runs from PowerShell 7 on macOS: prerequisites give the Homebrew install route, the
  deploy page signs in with `az login` first, and a config folder with `(` or `)` is no longer refused off Windows.
- Temporary files the deployer writes, such as `.env.client-config.pending.json`, are removed on macOS and Linux too.
- The developer setup scripts are Windows-only and now say so on macOS and Linux (`unsupported_platform`, nothing
  changed); macOS developer setup is planned (G-MACOS-CLIENT).
- `/usage` in Claude Code no longer stops with "Shell command permission check failed": the skill pre-approves its
  own command, for Git Bash and for Claude Code's PowerShell tool. The developer page explains that `/usage` is
  interactive only and cannot show a refused budget; the status line and the wrapper can.
- The offline test suites run under PowerShell 7 on Linux as well as Windows.

## 2026-10-26 — Bug bash fixes: gateway and developer (branch fix/bugbash-gateway)

- Budget pacing has its own gateway counter, keyed by the budget month and amount ([ADR-0047](adr/0047-budget-pacing-counter.md)):
  raising a budget, or a new month, lifts the guard's wait within minutes; before, a wait computed at a tiny budget
  stayed for hours. A pacing refusal says it is the budget guard, not the tokens-per-minute limit, and its
  `Retry-After` is at most the time to the month's end. A refusal from projected spend says it can clear within
  minutes. Budget and limit messages name the group, not a "CCU budget for project".
- Variants of `/v1/messages` (trailing slash, `.`, `//`, upper case) are answered 404 by the gateway, before the token
  check, instead of being forwarded and counted. A body that is not `application/json` is answered `415`, one above
  32 MB `413 request_too_large`, both from the headers before the body is read ([ADR-0048](adr/0048-request-checks-and-backend-refusals.md)).
- The `x-ccof-project` header compares a group Object ID in lower case. The not-entitled message tells no membership,
  an unknown group ID and a value that is not a group ID apart, and no longer asks a member to join their own group.
  A model refusal lists the group's allowed models. CLIENTS.md's multiple-group section matches the group selection rule.
- The ledger prices a request Foundry refused before inference (`4xx` other than `429`) at zero tokens, so a typo no
  longer makes the month's usage partial or, with `resolver.requireCompleteUsage`, blocks the person. Workbook and
  admin queries change with the ledger (Stages 5 and 7 redeploy them).
- `/usage` and the status line show a budget under USD 1 to four decimals, and say plainly that figures are a lower
  bound because the prompt-cache tokens of streamed replies are never priced. USAGE.md explains why, and the usage
  endpoint's approximate limit.
- Developer setup prints `models`, the deployment each Claude Code alias runs, so an Opus alias mapped to another model
  is visible. The Azure CLI helper's `status` no longer prints the Azure CLI's own `Please run 'az login'`. Stage 7 names
  the Desktop profile after the group. The developer page explains Claude Code's `Failed to authenticate` on a gateway
  `403`.

## 2026-10-26 — Deploy into an existing API Management (feature branch)

- Stage 0 checks an `apim.existing` instance before anything is created: readable, system-assigned identity, a v2
  tier, API ID, path and backend names free, room for CCOF's diagnostic settings, and a network route when Foundry or
  the Function Apps are private. Each refusal names the next step; the global policy is printed for review.
- Stage 5 sends the instance's gateway logs to CCOF's workspace (`ccof-gateway-logs`), so budgets, `/usage`,
  chargeback and the Stage 8 telemetry check work; it reuses the instance's `azuremonitor` logger.
- A new instance and `apim.existing` together are refused.
- New page: [Use an existing API Management](get-started/existing-api-management.md).

## 2026-10-26 — Long-term audit (feature branch)

- Gateway log archive (`audit.archive`, Stage 5): API Management gateway logs are also written to a dedicated
  storage account and kept for a set number of days, with an optional immutability policy. Works where a storage
  policy turns public network access off.
- Chargeback history (`audit.chargebackHistory`, Stages 2, 3, 5, 7): the reconciler keeps daily totals per
  chargeback ID, group, person and model in Cosmos DB; the admin usage export reads months older than the Log
  Analytics window from it and refuses days it does not cover or that have expired.
- Stage 7 stops when a configured group differs from the deployed one, unless `stage7.keepDifferingGroups` is set.
- Stage 5 always sets the retention the workspace actually holds, so reports and exports start where data exists.
- A tool deletes chargeback history by month or by person (`scripts/history/delete-chargeback-history.ts`).
## 2026-10-26 — Long-term audit (feature branch)

- Gateway log archive (`audit.archive`, Stage 5): API Management gateway logs are also written to a dedicated
  storage account and kept for a set number of days, with an optional immutability policy. Works where a storage
  policy turns public network access off.
- Chargeback history (`audit.chargebackHistory`, Stages 2, 3, 5, 7): the reconciler keeps daily totals per
  chargeback ID, group, person and model in Cosmos DB; the admin usage export reads months older than the Log
  Analytics window from it and refuses days it does not cover or that have expired.
- Stage 7 stops when a configured group differs from the deployed one, unless `stage7.keepDifferingGroups` is set.
- Stage 5 always sets the retention the workspace actually holds, so reports and exports start where data exists.
- A tool deletes chargeback history by month or by person (`scripts/history/delete-chargeback-history.ts`).
## 2026-10-25 — Resume after lost local state

- Stage 1 read-back no longer fails when the local state was lost after Stage 6 integrated the Function Apps with
  the network. Without a Stage 6 record it accepts no integration or the Functions subnet the configuration names;
  with a record, only that record's subnet.
- Troubleshooting: Azure Cloud Shell idle timeout during Stages 6 and 7, recovery after Cloud Shell lost `$HOME`,
  and the Stage 1 `verify_failed … VNet subnet` error.

## 2026-10-25 — Configuration reference reworked

- The configuration reference is now six pages: an overview with a complete sample, Entra and group forms, resource
  forms (Foundry, network, API Management, Cosmos DB) and three tables of every template key.
- Each reuse-or-create choice shows both forms as JSON and the lines the stage prints. The three `entra.existing` IDs
  (`gatewayAppId`, `resolverAppId`, `adminAppId`) are each optional; what Stage 4 changes on a reused application is listed.
- Network forms for `create`, `existing` and `verify`, with `infra/prereqs/network.bicep` and a parameters file.
- Tests: all leaf keys of the template must be on the pages; the sample runs through `Read-StgConfig`.

## 2026-10-25 — Configuration reference

- New page [configuration.md](get-started/configuration.md): each key of the staged configuration template that holds a
  `REPLACE-` value or is a decision, with its meaning, where to find the value and an example. Linked from the deploy
  page and the documentation map.
- A documentation test reads the template and fails when a `REPLACE-` key is not on the page.

## 2026-10-25 — First-time reader deployment

- Stage 0 refuses a configuration that creates no API Management and names none, and a new private Foundry account
  whose backend has no private endpoint. Both previously failed only after the create-only Stage 1.
- The Stage 1 preview and its changed-configuration error say that Stage 1 values are final in a resource group.
- Stage 6 no longer reads Foundry DNS zones it did not create, and can be rerun after a failed read-back in
  `network.mode: create`.
- A changed-configuration error names every stage to rerun, in order. Azure deployment errors start with the failing
  resource, its error code and the underlying message.
- Developer setup prints the sign-in method and the one sign-in command; the developer page has a single sign-in step.
- Prerequisites: a quota command that shows the model names and how quota maps to the configuration. Deploy page: the
  create-only lab values and the settings for dollar budgets. Troubleshooting: the errors met in the run.

## 2026-10-25 — Azure CLI developer sign-in

- New client setting `signInMethod: azure-cli`. Setup writes `ccof-token.cmd`, which signs the developer in with
  `az login` (interactive Entra sign-in) in a profile of its own, separate from the developer's own Azure CLI login.
- Claude Code `settings.json` uses that helper as `apiKeyHelper`; Claude Desktop gets a `helper-script` inference
  profile with the same helper; `/usage` reads its token from it without ever opening a sign-in.
- Stage 4 reads back that the gateway app pre-authorizes the Azure CLI; Stage 5 admits it at the gateway; Stage 7
  writes `signInMethod` only when Stage 4 allowed it.

## 2026-10-24 — Novice reader fixes (release 12)

- Developer setup starts with cloning the repository and names the folder every command runs from.
- Each deployment stage shows its preview command before the `-Apply` command; Stage 7 has a success checklist.
- The lab route gives a rough daily cost (about USD 25 per day before usage) with price sources and where to see
  actual spend.
- The admin console's earlier-model page is labelled **Legacy projects**.
- Thirteen earlier guides and run records moved to `docs/archive/`, listed by its README.

## 2026-10-24 — First-time reader follow-up

- Added an example of the main staged-deployment values and a single-subscription lab path with measured duration,
  permissions and ongoing Azure cost note.
- Replaced the clipped onboarding screenshot in the reader path with the review screen that labels chargeback ID,
  priority and admitted models.
- Refreshed the exhausted-budget screenshot from the captured usage response using the current client status-line
  formatter; the saved text output accompanies the image.
- Replaced the README's gateway-oriented acceptance details with a short user-facing result and a report link.

## 2026-10-24 — Reader documentation and demo screenshots

- Short README, documentation index and glossary, five get-started pages and four operate pages. Earlier guides
  remain available with a link to the short path.
- Fresh deployment evidence: Stages 0-8, Portal prerequisites, console group onboarding, own-usage states and
  chargeback CSV. Real names and identifiers replaced with consistent hypothetical values.
- Offline checks cover reader-page links/images, size and quoted script output.
- Capture tooling refuses configured identifier leaks and restores the original page after each screenshot, so
  repeated captures retain the same pseudonyms without changing live form values.
- Developer login uses the supplied client configuration. Snapshot-mode instructions include console-added groups
  explicitly; model/limit updates wait for sync before gateway cache expiry.
- Exhausted budgets now retain an explicit refusal notice in the Claude Code status line; the live run exposed
  the missing notice. Recorded demo spend: USD 2.14 against USD 2 with a 25% guard setting, not a strict cap.
- Public release 10: `2f84715`, CI passes on Node 22 and 26
  ([run](https://github.com/naveenneog/CCOF/actions/runs/40096140727)).

## 2026-10-24 — Budget guard: warning at 80% and bounded overshoot

- Optional `reconciler.budgetGuard` (`warnPercent`, `overshootPercent`, `projectionMinutes`; example 80 / 5 / 5).
  The reconciler projects the spend the reporting lag hides, warns from the warn percent and slows requests
  so the budget is not exceeded, and always limits the spend rate ([ADR-0040](adr/0040-budget-guard.md)).
- `/usage` returns `warning` and `projectedPercent`; the Claude Code `/usage` text and status line show the warning.
- Live: a USD 14 budget ended at USD 13.84 under the same load that took a USD 10 budget to USD 11.97.
## 2026-10-24 — Live budget, family-limit and chargeback acceptance; fixes found live

- **Group usage now reaches budgets and chargeback.** Kusto types a GUID-shaped string in a dynamic value as `guid`;
  the ledger accepted `projectId` only as `string`, so every group-centric request was unattributed. Fixed in
  `analytics/ledger.kql` and `analytics/budget-events.kql`.
- **Gateway policy deployed as policy fragments.** A Standard v2 API Management instance created on 2026-10-23 refused an API policy over 16 KB; the
  rendered policy is now deployed as one fragment per section with a small API policy (ADR-0039). All deployment paths.
- `GET /ccof/me/usage` calls are no longer listed as unattributed ledger rows.
- Staged: Stage 1 accepts a Flex app without VNet integration; ARM reads ask for JSON; the usage-policy read-back
  ignores comments; Stage 8 reads the Log Analytics JSON column.
- Guide: live walkthrough (Stages 0–8, Portal captures), problems met and their resolutions, measured budget
  overshoot, live WBS ID evidence.
## 2026-10-23 — Budget, chargeback-label and deployment acceptance

- Requested acceptance covers a USD 10 total consumption ceiling, budget-bypass attempts, group model-family
  restrictions, higher-spend group selection, a configurable individual chargeback-field name, and a Playwright
  deployment-guide walkthrough.
- G-LABEL adds an admin-defined individual tag name, including WBS ID, to tagging, report filters and CSV headings.
  Settings are audited and ETag-protected; JSON/Power BI property names are unchanged. Local Playwright verified
  assignment, persistence, filtering and the downloaded file.
- G-LIMIT retains the resolver's monetary TPM ceiling at APIM, refuses zero, invalidates legacy cached decisions,
  and adds an optional complete-accounting guard for personal and strict-group budgets. This is not an atomic
  dollar cap. [ADR-0038](adr/0038-budget-admission-acceptance.md).
- Live direct Foundry smoke and streamed cache calls consumed an estimated USD 0.011476 at list rates, not USD 10.
  Gateway consent and authenticated Portal sign-in blocked full live acceptance; Stage 0 and Stage 1 what-if
  completed without modifying existing labs. [Evidence](status/BUDGET-ACCEPTANCE-2026-10-23.md).

## 2026-10-23 — Fixes: client restore, Graph grant permissions list, Cosmos capacity notes

- The client installer's restore removes folders it created when they are empty (for example `~/.claude/skills`).
- `Grant-SyncGraphPermissions.ps1 -Permissions A,B,C` works under `pwsh -File`; before, the list arrived as one
  string and the script stopped with `app_role_missing`.
- Guide 2.6 and ADR-0036 record a live Cosmos capacity check: zone-redundant regions can be refused with
  `ServiceUnavailable`, and how to proceed.

## 2026-10-23 — Cosmos DB redundancy and consistency

- Staged `stage1.cosmosLocations` (regions in failover order, each `isZoneRedundant`) and `stage1.cosmosConsistency`.
  Two or more regions turn on service-managed failover. Absent: the earlier single region.
- Checks: serverless in one region only, the capacity modes agree, the first region is `location`, ARM region names,
  no duplicates, consistency values and bounded-staleness minimums. Stage 1 reads the account back.
- The resolver reads in `COSMOS_PREFERRED_REGIONS` order (Stage 5 sets it), so reads continue from the second region
  during an outage. The example configuration now uses two zone-redundant regions, provisioned autoscale, Session.
  [ADR-0036](adr/0036-cosmos-redundancy-and-consistency.md).

## 2026-10-23 — `/usage`: a person's own budget in Claude Code

- **Gateway:** `GET <gateway>/anthropic/ccof/me/usage` (operation `get-my-usage`). Same token checks as
  `/v1/messages`; the resolver receives only the token's `oid`; its own per-person limit `admission.usage`
  (optional, 10 per 60 s). `render.ts` also writes `<apiId>.usage.policy.xml`.
- **Resolver:** `POST /api/me/usage` returns, per active scope, spent, budget and remaining (USD and CCU), percent
  used, exhausted, period, as-of time and completeness, from the person's own `budgetState`; the scope total only
  when `RESOLVER_USAGE_GROUP_TOTALS=true` (absent: hidden).
- **Client:** `ccof-usage` and the Claude Code skill `/usage` (replaces the built-in `/usage` in a terminal session;
  `/cost` still shows the session estimate); `-UsageStatusLine` adds a status line only when none is set.
- **Staged:** Stage 5 deploys the operation and reads it back; `resolver.usageGroupTotals`, `gateway.admission.usage`.
  [USAGE.md](USAGE.md), [ADR-0035](adr/0035-own-usage-through-the-gateway.md).

## 2026-10-23 — Staged: user names setting, Graph grant steps

- `admin.userNamesEnabled` (default `false`) in the staged configuration; Stage 5 writes `ADMIN_USER_NAMES_ENABLED`.
  Before, a staged deployment could not turn names on: Stage 5 writes the complete settings set, so a hand-set value
  was removed on the next run.
- [Guide](STAGED-DEPLOYMENT-GUIDE.md) section 6.1: one admin grant with `Group.ReadBasic.All`,
  `GroupMember.ReadBasic.All` and `User.Read.All`; the settings to turn on afterwards; managed identity tokens are
  cached about 24 hours, so a new grant can take several hours to apply (Learn reference).

## 2026-10-23 — Precedence by actual spend

- **Precedence:** without a project selector, a person in several groups now gets the group where they have the
  higher month-to-date spend (the reconciler's `spentCcu` for the current UTC month; no state counts as zero),
  then the lower priority number. The earlier rule of this release compared per-user budgets, which is not usage
  spend. A malformed spend is refused `budget_state_invalid`; ties are refused `project_selection_required`.
  Memberships no longer carry `perUserBudget`. Rollout: resolver package, then raise `gateway.keyVersion`.

## 2026-10-23 — Admin 3.4.0: user tags

- **User tags (owner decision):** the chargeback ID (for example a WBS element) is set per person on the new
  **User tags** page: pick a member of an onboarded group (Graph `GroupMember.ReadBasic.All`) or enter the object ID;
  the person's name and current tag are shown before saving; every new tag is saved and suggested while typing.
  API: `/api/user-tags` and `GET /api/groups/directory/{groupId}/members` ([ADMIN-API.md](ADMIN-API.md)).
- **Sync:** copies each person's tag into their group memberships as `chargebackId` (the group's own ID for people
  without a tag); reads tags page by page from `adminConfig`; a failed read keeps stored IDs.
- **Reports:** the chargeback filter is "User tag" with suggestions; the Developers view and its CSV show each
  developer's tags; the "Chargeback IDs" view is "User tags"; Usage CSV carries the tag per row.
- Needs the sync and admin packages of this release; no new role or setting (both use `adminConfig`).

## 2026-10-23 — Precedence by spend, removal as retirement

- **Precedence (owner decision):** without a project selector, a person in several groups gets the group with the
  higher per-user monthly budget (USD and CCU compared at 100 CCU = 1 USD), then the lower priority number;
  anything still tied, or a missing or malformed budget or priority, is refused `project_selection_required`.
  Memberships now carry `perUserBudget`. Rollout: raise `gateway.keyVersion` to drop cached decisions.
- **Removal (owner decision):** removing a group is retirement, the same as a project; documented in ADR-0034
  decision 9, with a test that retired-group removal ignores the sync removal limits.

## 2026-10-23 — Group-centric onboarding (ADR-0034), admin 3.3.0

- **Group as the unit** ([ADR-0034](adr/0034-group-centric-onboarding.md)): an Entra group is onboarded as
  its own entity (`kind: "group"` document in `projects`, scope code `group`) with a per-user budget
  (auto-scale or cap), models and rate limits, allowed surfaces, chargeback ID, priority and cache share.
  No STD/PRM/CYB classification is entered for a group. Fable/Mythos need `restrictedFamiliesApproved`.
- **Sync, reconciler, resolver, gateway**: memberships carry priority, surfaces, chargeback ID and approval;
  with no selector the lowest-priority group applies, ties are refused; APIM maps client app IDs to surfaces
  (`entra.surfaceClients`) and refuses `403 surface_not_allowed`.
- **Chargeback**: the usage trace and ledger carry `chargebackId` and `surface`; the workbook and console add
  the Chargeback IDs view; `GET /api/v3/export/usage` and `/api/v3/export/groups` give CSV/JSON for Power BI.
- **Admin 3.3.0**: Groups page, four-step onboarding with Entra group search, budget estimate, cache suggestion
  with evidence class, group detail and retire (`/api/groups`).
- **Staged deployment**: `gateway.surfaceClients` and `admin.groupSearchEnabled`; new
  [staged deployment guide](STAGED-DEPLOYMENT-GUIDE.md) with prerequisites, Cloud Shell and Portal steps.
- **Staged pilot as a group (G-SEED)**: a `groups` entry with `"kind": "group"` has no project or classification;
  Stage 7 seeds it as a group document and writes the client file for `client.group`; the sync app's
  `registrySeed` accepts active group documents checked by the group contract. The example configuration's pilot
  is now `CCOF-PILOT01` (group) instead of `CCOF-PROJECT01-STD`/`-PRM`. `Invoke-QsClient` is split into selection
  and `New-QsClientFiles` (unchanged behaviour).
- Open: precedence and chargeback-ID-per-group are assumptions (UNKNOWNS G-A1, G-A2); requirement 9 (G-A3);
  Power BI connector sign-in (G-R3); live verification (G9).

## 2026-10-22 — Admin 3.2.0: project retirement, removal limits, change record

- **Retire project** (V3 project Settings, `POST /api/projects/{id}/retire`, If-Match and the project ID
  repeated in the body). Sets `status: "retired"` and `retiredAt`; edits then return 409
  `project_retired`. The sync removes all memberships of a retired project at its next run without
  reading its groups, outside the removal limits (`src/sync/plan.ts`, `src/sync/run.ts`). Other
  non-active statuses still freeze the project.
- **Removal limits** page and `GET/PUT /api/v3/sync/removal-limits`: an override of
  `SYNC_MAX_REMOVALS_PER_RUN` / `SYNC_MAX_REMOVAL_FRACTION` with reason and expiry (≤ 90 days), stored
  in `adminConfig`. The sync reads it when `SYNC_LIMITS_CONTAINER` is set; a missing, invalid, expired
  or unreadable override falls back to the app settings (`src/sync/removal-limits.ts`).
- **Change record**: every admin change (projects, catalog, removal limits) is written to `adminConfig`
  before it is applied and completed with its result; if it cannot be written, the change is refused
  with 503 `change_log_unavailable` (`admin/src/change-log.ts`). Audit has a Change record / Telemetry
  source switch; project Activity reads the change record. `GET /api/v3/audit/changes`.
- Staged deployment: Stage 3 assignment `sync-limits-reader` (Cosmos Built-in Data Reader on
  `adminConfig`, only with the admin app); Stage 5 sets `SYNC_LIMITS_CONTAINER=adminConfig` with the
  admin app. `tests/Test-StagedStages.ps1` checks both.
- [VDI upgrade](ADMIN-V3-VDI-UPGRADE.md) section 9: admin and sync packages, the sync grant and setting.
- Tests: admin 114, sync 237 (1 skipped), staged 355 checks; 11/11 mutants caught (control load
  failure reported separately); Edge check of retire, removal limits, audit in both themes and as reader.

## 2026-10-22 — Admin 3.1.0: Entra names and admin-only VDI upgrade

- V3 displays current Entra display names/UPNs beside full object IDs in Overview, Chargeback
  Developers, Budgets/Reconciler and Audit/Project Activity. Accounting, CSVs and filters keep IDs.
- Authenticated, bounded Graph lookup using the admin managed identity, enabled with
  `ADMIN_USER_NAMES_ENABLED=true` and Graph application `User.Read.All` with tenant admin consent.
  Missing users, denied permissions and provider failures keep IDs and other data available.
- Names are memory-only. Browser cache uses remaining server freshness, translated for clock
  skew, instead of restarting a five-minute TTL. Server lookup (including token acquisition) and
  browser queue have deadlines; failing batches cancel sibling requests.
- Added [manual VDI upgrade](ADMIN-V3-VDI-UPGRADE.md): existing managed identity consent, SPA
  redirect, private publishing, settings, verification and rollback. No changes to the gateway,
  sync, reconciler, APIM policies or deployed permissions.
- 108 admin tests, build/package, Edge UI/failure checks and the repository packet gate pass.

## 2026-10-21 — Network is the last setup stage

- New stage order: 0 checks, 1 resources, 2 schema, 3 grants, 4 Entra, 5 configuration,
  **6 network**, 7 code and data, 8 acceptance. As in the manual deployment, the customer usually
  builds the network; stages 2-5 do not need it, and Stage 7 requires it.
- `network.mode: verify` is the default: Stage 6 changes nothing and runs
  `scripts/manual/Test-NetworkConfiguration.ps1` (read-only) against the Stage 1 resources; a FAIL
  row stops it. `existing` and `create` (lab) remain opt-in.
- Templates and ARM deployment names follow the numbers: `stage2-schema`, `stage3-grants`,
  `stage5-config` (+ `stage5-api-telemetry`), `stage6-network`. An existing `state.json` moves to
  the new keys on first read (backup `state.layout1.json`).
- Fixes found on the way: the network check never reached Azure (`& az` recursed into its own
  `Az` function), failed on unrelated same-named DNS zones, and changed the CLI default
  subscription (`az account set`); the schema stage could not be rerun after grants; Stage 7 could
  not be rerun after a successful snapshot ([B-16 to B-20](../BUGS-FOUND.md)).
- Portal walkthrough steps and screenshots renumbered to match.

## 2026-10-21 — Portal walkthrough on both Standard v2 deployments

- Playwright walked the guide's 20 Portal steps on the signed-in Lab B/Lab B and Lab A Portals:
  20/20 and 19/20 pass; the remaining Lab A step is the APIs blade staying on "Service is getting
  ready..." while ARM lists the API ([report](archive/STAGED-STDV2-RUNS-2026-10-20.md#portal-walkthrough-with-playwright)).
- Walker fixes in `tests/playwright`: blade-menu navigation for sub-blades without a stable deep
  link, IAM **Role assignments** tab and list filters, reuse of the signed-in tab and its Portal
  host, one re-read for slow blades, literal-string masking. Two weak expectations were tightened;
  a negative control shows the resolver Authentication check fails on the wrong blade.
- The staged guide embeds 13 masked Lab A captures (`docs/runbooks/images/staged-portal`).
  Pages that list people are not published.

## 2026-10-20 — Staged deployment bug bash and live recheck

- Stage 1 shared-RG ownership now uses exact prior deployment resource IDs; the inventory verifier
  ignores unrelated and later-stage resources.
- Stage 2 create-mode retries skip the authoritative network deployment when a VNet already exists
  with saved state, and refuse to rewrite an existing VNet when that state is missing. DNS-link
  checks support earlier deployment outputs.
- Stage 8 acceptance uses the configured project header. Dependency hashes now migrate only when
  saved outputs match exactly or the relevant ARM outputs confirm the stable projection.
- Logged findings B-10 through B-15 in [`BUGS-FOUND.md`](../BUGS-FOUND.md). Offline staged,
  customer-deployment, quickstart and public-manual checks pass. Stage 1, Stage 2 and Stage 8
  acceptance rechecks and the Stage 4 grant recheck pass in both Lab B and Lab A
  ([report](archive/STAGED-STDV2-RUNS-2026-10-20.md)).

## 2026-10-20 — Standard v2 and private Foundry, Lab B and Lab A

- Stage 1 can create a keyless private Foundry account with Claude deployments
  (`foundry-account.bicep`; `modelProviderData` required, API `2025-10-01-preview`).
- Stage 2 integrates a Standard v2 APIM with the VNet (outbound) and creates the Foundry private
  endpoint with its three DNS zones.
- `sharedResourceGroup` and the guarded Stage 1 rerun: what-if must not change resources outside
  the deployment's prefix. State is bound to tenant/subscription/RG. Stage 8 correlates telemetry by
  this run's request IDs.
- Live: Lab B (shared RG) stages 0-8 with 200 responses; Lab A stages 0-8 with new
  Entra objects, Claude blocked by the sandbox subscription, Graph consent refused without an active
  admin role ([report](archive/STAGED-STDV2-RUNS-2026-10-20.md)).

## 2026-10-20 — Manual Portal walkthrough and verification gaps

- Added click paths for the staged guide, Foundry setup prerequisites, Standard v2 outbound
  networking, IAM and Entra checks, and the operations that still need Bicep or CLI.
- Embedded five existing masked Portal screenshots beside the relevant steps. They are
  labelled historical navigation references, not new Lab B/Lab A deployment evidence.
- Real Playwright Portal probes for Lab B and Lab A reached the Microsoft sign-in page.
  Fresh blade captures and the requested Standard v2 runs remain blocked on sign-in and
  confirmation of the separate Lab B/personal Lab B targets.
- Documented unresolved APIM integration, Foundry provisioning, cross-target state reuse
  (reproduced offline) and uncorrelated telemetry acceptance. Bicep compilation and existing
  stage tests pass but do not prove those missing behaviours.
- Playwright verified the rendered guide's five images and internal anchor. A broken-image
  negative control failed as intended, and restoring the image passed.

## 2026-10-20 — Stages 2-8 implemented and run live

- New entry points in `infra/staged`: `stage2-network.bicep`, `stage3-schema.bicep`,
  `stage4-grants.bicep`, `stage6-config.bicep` (+ `stage6-api-telemetry.bicep`), and the driver
  `Invoke-StagedDeployment.ps1` (stages 0-8: preview by default, apply, read-back, state).
  Configuration: `staged.config.example.json`.
- Stage 1: optional APIM moved into `apim-service.bicep` (what-if failed on the conditional scope);
  `BasicV2` allowed; outputs `names` and `apimName` for later stages.
- Live run in a new lab RG after deleting the Stage 1 RG: all nine stages verified, gateway
  401/200/403 matrix, Admin V3 with live chargeback data
  ([report](archive/STAGED-LIVE-RUN-2026-10-20.md), 20 screenshots in `docs/images/staged`).
- Tests: `tests/Test-StagedStages.ps1` (stage boundaries with a negative control, Cosmos
  contract against the quickstart, driver and configuration checks).
- Runbook rewritten: [configurable staged deployment](runbooks/STAGED-DEPLOYMENT-V2.md).

## 2026-10-20 — Stage 1 resources-only proof

- Completed live provider verification of the existing staged templates in an
  isolated new lab RG: 20 template resources at read-back (Application Insights
  later auto-added four Failure Anomalies alert rules, recorded in the report);
  all four private/keyless service checks pass, and no schema, application settings or runtime grants were created.
  Existing inference/admin deployments were not write targets. APIM is deferred.
- Added a scoped work ledger and local Ironclad charter/gate without installing
  hooks or changing CI. The stage contract remains the existing resources-only
  template and recursive offline test.
- Added the Stage 1 [live report](archive/STAGE1-LIVE-VERIFICATION.md) and
  [permission/configuration/runbook](runbooks/STAGED-DEPLOYMENT-V2.md).
- Full packet gate, root regression/type-check/build and 95 admin tests pass.
  Later-stage entry points, Admin V3 Azure acceptance and scale/accessibility
  verification remain pending.
