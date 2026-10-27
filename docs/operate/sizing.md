# Size the first developer cohorts

There is no verified 25,000-developer capacity guarantee. Four zone-redundant APIM Standard v2 units are
an initial rollout choice, not a measured four-unit result. Start with small cohorts and measure the
customer's model mix, peak concurrency, prompt lengths and cache hit rate before opening the whole population.

## What was measured

A one-unit Standard v2 lab on 2026-10-25 measured:

| Path | Observation | Important limit |
| --- | --- | --- |
| Gateway with no-op policy | About 4,700 requests/second | Not representative of CCOF |
| Full CCOF policy | About 800 requests/second | Mostly Foundry quota-429 responses, not successful streaming at scale |
| Mock streamed responses | 4,000 open streams, no errors; gateway CPU at most 30% | 30-second streams, one event/second; real model streams can be more expensive |
| One public backend IP/port | About 1,000 open connections before backend-connect failures | Use the default private Foundry endpoint; do not extrapolate public-backend concurrency |

Planning assumptions of 1,000 requests/developer/day, 20% in the peak hour and 20-second streams suggest
roughly 6,000 typical developers/unit near 70% CPU. Heavy parallel usage was estimated around 1,200/unit.
These are extrapolations, not measured developer counts; four units do not establish safe headroom for 25,000.
Successful-stream throughput, realistic stream event rates and linear scale-out remain unproven.
The deployment-day rehearsal tests routing/accounting, not this load.

Watch **`CpuPercent_Gateway`** and `MemoryPercent_Gateway`; Standard v2's `Capacity` metric remained zero
even at saturation. Investigate sustained five-minute CPU above about 70%, latency and backend errors.
See [APIM capacity](https://learn.microsoft.com/azure/api-management/api-management-capacity) and
[scale-out](https://learn.microsoft.com/azure/api-management/upgrade-and-scale).

## Quota request worksheet — model owner, before deployment day

At those typical assumptions, 25,000 developers need about **1,389 requests/second**, or at least
**83,334 requests/minute across all models at peak**, before retry/failover headroom:
`25,000 × 1,000 × 20% / 60`.

For **each model/version and Global or Data Zone pool**:

1. Multiply peak RPM by that model's measured share; agree extra headroom with its owner.
2. Estimate TPM from that model's measured input/output-token distribution, context lengths and concurrency;
   include the provider's rate-limit token-estimation rules. Do not treat request count alone as token sizing.
3. Compare required RPM **and** TPM with available quota and deployed capacity. Use the
   [quota/model commands](../get-started/02-prerequisites.md#microsoft-foundry-models) and provider's
   [Claude quota units and scope](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/claude-models-quotas-limits).
   Do not assume one capacity unit has the same RPM/TPM for every model or deployment type.
4. Request the shortfall in advance, record approval and allocate actual deployment capacity. Accounts in
   one subscription share the model's quota pool across regions; a standby in a separate subscription needs
   its own approved quota. Plan for that standby to carry the required load after primary failure.

An illustrative prerequisite quota line of 80 is not evidence that an enterprise peak is provisioned.
Also measure Cosmos RU/s/throttles, sync time, reconciler lag, budget overshoot and telemetry cost.
Group headcount, per-person budgets and aggregate caps are separate controls, not provider capacity.

## Enrollment and reconciliation limits

Device deployment is not group admission. The small delegated snapshot-through-app-settings helper is **not**
a 25,000-member transport: Windows is capped at 7,000 base64 characters; other platforms' helper limit is
96 KiB ([sync transports](../SYNC.md)). Approve automatic Graph sync/consent and its warm-up, or an alternative
large-snapshot runner. Do not truncate a group to fit. A fresh managed identity exists only after Stage 1;
allow up to 24 hours after new Graph grants instead of promising a full-population 2–3 hour fresh start.

The template's `reconciler.maxStates: 10000` is below 25,000 developers' budget scopes. With two groups and
everyone in both, plan for at least **50,002** person/group states. The day example raises the guard to
**100,000**, and `ledgerMaxRows` to **500,000** for model/member-row headroom. These are row/count guards,
**not** measured processing capacity: benchmark memory, query duration, Cosmos RU/s and fresh-budget latency
before broad admission. The smaller example Cosmos maximum still needs workload sizing.
The [runtime](../../src/reconciler/run.ts) refuses `state_limit_exceeded` before writes;
[settings](../../src/reconciler/settings.ts) bounds ledger rows at 500,000 and states at 10,000,000.
More than two groups or models needs a new scope/row estimate.
Review the per-person/group TPM and token quotas too: the example's **2,000,000-token daily group quota** is
a pilot guard (only 80 tokens per person if 25,000 people share it), not a full-population allowance.
Approve those limits with the group owner before expanding; a larger row guard does not raise token/model quotas.

Next: [deployment-day checklist](../get-started/deployment-day.md) ·
[HA costs and limits](../get-started/high-availability.md).
