# ADR-0040: Budget guard: projected spend, rate guard and an early warning

Status: Accepted (2026-10-24).

## Context

The live test of 2026-10-24 ([report](../status/BUDGET-ACCEPTANCE-2026-10-23.md)) used up a USD 10 person budget
and ended at USD 11.25 recorded and USD 11.97 at list price. The reconciled spend trailed actual spend by about
USD 1.20 throughout (121–166 s). The lag is Log Analytics ingestion plus one reconciler run; the gateway's cached
decision (`allowTtlSeconds`, 120 s) adds up to two minutes before a new ceiling applies.

The monetary ceiling (ADR-0038) is `remaining budget / most expensive output price`, applied as tokens per
**minute**. Near the end of a budget it admitted the whole remaining budget every minute, so it never limited the
spend that the lag hides. The owner asked for throttling at 80% and a warning to the person, as 15% over budget is
too much.

A simulation of the measured run (demand USD 0.50 per minute, lag 2.5 min plus 2 min cache) gave:

| Rule | Final spend for USD 10 |
| --- | --- |
| Current ceiling | USD 12.75 (model; measured USD 11.97) |
| Throttle at 80% of **recorded** spend | USD 11.78 |
| Throttle at 80% of **projected** spend (recorded + recent rate x lag) | USD 9.58–9.98 |
| As above, a burst of USD 2 per minute | USD 14.60 |
| Projected spend and a rate guard of 5% of the budget per lag window | USD 9.88; the burst case USD 9.88; USD 100 and USD 1,000 budgets 1–2% under |

## Decision

Three optional reconciler settings, all or none (`RECONCILER_BUDGET_WARN_PERCENT`, `RECONCILER_OVERSHOOT_PERCENT`,
`RECONCILER_PROJECTION_MINUTES`). Absent: the earlier behaviour. When set, for each person and scope:

- **Projected spend** = recorded spend + (spend ingested in the last 5 minutes / 5) x projection minutes.
- **Warning** when projected spend reaches the warn percent of the budget (example: 80). The budget state carries
  `warning: true` and `projectedCcu`; `/usage` and the Claude Code status line show it.
- **Rate guard**, always: the ceiling is at most `budget x overshoot percent / projection minutes`, in tokens of the
  most expensive admitted output price. The spend the lag hides is then at most the overshoot percent (example: 5).
- **Throttle after the warning**: the ceiling is also at most `(budget - projected) / projection minutes`, so the
  allowance shrinks to zero as projected spend approaches the budget. A zero ceiling is refused as
  `budget_exhausted` (ADR-0038). `exhausted` keeps its meaning: recorded spend at or above the budget.

## Consequences

- The rate guard applies at every level of spend, not only after the warning, because hidden spend can only be
  bounded by bounding the rate. The person token limit counts prompt and output tokens, converted at the most
  expensive admitted model's output price, so the cap is lower in tokens when an expensive family (for example
  Opus) is admitted. It limits how fast a small budget can be spent: USD 10 with 5% over 5 minutes is USD 0.10
  per minute (10,000 tokens per minute at USD 10 per million); USD 1,000 is USD 10 per minute. The budget owner
  trades speed for precision with the overshoot percent; the staged example turns the guard on (80 / 5 / 5).
- The warning can clear again while recorded spend is below the warn percent: throttling lowers the recent rate
  and therefore the projection. From the warn percent of recorded spend it stays on.
- Requests already in flight when the ceiling drops still complete; they are not bounded by this rule.
- Streamed cache writes remain invisible to the ledger (ADR-0038), so recorded and projected spend stay a lower bound.
- The warning reaches a person through `/usage` and the status line; Claude Code does not display gateway headers.
- A request refused because projected spend reached the budget gets the same `budget_exhausted` message ("used
  up") although the recorded figure can still show a small remainder (USD 0.16 of 14 in the live check).

## Live check (2026-10-24)

Same lab and load as the first run (eight concurrent Sonnet 5.5 requests of 6,000 output tokens), Alpha's budget
raised to USD 14 with USD 11.25 already recorded (80.4%), guard 80 / 5 / 5:

| Measure | Without the guard (USD 10) | With the guard (USD 14) |
| --- | --- | --- |
| Warning | none | from the first run after the change: `/usage` and status line "about 80% used, slowed" |
| Spend rate near the end | USD 0.50 per minute | USD 0.15 per minute (429 with `Retry-After` up to 130 s) |
| First refusal | 21:24:25, USD 10.35 recorded | 06:54:14, USD 13.84 recorded |
| Final recorded spend | USD 11.25 (+12.5%) | USD 13.84 (-1.1%) |
| List-price spend | USD 11.97 (+19.7%) | USD 13.84 (-1.1%; no streamed requests in this run) |
