# Bug bash 5: client and gateway follow-up

This is a pseudonymised summary of the owner's 2026-10-27 developer-gateway report,
not a new live test. Private source artifacts: `developer-gateway.md`, DG-6/7;
`developer-gateway/17-guard-run2.txt`, `12-guard-after-raise.txt`, `15-guard-watch.txt`.

## DG-6: revisiting a budget amount

The report's USD 1 → 100 → 1 sequence reused the first USD 1 counter. At 20:30:38 UTC
the returned wait was 1,813 seconds. This matches the deterministic period/amount key;
[ADR-0051](../adr/0051-retain-pacing-debt-for-reused-budgets.md) retains it intentionally.

## DG-7: intermittent old decisions after raising a budget

The first run overlapped resolver/reconciler restarts from a deployment apply. Responses
briefly alternated between success and the old pacing wait before stabilising. This does
not isolate a cache bug from old cost-run state or in-flight work during restarts.

The second run had no overlapping restarts. After the raise, the first success came
112 seconds later, followed by 22 consecutive successes over five minutes. The cost run
wrote the raised budget before the gateway picked it up.

**Triage:** no reproducible independent code issue established. No speculative cache or
generation change. If it recurs without a deployment/restart, collect request IDs, cost-run
timestamps and resolver traces before changing the cache contract. This local fix packet
did not contact the lab.
