# Add Foundry account failover

Use a second Foundry account when requests must continue after the primary account or its endpoint
fails. This does not protect the gateway, Function Apps or their region. See
[regions and failover](region-and-failover.md) for the rest of the system.

## 1. Choose the account

Choose another region that offers the **same Claude model, version and deployment type**.
Check the current offer with `az cognitiveservices model list -l <region>`. For example,
`centralus` and `swedencentral` offer Global Standard Claude models; offers and capacity change.
Global Standard can process prompts globally; US Data Zone Standard stays in its data zone.
Get approval before changing where data can be processed
([Claude models](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/claude-models),
[deployment types](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/deployment-types)).

- **The same subscription:** accounts and regions share Claude model/version quota, in the Global
  pool or each Data Zone pool. Another account protects an endpoint outage, **not quota 429**.
- **Another subscription, same tenant:** quota is separate. Its owner must approve Claude access,
  the gateway identity's account-scoped role, and any private endpoint connection.
- Cross-tenant failover is not supported. Do not copy a key or add a secret to this configuration.

Source: [Claude quota scope](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/claude-models-quotas-limits)
(checked 2026-10-27).

## 2. Add the configuration

Back up the configuration and its `.staged-state\state.json` first. Keep the existing backend's ID,
URL and group assignments. Add `backends[].failover` to that entry:

```json
{
  "id": "foundry-main",
  "subscriptionId": "00000000-0000-4000-8000-000000000002",
  "resourceGroup": "ccof-lab-rg",
  "accountName": "contoso-primary",
  "url": "https://contoso-primary.services.ai.azure.com/anthropic",
  "resource": "https://cognitiveservices.azure.com",
  "privateEndpoint": true,
  "deploymentInferenceGeo": { "claude-haiku-5-5": "global" },
  "failover": {
    "subscriptionId": "00000000-0000-4000-8000-000000000003",
    "resourceGroup": "ai-standby-rg",
    "accountName": "contoso-standby",
    "url": "https://contoso-standby.services.ai.azure.com/anthropic",
    "privateEndpoint": true,
    "deploymentInferenceGeo": { "claude-haiku-5-5": "global" }
  },
  "circuitBreaker": {
    "count": 1,
    "intervalSeconds": 60,
    "tripDurationSeconds": 60,
    "acceptRetryAfter": true,
    "statusCodeRanges": [{ "min": 429, "max": 429 }, { "min": 500, "max": 599 }]
  }
}
```

Replace the example IDs/names. Copy **every** primary deployment name and inference geography to
the standby; deploy the same models/versions/SKUs there. Capacity may differ. `global` means
GlobalStandard; `us` means DataZoneStandard. Stage 0 refuses a mismatch and tells you to create
matching deployments. Leave `circuitBreaker` out to use the values above. Counts and durations
are whole numbers 1–86400; custom status ranges must lie within 400–599. A breaker without a
failover account can protect a single backend, but answers 503 while tripped.

**Already deployed:** create the second account outside CCOF (Portal > Microsoft Foundry > create
account and model deployments), then add the descriptor above. Use keyless authentication.
Do **not** change `stage1`: Stage 1 is create-only and refuses changed settings.

