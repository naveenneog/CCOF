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
  trusted-service exception (research said not when public network access is Disabled; the live test showed it does,
  see Consequences); the hourly `PT1H.json` blobs are append
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
  `enabled: false`, deploys nothing. An absent section, or `{ "enabled": false }` with no other key, leaves the Stage 5
  configuration hash unchanged; any other present value, including `enabled: false` beside other keys, is part of
  the hash (`Test-StgOffOnly`, `Get-StgAuditStageInput`). Validation is in
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
  `az monitor log-analytics workspace update` (AUD-A8). `stage1.retentionInDays` keeps its Stage 1 value. What the
  workspace keeps is `audit.workspaceRetentionDays` when set, otherwise `stage1.retentionInDays`
  (`Get-StgLogRetentionDays`); chargeback history (ADR-0044) uses that one value. Removing the key does not restore
  the Stage 1 value in Azure: set it to `stage1.retentionInDays` instead.
- Stage 5 read-back checks the account, the containers and policies, the lifecycle rule, the diagnostic setting
  and the workspace retention.

## Consequences

- The archive is a copy of the resource log, which Azure documents as not completely lossless (AUD-A4). The
  workspace remains the ledger for chargeback; the archive is the audit copy.
- Cost per GB of request log: USD 0.25 export (GatewayLlmLogs only) once, then about USD 0.02 per month in Hot LRS.
  No Cool or Archive tier.
- Readers need Storage Blob Data Reader and a network path (a private endpoint or a temporary IP rule, which the
  next Stage 5 run removes).
- Live result (2026-10-26, AUD-A2 and AUD-A3 resolved): Azure Monitor writes with Shared Key disabled, and also
  after a storage policy (`modify` effect) set public network access to Disabled, through the trusted-services
  bypass (storage metrics: `AppendBlock`/`PutBlob` successes with `OAuth`). Stage 5 keeps deploying Enabled, since
  many tenants have no such policy, and its read-back accepts Enabled or Disabled with default Deny, the
  AzureServices bypass and no rule (`Get-StgAuditArchiveNetworkMode`), printing which. With Disabled, a temporary IP
  rule does not open a path; reading needs a private endpoint. Delivery is checked from the account's Transactions
  metrics, which Stage 5 does not wait for (exports can take about 90 minutes).
- Turning the feature off stops nothing that already exists: delete `ccof-gateway-archive` to stop exports. An
  unlocked immutability policy is not removed when `immutabilityDays` becomes null. A locked policy blocks account
  deletion until it expires.
- Lifecycle deletion does not act on blobs in a container with an immutability policy; with immutability on, expired
  blobs are deleted by an operator.

## Raising the workspace retention

(Council round 2, 2026-10-26.) Raising the retention keeps rows longer from then on; rows already deleted do not
come back ([data retention](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure)).
For `now - retention` days after a raise from P to R days at time T, the workspace holds rows only from T - P. Stage 5
therefore records, before it deploys or changes anything, the instant the workspace holds rows from
(`Get-StgRetentionHeldFrom`: the later of T - P and an instant recorded at an earlier raise) in
`evidence/stage5.retention.json` in the state folder, and passes it to the places below. When that file is absent (the
state folder was lost, council round 3), Stage 5 takes the earlier instant from the deployment instead: the later of
the admin app's `ADMIN_LOG_RETENTION_HELD_FROM` and the instant in the deployed workbook's retention cut
(`Get-StgPreviousRetentionHeldFrom`), so a rerun does not drop it. The instant then goes to:

- the workbook (`retentionHeldFrom`) and the admin app (`ADMIN_LOG_RETENTION_HELD_FROM`, with chargeback history on or off):
  `RetentionTruncated` is true for a period that starts before the later of `now - retention` and that instant
  ([queries.ts](../../analytics/workbooks/queries.ts));
- the history export (ADR-0044): its boundary is the first whole month after that later instant
  ([admin/src/history.ts](../../admin/src/history.ts) `historyBoundary`).

Lowering the retention records nothing (the workspace holds `now - retention`), and an unchanged retention keeps
the recorded instant until `now - retention` passes it. The instant is not a stage output, so later stages are not
asked to rerun. Limits: a retention changed outside Stage 5 (Portal, CLI) is not recorded. Every Stage 5 run writes
`ADMIN_LOG_RETENTION_DAYS` (the effective retention, `Get-StgLogRetentionDays`) and, when recorded,
`ADMIN_LOG_RETENTION_HELD_FROM` to the admin app whether chargeback history is on or off (`logRetention` in
[stage5-config.bicep](../../infra/staged/stage5-config.bicep)), so the console's chargeback flag matches the workbook.
The workbook now uses the effective retention instead of `stage1.retentionInDays`.

Turning the archive on in a running deployment needs Stage 5 only: no new code runs, and Stage 5's recorded
outputs do not change, so Stages 7 and 8 are not asked to rerun (`Get-StgOutputHash` excludes the verify record;
[Test-AuditArchive.ps1](../../tests/Test-AuditArchive.ps1)).

## Integration with ADR-0044 (2026-10-25)

The archive's Stage 5 hash input (`Get-StgAuditStageInput`) covers only `audit.archive` and `audit.workspaceRetentionDays`. `audit.chargebackHistory` is part of the Stage 2, 3 and 5 inputs by ADR-0044, so configuring it does change the Stage 5 hash; a configuration without any `audit` key, or with only `{ "enabled": false }` sections, keeps its earlier hashes ([Test-AuditArchive.ps1](../../tests/Test-AuditArchive.ps1)).
