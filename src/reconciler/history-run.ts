// The chargeback history step of a reconciler run (ADR-0044): after the budget states are written and the budget
// lease is released, under its own lease and within a time and write budget, the documents of the current month from
// the rows the run already read, plus, early in a month, the previous month's open days from one extra ledger query;
// then only the documents the plan selects are written. A failure here is reported on the run line and never fails
// or delays the budget run.

import type { RateCard } from "../cost/rate-card.ts";
import type { ContractSchedule } from "../cost/contract-schedule.ts";
import { COVERAGE_ID, COVERAGE_SCHEMA, HISTORY_MAX_WRITES_PER_RUN, buildDailyDocuments, mergeCoverage, monthExpiry, planHistoryWrites, storedSummaryOf, ttlSeconds } from "./history.ts";
import type { ChargebackDailyDocument, CoverageDocument, DayState, HistoryRow, StoredSummary } from "./history.ts";
import { HISTORY_LEASE_ID, LeaseLostError, acquireLease } from "./lease.ts";
import type { Lease, LeaseStore } from "./lease.ts";
import { LedgerReadError, buildLedgerQuery, parseLedgerResponse } from "./ledger.ts";
import type { LedgerAnswer } from "./ledger.ts";
import { budgetPeriodAt } from "./period.ts";
import type { BudgetPeriod } from "./period.ts";
import { classifyRow } from "./price-rows.ts";

export interface HistoryStore {
  // Summaries of the stored documents of one month (partition key /month).
  readSummaries(month: string): Promise<ReadonlyMap<string, StoredSummary>>;
  write(doc: ChargebackDailyDocument): Promise<void>;
  // The month's coverage document (ADR-0044 decision 8); null when none was written yet.
  readCoverage(month: string): Promise<CoverageDocument | null>;
  // Conditional on the coverage last read for that month.
  writeCoverage(doc: CoverageDocument): Promise<void>;
}

// Another writer changed the document since the summaries were read (Cosmos 409 on create, 412 on If-Match).
export class HistoryConflictError extends Error {
  constructor() {
    super("history_conflict");
    this.name = "HistoryConflictError";
  }
}

// The Cosmos operations behind the store (azure.ts): one single-partition query, and a create (no etag) or an
// If-Match replace (etag) that returns the new etag and throws HistoryConflictError on a conflict.
export interface HistoryContainer {
  querySummaries(month: string): Promise<Array<StoredSummary & { id: string }>>;
  write(doc: ChargebackDailyDocument, etag: string | undefined): Promise<string>;
  // A point read of the coverage document; a create or If-Match replace like write.
  readCoverage(month: string): Promise<{ doc: CoverageDocument; etag: string } | null>;
  writeCoverage(doc: CoverageDocument, etag: string | undefined): Promise<string>;
}

// Summaries are read once per month and host instance every SUMMARY_CACHE_MINUTES (AUD-C1) and updated after each
// write. Writes are conditional on the cached etag, so an instance whose cache is behind another instance's writes
// cannot overwrite them (a closed day stays closed): it gets a conflict, drops the month's cache and re-reads it on
// the next run.
export const SUMMARY_CACHE_MINUTES = 60;

export function createCachedHistoryStore(container: HistoryContainer, now: () => Date): HistoryStore {
  const cache = new Map<string, { readAt: number; summaries: Map<string, StoredSummary> }>();
  const coverageEtags = new Map<string, string>();
  return {
    async readCoverage(month) {
      const read = await container.readCoverage(month);
      if (read === null) coverageEtags.delete(month);
      else coverageEtags.set(month, read.etag);
      return read?.doc ?? null;
    },
    async writeCoverage(doc) {
      coverageEtags.set(doc.month, await container.writeCoverage(doc, coverageEtags.get(doc.month)));
    },
    async readSummaries(month) {
      const hit = cache.get(month);
      if (hit !== undefined && now().getTime() - hit.readAt < SUMMARY_CACHE_MINUTES * 60_000) return hit.summaries;
      const readAt = now().getTime();
      const summaries = new Map((await container.querySummaries(month)).map(({ id, ...summary }) => [id, summary]));
      cache.set(month, { readAt, summaries });
      return summaries;
    },
    async write(doc) {
      const summaries = cache.get(doc.month)?.summaries;
      try {
        const etag = await container.write(doc, summaries?.get(doc.id)?.etag);
        summaries?.set(doc.id, { ...storedSummaryOf(doc), etag });
      } catch (error) {
        if (error instanceof HistoryConflictError) cache.delete(doc.month);
        throw error;
      }
    },
  };
}

