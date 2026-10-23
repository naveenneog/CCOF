# Budget and group acceptance, 2026-10-23

## Outcome

The current reconciled budget is not an absolute dollar cap. Reaching USD 10 in recorded spend refuses a further
request after reconciliation; concurrent requests and cached permission can spend beyond a previously recorded
balance. Atomic request-cost reservations are not implemented.

The gateway's dropped monetary TPM ceiling is corrected. An optional complete-accounting guard refuses unknown
charges instead of treating their lower bound as evidence of remaining budget. Streaming cache accounting itself
is not repaired; the guard is a conservative availability tradeoff. [ADR-0038](../adr/0038-budget-admission-acceptance.md).

## Real consumption

These requests used an existing approved Foundry Haiku 4.5 deployment, with a synthetic prompt and no repository or
user data. They called Foundry directly, **not the CCOF gateway**. They prove inference and cache behavior, not a
deployed CCOF budget limit.

| Request | Input | 5-minute cache writes | Cache reads | Output | Estimated list USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Nonstreaming smoke | 26 | 0 | 0 | 4 | 0.000046 |
| Streaming, cold cache | 25 | 8,400 | 0 | 4 | 0.010545 |
| Streaming, warm cache | 25 | 0 | 8,400 | 4 | 0.000885 |
| Total | | | | | **0.011476** |

The SSE responses included `message_start`, final output usage and `message_stop`. A separate malformed-request
attempt received HTTP 400 before inference; its reservation was retained. Conservative worst-case reservations
totalled USD 0.34 against the authorized USD 10 ceiling. They are not a spend measurement.

The estimates use Haiku 4.5 list rates of USD 1 input, 1.25 five-minute cache writes, 0.10 cache reads and 5 output
per million tokens ([pricing](https://platform.claude.com/docs/en/about-claude/pricing), retrieved 2026-10-23).
The deployment's GlobalStandard SKU supplied the global-pricing context; the response itself reported
`inference_geo: "not_available"`. No private-offer discount or Marketplace invoice amount was verified.

**USD 10 was not consumed.** The existing gateway token request failed with `AADSTS65001`/`AADSTS650057`: Azure CLI
was not consented/configured as a client of that gateway API. Its currently deployed policy also lacks this
checkout's monetary-ceiling correction. Existing deployments owned by another session were not replaced, and
production admission was not weakened to make the test pass. A registered developer-client sign-in and an isolated
deployment of the updated code remain necessary for the requested full live budget and chargeback run.

## Offline acceptance

The test fixtures are synthetic, not Azure consumption. The cross-component tests use the actual group parser,
sync planner, rate-card pricing, reconciler, resolver and compiled C# expressions from the rendered APIM policy.

| Scenario | Result |
| --- | --- |
| USD 9.90 / 10.00 / 10.10 recorded spend | Admitted below the limit; exhausted at equality and above |
| Higher month-to-date group spend | Higher-spend group selected; an exhausted winner is refused, not silently replaced |
| Explicit selector for another active membership | Selects that separate group's budget; this is not one universal personal USD 10 budget |
| Selector for a nonmember group | Refused |
| Group allowing only the exact Haiku alias | Sonnet, differently cased IDs, unregistered dated versions, trailing spaces and unregistered aliases refused |
| Family-specific rate/quota policy | Existing compiled policy tests verify independent person/group family counters, shared across admitted model versions |
| Dynamic monetary ceiling below static TPM | Lower ceiling retained and enforced; null static TPM does not remove it |
| Less than one output token of monetary remainder | Zero ceiling becomes `budget_exhausted`, not an unlimited token policy |
| Old/malformed cached monetary decision | Rejected before fresh or last-known-good reuse |
| Partial person or strict-group charges, complete-usage guard enabled | Classified 503; replaces permission instead of generic last-known-good fallback |
| Unknown charges from another member | Aggregate completeness becomes partial even when the caller's own usage is complete |
| Same USD 9.90 snapshot read by 20 simultaneous resolver calls | All 20 admitted in a nonbillable experiment; no synchronous balance reservation |

Missing or stale state, restricted-family approval, malformed spend, month rollover and equal-priority ties remain
covered by the existing resolver and group-contract suites. A model alias not explicitly registered does not inherit
permission from a family-name prefix. Client-controlled headers cannot grant membership.

## Reproduction

```powershell
$env:CCOF_LIVE_TESTS = '0'
node --test tests\budget-acceptance.test.ts tests\gateway-dollar-ceiling.test.ts `
  tests\resolver-budget-exhaustion.test.ts tests\resolver-config.test.ts `
  tests\reconciler-reconcile.test.ts tests\resolver-group-precedence.test.ts `
  tests\group-registration.test.ts tests\gateway-family-quotas.test.ts
```

New monetary tests first failed on the missing ceiling, zero-allow behavior, missing completeness checks and missing
group completeness. Eight valid mutations were caught by named failing tests with all 67 baseline tests loaded;
the restored suite passed all 67. Source and assertions: [dollar ceiling](../../tests/gateway-dollar-ceiling.test.ts),
[cross-component acceptance](../../tests/budget-acceptance.test.ts),
[budget refusals](../../tests/resolver-budget-exhaustion.test.ts).
