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
2. **Document**: one per UTC day, chargeback ID, project (group), classification, person and model. `id` is the
   SHA-256 of those six values. Fields: request counts (priced, partial, unpriced, unattributed), token sums and
   known-request counts per category, `listCcu` (list price, as the report) and `contractCcu` (the budget basis),
   rate card and contract schedule versions, `closed`, `computedAt` and `contentHash` (SHA-256 of every total and
   `closed`). Rows without a valid attribution are kept with empty ids and counted as unattributed.
3. **Writes** (pure planning in `src/reconciler/history.ts`, run in `src/reconciler/history-run.ts`), after the
   budget states, every run:
   - compute the documents of every day of the current month from the rows already read; during the first
     `closeAfterDays` + 1 days of a month, also read and compute the previous month's last `closeAfterDays` + 1
     days with one extra ledger query;
   - a day closes once `closeAfterDays` whole days have passed after it; its document is written once with
     `closed: true`;
   - skip a document whose stored copy is closed (closed-day guard), whose stored request count is higher
     (never lower a total), whose content hash is unchanged, or which is open and was written less than 60
     minutes ago (cost bound, AUD-C1);
   - stored hashes come from one single-partition query per month, cached in the host for 60 minutes and
     updated after each write.
   A history failure never fails the budget run: the run line carries `historyOutcome` and its counts.
4. **Settings**: reconciler `RECONCILER_HISTORY_CONTAINER` and `RECONCILER_HISTORY_CLOSE_AFTER_DAYS` (both or
   neither; absent: off). Admin `ADMIN_CHARGEBACK_HISTORY_CONTAINER` (absent: off) and `ADMIN_LOG_RETENTION_DAYS`.
   Configuration `audit.chargebackHistory { enabled, closeAfterDays, ttlDays }`, validated by the staged driver,
   part of the Stage 2, 3 and 5 configuration hashes only when present.
5. **Grants** (Stage 3): the reconciler gets the reconciler writer role and Cosmos DB Built-in Data Reader (for the
   hash query) on `chargebackDaily`; the admin app gets Built-in Data Reader on it. No delete for anyone.
6. **Reads** (`admin/src/history.ts`): the usage export splits its range at the boundary, the first UTC month
   start on or after `now - ADMIN_LOG_RETENTION_DAYS`. Before it, rows come from `chargebackDaily`; from it, from
   Log Analytics as before. Rows with the same chargeback ID, group and person are merged: counts, tokens and
   amounts are added; columns history cannot fill (AUD-C8) are empty on merged rows. The history part must start
   and end on whole UTC days; backend and tag filters are refused for it. The console views stay on Log Analytics.

## Consequences

- Months older than the workspace retention can be exported with the same column names and the administrator's
  tag heading. Their per-request diagnostics are not kept.
- Days before history was enabled, and previous-month days missed while the reconciler was stopped for longer
  than `closeAfterDays` + 1 days into the next month, are not in history. A month enabled mid-way is backfilled
  from the rows of that month at the first run.
- An open day in history is at most 60 minutes behind the ledger; the export reads only closed months.
- History follows the rate card in force when the day closed; a later rate-card correction does not change it.
- Turning history off stops writes and reads; the container and its documents stay until deleted by hand.
