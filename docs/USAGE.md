# Usage: a person's own CCOF budget

A person can see their own spend, budget and remaining budget for the month, in Claude Code (`/usage`)
or from the gateway's `GET /ccof/me/usage`. The figures come from the reconciler's `budgetState`
documents, which existed before but were read by nothing except the resolver's budget check.

| Part | Where |
| --- | --- |
| Gateway operation `GET <gateway>/anthropic/ccof/me/usage` | [infra/gateway/policy/my-usage.template.xml](../infra/gateway/policy/my-usage.template.xml), rendered by [render.ts](../infra/gateway/render.ts) to `<apiId>.usage.policy.xml`, deployed as operation `get-my-usage` by [apim-api.bicep](../infra/quickstart/modules/apim-api.bicep) |
| Resolver route `POST /api/me/usage` | [src/resolver/my-usage.ts](../src/resolver/my-usage.ts), [http-handler.ts](../src/resolver/http-handler.ts) `handleMyUsageRequest` |
| Client script `ccof-usage` | [client/src/usage.mjs](../client/src/usage.mjs), [client/bin/ccof-usage.mjs](../client/bin/ccof-usage.mjs) |
| Claude Code skill `/usage` | written by [scripts/client/ClaudeCodeGateway.ps1](../scripts/client/ClaudeCodeGateway.ps1) to `%USERPROFILE%\.claude\skills\usage\SKILL.md` |

## How a request flows

