# CCOF admin console and API

The current console is **group-only** at `/api/console-v3`: use Groups to onboard,
edit and retire Entra security groups. There is no Legacy projects section,
classification filter/drill-down, project-tag control or Projects chargeback view.
Old project bookmarks show an explanation and a Groups link. Historical non-GUID
scope IDs remain visible as text, not links. See [ADMIN-V3.md](ADMIN-V3.md) and
[ADR-0054](adr/0054-group-only-admin-console.md).

New deployments use groups. Obsolete project-based deployments are separately
decommissioned; server project APIs, schema and runtime handling remain unchanged
to avoid a storage/runtime migration in this console packet. The baseline project
API and older console descriptions below are historical compatibility reference,
not a second onboarding path for new deployments.

> **v2 release:** see [Admin v2 capabilities, optional permissions and VDI
> upgrade/rollback](archive/ADMIN-V2.md). The Phase 1 description below documents the
> original baseline. V2 adds optional Graph lookup, tags, reviewed backend/budget
> settings, catalog/pricing and read-only operations panels; no permission is
> granted automatically. Manual group IDs and the existing limits editor remain.

A separate Function App that lists, creates and edits CCOF projects in the private Cosmos
`projects` registry. It has two parts:

- **API:** `/api/projects...`
- **Browser console:** `/api/console`, served by the same app.

All writes to Cosmos happen inside the Function App, using its own managed identity. Browsers
and scripts never connect to Cosmos. Directory lookups such as Entra group search are left out
on purpose, so no Microsoft Graph permission is involved. Admins paste the group's **Object ID**
from the Entra admin center.

It adds **new resources only**. The deployed APIM, Cosmos account, resolver, sync and reconciler
apps, and their code, settings, identities and permissions, are not changed.

| Part | Location |
|---|---|
| API and console server (separate package; the root build is unchanged) | `admin/src` |
| Console UI (HTML, CSS, JS bundled with MSAL) | `admin/ui` → built to `admin/ui-dist` |
| Unit tests | `admin/tests` (`npm test` in `admin/`) |
| Local demo server, never deployed | `admin/dev/serve.ts` (`npm run demo`) |
| API contract | `admin/openapi.yaml` |
| New Azure resources: app, storage, Log Analytics, Application Insights | `infra/admin/admin-resources.bicep` |
| New private network for the admin storage, in its own resource group | `infra/admin/admin-network.bicep` |
| Package build | `admin/Build-AdminPackage.ps1` (build, test, zip; does not deploy) |

## Current console

Use `/api/console-v3`. Groups manages budgets, surfaces, models, limits, priority
and chargeback IDs. Overview and Chargeback select groups without classification
or project tags; Budgets selects group registrations only for burn-down; Foundry
lists linked groups only. Group onboarding retains its review step; edits retain
ETags, server validation and existing `CCOF.Projects.Read` / `CCOF.Projects.Write`
permissions. This packet does not change write behavior.

Run the group-seeded demo without Azure:

```powershell
npm ci --prefix admin
npm run build --prefix admin
node admin/dev/serve.ts
# http://127.0.0.1:7171/api/console-v3
```

## Historical baseline console (/api/console)

The console is designed for an administrator at a desk who adjusts quotas between other work and
needs confidence before saving.

- **Project list:** projects with search.
- **Project page:** the access group (Object ID, with a copy button), budgets (read-only), and a
  limits table. The table has one row for all models plus one per model family, with person and
  group columns.
- **Edit → Review → Save:** edits happen inline. *Review changes* lists every change as a
  before → after line, and nothing is saved until you confirm. Saving sends the version you
  loaded (`If-Match`).
  - If someone else saved in the meantime, the console says so and offers *Load latest version*.
    Nothing is overwritten.
- **New project:**
  - Include **STD, PRM and CYB** in the same project. Each classification has its own Entra group
    Object ID, display name, model family, deployments, limits and budgets. Unchecked groups are
    omitted from the document; at least one is required, and group Object IDs must be distinct.
  - Fields are validated when you leave them (ID pattern, GUIDs, whole numbers).
  - You can preview the exact registry document before creating it.
  - The server re-validates with the deployed sync's own rules.
- **Roles:**
  - Readers see no edit controls.
  - Editors need the `CCOF.Projects.Write` app role.
  - The API enforces both; the page only reflects them.
- **States:**
  - **No sign-in settings:** a setup screen.
  - **Signed in but not an admin:** a clear refusal.
  - **Registry unreachable:** "Can't reach the project registry", with the request ID and a retry.
  - **Empty registry:** what you need before creating the first project.
  - Loading skeletons while data loads, marked `aria-busy` for screen readers; mobile layout below 820px.
