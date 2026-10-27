# Configuration reference: resolver, sync, reconciler, gateway, reports, audit

Part of the [configuration reference](configuration.md). Every key of these sections in
[staged.config.example.json](../../infra/staged/staged.config.example.json), with the columns of the
[first reference page](configuration-reference.md). Keys passed as a whole object to Stage 5
([stage5-config.bicep](../../infra/staged/stage5-config.bicep)) reach the apps as settings; the readers are named per section.

## Resolver

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `resolver.budgetEnforcement` | No | `token-limits-only` | `token-limits-only` (no dollar budget) or `budget-state` ([budgets](../operate/budgets-and-guard.md)) | [resolver config](../../src/resolver/config.ts) |
| `resolver.requireCompleteUsage` | No | `false` | JSON boolean; `true` needs `budget-state` | `Read-StgConfig` |
| `resolver.cosmosRequestTimeoutMs` | No | `2000` | Milliseconds | resolver config |
| `resolver.cosmosRetryAttempts` | No | `2` | Retries | resolver config |
| `resolver.cosmosRetryMaxWaitSeconds` | No | `2` | Seconds | resolver config |
| `resolver.requestDeadlineMs` | No | `4000` | Milliseconds | resolver config |
| `resolver.usageGroupTotals` | No | `false` | Whether `/usage` shows the group total | resolver config |

