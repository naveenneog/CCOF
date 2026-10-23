# ADR-0038: Monetary admission ceilings and incomplete-accounting acceptance

Status: Accepted for acceptance testing and conservative admission; strict reservations not implemented.

## Context

The owner requested a USD 10 consumption test, attempts to exceed configured limits, group model-family limits,
and higher-spend group selection. An offline security review reproduced two gaps: APIM discarded the resolver's
`personCeilingTokensPerMinute`, and streamed cache charges could remain unknown while a fresh partial budget state
continued to admit requests. Pricing and reconciliation are not synchronous request reservations.

## Decision

- APIM retains and validates `budgetEnforcement` and `personCeilingTokensPerMinute` in fresh and cached decisions.
  The aggregate person TPM is the lower of the configured limit and the monetary ceiling; a configured null does
  not disable the monetary ceiling. A zero monetary ceiling is a classified `budget_exhausted` refusal.
- Older cached decisions without these fields are invalid and must be refreshed. This is a fail-closed cache
  migration, not permission to serve an old last-known-good decision.
- `resolver.requireCompleteUsage` (`RESOLVER_REQUIRE_COMPLETE_USAGE`) is an explicit boolean opt-in, default false
  for compatibility. It requires `budget-state` mode. When enabled, only `completeness: "complete"` person states,
  and complete aggregate states for strict groups, are usable. The reconciler stamps aggregate completeness from
  every attributed row in the group, including former members. Missing completeness is not complete.
- The existing lower-bound reporting remains available. The opt-in does not invent an amount for unpriced usage,
  and does not change the meaning of `exhausted`. Invalid accounting is a visible 503, not a fabricated zero balance.
- The live runner's authorization ceiling is USD 10 total, with conservative cost reserved before each paid attempt.
  Unknown outcomes retain their reservation. A failed or timed-out inference must not be blindly retried.
  Synthetic budget-state fixtures do not count as real Azure spend.

## Alternatives and limits

An atomic worst-case dollar reservation is not interchangeable with a recurring TPM limit. It would require an
authoritative request ledger, idempotent reservations, bounded input/cache/output pricing, crash-safe settlement,
and atomic enforcement of personal and aggregate group budgets. These records currently have different Cosmos
partition keys. No cross-partition atomic guarantee is assumed here.

The changes above do **not** establish an absolute dollar cap. Telemetry ingestion, reconciliation, allow caching,
in-flight/concurrent responses, last-known-good grace and distinct group budgets can still permit overshoot.
Changing a selector to another group of which the person is a member selects that group's independent budget;
it is not an authorization bypass. A nonmember selector remains refused.

Streamed cache categories are not captured by the current nonbuffering APIM trace. Enabling complete-accounting
admission can therefore block further use after such requests; it is conservative refusal, not a streaming-accounting
repair. Complete telemetry also cannot prove that no un-ingested request exists. The guide and acceptance report
must distinguish these limitations from successfully tested restrictions.

## References

- [Resolver decisions](../../src/resolver/decide.ts) and [configuration](../../src/resolver/config.ts).
- [Gateway policy](../../infra/gateway/policy/claude-messages.template.xml), monetary normalization and person TPM.
- [Aggregate writer](../../src/reconciler/reconcile-group.ts) and [row pricing](../../src/reconciler/price-rows.ts).
- [Azure Cosmos DB transactions](https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/database-transactions-optimistic-concurrency):
  transactions have a logical-partition scope.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), retrieved 2026-10-23;
  live usage estimates remain distinct from later Marketplace charges.