- **Errors in a form:** when Continue or Save finds a problem, focus moves to the first field that needs
  attention, or to the error summary ("N fields need attention") when the problem has no single field.
- **Security headers:**
  - Strict Content-Security-Policy (`default-src 'none'`, scripts only from the app,
    `frame-ancestors 'none'`).
  - No inline script or style; API values are inserted as text only.
- **What the browser receives:** only tenant ID, client ID and scope. No keys, allow-lists or tokens.

Run it locally without Azure, using an in-memory registry and a demo sign-in:

```powershell
cd admin; npm ci; npm run build
npm run demo                       # http://127.0.0.1:7171/api/console-v3 (?as=reader for read-only)
$env:DEMO_REGISTRY='down'; npm run demo    # shows the "registry unreachable" state
```

## API

| Request | Role | Behaviour |
|---|---|---|
| `GET /api/projects` | Reader | Summaries with ETags |
| `GET /api/projects/{id}` | Reader | The project and its `ETag` |
| `POST /api/projects` | Editor | Create-only; 409 if the ID exists |
| `PUT /api/projects/{id}/classifications/{code}/family-policy` | Editor | Replace models and limits; needs `If-Match` |
| `PATCH /api/projects/{id}/classifications/{code}/limits` | Editor | Change limits only; needs `If-Match` |
| `GET /api/console`, `/api/console/config`, `/api/console/me` | Anonymous; `me` needs a token | Console assets, public sign-in settings, caller's write permission |
| `GET /api/health?code=<function key>` | Function key | Auth configuration and Cosmos reachability, as codes |

Routes must not start with `admin`: the Functions host reserves that prefix for its own API.

- **Validation:** uses the deployed sync's own project reader and family-policy parser
  (`src/sync/projects.ts`, `src/contracts/model-families.ts`).
- **Not changeable here:** project ID, groups, backend, budgets and status. There is no delete.
- **Registry failures:** a missing network path or data role, or an outage, returns `503
  registry_unavailable` with no provider detail.
- **Audit:** each write or refusal logs one `ccof.admin.audit.v1` line to the app's own
  Application Insights. It records the actor's object ID, operation, project, classification,
  ETags, and the before and after value of each changed limit or model list. Tokens are never
  logged.

### Onboarded groups ([ADR-0034](adr/0034-group-centric-onboarding.md))

An onboarded group is one existing Entra security group with its own per-user budget (`autoScale`
or `cap`), limits, models, surfaces, priority, chargeback ID and cache profile. Group documents are
stored in the `projects` container with `kind: "group"` and `id = projectId = groupId`
([admin/src/groups.ts](../admin/src/groups.ts)).