## Sync, reconciler and budget state

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `sync.mode` | No | `delegated-snapshot` | `delegated-snapshot` or `application-permission` (needs `GroupMember.Read.All`, [guide 6.1](../STAGED-DEPLOYMENT-GUIDE.md#61-graph-grants-group-search-names-and-sync)) | `stage3-grants.bicep` |
| `sync.schedule` | No | `0 */1 * * * *` | Six-field timer expression | [sync config](../../src/sync/config.ts) |
| `sync.leaseSeconds` | No | `300` | Seconds | sync config |
| `sync.maxRemovalsPerRun` | No | `5` | Whole number | sync config |
| `sync.maxRemovalFraction` | No | `0.1` | Fraction as a string | sync config |
| `sync.memberTypes` | No | `user` | `user`, `servicePrincipal` (comma-separated) | sync config |
| `sync.graphMaxRetries` | No | `3` | Retries | sync config |
| `sync.graphMaxRetryAfterSeconds` | No | `30` | Seconds | sync config |
| `sync.graphTimeoutSeconds` | No | `30` | Seconds | sync config |
| `sync.writeMode` | No | `apply` | `apply` or `dry-run` | sync config |
| `syncTimerEnabled` | No | `false` | `true` runs the sync on its timer; needs `application-permission` | `stage5-config.bicep` |
| `reconciler.timerEnabled` | No | `false` | `true` prices usage on the schedule; dollar budgets need it | `stage5-config.bicep` |
| `reconciler.schedule` | No | `0 */2 * * * *` | Six-field timer expression | [reconciler settings](../../src/reconciler/settings.ts) |
| `reconciler.validitySeconds` | No | `600` | Seconds | reconciler settings |
| `reconciler.leaseSeconds` | No | `300` | Seconds | reconciler settings |
| `reconciler.ledgerTimeoutSeconds` | No | `60` | Seconds | reconciler settings |
| `reconciler.ledgerMaxRows` | No | `100000` | Rows per run | reconciler settings |
| `reconciler.maxStates` | No | `10000` | States per run | reconciler settings |
| `reconciler.writeConcurrency` | No | `8` | Parallel writes | reconciler settings |
| `reconciler.logAnalyticsEndpoint` | No | `https://api.loganalytics.io` | Log Analytics query endpoint | reconciler settings |
| `reconciler.budgetGuard.warnPercent` | No | `80` | Whole number 1-99 | `Read-StgConfig` |
| `reconciler.budgetGuard.overshootPercent` | No | `5` | Whole number 1-50 | `Read-StgConfig` |
| `reconciler.budgetGuard.projectionMinutes` | No | `5` | Whole number 1-60 | `Read-StgConfig` |
| `budgetState.graceSeconds` | No | `900` | Seconds | `stage5-config.bicep` |
| `budgetState.hardLimitSeconds` | No | `3600` | Seconds | `stage5-config.bicep` |

## Gateway

Read by [infra/gateway/config.ts](../../infra/gateway/config.ts) (schema: `gateway-config.schema.json`) unless noted.

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `gateway.configurationId` | No | `ccof-staged-gateway-1` | Identifier of the gateway configuration | gateway config |
| `gateway.surfaceClients` | No | `[]` | List of `{ clientAppId, surface }` | `Staged.Application.ps1` |
| `gateway.admission.perPerson.calls` | No | `120` | Calls per renewal period per person | gateway config |
| `gateway.admission.perPerson.renewalPeriodSeconds` | No | `60` | Seconds | gateway config |
| `gateway.admission.resolverMisses.calls` | No | `200` | Calls | gateway config |
| `gateway.admission.resolverMisses.renewalPeriodSeconds` | No | `1` | Seconds | gateway config |
| `gateway.admission.resolverMisses.maxConcurrent` | No | `100` | Concurrent calls | gateway config |
| `gateway.admission.usage.calls` | No | `10` | Calls | gateway config |
| `gateway.admission.usage.renewalPeriodSeconds` | No | `60` | Seconds | gateway config |
| `gateway.resolverTimeoutSeconds` | No | `10` | Seconds | gateway config |
| `gateway.projectHeaderName` | No | `x-ccof-project` | Request header that carries the selector | `Staged.Application.ps1`, gateway config |
| `gateway.keyVersion` | No | `1` | Whole number | gateway config |
| `gateway.entitlementCache.cachingType` | No | `internal` | `internal`, `external` or `prefer-external` | gateway config |
| `gateway.entitlementCache.allowTtlSeconds` | No | `120` | Seconds | gateway config |
| `gateway.entitlementCache.refusalTtlSeconds` | No | `30` | Seconds | gateway config |
| `gateway.entitlementCache.lastKnownGoodGraceSeconds` | No | `3600` | Seconds | gateway config |
| `gateway.entitlementCache.refreshBackoffSeconds` | No | `30` | Seconds | gateway config |
| `gateway.entitlementCache.unavailableRetryAfterSeconds` | No | `5` | Seconds | gateway config |
| `gateway.tokenLimits.estimatePromptTokens` | No | `false` | `true` or `false` | gateway config |
| `gateway.tokenLimits.headers.personRemainingQuota` | No | `x-ccof-person-quota-remaining` | Response header name | gateway config |
| `gateway.tokenLimits.headers.personRemainingTokens` | No | `x-ccof-person-tokens-remaining` | Response header name | gateway config |
| `gateway.tokenLimits.headers.groupRemainingQuota` | No | `x-ccof-group-quota-remaining` | Response header name | gateway config |
| `gateway.tokenLimits.headers.groupRemainingTokens` | No | `x-ccof-group-tokens-remaining` | Response header name | gateway config |
| `gateway.tokenLimits.headers.tokensConsumed` | No | `x-ccof-tokens-consumed` | Response header name | gateway config |
| `gateway.defaultAnthropicVersion` | No | `2023-06-01` | `anthropic-version` sent when the client sends none | gateway config |
| `rateCard.path` | No | `config/rate-card.json` | Price list, relative to the repository | `Staged.Common.ps1` |
| `rateCard.contractSchedulePath` | No | `config/contract-schedule.json` | Contract schedule file | `Staged.Common.ps1` |

## Reports, admin and acceptance

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `workbook.resourceName` | Yes | `REPLACE-new-workbook-guid` | A new GUID per deployment: `[guid]::NewGuid()` | `stage5-config.bicep` |
| `workbook.displayName` | No | `Claude gateway chargeback (staged)` | Portal name | `stage5-config.bicep` |
| `workbook.readerPrincipalIds` | No | `[]` | Object IDs that read the workbook | `stage5-config.bicep` |
| `workbook.settings.defaultProjectId` | No | `*` | Default scope filter | workbook |
| `workbook.settings.maxRows` | No | `1000` | Rows per query | workbook |
| `workbook.settings.topUsers` | No | `25` | Users listed | workbook |
| `workbook.settings.maxQueryDays` | No | `62` | Days | workbook |
| `workbook.settings.budgetLookbackDays` | No | `31` | Days | workbook |
| `admin.v3Enabled` | No | `true` | `false` turns the v3 console off | `Staged.Application.ps1` |
| `admin.extraAllowedClientIds` | No | `[]` | Client app GUIDs allowed to call the admin API; preauthorized in Stage 4 | `Staged.Application.ps1` |
| `admin.groupSearchEnabled` | No | `false` | Needs the admin Graph grants ([guide 6.1](../STAGED-DEPLOYMENT-GUIDE.md#61-graph-grants-group-search-names-and-sync)) | `Staged.Application.ps1` |
| `admin.userNamesEnabled` | No | `false` | Needs `User.Read.All` on the admin identity | `Staged.Application.ps1` |
| `acceptance` | Yes | see below | Stage 8 requests | `Staged.Application.ps1` |
| `acceptance.selectorNote` | No | text | Comment; not read | none |
| `acceptance.allowed[].model` | Yes | `claude-haiku-4-5` | Deployment name that must answer `200` | Stage 8 |
| `acceptance.denied[].model` | Yes | `claude-opus-5-5` | Model that must be refused | Stage 8 |
| `acceptance.denied[].expectedStatus` | Yes | `403` | HTTP status expected | Stage 8 |
| `acceptance.denied[].reason` | No | text | Comment | none |
| `acceptance.expectedGroup` | If several groups | absent | Configured `groupDisplayName`, or expected group Object ID (also console-added groups). Asserts no-selector attribution; does not choose routing | [guide 3.3](../STAGED-DEPLOYMENT-GUIDE.md#33-configuration-file) |


## Audit

Two optional features under `audit`. The template turns on the audit archive and shows chargeback history switched
off (`enabled: false`), because history needs the reconciler timer, which the template also leaves off. Each can be
turned on alone:

- **Audit archive** (`audit.archive`, `audit.workspaceRetentionDays`): a long-term copy of every gateway request log
  in a storage account ([operate: audit archive](../operate/audit-archive.md), [ADR-0043](../adr/0043-long-term-audit-archive.md)).
- **Chargeback history** (`audit.chargebackHistory`): daily chargeback totals in Cosmos DB beyond the Log Analytics
  retention ([operate: chargeback history](../operate/chargeback-history.md), [ADR-0044](../adr/0044-chargeback-history-in-cosmos.md)).

An absent `audit` section deploys nothing and leaves every stage's record of its inputs unchanged. So does
`audit.archive` or `audit.chargebackHistory` given as `{ "enabled": false }` with no other key: it is recorded as if
the section were absent ([Staged.Audit.ps1](../../infra/staged/Staged.Audit.ps1) `Test-StgOffOnly`). Any other
present value is part of the record, including `enabled: false` beside other keys, as in the template's
`audit.chargebackHistory` block: adding it to an existing deployment makes Stages 2, 3 and 5 ask to be previewed and
applied again (`stage_config_changed`), which is harmless and creates nothing.
Changing an archive key makes Stage 5 ask to be previewed and applied again (`stage_config_changed`); changing a
history key does the same for Stages 2, 3 and 5. Stage 1 is not affected.

**Effective Log Analytics retention** is `audit.workspaceRetentionDays` if set, else `stage1.retentionInDays`. The
history export uses it to decide which months come from history (`ADMIN_LOG_RETENTION_DAYS`), and `ttlDays` must be
more than it. Raising it does not bring back rows the workspace already deleted. When Stage 5 raises
`audit.workspaceRetentionDays`, it records the oldest instant the workspace then holds (now minus the old retention)
in `ADMIN_LOG_RETENTION_HELD_FROM` and in the workbook; reports flag periods before that instant as
`retention_truncated`, and the history export reads them from history, until now minus the new retention passes that
instant ([ADR-0043](../adr/0043-long-term-audit-archive.md#raising-the-workspace-retention)). Lowering it records
nothing. The workbook also uses the effective retention.

### Audit archive

Read by [Staged.Audit.ps1](../../infra/staged/Staged.Audit.ps1) and deployed by Stage 5.
Other keys inside `audit.archive` are refused.

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `audit.archive` | No | see below | Absent or `null`: no archive | `Staged.Audit.ps1` |
| `audit.archive.enabled` | Yes, inside `audit.archive` | `true` | JSON boolean; `true` creates the archive account and the diagnostic setting `ccof-gateway-archive`; `false` creates nothing and removes nothing | `Staged.Audit.ps1` |
| `audit.archive.retentionDays` | No | `2555` | Whole number 1-36500: a lifecycle rule deletes log blobs that many days after their last write. Absent or `null`: blobs are kept, no deletion rule | `stage5-audit-archive.bicep` |
| `audit.archive.immutabilityDays` | No | `null` | Whole number 1-146000, at most `retentionDays`: an unlocked time-based retention policy on both log containers (blobs cannot be changed or deleted until it expires; an administrator can still shorten or remove an unlocked policy). Absent or `null`: none | `stage5-audit-archive.bicep` |
| `audit.archive.storageSku` | No | `Standard_LRS` | `Standard_LRS`, `Standard_ZRS`, `Standard_GRS`, `Standard_RAGRS`, `Standard_GZRS` or `Standard_RAGZRS`. Absent: `Standard_LRS` | `stage5-audit-archive.bicep` |
| `audit.workspaceRetentionDays` | No | absent | Whole number 30-730: Stage 5 sets the Log Analytics workspace retention. Absent: Stage 5 leaves the retention as it is; removing the key does not restore `stage1.retentionInDays`, so set it to that value instead. Lowering it removes workspace data older than the new value | `Staged.Audit.ps1` |

`audit.archive.coolAfterDays` and `audit.archive.archiveAfterDays` are refused: Azure Monitor writes the logs as
append blobs, and lifecycle management cannot move append blobs to Cool or Archive
([lifecycle policy structure](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-policy-structure)).

### Chargeback history

Read by [Staged.Cosmos.ps1](../../infra/staged/Staged.Cosmos.ps1). Other keys inside
`audit.chargebackHistory` are refused.

| Key | Req | Template | Allowed values and effect | Read by |
| --- | --- | --- | --- | --- |
| `audit.chargebackHistory` | No | see below | Absent or `null`: off | `Staged.Cosmos.ps1` |
| `audit.chargebackHistory.enabled` | Yes, inside the section | `false` | JSON `true` or `false`. `true`: Stage 2 creates `chargebackDaily`, Stage 3 grants it, Stage 5 writes the settings. `true` needs `reconciler.timerEnabled: true`: only the reconciler's timer run writes history. With the timer off the configuration check refuses: `audit.chargebackHistory.enabled is true but reconciler.timerEnabled is not: history is written only by the reconciler timer run; set reconciler.timerEnabled to true or audit.chargebackHistory.enabled to false (ADR-0044)` | `Staged.Cosmos.ps1` |
| `audit.chargebackHistory.closeAfterDays` | If enabled | `2` | Whole number 1-7: whole days after a UTC day ends before its totals are final (`RECONCILER_HISTORY_CLOSE_AFTER_DAYS`) | `app-settings.bicep` |
| `audit.chargebackHistory.ttlDays` | If enabled | `null` | `null`: kept until deleted. A whole number above the effective Log Analytics retention, at most 24855 (the largest 32-bit Cosmos DB time to live, in seconds): every document of a month expires this many days after the month ends (`RECONCILER_HISTORY_TTL_DAYS`, ADR-0044 decision 9). Stage 2 refuses a change between `null` and a number on an existing container ([procedure](../operate/chargeback-history-changes.md)) | `stage2-schema.bicep` |
