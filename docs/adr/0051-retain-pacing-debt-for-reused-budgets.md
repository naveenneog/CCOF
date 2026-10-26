# ADR-0051: Retain pacing debt when a budget amount is reused

Status: Accepted (2026-10-27). Corrects decision 3 and assumption BB-G2 of
[ADR-0047](0047-budget-pacing-counter.md). Finding: DG-6.

## Evidence

Bug bash 5 DG-6 lowered a budget to USD 1, built pacing debt, raised it to USD 100,
then returned to USD 1 in the same month. The first request after the second lowering
received `Retry-After: 1813`, consistent with the earlier debt minus elapsed time.
The [resolver](../../src/resolver/decide.ts) keys pacing by `<period>_<budgetCcu>`;
it does not track an administrator-change generation.

## Decision

Keep that deterministic key. A previously unused amount in a month starts a counter;
returning to an earlier amount can reuse that counter's remaining debt. A new month uses
a new key. A changing spend-derived ceiling does not reset the counter. Update the
operator guide and refusal text to state this, rather than promise a reset on every edit.

A persisted change-generation counter was considered and rejected: it would let repeated
administrative toggles forget pacing debt and would require a new contract across the admin,
sync, reconciler, resolver and gateway. The budget is an allowance, not a reset command.
Recorded-spend admission and configured token quotas remain independent.

## Consequences

BB-G2's blanket fresh-counter assumption was false; the retained behavior is now intentional.
After a raise to a previously unused amount, allow the next cost run and gateway cache
refresh (a few minutes). A raise to a reused amount may still wait. Follow `Retry-After`,
or ask the budget owner to review an appropriate unused higher amount; changing a budget
must not be presented as a guaranteed debt reset.

Source: bug bash 5 developer-gateway report DG-6 and evidence `17-guard-run2.txt`
(2026-10-27); no new live experiment was performed for this decision.
