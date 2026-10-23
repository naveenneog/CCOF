# Budget and group acceptance, 2026-10-23/24

## Outcome

A new staged deployment (Stages 0–8, lab subscription, resource group `lab-e2e-rg`) was
tested through the CCOF gateway with an Azure CLI token for the gateway app (`entra.allowAzureCliClient`).
Two separate groups of which the tester is a direct member:

| Group | Budget (cap) | Families | Family limit |
| --- | --- | --- | --- |
| Alpha | USD 10 per person, USD 10 group | Haiku 5.5, Sonnet 5.5 | none |
| Beta | USD 1 per person, USD 1 group | Haiku 5.5 only | Haiku: 20,000 tokens per minute per person |

- **USD 10 consumed through the gateway.** The person's Alpha budget was used up and every later
  Alpha request was refused. The reconciled budget is not an absolute cap: recorded spend reached
  USD 11.25 and list-price spend USD 11.97 (details below).
- **Model-family restriction and limit hold:** Sonnet through Beta `403`; Beta Haiku `429` after the
  family limit.
- **Higher-spend group selection holds:** without a selector, the group with the higher month-to-date
  spend is used, and its exhaustion is not bypassed by falling back to the other group.
- **Chargeback:** an admin-defined field name `WBS ID` and a person's `WBS-1001.01` appear in the
  downloaded CSV of the deployed admin console.
- **Defects found live and fixed** (all with tests): group usage was not attributed in the ledger
  (Kusto types GUID strings as `guid`), so group budgets never accumulated spend; the gateway policy
  exceeded a 16 KB API policy limit on new APIM instances (now policy fragments, ADR-0039); four
  staged read-back faults (null subnet, BOM in an `az rest` read, comments in the usage-policy check,
  JSON text from Log Analytics); `/usage` calls listed as unattributed ledger rows.

Spend authorised: USD 10. Spend estimated from response bodies at list price, all phases: **USD 11.98**
(Alpha 11.97, Beta 0.004). No Marketplace invoice amount was checked.

## Live phases (2026-10-23, 19:57–21:54 UTC)

Rates: Sonnet 5.5 USD 2 input, 2.50 cache write 5 m, 4 cache write 1 h, 0.10 cache read, 10 output; Haiku 5.5
(prompt up to 100,000 tokens) 0.10, 0.125, 0.20, 0.01, 0.50, per million tokens
([config/rate-card.json](../../config/rate-card.json), retrieved 2026-10-11).

### 1. Admission and bypass attempts (15 of 15 as expected)

| Attempt | Result |
| --- | --- |
| No selector / Alpha selector / Beta selector, allowed model | 200, 200, 200 |
| Beta selector, Sonnet (family not in Beta) | 403 `permission_error` |
| Opus (no group admits it) | 403 |
| Selector of a group the caller is in but which is not onboarded | 403 |
| Selector of a group the caller is not in | 403 |
| Two selector values in one header | 400 |
| Model ID in different case; with a trailing space; an unregistered dated version | 403, 403, 403 |
| Token for another audience (Azure Resource Manager); no token | 401, 401 |
| Spoofed identity headers (`x-ms-client-principal-id`, `x-ccof-person`) | 200, charged to the real caller |
| Direct call to the private Foundry endpoint, bypassing the gateway | 403 "Public access is disabled" |

### 2. Family limit and group selection

- Beta Haiku, six requests of about 12,600 tokens: 200, 200, 200, then 429, 429, 429 (`Retry-After` 13–51 s).
  The limit counts tokens after each response, so 37,872 tokens were admitted in the minute against
  20,000. The same request through Alpha (no family limit): 200.
- Equal spend (zero): no-selector requests went to Alpha (lower priority number).
- After Beta's spend (USD 0.0038) exceeded Alpha's (USD 0.0017): a no-selector Haiku request went to
  Beta, and a no-selector Sonnet request was refused `403` (Beta does not admit Sonnet; no fallback).

### 3. USD 10 through the gateway

Eight workers sent Sonnet 5.5 requests (6,000 output tokens each) through Alpha, about USD 0.50 per
minute; six of them were streamed with a 1-hour prompt-cache write of about 30,000 tokens.

| Time (UTC) | Event |
| --- | --- |
| 21:23:00 | Reconciled Alpha spend USD 9.87, not exhausted |
| 21:24:00 | Reconciled USD 10.35, `exhausted: true` |
| 21:24:25 | First refusal: `403` "Your CCU budget for project … is used up for this budget period" |
| 21:24:38 | Last request already in flight completes (200) |
| 21:27:00 | Final reconciled Alpha spend USD 11.2497 (1,124.97 CCU), `completeness: partial` |

List-price spend from the response bodies for Alpha: USD 11.9696. The USD 0.72 difference equals the
cost of the six streamed cache writes (USD 0.7232): the gateway's trace of a streamed response does not
carry cache categories (ADR-0038), so the reconciled figure is a lower bound and `completeness` is
`partial`. Foundry also throttled some requests (`429 RateLimitReached`, 16,000 output tokens per
minute per user); those were not charged.

### 4. After exhaustion (8 of 8 as expected)

| Attempt | Result |
| --- | --- |
| Alpha selector: Sonnet; Haiku (cheaper); streamed | 403 budget used up, each |
| No selector (Alpha has the higher spend) | 403 budget used up, no switch to Beta |
| Selector header in other case (`X-CCOF-PROJECT`) | 403 budget used up |
| Selector value in upper case | 403 not entitled |
| Beta selector, Haiku | 200 (Beta's own USD 1 budget; a separate group, by design) |
| Beta selector, Sonnet | 403 family |

`/usage` then showed Alpha USD 11.2497 of 10, 112.5%, exhausted; Beta USD 0.0038 of 1.

### 5. Chargeback with an admin-defined field name

In the deployed console ([admin-wbs.cjs](../../tests/playwright/admin-wbs.cjs), signed-in Edge):
field name `WBS ID` saved; person tagged `WBS-1001.01`; the saved tag suggested while typing `WBS-1`;
the chargeback tabs read Groups, Developers, **WBS ID**, …; the downloaded developers CSV has the
header column `WBS ID` and the row value `CC-ALPHA-100, CC-BETA-200, WBS-1001.01` (group chargeback
IDs for requests before the tag reached the entitlement, the tag after). In `delegated-snapshot` mode a
tag reaches requests when a snapshot is applied (Stage 7 rerun at 21:50; the next request's trace carried
`WBS-1001.01`).

### Open item for an owner decision

A request that Foundry refuses with `429` is counted in the ledger as a forwarded request with
unknown tokens, so the developer's chargeback row shows `unpriced usage` and a blank complete cost
while throttling occurs (82 such rows in this run). Budget enforcement is unaffected (the known spend is
a lower bound). Treating a backend `429` as no usage needs a cited statement that it is not billed;
Microsoft Learn's Foundry error page does not state it (checked 2026-10-24). Recorded in
[UNKNOWNS](../UNKNOWNS.md).
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
