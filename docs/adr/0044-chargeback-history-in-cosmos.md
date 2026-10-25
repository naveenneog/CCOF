# ADR-0044: Chargeback history in Cosmos DB

Status: Accepted (2026-10-25).

## Context

Chargeback reports and the usage export (`admin/src/export.ts`) query the usage ledger in Log Analytics
(`analytics/ledger.kql`). The workspace keeps it for its retention (30 days in the staged example,
`stage1.retentionInDays`). The owner needs chargeback and audit figures for longer than that.

The reconciler (`src/reconciler/run.ts`) already reads and prices every ledger row of the current UTC month each
run. Unknowns AUD-C1 to AUD-C8 (docs/UNKNOWNS.md) cover cost, partitioning, late rows, idempotency, finalisation,
tags and TTL.

Options considered:

1. Raise Log Analytics retention or use long-term retention: per-GB cost for every gateway log column, and the
   long-term tier needs search jobs instead of the report queries.
2. Archive raw gateway logs to storage (ADR-0043): complete and cheap, but a report must re-price raw logs.
3. Daily totals in Cosmos DB, written by the reconciler from the rows it already prices (this ADR).

Option 3 is chosen for reports; ADR-0043 is the raw audit trail. They are independent.

## Decision

1. **Container** `chargebackDaily`, partition key `/month` (`YYYY-MM`), created by Stage 2 only when
   `audit.chargebackHistory.enabled` is true. It indexes only `day`, `chargebackId`, `projectId`, `classification`,
   `personId` and `model`. `ttlDays` sets the container's `defaultTtl` (days x 86,400); null means no expiry.
   With `ttlDays`, each document carries its own `ttl` so that a whole month expires at one instant (decision 9).
2. **Document**: one per UTC day, chargeback ID, project (group), classification, person and model. `id` is the
   SHA-256 of those six values. Fields: request counts (priced, partial, unpriced, unattributed), token sums and
   known-request counts per category, `listCcu` (list price, as the report) and `contractCcu` (the budget basis),
   rate card and contract schedule versions, `closed`, `computedAt` and `contentHash` (SHA-256 of every total and
   `closed`). Valid ids are kept even on unattributed rows, as the report keeps them; such rows are counted as
   unattributed. Rows whose five token counts are all known and zero are left out, as the report leaves them out.
3. **Writes** (pure planning in `src/reconciler/history.ts`, run in `src/reconciler/history-run.ts`), after the
   budget states and the release of the budget lease (decision 7), every run:
   - compute the documents of every day of the current month from the rows already read; during the first
     `closeAfterDays` + 1 days of a month, also read and compute the previous month's last `closeAfterDays` + 1
     days with one extra ledger query;
   - plan each day as a whole, because a row can move to another document of its day when its trace arrives
     later (AUD-C9): a stored document the run no longer computes is written with zero totals, and a day whose
     total request count would fall is refused (never lower a total); writes that lower a document's count all
     finish before the others start, so an interrupted run leaves a day too low, repaired by the next run, never
     counted twice;
   - a day closes once `closeAfterDays` whole days have passed after it, in two phases: if its computed totals
     differ from the stored ones, they are first written open (lowering first, as above); once every document of
     the day holds its final totals, all of them are written with `closed: true`. A day with any closed document
     is frozen as a whole: a closed document is never written again, its open documents may only be closed with
     unchanged totals (finishing an interrupted close), and every new, changed or zeroed document of that day is
     refused and counted as `historyClosedRefused`, so a key that moves after the close is never counted twice;
   - skip a document whose content hash is unchanged; defer an open day's changes until its last write is 60
     minutes old, all of the day together (cost bound, AUD-C1);
   - stored summaries (key, hash, closed, requests, time, etag) come from one single-partition query per month,
     cached in the host for 60 minutes; every write is a create or an If-Match replace on the cached etag, so an
     instance with a stale cache gets a conflict instead of overwriting another instance's write (AUD-C10).
   A history failure never fails the budget run: the run line carries `historyOutcome` and its counts.