| Request | Role | Behaviour |
|---|---|---|
| `GET /api/groups` | Reader | Group summaries with ETags; baseline projects are not listed |
| `GET /api/groups/{groupId}` | Reader | The group document and its `ETag`; `404 group_not_found` for a baseline project, an unknown ID, or a value that is not a GUID (also on `PUT` and `/retire`) |
| `POST /api/groups` | Editor | Onboard: body holds `groupId` and the editable fields; stored `active`; 409 if the ID exists as a group or a project |
| `PUT /api/groups/{groupId}` | Editor | Change any of `displayName`, `backendId`, `priority`, `chargebackId`, `budget`, `restrictedFamiliesApproved`, `familyPolicy`, `surfaces`, `cacheProfile`; needs `If-Match`; 409 when retired |
| `POST /api/groups/{groupId}/retire` | Editor | Body `{"confirmGroupId": "<groupId>"}`; needs `If-Match`; one way. The next sync removes every member's access |
| `GET /api/groups/directory?search=<text>` | Reader | Entra security groups whose display name matches; text 1-100 characters without `"` or `\` |
| `GET /api/groups/directory/{groupId}` | Reader | One Entra group with its direct member count |
| `GET /api/groups/directory/{groupId}/members` | Reader | The direct user members (`id`, `displayName`, up to 999, with `truncated`) of an **active onboarded** group; `404 group_not_onboarded` for any other group |
| `GET /api/groups/cache-suggestion?surfaces=code,chat` | Reader | Suggested cache-read share for the surfaces, with evidence class ([cache-suggestions.ts](../src/contracts/cache-suggestions.ts)) |
| `GET /api/groups/backends` | Reader | The deployment's backends and the model deployments on each, from `ADMIN_BACKENDS` (`state` is `configured`, `not_configured` or `invalid`) |

- **Backend and models** ([ADR-0046](adr/0046-admin-checks-backends-and-models.md)): onboarding, and an edit that
  changes the backend or adds models, must use a backend in the app setting `ADMIN_BACKENDS` and models deployed on
  it. Stage 5 writes the setting from `backends[].id` and the keys of `backends[].deploymentInferenceGeo`, as
  `[{"id":"<backendId>","deployments":["<deployment>"]}]`. A refusal is `422 invalid_group` with
  `backendId:not_deployed` or `familyPolicy.families.<family>.models:not_deployed`, and `allowed` names the valid
  `backendIds` and the chosen backend's `deployments`. Without the setting such a write is refused with
  `503 backend_list_not_configured` (`503 backend_list_invalid` when it is malformed): rerun Stage 5. Without this
  check, members of such a group are refused at the gateway (`backend_not_configured`) or by Foundry.
- **Validation:** the same contract the sync and reconciler read
  ([src/contracts/group-registration.ts](../src/contracts/group-registration.ts)); problems are
  returned as field paths (`422 invalid_group`). The admin also refuses a `displayName` with no visible text
  or with control characters such as tabs or line breaks, or bidi overrides/isolates U+202A–U+202E and
  U+2066–U+2069 (`displayName:invalid`; 1-256 characters). Format characters such as zero-width space
  do not count as visible text ([shared server/console rules](../admin/src/text-rules.ts)).
- **Change record:** each write is recorded in `adminConfig` before it is applied, as for projects.
- **Directory lookup:** enabled with `ADMIN_GROUP_SEARCH_ENABLED=true`. The admin managed identity
  needs Microsoft Graph application permissions `Group.ReadBasic.All` (search and read) and
  `GroupMember.ReadBasic.All` (member count) with tenant admin consent. These are the read-only
  least-privileged options listed on
  [List groups](https://learn.microsoft.com/en-us/graph/api/group-list?view=graph-rest-1.0) and
  [List group members](https://learn.microsoft.com/en-us/graph/api/group-list-members?view=graph-rest-1.0).
  Requests send `ConsistencyLevel: eventual`
  ([advanced queries](https://learn.microsoft.com/en-us/graph/aad-advanced-queries)). Without the
  setting the routes return `503 group_directory_disabled`; a missing permission returns
  `502 group_directory_permission_required`.
- **Error codes:** `400 invalid_search_text` (blank, over 100 characters, or containing `"` or `\`),
  `400 group_search_rejected` (Graph refused the text), `400 invalid_surfaces`,
  `503 group_directory_not_configured` (no directory client), `503 group_directory_unavailable`
  (Graph outage or timeout), `404 group_not_found`, `409 group_exists`, `409 group_retired`,
  `412 etag_mismatch`, `428 if_match_required`, `422 invalid_group` with `problems`.
- **Projects API:** `/api/projects` and the V2/V3 project lists do not return group documents, and
  `GET /api/projects/{groupId}` is 404, so no project route can change a group.

### User tags ([admin/src/user-tags.ts](../admin/src/user-tags.ts))

A user tag is the chargeback ID (for example a WBS element) a person's usage is charged to, set per
person (owner decision 2026-10-23, [ADR-0034](adr/0034-group-centric-onboarding.md) decision 7). Every
new tag is saved; saved tags are suggested while typing. The sync copies the person's tag into their
group memberships as `chargebackId`, so requests carry it from the next sync on; a person without a tag
gets the group's own chargeback ID. Documents live in `adminConfig` (`userTag-<personId>` per person and
one `userTagCatalog` with the saved tags, at most 2,000).

| Request | Role | Behaviour |
|---|---|---|
| `GET /api/user-tags?search=<text>` | Reader | Up to 20 saved tags containing the text, case-insensitive, prefix matches first |
| `GET /api/user-tags/settings` | Reader | Deployment-wide `label`, `exists`, `etag`; absent settings default to `User tag`, while failed/invalid reads return errors |
| `PUT /api/user-tags/settings` | Editor | Exactly `{"label":"WBS ID"}`. First save: `If-None-Match: *`; later saves: `If-Match`. Audit-first, ETag-guarded write in `adminConfig` |
| `GET /api/user-tags/people[?tag=<tag>][&limit=1-500]` | Reader | Tagged people (optionally one tag), with `truncated` |
| `GET /api/user-tags/people/{personId}` | Reader | The person's tag and `ETag`; `exists: false` and no `ETag` when none was set |
| `PUT /api/user-tags/people/{personId}` | Editor | Body `{"tag": "<tag>"}` or `{"tag": null}` to clear; `If-None-Match: *` to create, `If-Match` to change. The change record is written first, then the tag; a new tag is added to the saved list only after the tag is written (`suggestionSaved` says whether it was) |