1. Claude Code runs the skill. Its `` !`command` `` line runs `powershell -NoProfile -ExecutionPolicy Bypass -File "<home>/.claude/ccof-usage.ps1"` before
   anything reaches the model ([Claude Code skills, dynamic context](https://code.claude.com/docs/en/skills#inject-dynamic-context)).
2. `ccof-usage` takes a token from the existing helper's token service (the same token Claude Code's
   `apiKeyHelper` uses) and calls `GET <gatewayUrl>/ccof/me/usage`.
3. The gateway checks the token exactly as for `/v1/messages`: the same `validate-jwt` (tenant, issuers,
   audiences) and the same `oid`, scope and client-application checks. A test keeps these blocks
   byte-for-byte equal to the messages policy ([tests/gateway-usage-policy.test.ts](../tests/gateway-usage-policy.test.ts)).
   The operation's policy has no `<base />`, so the messages policy does not run for it.
4. The gateway applies its own per-person limit (`admission.usage`, 10 calls per 60 seconds when absent),
   takes a token with its managed identity, and sends the resolver `{ personId: <oid>, requestId }`. Nothing
   from the caller's request (query, headers, body) is read or forwarded, so a caller cannot ask for another
   person's figures.
5. The resolver's existing rule holds: App Service Authentication admits only APIM's managed identity
   (ADR-0009), and the route checks that the platform gate is on and ran, as `/api/resolve` does.
6. The resolver reads the person's entitlement, then for each active membership one `budgetState` document
   (`<personId>:<projectId>`, partition `/personId`), and, only when group totals are allowed, one
   `aggregateBudgetState` (`<projectId>:<code>`). All are point reads; at most 25 scopes are read.
7. The gateway passes on only a `200` whose body has `schema: "ccof.usage.v1"` and a `scopes` array, with
   `Cache-Control: no-store`. Anything else becomes `503` "temporarily unavailable".

## The answer

```json
{
  "schema": "ccof.usage.v1",
  "period": "2026-10",
  "groupTotals": "hidden",
  "truncated": false,
  "scopes": [{
    "projectId": "PILOT1", "classification": "STD", "status": "current",
    "spent": { "ccu": "4210", "usd": "42.1" }, "budget": { "ccu": "10000", "usd": "100" },
    "remaining": { "ccu": "5790", "usd": "57.9" }, "percentUsed": 42.1, "exhausted": false,
    "period": "2026-10", "asOf": "2026-10-23T10:42:13.000Z", "completeness": "complete"
  }]
}
```

- Amounts are the reconciler's exact decimal strings; USD is derived at 100 CCU = 1 USD
  ([src/cost/budget-units.ts](../src/cost/budget-units.ts)). `remaining` never goes below zero.
- `status` is `current`, `not_computed` (no figure for this UTC month yet: no `budgetState`, or one from an
  earlier month) or `invalid` (the stored figure failed its checks, or names another person or project; it is
  not shown).
- `asOf` is the reconciler's `computedAt`. `completeness: "partial"` means some requests in the period were
  not yet priced.
- `group` is present only when group totals are allowed: `{ "remaining": { "ccu", "usd" } }`, the group's remaining budget only; `{ "remaining": null }` when the group has no shared cap (auto-scale); `null`
  when this month's total is not available (none yet, or the stored one is from an earlier month). It carries no
  spend, cap, mode, member count or other person's figure.

Claude Code shows it as, for example:

```text
CCOF budget, project PILOT1 / STD: $42.10 of $100.00 used (42%), $57.90 left, as of 10:42 UTC.
Figures are from the last cost run; requests not yet priced are not included.
```

A group is shown by its group ID (the Entra object ID), never by a directory display name: the output is placed in the model's context, and a display name is directory text that could carry instructions. The admin console shows which group an ID is. With group totals allowed, a second line reads `Group remaining: $7,500.00.` or `Group: no shared cap.`

## How current the figures are

- As of the reconciler's last run (`asOf`). The staged example runs it every 2 minutes
  (`reconciler.schedule`), so figures are usually a few minutes old.
- Requests not yet priced are not included, so spend is a lower bound.
- Figures are refreshed only while the reconciler runs (`reconciler.timerEnabled: true`). With the timer off,
  figures already written for this month stay as they were at their `asOf` time; a scope with none shows
  "no figures for this month yet", and every scope does once the month changes.
- A figure is shown only when the stored state names the same person, project and classification as the
  membership; a state left from an earlier classification of the project is reported `invalid`.

## Privacy

- A person sees only their own figures: the person ID is the validated token's `oid`, set by the gateway.
- The group's remaining budget is shown only when the deployment allows it: `resolver.usageGroupTotals`
  in the staged configuration, written by Stage 5 as the resolver setting `RESOLVER_USAGE_GROUP_TOTALS`.
  Absent means hidden; a value other than exactly `true` or `false` is a configuration problem, and the
  resolver then refuses every request, as for any other invalid setting. It applies to every scope of the
  deployment; there is no per-group switch yet.
- The resolver writes no log line for a successful answer; a failure logs reason codes and IDs only.

## Cost and limits

- Per call: one entitlement read, one `budgetState` read per scope (at most 25), and with group totals one
  `aggregateBudgetState` read per scope. All are point reads: entitlement and `budgetState` in the person's
  partition (`/personId`), `aggregateBudgetState` in the scope's (`/scopeId`).
- Per person: `admission.usage` (default 10 calls per 60 seconds, its own counter), separate from the
  `/v1/messages` admission limit.
- The status line caches its line for 60 seconds next to the client configuration
  (`usage-statusline.json`, the line and its time only).

## Claude Code

- `Set-ClaudeCodeGateway.ps1 -Confirmed` writes `%USERPROFILE%\.claude\ccof-usage.ps1` (pins the client configuration, runs `ccof-usage` with the installed Node) and
  `%USERPROFILE%\.claude\skills\usage\SKILL.md`, backed up and restorable like its other files ([CLIENTS.md](CLIENTS.md)).
- A personal skill named `usage` replaces the built-in `/usage` in a local terminal session; the built-in
  aliases `/cost` and `/stats` still run the built-in command, which shows the session's own estimate
  ([Claude Code skills, skills that share a name](https://code.claude.com/docs/en/skills)). The documentation
  states this for local terminal sessions; the VS Code extension's behaviour is not verified here.
- Status line, opt in: `Set-ClaudeCodeGateway.ps1 -UsageStatusLine -Confirmed` sets `statusLine` to
  `powershell -NoProfile -ExecutionPolicy Bypass -File "<home>/.claude/ccof-usage.ps1" --statusline` only when the person has no status line; an existing one is kept and reported
  as `kept_existing`. It shows the scope with the highest spend, for example `CCOF $42.10/$100.00 (42%)`, and
  prints nothing when the figures cannot be read.
- There is no Intune package in this repository. A device-management script runs the same installer.

## Outage behaviour

If the resolver cannot read Cosmos within its deadline (`requestDeadlineMs`), the operation answers `503`
with "Your access to Claude is not affected". `/usage` then prints that line. Claude requests follow their
own rules (cached decisions and the last-known-good grace, [GATEWAY.md](GATEWAY.md)).

## Rollout

1. Resolver package with the `me/usage` route (Stage 7), and the `RESOLVER_USAGE_GROUP_TOTALS` setting (Stage 5).
2. Gateway: Stage 5 renders and deploys `get-my-usage` with its operation policy and reads it back.
3. Clients: rerun `Set-ClaudeCodeGateway.ps1 -Confirmed` to add the skill.

Until step 1 is done, the operation answers `503`. The quickstart, Core and manual paths pass no usage policy,
so the operation is not created there ([apim-api.bicep](../infra/quickstart/modules/apim-api.bicep), `usagePolicyXml`
empty).
