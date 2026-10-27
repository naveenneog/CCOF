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

Next: [deployment-day checklist](../get-started/deployment-day.md) ·
[HA costs and limits](../get-started/high-availability.md).