export interface HistoryStepInput {
  closeAfterDays: number;
  // The container's time to live in days (ADR-0044 decision 9); null: documents never expire.
  ttlDays: number | null;
  rows: readonly HistoryRow[];
  period: BudgetPeriod;
  now: Date;
  rateCard: RateCard;
  schedule: ContractSchedule;
  ledgerKql: string;
  gatewayResourceId: string;
  ledgerMaxRows: number;
  writeConcurrency: number;
  store: HistoryStore | undefined;
  lease: Lease;
  queryLedger(query: string, timespan: string): Promise<LedgerAnswer>;
}

export type HistoryLine = Record<string, string | number | null>;

const DAY_MS = 86_400_000;

class HistoryFailure extends Error {
  readonly reason: string;
  readonly cause: unknown;
  constructor(reason: string, cause?: unknown) {
    super(reason);
    this.reason = reason;
    this.cause = cause;
  }
}

async function step<T>(reason: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof HistoryFailure ? error : new HistoryFailure(error instanceof LeaseLostError ? "lease_lost" : reason, error);
  }
}

// The previous month's days that may still be open: read while the first closeAfterDays + 1 days of a month last.
export function previousMonthTail(period: BudgetPeriod, now: Date, closeAfterDays: number): BudgetPeriod | null {
  const span = (closeAfterDays + 1) * DAY_MS;
  if (now.getTime() >= period.start.getTime() + span) return null;
  const previous = budgetPeriodAt(new Date(period.start.getTime() - 1));
  return { label: previous.label, start: new Date(period.start.getTime() - span), end: period.start };
}

// The UTC days from the day of `from` to the day of `through`, both included.
function daysOf(from: Date, through: Date): string[] {
  const days: string[] = [];
  for (let at = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); at <= through.getTime(); at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

async function readTail(input: HistoryStepInput, tail: BudgetPeriod): Promise<HistoryRow[]> {
  const query = buildLedgerQuery(input.ledgerKql, tail, input.gatewayResourceId);
  const answer = await input.queryLedger(query, `${tail.start.toISOString()}/${tail.end.toISOString()}`);
  return parseLedgerResponse(answer.body, input.ledgerMaxRows).map((row) => ({ row, classified: classifyRow(row, tail, input.rateCard, input.schedule) }));
}

// Set when the time budget is spent: no read or write starts after it.
interface Stop {
  stopped: boolean;
}

const checkStop = (stop: Stop): void => {
  if (stop.stopped) throw new HistoryFailure("history_time_budget");
};

async function writeAll(docs: ChargebackDailyDocument[], store: HistoryStore, lease: Lease, concurrency: number, counts: HistoryCounts, stop: Stop): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined && !stop.stopped && next < docs.length) {
      const doc = docs[next++];
      try {
        await lease.ensure();
        await store.write(doc);
        counts.historyWritten += 1;
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, docs.length) }, worker));
  if (failure !== undefined) {
    const reason = failure instanceof LeaseLostError ? "lease_lost" : failure instanceof HistoryConflictError ? "history_conflict" : "history_write_failed";
    throw new HistoryFailure(reason, failure);
  }
  checkStop(stop);
}

