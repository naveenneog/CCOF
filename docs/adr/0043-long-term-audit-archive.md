# ADR-0043: Long-term audit archive of gateway requests

Status: Accepted (2026-10-25).

## Context

The usage ledger is the API Management resource log (GatewayLogs and GatewayLlmLogs, about 1 KB per request, token
counts only; prompt and completion logging is off in
[stage5-api-telemetry.bicep](../../infra/staged/stage5-api-telemetry.bicep)) in the Log Analytics workspace
([analytics/ledger.kql](../../analytics/ledger.kql)). The workspace keeps it for `stage1.retentionInDays` (30 days in
the example). The owner wants a long-term audit record of every gateway request.

Constraints:

- Stage 1 is create-only ([ADR-0042](0042-stage0-refusals-and-stage6-recovery.md)): a verified Stage 1 never
  redeploys, and `Assert-StgStage1Parameters` refuses any changed `stage1.*` value. Neither the workspace retention
  nor the `ccof-gateway-logs` diagnostic setting can change through Stage 1 on an existing install.
- Analytics retention beyond the included period costs USD 0.12/GB/month; Hot LRS blob storage about
  USD 0.02/GB/month (eastus2 retail).
- Research ([UNKNOWNS](../UNKNOWNS.md) AUD-A1 to AUD-A10): a resource can have five diagnostic settings; a storage
  destination must be in the gateway's region; Azure Monitor reaches a firewalled account only through the
  trusted-service exception, not when public network access is Disabled; the hourly `PT1H.json` blobs are append
  blobs, which lifecycle management cannot move to Cool or Archive; GatewayLlmLogs exports are billed (USD 0.25/GB
  eastus2), GatewayLogs exports are not.

## Options

1. Raise the workspace retention (up to 730 days) or the tables' total retention (up to 12 years, search jobs to
   read). No new resource; per-table settings outside the staged driver today.
2. A second diagnostic setting to a dedicated storage account (this ADR). Independent of the workspace, optional
   immutability, readable with any blob tool.
3. Copy query results to storage on a schedule (a Function). New code, a new identity and grants.

## Decision

Option 2, deployed by Stage 5 so an existing install gets it on a Stage 5 rerun, plus an optional workspace
retention change from option 1.

- Configuration `audit.archive { enabled, retentionDays, immutabilityDays, storageSku }`. An absent section, or
  `enabled: false`, deploys nothing and leaves the Stage 5 configuration hash unchanged. Validation is in
  [Staged.Audit.ps1](../../infra/staged/Staged.Audit.ps1). `coolAfterDays` and `archiveAfterDays` are refused:
  append blobs cannot be tiered (AUD-A5).
- Account name: the Stage 1 storage stem plus `aud` (the resolver's storage name with `res` replaced), 24
  characters at most. Region: the API Management service's region (AUD-A9). StorageV2, HTTPS only, TLS 1.2, no blob
  public access, Shared Key disabled (AUD-A3), public network access Enabled with default action Deny, bypass
  AzureServices and no IP or VNet rule (AUD-A2).
- Containers `insights-logs-gatewaylogs` and `insights-logs-gatewayllmlogs` are created by Stage 5. With
  `immutabilityDays`, each gets an unlocked time-based retention policy with protected append writes (AUD-A6).
  Stage 5 never writes a policy that the owner has locked.
- A lifecycle rule deletes append blobs older than `retentionDays` (null keeps them).
- Diagnostic setting `ccof-gateway-archive` on the gateway: GatewayLogs and GatewayLlmLogs to the account.
- `audit.workspaceRetentionDays` (30-730), when present, sets the workspace default retention through
  `az monitor log-analytics workspace update` (AUD-A8). `stage1.retentionInDays` keeps its Stage 1 value.
- Stage 5 read-back checks the account, the containers and policies, the lifecycle rule, the diagnostic setting
  and the workspace retention.

## Consequences

- The archive is a copy of the resource log, which Azure documents as not completely lossless (AUD-A4). The
  workspace remains the ledger for chargeback; the archive is the audit copy.
- Cost per GB of request log: USD 0.25 export (GatewayLlmLogs only) once, then about USD 0.02 per month in Hot LRS.
  No Cool or Archive tier.
- Readers need Storage Blob Data Reader and a network path (a private endpoint or a temporary IP rule, which the
  next Stage 5 run removes).
- Turning the feature off stops nothing that already exists: delete `ccof-gateway-archive` to stop exports. An
  unlocked immutability policy is not removed when `immutabilityDays` becomes null. A locked policy blocks account
  deletion until it expires.
- Lifecycle deletion does not act on blobs in a container with an immutability policy; with immutability on, expired
  blobs are deleted by an operator.
