# ADR-0035: A person's own budget figures through the gateway

Status: Accepted (owner request 2026-10-23). Implementation: [USAGE.md](../USAGE.md).

## Context

The reconciler writes each person's spend and budget per scope to `budgetState` (partition `/personId`):
`spentCcu`, `budgetCcu`, `exhausted`, `period`, `computedAt`, `completeness`. The resolver read only
`exhausted` and `validUntil`; nobody could see the figures. The owner asked for `/usage` in Claude Code to
show a person's own spend, budget and remaining, with the group's remaining budget only when an administrator
allows it.

## Options

1. **Admin API.** The admin Function App already reads Cosmos, but it admits only console users with app
   roles; developers have no role and would need a second audience.
2. **A gateway operation backed by the resolver (chosen).** The developer's existing gateway token, already
   requested by Claude Code's helper, authenticates; APIM takes the person ID from the token; the resolver,
   which only APIM can call (ADR-0009), reads the documents.
3. **Direct Cosmos access from the client.** Rejected: every developer would need a data-plane role.

## Decision

1. `GET /ccof/me/usage` is an operation of the existing `claude-messages` API with its own operation policy
   (`policy/my-usage.template.xml`), without `<base />`, so none of the messages policy runs for it.
2. Its token checks are the messages policy's, byte for byte (a test compares them).
3. The person ID is the validated token's `oid`. Nothing else from the request reaches the resolver.
4. The resolver route `POST /api/me/usage` sits behind the same App Service Authentication; it accepts only
   `{ personId (lower-case GUID), requestId? }` and makes point reads only: the entitlement, one
   `budgetState` per active membership, and, when allowed, one `aggregateBudgetState` per scope. At most 25.
5. The group's remaining budget (and nothing else of the group: no spend, cap, mode or member count) is a
   deployment setting, `RESOLVER_USAGE_GROUP_TOTALS`. It is the one optional resolver
   setting: absent means hidden, so a resolver deployed before it existed keeps running.
6. Per-person limit `admission.usage` (optional, 10 per 60 s), separate from `/v1/messages`.
7. The Claude Code skill is a personal skill named `usage`, which replaces the built-in `/usage` in a local
   terminal session; `/cost` and `/stats` keep the built-in command
   ([Claude Code skills](https://code.claude.com/docs/en/skills), "skills that share a name"). It runs
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<home>/.claude/ccof-usage.ps1"`, the form Claude Code
   documents for Windows whether it uses Git Bash or PowerShell ([status line, Windows configuration](https://code.claude.com/docs/en/statusline)).
8. The output names scopes by ID only. It is placed in the model's context, and a directory display name could
   carry instructions.

## Consequences

- Figures are as of the reconciler's last run and exclude unpriced requests: a lower bound, a few minutes old.
- A Cosmos outage makes usage answer `503`; Claude requests are unaffected by this operation.
- The group-total switch is deployment-wide; a per-group switch would need a field in the group contract.
- The quickstart, Core and manual paths do not create the operation (no usage policy passed).
- The operation must not be deployed before the resolver route: until then it answers `503`, not wrong data.