- **Tag rule:** 1-64 characters, letters, digits and `. _ / -`, starting with a letter or digit (the
  chargeback ID pattern, [src/contracts/user-tags.ts](../src/contracts/user-tags.ts)).
- **Change record:** each change is recorded first (operation `userTag.set`, `details.personId`).
- **Error codes:** `400 invalid_search_text`, `400 invalid_tag_filter`, `400 invalid_limit`,
  `412 etag_mismatch`, `412 user_tag_exists` (create over an existing tag), `428 if_match_required`,
  `409 saved_tags_full` (a new tag when 2,000 are saved; nothing is written), `422 invalid_user_tag`, `503 user_tags_not_configured`
  (no `ADMIN_CONFIG_CONTAINER`).
- **Picking a person:** `GET /api/groups/directory/{groupId}/members` (Reader) lists a group's direct
  user members (`id`, `displayName`, `truncated` beyond 999) through Graph `GroupMember.ReadBasic.All`
  ([List group members](https://learn.microsoft.com/en-us/graph/api/group-list-members?view=graph-rest-1.0));
  the console's User tags page uses it, and accepts a pasted object ID when group search is off.
- **Reports:** the chargeback `chargeback` filter selects a tag, the Developers view has a `userTag`
  column (the tags a developer's requests carried in the period, `(none)` when a request had none),
  and Usage CSV carries `chargebackId` per row.

- **Field name:** one deployment-wide label (default `User tag`), editable on User tags. Labels are
  1–64 characters, without leading/trailing whitespace, control characters or leading `= + - @`.
  Invalid bodies return 422; missing version headers return 428 and stale versions/races return 412.
  The label changes tagging/filter/report presentation only, never saved/suggested values,
  `chargebackId` / `userTag` JSON keys or filter parameters
  ([ADR-0037](adr/0037-deployment-user-tag-label.md)).

### Export for Power BI ([admin/src/export.ts](../admin/src/export.ts))

Two datasets join on the group ID (`groupId` = usage `projectLabel`). Both need the Reader role and
accept `format=json` (default) or `format=csv`. CSV quotes every field and prefixes with an apostrophe any
value that starts with `=`, `+`, `-`, `@` or their full-width forms `＝ ＋ － ＠` (also after leading spaces),
or with a tab, carriage return or line feed
([OWASP CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection)). A line break inside a quoted
value is kept, so read the file with a CSV parser rather than line by line.

| Request | Rows |
|---|---|
| `GET /api/v3/export/usage?period=month\|previous\|custom[&from&to][&project][&group][&developer][&model][&backend][&family][&classification][&chargeback=<id>]` | One per chargeback ID, group and person: token categories, known/complete list cost in USD and CCU, observed cache-hit request share. At most 5,000 rows. List price at the rate card, not an Azure invoice |
| `GET /api/v3/export/groups` | One per onboarded group: chargeback ID, priority, budget mode, per-user amount, group cap, surfaces, expected cache-read share and its basis |

Any other parameter (including `tags`, `offset`, `limit`) is refused with `400 unknown_parameter`, and `from`
or `to` without `period=custom` with `400 from_to_require_custom_period`, so an export is never broader than its
request. The JSON echoes every applied filter.

A custom range (`from` and `to` as UTC timestamps, `to` excluded) must start before the current time and
end at most 31 days after it, so the current month always fits and a range in the future is refused with
`400 range_out_of_bounds` rather than answered as zero usage. The same rule applies to the chargeback views.
Both formats return JSON error bodies for the refusals below ([export handler](../admin/src/export.ts)).

Export errors. Each error body is JSON with `error` and `requestId` (quote the request ID when asking for help):

| Code | Meaning and fix |
| --- | --- |
| `400 invalid_format` | `format` is not `json` or `csv` (lower case) |
| `400 invalid_period` | `period` is not `month`, `previous` or `custom` |
| `400 from_to_require_custom_period` | `from` or `to` was sent without `period=custom` |
| `400 custom_period_requires_utc_from_and_to` | `period=custom` needs both `from` and `to` as UTC timestamps such as `2026-10-01T00:00:00Z` (no date-only value, no offset like `+05:30`) |
| `400 invalid_custom_range` | `from` is not before `to`, or a date does not exist (for example month 13) |
| `400 range_exceeds_max_query_days` | The range is longer than `ADMIN_CHARGEBACK_MAX_QUERY_DAYS` (default 62): split it |
| `400 range_out_of_bounds` | The range starts now or later, ends more than 31 days ahead, or starts more than 12 years ago |
| `400 unknown_parameter`, `400 repeated_parameter` | A parameter the export does not apply, or one sent twice |
| `400 invalid_project_filter`, `invalid_group_filter`, `invalid_developer_filter`, `invalid_model_filter`, `invalid_backend_filter`, `invalid_family_filter`, `invalid_classification_filter`, `invalid_chargeback_filter` | A filter value has the wrong shape: group and developer are Object IDs; family is `haiku`, `sonnet`, `opus`, `fable` or `mythos` |
| `404 export_not_found` | The dataset is not `usage` or `groups` |
| `503 project_store_not_configured` | `export/groups` without the registry settings |
| `503 user_tags_not_configured`, `500 user_tag_settings_unavailable` | A CSV needs the user-tag label: set `ADMIN_CONFIG_CONTAINER`, or retry when Cosmos DB answers; JSON still works |
| `503 export_unavailable` | The chargeback source is not configured or failed; `capability` says which |

History refusals (`history_*`, `backend_filter_not_in_history`, `chargeback_history_*`) are listed below. Both formats return
`x-ccof-truncated` (`true` when more than 5,000 rows matched; the JSON also has `truncated`) and
`x-ccof-row-limit`. A truncated export understates totals: narrow the period or filters.

When the chargeback source is not configured or fails, `export/usage` returns `503 export_unavailable`
with the capability state, never an empty file.

With chargeback history ([ADR-0044](adr/0044-chargeback-history-in-cosmos.md),
[chargeback history](operate/chargeback-history.md)), `export/usage` reads the part of its range before the
first whole UTC month the Log Analytics workspace still holds from the Cosmos DB container `chargebackDaily`, and
the rest from Log Analytics; rows with the same chargeback ID, group and person are merged, and every row carries
the whole requested period in `periodStart` and `periodEnd` ([admin/src/history.ts](../admin/src/history.ts)).
The JSON lists the parts in `sources`; the `chargebackHistory` entry has `openDays` (covered days not yet closed),
which the response (CSV too) also gives in the `x-ccof-history-open-days` header, comma-separated.
Refusals of that part: `400 history_range_not_whole_days` (it must start and end at 00:00 UTC),
`400 backend_filter_not_in_history`, `409 history_not_covered` with `uncoveredDays` (days the reconciler never
recorded; JSON body for CSV requests too, never a file with zeros), `409 history_expired` with `expiredDays` and
`expiresAt` (days whose documents expired, or expire within a day, under `ttlDays`), `503 chargeback_history_not_configured` and
`503 chargeback_history_settings_invalid`. Without the history settings the whole range is read from Log Analytics.

Usage CSV uses the configured individual-tag label instead of the `chargebackId` display heading.
Browser chargeback CSV similarly labels `chargebackId` / `userTag`. Values are still read by their
original keys. Collisions with other headings are resolved by appending the machine key in
parentheses, then a number if necessary. JSON/Power BI schemas and Groups CSV are unchanged.
A missing settings document uses `User tag`; unavailable/unreadable/invalid settings refuse the CSV
download (non-success response), rather than silently using a default. JSON exports remain independent.

Connecting Power BI: the documented Entra path for a custom API is a Power Query custom connector with
`Aad` authentication ([Handling authentication](https://learn.microsoft.com/en-us/power-query/handling-authentication)).
Whether Power BI's built-in Web connector with "Organizational account" can sign in to this API has not
been verified (UNKNOWNS G-R3); the token must come from a client in `ADMIN_ALLOWED_CLIENT_IDS` with the
admin scope. Until that is verified, the supported path is to download the CSV (or JSON) and load it as a
file source.

## Sign-in

A new app registration, "CCOF Admin", serves both the console and the API. It has **no Graph or
other API permissions**.

| Setting | Value |
|---|---|
| Exposed scope | `Projects.Manage` (`requestedAccessTokenVersion: 2`) |
| App roles | `CCOF.Projects.Read`, `CCOF.Projects.Write`, assigned to admin users or groups |
| Platform | Single-page application, redirect URI `https://<admin-app>/api/console` |
| Pre-authorized clients | The app itself, so no consent prompt; optionally Azure CLI (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) for scripted calls |

| App setting | Value |
|---|---|
| `ADMIN_TENANT_ID` | Tenant ID |
| `ADMIN_AUDIENCE` | The app registration's client ID (v2 tokens) |
| `ADMIN_SCOPE` | `Projects.Manage` |
| `ADMIN_ALLOWED_CLIENT_IDS` | The app's client ID, plus Azure CLI's only if scripted access is wanted |
| `ADMIN_UI_CLIENT_ID`, `ADMIN_UI_SCOPE` | Client ID and `api://<client-id>/Projects.Manage`, served to the console |
| `ADMIN_READER_IDS`, `ADMIN_EDITOR_IDS` | Optional object-ID lists; app roles are preferred |

If any required value is missing, the API returns 503 and the console shows its setup screen
(fails closed).

**Role changes apply at the next token.** The roles are claims in the access token, so a role added, changed or
removed on CCOF Admin takes effect only when the caller gets a new token. Entra gives an access token a lifetime
of 60-90 minutes by default
([access tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens)), and clients reuse it
until it expires. In the 2026-10-26 lab, writes kept returning `403 write_permission_required` for about 90
minutes after the Write role was restored. To get a fresh token now:

- **Console:** **Sign out**, then sign in again.
- **Azure CLI:** `az account clear`, then `az login` and request the token again. Requesting the scope by the
  application ID without `api://` (`<client-id>/Projects.Manage`) also returned a new token in the lab.

A role **removal** also waits for the token to expire: remove the role, then expect up to 90 minutes before the
person's console or script is refused.

## Deploy

For **granular hand configuration**, follow the appended
[Public Access Workbook Modules 17-24](runbooks/PUBLIC-ACCESS-WORKBOOK.md#admin-hand-configuration).
They preserve the existing Modules 00-16, consolidate the Step 13 client/desktop material,
and give individually numbered Portal/CLI alternatives and checks for new resources, grants,
Entra sign-in, publishing, private Cosmos access and UI restrictions. The condensed deployment
and Bash commands below are alternative references, not the customer's default hand-config path.

```powershell
# 1. New app, storage and logs (resource group of your choice)
az deployment group create -g <rg> -n ccof-admin-api --template-file infra/admin/admin-resources.bicep `
  --parameters functionAppName=<app> storageAccountName=<storage> `
               cosmosEndpoint=https://<cosmos>.documents.azure.com:443/ cosmosDatabase=ccof
# 2. If policy forces storage to private (it does in the lab): a new network resource group
az group create -n <admin-net-rg> -l <region>
az deployment group create -g <admin-net-rg> -n ccof-admin-network --template-file infra/admin/admin-network.bicep `
  --parameters adminStorageAccountId=<storage resource id from step 1>
# 3. Redeploy step 1 with integrationSubnetId=<output of step 2>, storagePublicNetworkAccess=Disabled
#    and the ADMIN_* sign-in parameters
# 4. Build and deploy the package (this CLI command detects the Flex package API)
pwsh admin/Build-AdminPackage.ps1
az functionapp deployment source config-zip -g <rg> -n <app> --src admin/admin.zip
```

Flex publishing note: Microsoft documents `az functionapp deployment source config-zip`
for Flex Consumption: the CLI detects the plan and uses the managed package publishing
endpoint. It is **not** a direct Kudu ZIP-deploy request on a Flex app. The generic
`az functionapp deploy --type zip` returned HTTP 415 in the lab with CLI 2.91.0.
Do not set `WEBSITE_RUN_FROM_PACKAGE` or request remote build for this ready-to-run ZIP.
[Microsoft reference](https://learn.microsoft.com/azure/azure-functions/deployment-zip-push#deploy-by-using-azure-cli).

If the customer permits a repository clone, the [quick modular stages](archive/ADMIN-QUICK-STAGES.md) create the admin resources first, then configure sign-in, build/publish code and verify data access independently. Storage/network policy remains a dependency, not something this path bypasses.

## Lab status (2026-10-16)

| Item | State |
|---|---|
| Console page, CSP, public configuration | Live; served by the app |
| Entra sign-in | Live; redirects to the tenant's v2 authorize endpoint |
| Token validation and roles | Live; with a real Entra token, `/api/console/me` returned `canWrite: true`; with no token, 401 |
| Write without `If-Match` | Live; 428 |
| Registry read and write | **Blocked:** 503 `registry_unavailable`. The health probe log shows Cosmos refusing the admin identity because it has no data role (`readMetadata`). |

## Remaining steps to read and write the registry (each needs approval)

Both steps add configuration under the existing Cosmos account: a custom role/assignment and a
private-endpoint connection. Existing apps, their grants, the original endpoint, and the public-access
setting stay unchanged. These are real Azure writes and require the account owner's approval.

### Hand configuration from Azure Cloud Shell

Use **Bash**, not PowerShell. The complete copy-paste procedure is
[`admin/Configure-RegistryAccess.sh`](../admin/Configure-RegistryAccess.sh). It needs no clone,
download, app rebuild, account key or Graph consent. Paste its contents into Cloud Shell after
filling the variables at the top. Cloud Shell configures resources through Azure's management
plane; the **Function App**, not Cloud Shell, subsequently connects to private Cosmos.

Required authority: Cosmos `sqlRoleDefinitions/write` and `sqlRoleAssignments/write`; Network
Contributor-equivalent access to the admin VNet, subnet and private endpoint; Private DNS
Zone Contributor-equivalent access to the admin DNS zone; permission to approve the new
Cosmos private-endpoint connection; and permission to restart/read keys on the admin app.
Owner or appropriately scoped Contributor/custom roles can supply these actions; a Cosmos
data-reader role alone cannot configure them.

The procedure:

1. Checks the selected app's system identity and existing integration with the admin VNet.
2. Adds a custom role permitting metadata read, query, item read/create/replace, assigned
   **only** on `/dbs/<database>/colls/projects`. Includes `readChangeFeed`, which Microsoft requires
   alongside `executeQuery` for SDK queries (the project list). No delete, upsert, entitlement or
   backend writes.
3. Adds a `Sql` Cosmos private endpoint in `snet-admin-private-endpoints`, not the delegated
   Functions subnet. Creates a documents private DNS zone in the **admin network** resource
   group and links it to the **admin VNet only**. Leaves the CCOF VNet/zone alone.
4. Requires connection approval and adds the endpoint's DNS zone group. The group manages the
   global and regional records; do not manually create just one account A record.
5. Restarts **only the admin app** and checks `/api/health` with a key held in memory, never
   printed or put in the URL. No API token or key should be pasted into a ticket or screenshot.

**Expected result:** HTTP 200, `status: ready`, `checks.auth: configured`, `checks.cosmos: ok`.
This is a point-read probe from the app. It does **not** prove list, create, replace, audit
ingestion or propagation into developer entitlements. Sign in to the UI, click **Try again**,
confirm projects load, then separately approve a dedicated test-project create/update test.
Do not change live projects just to test connectivity.

**If it still fails:**

| Result | Action |
|---|---|
| `forbidden_data_role` | Verify the assignment uses the admin app's **principal/Object ID**, correct database/container and custom role; allow a few minutes for propagation. The metadata refusal can occur before networking is fully exercised. |
| `blocked_by_network` / `unreachable` | Confirm PE Approved, DNS zone group and VNet link, app integration, custom-DNS forwarding if any, and NSG/UDR reachability. Private DNS must work inside the Function VNet. |
| HTTP 403 before a health JSON | App inbound restrictions may block ordinary Cloud Shell. Test from an approved network; do not broaden the allow-list just for the probe. |
| Endpoint connection Pending | Cosmos owner: **Cosmos account > Networking > Private access**, approve only this new admin connection; rerun afterwards. |
| Health ready but UI refuses sign-in | Authentication/app-role issue, not Cosmos networking; check the CCOF Admin app assignment and client/scope settings. |

If custom DNS, NSGs or a firewall are in use, allow the Functions host, Entra authentication,
monitoring and deployment dependencies as well. The Cosmos SDK currently uses its default Direct
mode: TCP 443 and the documented private-endpoint Direct-mode port requirements must be considered.
Do not change the endpoint account URL to a private IP. Sources:
[Cosmos Private Link](https://learn.microsoft.com/azure/cosmos-db/how-to-configure-private-endpoints),
[Cosmos data RBAC](https://learn.microsoft.com/azure/cosmos-db/how-to-connect-role-based-access-control).

### Equivalent hand-configured Portal steps

1. **Admin Function App > Identity > System assigned**: copy its Object/principal ID. Do not use
   the Entra UI application client ID or the sync identity.
2. Use the Cloud Shell role-definition/assignment commands for **Cosmos native data RBAC**.
   Ordinary **Access control (IAM)** assignments are not a substitute. Scope only to `projects`.
3. **Private endpoints > Create**: select the admin network resource group and the admin VNet's
   region. Target **Microsoft.DocumentDB/databaseAccounts**, the existing Cosmos account, and
   sub-resource **Sql**. Use a new endpoint name.
4. Select the **admin VNet > snet-admin-private-endpoints**. Do not use the delegated Functions
   integration subnet. Do not edit the CCOF VNet.
5. In DNS, integrate with **privatelink.documents.azure.com in the admin network resource group**.
   If the wizard does not offer a separate zone, create it in **Private DNS zones**, add a virtual
   network link to the admin VNet (auto registration off), then add a **DNS configuration > private
   DNS zone group** on this new endpoint pointing to that zone.
6. Cosmos account > **Networking > Private access**: verify this endpoint connection is
   **Approved**. Leave public network access **Disabled** and keep the original connection.
7. Confirm **Admin Function App > Networking > VNet integration** still points to the admin VNet,
   and restart only the admin app. Its `COSMOS_ENDPOINT` remains the normal account hostname.
8. Run the final Cloud Shell health probe, then reopen the console. Creating a private endpoint is
   not evidence of a successful data read. For a private-only inbound console, test from the
   approved admin network rather than ordinary Cloud Shell.

### Role details and alternative networking

1. **Data role for the admin identity only**, scoped to the `projects` container. Use a custom
   role with `readMetadata`, `items/read`, `items/create`, `items/replace` and
   `executeQuery` and `readChangeFeed`. Both query actions are required for SDK queries. No delete
   and no upsert.

   ```powershell
   az cosmosdb sql role definition create -g <rg> -a <cosmos> -b '{
     "RoleName":"ccof-admin-project-editor","Type":"CustomRole","AssignableScopes":["/"],
     "Permissions":[{"DataActions":[
       "Microsoft.DocumentDB/databaseAccounts/readMetadata",
       "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/executeQuery",
       "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/readChangeFeed",
       "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read",
       "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/create",
       "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/replace"]}]}'
   az cosmosdb sql role assignment create -g <rg> -a <cosmos> --role-definition-name ccof-admin-project-editor `
     --principal-id <admin app principal id> --scope /dbs/ccof/colls/projects
   ```

2. **Network path from the admin VNet to Cosmos.** Choose one:
   - **A Cosmos private endpoint in `ccof-admin-vnet`**, with its own
     `privatelink.documents.azure.com` zone in the admin network resource group. This adds a
     private-endpoint connection to the Cosmos account.
   - **VNet peering** between `ccof-admin-vnet` and the CCOF VNet, plus a link from the existing
     documents DNS zone. This changes the existing VNet and DNS zone.

   After both steps, `GET /api/health` reports `cosmos: ok`.

## Access restriction guidelines

Sign-in, roles and ETags already protect the data. Network restrictions add a second layer, so
the console and API are reachable only from where administrators work. Apply them to the
**admin app only**.

**1. Choose one inbound model.**

| Model | When to use | How |
|---|---|---|
| **Private only** (recommended for production) | Admins are on the corporate network, VPN or ExpressRoute, connected to Azure | Inbound private endpoint on the admin app (`sites` sub-resource) in a VNet the corporate network reaches. Set `publicNetworkAccess=Disabled` on the app. Resolve `privatelink.azurewebsites.net` for the app name from corporate DNS. |
| **Allow-list** | There is no private connectivity yet | Access restrictions with default action **Deny**, plus Allow rules only for the organization's egress IP ranges (CIDR). |

**2. Allow-list commands** (example ranges; use the organization's real egress ranges):

```powershell
az functionapp config access-restriction add -g <rg> -n <admin-app> --rule-name corp-egress-1 `
  --action Allow --ip-address 203.0.113.0/24 --priority 100
az functionapp config access-restriction add -g <rg> -n <admin-app> --rule-name corp-egress-2 `
  --action Allow --ip-address 198.51.100.0/24 --priority 110
az resource update -g <rg> -n <admin-app> --resource-type Microsoft.Web/sites `
  --set properties.siteConfig.ipSecurityRestrictionsDefaultAction=Deny
# Deployment (SCM) endpoint: same rules, or stricter
az functionapp config access-restriction set -g <rg> -n <admin-app> --use-same-restrictions-for-scm-site true
```

**3. Rules to keep.**

- Restrict the **admin app only**. Never open Cosmos, storage or the existing gateway apps to make
  the console reachable.
- Never add `0.0.0.0/0`, broad service tags such as `AzureCloud`, or home or guest networks.
- Entra sign-in still happens at `login.microsoftonline.com`, so admin browsers need normal
  internet access to Entra. Only the console and API host are restricted.
- Set **Assignment required = Yes** on the CCOF Admin enterprise application, so only users or
  groups with a CCOF role can get a token at all.
- Assign `CCOF.Projects.Write` to a small admin group, and `CCOF.Projects.Read` to reviewers.
  Review membership regularly.
- Remove Azure CLI from `ADMIN_ALLOWED_CLIENT_IDS` and the pre-authorized clients if scripted
  access isn't wanted.
- Keep `/api/health` on the function key; don't share the key with administrators.
- Send the app's Application Insights audit lines (`ccof.admin.audit.v1`) to the security team's
  workspace or alerting.

**4. Verify after applying.**

- From an allowed network, `GET https://<admin-app>/api/console` returns 200.
- From any other network, it returns 403 (IP restriction) or doesn't resolve (private only).
- The health check, from an allowed network with the function key, still reports `auth: configured`.