7. **History never holds up budgets** (council review 2026-10-25). The budget states are written and the budget
   lease (`ccof-budget-reconciler`) is released before history starts. History then takes its own lease,
   `ccof-chargeback-history`, in the same lease container (held by another run: `historyOutcome: skipped`,
   `historyReason: history_lease_held`), and runs within a time budget, half the run interval and at least 15
   seconds: when it is spent the run line is written with `historyReason: history_time_budget`, no further read or
   write starts, and the history lease is released when the call in flight ends. A run writes at most 1,000
   documents (`HISTORY_MAX_WRITES_PER_RUN`), whole days, oldest first; the rest wait for the next run
   (`historyBudgetDeferred`). A first day larger than that is written whole. Considered and rejected: one lease
   for both (a slow Cosmos holds the next budget run) and a separate timer function (a second schedule and
   identity to deploy for the same rows the run already read).
4. **Settings**: reconciler `RECONCILER_HISTORY_CONTAINER` and `RECONCILER_HISTORY_CLOSE_AFTER_DAYS` (both or
   neither; absent: off), and `RECONCILER_HISTORY_TTL_DAYS` (`ttlDays`, only when set; decision 9). Admin `ADMIN_CHARGEBACK_HISTORY_CONTAINER` (absent: off); Stage 5 writes `ADMIN_LOG_RETENTION_DAYS` with history on or off (ADR-0043).
   Configuration `audit.chargebackHistory { enabled, closeAfterDays, ttlDays }`, validated by the staged driver.
   An absent section, or `{ "enabled": false }` with no other key, leaves every stage hash unchanged; any other
   present value (including `enabled: false` beside other keys) is part of the Stage 2, 3 and 5 hashes.
   The workspace's retention is one value, `audit.workspaceRetentionDays` when set (ADR-0043), otherwise
   `stage1.retentionInDays` (`Get-StgLogRetentionDays`): it is `ADMIN_LOG_RETENTION_DAYS` (the export boundary and
   the report's `RetentionTruncated` flag) and the floor of `ttlDays`, which must be more than it and at most 24,855
   (`defaultTtl` is a 32-bit number of seconds). History is written only by the reconciler's timer run, so
   `enabled: true` with `reconciler.timerEnabled` not true is refused.
5. **Grants** (Stage 3): the reconciler gets the reconciler writer role and Cosmos DB Built-in Data Reader (for the
   hash query) on `chargebackDaily`; the admin app gets Built-in Data Reader on it. No delete for anyone.
6. **Reads** (`admin/src/history.ts`): the usage export splits its range at the boundary, the first UTC month
   start on or after `now - ADMIN_LOG_RETENTION_DAYS` (after a raised retention, on or after the later of that and
   `ADMIN_LOG_RETENTION_HELD_FROM`, ADR-0043), and never after the current month's start. Before it, rows come from `chargebackDaily`; from it, from
   Log Analytics as before. Rows with the same chargeback ID, group and person are merged: counts, tokens and
   amounts are added; columns history cannot fill (AUD-C8) are empty on merged rows. Every row of a split export
   carries the whole export period in `periodStart` and `periodEnd`. The history part must start and end on whole
   UTC days (`history_range_not_whole_days`). Of the export's filters, project, group, developer, model, family,
   classification and chargeback (the chargeback ID) are applied to the history part as to the Log Analytics part;
   `backend` is refused when the range has a history part (`backend_filter_not_in_history`, history has no
   backend); user-tag, paging and trend parameters are not export parameters at all (`unknown_parameter`). The
   console views stay on Log Analytics.
8. **Coverage** (council review 2026-10-25): a day without usage has no document, so history alone cannot tell it
   from a day it never read. Each month has one coverage document (`id: "coverage"`, `schema:
   ccof.chargeback.coverage.v1`, `days: { "YYYY-MM-DD": "open" | "closed" }`, no `day` field, so the day queries
   never return it). After all of a run's document writes succeed, the reconciler records every day it read whole
   and planned in full: `closed` once every document of the day is closed (or the day had none and is due to
   close), otherwise `open`; days left by the write budget are not recorded, and a closed day never reopens. The
   run line counts `historyCoverageWritten`. The export reads the coverage of each month of its history part and
   refuses the request with HTTP 409 `{ "error": "history_not_covered", "uncoveredDays": [...] }` (JSON and CSV
   alike) when any day is not covered; covered days still open are listed in the JSON `sources[].openDays`.
9. **Expiry** (council round 2, 2026-10-26). Cosmos DB expires an item `ttl` seconds after its last write
   ([time to live](https://learn.microsoft.com/en-us/azure/cosmos-db/time-to-live), retrieved 2026-10-26). With
   `defaultTtl` alone, each document of a day expired `ttlDays` after its own last write, while the coverage record
   was rewritten later, so the coverage could list a day whose documents had expired and the export would return
   incomplete totals as covered. Chosen: one expiry per month. Every document written with `ttlDays` carries
   `ttl` = the seconds from the run's time to the first instant of the next month plus `ttlDays` days (capped at
   2,147,483,647, the largest `ttl`), so all documents of a month, whenever written, expire together. The coverage
   record carries `ttl: -1` (never expires) and `expiresAt`, the earliest instant a document of the month can
   expire: the minimum of what every write set, so a lowered `ttlDays` lowers it and a raised one does not raise
   it; for documents written while `ttlDays` was null (they take `defaultTtl` from their last write) it assumes the
   month's start plus `ttlDays`; with `ttlDays` null it is null (Stage 2 then removes `defaultTtl`, and nothing
   expires). The export refuses, before reading, every day of its history part whose month's `expiresAt` is
   within one day of now (`HISTORY_EXPIRY_MARGIN_MS`; items stop being returned as soon as they expire) with HTTP
   409 `{ "error": "history_expired", "expiredDays": [...], "expiresAt": "..." }`. Rejected: per-day closing times
   in the coverage with the expiry computed from `defaultTtl` (open days are rewritten at different times, and a
   changed `defaultTtl` applies at once to every document, so the admin app would need the current value and every
   document's last write); per-document expiry checks at read time (an expired document is simply absent).
10. **ttlDays between null and a number** (council round 3, 2026-10-26). Decision 9 holds while `ttlDays` stays a
   number or stays null. A change between them breaks it for months already written: from null, the new
   `defaultTtl` applies at once to documents that carry no `ttl` (they expire from their last write), while those
   months' coverage records say they never expire; to null, Cosmos DB ignores item `ttl` without a container
   `defaultTtl` ([time to live](https://learn.microsoft.com/en-us/azure/cosmos-db/time-to-live)), so nothing
   expires while the coverage records still give an expiry. Chosen: Stage 2 reads the existing container (an ARM
   read) before it previews or deploys and refuses the change with `chargeback_history_ttl_transition`
   (`Get-StgChargebackTtlTransitionProblem`). The documented procedure is to raise `ttlDays` (up to 24,855) instead of
   null, or to export, delete the container and start the history again
   ([chargeback history changes](../operate/chargeback-history-changes.md)). Rejected:
   the reconciler rewriting the coverage record of every month in the container and the export refusing months
   whose recorded expiry does not match the current setting. It needs a cross-partition read of every coverage
   record each run, the container's current `defaultTtl` in the admin app, and a refusal window between Stage 2 and
   the next reconciler run; the transition is rare and a refusal before any change is simpler to verify. Limit: a
   `defaultTtl` changed outside Stage 2 (Portal, CLI) is not detected.

## Consequences

- Months older than the workspace retention can be exported with the same column names and the administrator's
  tag heading. Their per-request diagnostics are not kept.
- The first history run reads the whole current month, so it backfills and covers every day of that month from its
  first day (and, during the first `closeAfterDays` + 1 days of a month, the previous month's last
  `closeAfterDays` + 1 days). Earlier days, and previous-month days missed while the reconciler was stopped for
  longer than that into the next month, are never covered: the export refuses them with `history_not_covered`
  instead of showing zero. A backfill can only hold what the workspace still keeps (AUD-C5).
- An open day in history is at most 60 minutes behind the ledger; the export reads history only before the
  current month, and lists any day of its range that is not yet closed in `sources[].openDays`.
- History follows the rate card in force when the day closed; a later rate-card correction does not change it.
- With `ttlDays`, a month is kept `ttlDays` days after it ends (decision 9), then refused as `history_expired` from
  one day before that. A changed `ttlDays` applies to documents written after the change: a closed month is never
  written again, so it keeps the expiry it was written with; to delete older history sooner, use the deletion tool
  below.
- Deletion (council round 3, 2026-10-26): `scripts/history/delete-chargeback-history.ts` deletes whole months, or one
  person's documents in them, with `DefaultAzureCredential` (what-if unless `--confirm`;
  [chargeback history changes](../operate/chargeback-history-changes.md#delete-history)). A whole month's coverage
  record is deleted before its documents, so the export refuses the month (`history_not_covered`) rather than return
  it as covered with documents missing; for one person the coverage record first records the deletion in
  `personDeletions` (no ID) and the month stays covered without that person. The previous month and later are
  refused, because the reconciler may still write them. The Stage 3 roles still cannot delete: the operator takes the
  built-in Data Contributor role on the container for the task and runs the tool from inside the virtual network.
- Turning history on in a running deployment (council round 2, 2026-10-26) needs Stages 2, 3 and 5 (container,
  grants, settings) and Stage 7, because the reconciler and admin code that write and read history are new; Stage 4
  only when `admin.extraAllowedClientIds` changes. Stage 5's recorded outputs (gateway URL, settings list, workbook
  flag) do not change, so Stage 7 is not forced by the dependency check and is run for the code. A Stage 7 rerun
  seeds create-only: group documents edited in the admin console since the first seed now differ from the
  configuration. Council round 3 (2026-10-26) reverted round 2's default of keeping them: Stage 7 stops with
  `seed_documents_differ`, naming each group and the differing fields, unless the configuration sets
  `stage7.keepDifferingGroups: true`; then it keeps them, ends with `kept N console-edited group(s): …` and records
  them in `evidence/stage7.verify.json` (`seed.kept`). Why: keeping silently hid a configuration that no longer
  describes the deployment, and a warning in a long log is easy to miss; an opt-in in the configuration is
  reviewable and part of the Stage 7 hash. `groups[]` seeds a group once; afterwards the admin console owns it.
  Other differing documents always stop Stage 7. Stage 5 replaces each app's whole settings set, so it now writes
  `AzureWebJobs.snapshotApply.Disabled: true` itself (ADR-0024); before, a Stage 5 rerun dropped the switch that
  Stage 7 had left and the Stage 1 recheck failed. A Stage 5 rerun with a changed rendered policy leaves the
  previous policy fragments in API Management (ADR-0039); removing them is a documented manual step
  ([troubleshooting](../operate/troubleshooting.md#old-policy-fragments)), not automated here.
- The committed example (`infra/staged/staged.config.example.json`) shows `audit.chargebackHistory` with
  `enabled: false`, because its `reconciler.timerEnabled` is false (timers stay off until a deployment is verified)
  and enabled history without the timer is refused. Turn both on together.

## Rollback

Set `audit.chargebackHistory.enabled` to false (or remove the section) and rerun Stages 2, 3 and 5. Stage 5
removes the `RECONCILER_HISTORY_*` and `ADMIN_CHARGEBACK_HISTORY_CONTAINER` settings
(the settings resource replaces the whole set), so the reconciler stops writing and the export reads Log Analytics
only. The stage deployments are incremental and never delete, so these remain until removed by hand:

- the `chargebackDaily` container with all its documents (daily totals and monthly coverage):
  `az cosmosdb sql container delete --account-name <account> --resource-group <rg> --database-name <database>
  --name chargebackDaily`;
- the three Stage 3 data-plane role assignments scoped to `.../colls/chargebackDaily` (reconciler writer,
  reconciler reader, admin reader): find them with `az cosmosdb sql role assignment list` and delete each with
  `az cosmosdb sql role assignment delete --role-assignment-id <id>`;
- the `ccof-chargeback-history` lease document in the reconciler lease container (harmless; it expires).

Turning history on again resumes at the next run; days of the gap are covered only if that run's current month (or
previous-month tail) still includes them.