**New installation:** Stage 1 can also create the standby. Add `stage1.foundry.failover` with
`create: true`, `accountName`, `location`, `publicNetworkAccess`, `deployments` and
`modelProviderData`, just like the primary's
[Foundry settings](configuration-resources.md#foundry-and-backends).
The created standby must be in the deployment subscription/resource group and match a
`backends[].failover` descriptor. Supply your real organisation attestation; do not copy an
example organisation. Private accounts require `failover.privateEndpoint: true`.

## 3. Check and apply

For an existing deployment, run Stage 0, then preview and apply **3, 5, 6**, in that order:

```powershell
$config = '.env.staged\staged.config.json'
pwsh -File infra\staged\Invoke-StagedDeployment.ps1 -Stage 0 -ConfigPath $config
foreach ($stage in 3, 5, 6) {
  pwsh -File infra\staged\Invoke-StagedDeployment.ps1 -Stage $stage -ConfigPath $config
  # Read the preview before running this line:
  pwsh -File infra\staged\Invoke-StagedDeployment.ps1 -Stage $stage -ConfigPath $config -Apply
}
pwsh -File infra\staged\Invoke-StagedDeployment.ps1 -Stage 8 -ConfigPath $config -Apply
```

Stage 0 is an ARM readability/deployment check, not a data-plane reachability guarantee.
It prints, for a standby in the same subscription:

```text
Foundry HA: foundry-main -> contoso-standby in centralus; shares the same subscription/model quota pool across regions; protects endpoint outages, not quota 429
suggestion: preview/apply Stages 3, 5 and 6; run Stage 8 and inspect ApiManagementGatewayLogs.BackendUrl during a failover drill
```

Stage 3 grants the gateway's managed identity **Cognitive Services User** on both accounts.
Stage 5 makes `foundry-main` a priority pool, containing `foundry-main-primary` (priority 1) and
`foundry-main-failover` (priority 2), and reads back their URLs, priorities and breakers.
The existing gateway policy selects the pool by its original ID, so budgets, ledger and chargeback
remain attributed to the same group/backend.

Stage 6 adds the standby private endpoint and its three Foundry DNS zones. The endpoint stays
in the gateway VNet's region even when its account is elsewhere. Existing/create network modes
need endpoint/subnet and DNS write permission; the target account's owner may need to approve
the connection. A pending connection stops verification with a next step. In `verify` mode the
network owner creates the path; Stage 6 only checks it. An existing API Management instance must
already route to and resolve **both** accounts; CCOF never changes its network.

In an existing-network preview, Stage 6 takes endpoint/DNS IDs from configuration. On a first
create-mode preview it prints `preview: Foundry failover endpoints deferred until verified Stage 6
network outputs exist`; apply provisions the network before its standby endpoints.
Later additions or replacements use the recorded base-network fingerprint and do not redeploy the
VNet. Older failover state without that fingerprint needs one Stage 6 apply with its **last verified
configuration** before you change standby descriptors; the refusal names this recovery step.

No Stage 4 or shared registration changes are needed. Stage 7 is needed only if you also change
code or seed data. Keep the state folder: later stages may ask you to rerun an earlier stage if
its verified outputs changed; follow the named stage, not a manual edit to the state.

## 4. Prove a failover

Use an approved lab and a small spending limit, not a production outage. Save the primary's
deployment capacity. Send a short request and note its UTC time/request ID. Temporarily lower
the primary deployment's capacity, then send a bounded burst until a **backend** 429 occurs.
A gateway budget/token-limit 429 is not proof: it never reaches the account. Stop at your
spending limit; do not assume lowering capacity guarantees an account-local limit.

Check the gateway's Log Analytics workspace:

```kusto
ApiManagementGatewayLogs
| where TimeGenerated > ago(30m)
| where OperationId == "create-message"
| project TimeGenerated, CorrelationId, ResponseCode, BackendResponseCode, BackendUrl
| order by TimeGenerated asc
```

Look for the primary URL with BackendResponseCode 429, then successful requests using the standby
URL. Restore the primary capacity immediately. After `tripDurationSeconds` (or the longer
backend Retry-After), send a short request again and confirm the primary URL and success.
Save all four steps: normal primary, primary 429, standby success, recovered primary.
Gateway logs identify the actual account; usage traces retain the logical backend ID for billing.

## Limits and cost

- The **tripping 429 still reaches the client once**. Requests are not replayed; retrying a streamed
  or already billed request can duplicate work.
- Breakers are **approximate per gateway instance**; requests may still hit the primary while
  other instances learn of the failure. A standby is selected only when higher-priority
  breakers are tripped. Both accounts tripped means 503.
- `acceptRetryAfter: true` can extend the outage wait beyond the configured trip duration.
- A second account does not double quota in the same subscription, nor move the gateway to
  another region. It does not repair shared DNS, network, identity or budget failures.
- Standard inference is usage billed; a second account alone is not a second APIM unit.
  Additional private endpoints are hourly billed, plus private-link traffic/DNS and model usage.
  One extra endpoint is USD 0.01/hour (about 0.24/day or 7.30/month), before traffic and DNS:
  [Retail Prices API](https://prices.azure.com/api/retail/prices), product `Virtual Network Private Link`,
  meter `Standard Private Endpoint`, region `Global`, checked 2026-10-27. This is a list price, not
  your bill; check your agreement and [pricing calculator](https://azure.microsoft.com/pricing/calculator/).

Sources: [APIM circuit breakers and pools](https://learn.microsoft.com/azure/api-management/backends),
[Private Link properties](https://learn.microsoft.com/azure/private-link/private-endpoint-overview#private-endpoint-properties).
