# ADR-0047: A separate budget-pacing counter, keyed by budget and month

Status: Accepted (2026-10-26). Supersedes the "lower of the two" rule of [ADR-0038](0038-budget-admission-acceptance.md)
for the person token limit. Findings: bug bash DEV-3, DEV-6, DEV-7.

## Context

The resolver returns a monetary ceiling, `personCeilingTokensPerMinute` (ADR-0038), which the budget guard lowers to
pace spending (ADR-0040). The gateway applied the lower of that ceiling and the configured person tokens per minute
on one counter, `p:<project>:<oid>`, which also holds the person's configured token quota.

In the bug bash a group budget was lowered to USD 0.01. The ceiling fell to a few tokens per minute, and one
8,100-token request left the counter in debt. After the budget was raised to USD 100, the same counter kept answering
`429` with `Retry-After` near 25,600 s for hours, with the message "You have reached your tokens-per-minute limit",
although the configured limit (200,000) was never reached ([UNKNOWNS BB-G1](../UNKNOWNS.md)). A zero ceiling from
projected spend was refused as "used up … wait for the next period" although it clears within minutes (DEV-6).

## Options

1. **Keep one counter, put the ceiling value in its key.** Every ceiling change opens a fresh counter. The guard
   changes the ceiling at most every reconciler run while spend rises, so each change would forget the debt and admit
   another request: pacing would no longer bound spend.
2. **Keep one counter, key by budget and month.** A budget change would also reset the configured monthly token
   quota on that counter.
3. **A separate pacing counter keyed by budget and month (chosen).** The configured limits keep their counter and
   meaning; only the pacing counter restarts, and only when the budget or the month changes.

## Decision

1. The resolver adds `personCeilingKey` to a `budget-state` decision: `<period>_<budgetCcu>` from the person's budget
   state, for example `2026-10_10000`. It is omitted when the state has no valid period or budget.
2. The gateway applies the configured person limits on `p:<project>:<oid>`, unchanged, and the monetary ceiling on its
   own counter, `pb:<project>:<oid>:<personCeilingKey>` (`-` when absent), policy id `ccof-limit-budget-person`.
3. A new month, or an amount not yet used that month, gives a new key. Returning to an earlier amount can reuse
   its remaining debt; changing spend keeps the key. This correction to assumption BB-G2 is intentional:
   [ADR-0051](0051-retain-pacing-debt-for-reused-budgets.md).
4. A pacing refusal is `429 rate_limit_error` that says it is the budget guard, not the configured tokens-per-minute
   limit, and that raising to a previously unused amount lifts it. `Retry-After` is the counter's own value, at most the time until the
   key changes at the end of the month plus the allow cache time.
5. A zero ceiling while recorded spend is under the budget (projected spend or a sub-token remainder) is a new
   gateway refusal, `budget_projected`: `403 permission_error` saying the budget is reached by recent spending and
   that it clears when recorded spend catches up, the budget is raised, or the month ends.

## Consequences

- The `x-ccof-person-tokens-remaining` header shows the configured person limit only; the pacing counter has no
  header. `x-ccof-tokens-consumed` comes from the pacing counter when no configured person limit applies.
- A raise to a previously unused amount lifts pacing after the next reconciler run and the gateway's allow cache
  (`allowTtlSeconds`), within a few minutes; a reused amount can resume its earlier wait.
- One large request at a very small budget can still block for hours: the pacing rate converts at the most
  expensive admitted output price (ADR-0040). The message and `/usage` now say so plainly.
- Old cached decisions without `personCeilingKey` stay valid and use the `-` key until refreshed.

## References

- [llm-token-limit policy](https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy), Microsoft
  Learn, retrieved 2026-10-26.
- [Gateway policy](../../infra/gateway/policy/claude-messages.template.xml), [resolver decision](../../src/resolver/decide.ts).