function errorCode(error: unknown): string | null {
  if (error instanceof LedgerReadError) return error.code ?? null;
  const value = typeof error === "object" && error !== null ? ((error as { code?: unknown }).code ?? (error as { statusCode?: unknown }).statusCode) : undefined;
  const code = value === undefined ? null : String(value);
  return code !== null && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : null;
}

type HistoryCounts = Record<
  "historyDocuments" | "historyWritten" | "historyUnchanged" | "historyNotDue" | "historyClosedSkipped" | "historyClosedRefused" | "historyShrinkRefused" | "historyBudgetDeferred" | "historyCoverageWritten",
  number
>;

const emptyCounts = (): HistoryCounts => ({
  historyDocuments: 0, historyWritten: 0, historyUnchanged: 0, historyNotDue: 0, historyClosedSkipped: 0, historyClosedRefused: 0, historyShrinkRefused: 0, historyBudgetDeferred: 0, historyCoverageWritten: 0,
});

export async function runHistoryStep(input: HistoryStepInput, counts: HistoryCounts = emptyCounts(), stop: Stop = { stopped: false }): Promise<HistoryLine> {
  try {
    const store = input.store;
    if (store === undefined) throw new HistoryFailure("history_store_missing");
    const tail = previousMonthTail(input.period, input.now, input.closeAfterDays);
    const rows = tail === null ? input.rows : [...input.rows, ...(await step("history_ledger_read_failed", () => readTail(input, tail)))];
    const coveredDays = new Set([...daysOf(input.period.start, input.now), ...(tail === null ? [] : daysOf(tail.start, new Date(tail.end.getTime() - 1)))]);
    const options = { now: input.now, closeAfterDays: input.closeAfterDays, rateCardVersion: input.rateCard.version, contractScheduleVersion: input.schedule.version, coveredDays, maxWrites: HISTORY_MAX_WRITES_PER_RUN };
    const docs = buildDailyDocuments(rows, options);
    const stored = new Map<string, StoredSummary>();
    for (const month of [...new Set([...coveredDays].map((day) => day.slice(0, 7)))].sort()) {
      checkStop(stop);
      for (const entry of await step("history_read_failed", () => store.readSummaries(month))) stored.set(...entry);
    }
    const plan = planHistoryWrites(docs, stored, options);
    const ttlDays = input.ttlDays;
    if (ttlDays !== null) plan.writes = plan.writes.map((doc) => ({ ...doc, ttl: ttlSeconds(monthExpiry(doc.month, ttlDays), input.now) }));
    const monthsWithDocuments = new Set([...stored.values()].map((s) => s.key.day.slice(0, 7)));
    counts.historyDocuments = docs.length;
    counts.historyUnchanged = plan.unchanged;
    counts.historyNotDue = plan.notDue;
    counts.historyClosedSkipped = plan.closedSkipped;
    counts.historyClosedRefused = plan.closedRefused;
    counts.historyShrinkRefused = plan.shrinkRefused;
    counts.historyBudgetDeferred = plan.budgetDeferred;
    // Lowering writes first, all of them, then the rest (HistoryPlan.loweringCount).
    await writeAll(plan.writes.slice(0, plan.loweringCount), store, input.lease, input.writeConcurrency, counts, stop);
    await writeAll(plan.writes.slice(plan.loweringCount), store, input.lease, input.writeConcurrency, counts, stop);
    await writeCoverage(plan.coverage, monthsWithDocuments, store, input, counts, stop);
    return { historyOutcome: "written", historyReason: null, ...counts };
  } catch (error) {
    const failure = error instanceof HistoryFailure ? error : new HistoryFailure(error instanceof LedgerReadError ? error.reason : "history_failed", error);
    return { historyOutcome: "failed", historyReason: failure.reason, historyErrorCode: errorCode(failure.cause), ...counts };
  }
}

