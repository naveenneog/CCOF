# ADR-0046: Admin checks a group's backend and models against the deployment

Status: Accepted (2026-10-26).

## Context

The admin bug bash of 2026-10-26 (finding ADMIN-1) showed that `POST /api/groups` accepted any backend ID that
matched the identifier pattern and any model ID that matched its family's pattern, so a group could be stored
`active` with a backend or model the deployment does not have. When the APIM inventory was off, the console's
backend field was free text.

What members of such a group get today:

- **Unknown backend:** the gateway policy routes only to a static backend or to one the resolver describes from
  the `backends` container; anything else is refused with `backend_not_configured`
  ([claude-messages.template.xml](../../infra/gateway/policy/claude-messages.template.xml)).
- **Undeployed model:** the gateway admits the model by name, and Foundry refuses the call because the
  deployment does not exist.

So the error surfaces only when a member sends a request, far from the admin who made it.

Options considered for the list the admin checks against:

1. The APIM inventory (`/api/v2/inventory`): optional, needs Reader on APIM, often off (it was off in the lab),
   and knows backends but not the deployment names the gateway forwards.
2. The `backends` container the resolver reads: the admin identity has no data role on it, and its documents
   carry no deployment names.
3. The deployment's own configuration: `backends[].id` and the keys of `backends[].deploymentInferenceGeo`,
   which are the deployment names. Stage 1 checks that these deployments exist (or are created) on the
   Foundry account, and the gateway reads their inference geography from the same keys.

## Decision

1. Stage 5 writes the admin app setting `ADMIN_BACKENDS`, a JSON array `[{"id","deployments"}]` built from
   option 3 ([stage5-config.bicep](../../infra/staged/stage5-config.bicep),
   [Staged.Application.ps1](../../infra/staged/Staged.Application.ps1)). A deployment that adds a backend by hand
   adds it there too.
2. On onboarding, and on an edit that changes the backend or adds models, the admin refuses a backend not in the
   list (`422 invalid_group`, `backendId:not_deployed`) and a model not deployed on the group's backend
   (`familyPolicy.families.<family>.models:not_deployed`). The body names the allowed values in `allowed`
   (`backendIds`, and `deployments` of the chosen backend) ([backend-settings.ts](../../admin/src/backend-settings.ts)).
3. Only what a write introduces is checked. A model stored before this check, or removed from the deployment
   later, does not block an unrelated edit such as a chargeback ID; moving to another backend checks every model.
4. Fail closed: without `ADMIN_BACKENDS`, or with an invalid value, such a write is refused with
   `503 backend_list_not_configured` or `503 backend_list_invalid`. Edits that change neither still work.
5. The console reads the list from `GET /api/groups/backends` (Reader), offers only those backends, lists the
   models deployed on the chosen one, and checks the form before sending.

The shared group contract (`src/contracts/group-registration.ts`) is unchanged: the sync and reconciler keep reading
existing documents as before.

## Consequences

- An admin app updated without rerunning Stage 5 refuses onboarding until Stage 5 has written `ADMIN_BACKENDS`;
  the error and the console name the setting.
- The list is the configuration, not a live read of Foundry: a deployment deleted in the portal after Stage 1 is
  still listed. The gateway still refuses what it cannot route.

## Related findings in the same bug bash

- ADMIN-2 and ADMIN-4: `from`/`to` are refused unless `period=custom`, and a custom range must start before now and
  end at most 31 days ahead (`range_out_of_bounds`), so no request returns more than asked or an empty future range
  that reads as zero usage.
- ADMIN-5: display names need visible text and no control characters; the CSV formula guard follows
  [OWASP CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection), including full-width triggers and
  triggers after leading whitespace ([text-rules.ts](../../admin/src/text-rules.ts)).
