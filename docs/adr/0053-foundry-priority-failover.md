# ADR-0053: Opt-in Foundry priority pools

Status: Accepted (2026-10-27), packet G-HA-FOUNDRY.

## Context and options

A group names one logical backend. Changing its ID on outage would fragment budget admission,
ledger attribution and chargeback. Retrying a streamed or chargeable request can duplicate work.
Manual reassignment is slow; policy-level retries are therefore rejected in favour of APIM's
native circuit breakers and priority pools.

## Decision

- `backends[].failover` is a second account descriptor (subscriptionId, resourceGroup, accountName,
  url, privateEndpoint, deploymentInferenceGeo). No recursive pools or cross-tenant credentials.
  The gateway identity must exist in the account's tenant; another subscription in that tenant is supported.
- The existing backend ID becomes the pool; `<id>-primary` and `<id>-failover` are its members,
  priorities 1 and 2. Groups, resolver descriptors, rate cards and accounting retain the logical ID.
  Existing `set-backend-service backend-id` expressions already select this pool.
- Each member has one breaker: default one 429 or 500-599 in 60 seconds trips for 60 seconds,
  accepting Retry-After. Optional `circuitBreaker` sets count, intervalSeconds,
  tripDurationSeconds, acceptRetryAfter and statusCodeRanges. No automatic replay.
- Stage 0 reads existing account deployments, requiring matching names and inference geography.
  It warns that Claude quota is shared across regions/accounts in a subscription.
- New installations may create a standby with `stage1.foundry.failover`, using the existing
  Foundry account module. This is create-only. Existing installations create it outside Stage 1,
  then rerun Stages 0, 3, 5, 6 and 8. Stage 3 grants account-scoped Cognitive Services User.
- Stage 6 adds standalone failover private endpoints and DNS groups, including accounts in
  another region/subscription. It never redeploys an existing create-mode VNet to add an endpoint.
- A network what-if returns no outputs. Existing-network standby previews derive subnet, VNet
  and DNS IDs from configuration; first-create previews defer the standby what-if until verified
  network outputs exist. Null DNS entries are discarded before fallback.
- Stage 6 records `verify.foundryFailoverBaseNetworkHash`, the Stage 6 input hash with all backend
  failover descriptors removed. Later additions/replacements compare that fingerprint, not the
  earlier full descriptor-bound hash. Real base-network changes still refuse. Verification-only
  metadata does not change published-app dependencies. Legacy non-failover records can bootstrap
  from their full hash; older failover records require applying their last verified configuration
  once to record the fingerprint before changing standbys.
- Legacy configurations do not acquire defaults or extra hash inputs. Failover changes invalidate
  Stages 3/5/6. Existing API Management ownership/conflict checks cover generated member names.
- Gateway logs' BackendUrl identify the serving account; usage traces retain the logical backend
  for existing accounting readers. No new public response header exposes account names.

## Consequences

The tripping request still reaches the client. Breaker state is approximate per gateway instance;
recovery happens after the trip interval, which Retry-After can extend. Both members tripped means
503. Pools protect endpoint/account outages, not a shared subscription quota or the gateway region.
Operators must approve any changed inference geography and deploy the same models/versions/SKUs.

Sources (checked 2026-10-27): [APIM backends](https://learn.microsoft.com/azure/api-management/backends),
[ARM backend schema](https://learn.microsoft.com/azure/templates/microsoft.apimanagement/2024-05-01/service/backends),
[Claude quota scope](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/claude-models-quotas-limits),
[Private Link](https://learn.microsoft.com/azure/private-link/private-endpoint-overview).