// The earliest instant a document of the month can expire (ADR-0044 decision 9). This run's writes expire at the
// month's expiry (earlier when capped); an earlier write expires no later than the stored expiresAt; a document
// written while there was no time to live takes the container's default from its last write, so at the earliest
// ttlDays after the month starts. Null without ttlDays: the container then expires nothing.
function coverageExpiry(month: string, stored: CoverageDocument | null, hasDocuments: boolean, ttlDays: number | null, now: Date): string | null {
  if (ttlDays === null) return null;
  const candidates = [now.getTime() + ttlSeconds(monthExpiry(month, ttlDays), now) * 1000];
  if (typeof stored?.expiresAt === "string") candidates.push(Date.parse(stored.expiresAt));
  else if (stored !== null || hasDocuments) candidates.push(Date.parse(`${month}-01T00:00:00Z`) + ttlDays * DAY_MS);
  return new Date(Math.min(...candidates)).toISOString();
}

// After every document write succeeded: the coverage of each month the plan covered, only when it changed.
async function writeCoverage(coverage: ReadonlyMap<string, DayState>, monthsWithDocuments: ReadonlySet<string>, store: HistoryStore, input: HistoryStepInput, counts: HistoryCounts, stop: Stop): Promise<void> {
  for (const month of [...new Set([...coverage.keys()].map((day) => day.slice(0, 7)))].sort()) {
    checkStop(stop);
    const update = new Map([...coverage].filter(([day]) => day.startsWith(month)));
    const stored = await step("history_read_failed", () => store.readCoverage(month));
    const merged = mergeCoverage(stored?.days, update);
    const expiresAt = coverageExpiry(month, stored, monthsWithDocuments.has(month), input.ttlDays, input.now);
    if (merged === null && expiresAt === (stored?.expiresAt ?? null)) continue;
    const days = merged ?? { ...stored?.days };
    await step("history_write_failed", () => input.lease.ensure());
    try {
      // ttl -1 with ttlDays: the coverage never expires, or it would expire on the container's default.
      await store.writeCoverage({ id: COVERAGE_ID, schema: COVERAGE_SCHEMA, month, days, computedAt: input.now.toISOString(), expiresAt, ...(input.ttlDays === null ? {} : { ttl: -1 }) });
    } catch (error) {
      throw new HistoryFailure(error instanceof HistoryConflictError ? "history_conflict" : "history_write_failed", error);
    }
    counts.historyCoverageWritten += 1;
  }
}

export interface HistoryRunInput extends Omit<HistoryStepInput, "lease"> {
  leases: LeaseStore;
  leaseSeconds: number;
  holder: string;
  clock: () => Date;
  // After this, the run line is returned, no read or write starts, and the lease is released when the call in
  // flight ends.
  timeBudgetMs: number;
}

// Called after the budget lease is released: history takes its own lease, so a slow or failing history never holds
// the budget run, and two instances never write history at once.
export async function runHistory(input: HistoryRunInput): Promise<HistoryLine> {
  const counts = emptyCounts();
  const stop: Stop = { stopped: false };
  const work = (async (): Promise<HistoryLine> => {
    let acquired: Awaited<ReturnType<typeof acquireLease>>;
    try {
      acquired = await acquireLease(input.leases, { id: HISTORY_LEASE_ID, holder: input.holder, leaseSeconds: input.leaseSeconds, now: input.clock });
    } catch (error) {
      return { historyOutcome: "failed", historyReason: "history_lease_unavailable", historyErrorCode: errorCode(error), ...counts };
    }
    if (!acquired.acquired) return { historyOutcome: "skipped", historyReason: "history_lease_held", ...counts };
    try {
      checkStop(stop);
      return await runHistoryStep({ ...input, lease: acquired.lease }, counts, stop);
    } catch {
      return { historyOutcome: "failed", historyReason: "history_time_budget", ...counts };
    } finally {
      await acquired.lease.release().catch(() => false);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HistoryLine>((resolve) => {
    timer = setTimeout(() => {
      stop.stopped = true;
      resolve({ historyOutcome: "failed", historyReason: "history_time_budget", ...counts });
    }, input.timeBudgetMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
