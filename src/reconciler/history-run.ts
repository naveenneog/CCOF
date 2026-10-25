// The chargeback history step of a reconciler run (ADR-0044): after the budget states, the documents of the current
// month from the rows the run already read, plus, early in a month, the previous month's open days from one extra
// ledger query; then only the documents the plan selects are written. A failure here is reported on the run line
// and never fails the budget run.

import type { RateCard } from "../cost/rate-card.ts";
import type { ContractSchedule } from "../cost/contract-schedule.ts";
import { buildDailyDocuments, planHistoryWrites, storedSummaryOf } from "./history.ts";
import type { ChargebackDailyDocument, HistoryPlan, HistoryRow, StoredSummary } from "./history.ts";
import { LeaseLostError } from "./lease.ts";
import type { Lease } from "./lease.ts";
import { LedgerReadError, buildLedgerQuery, parseLedgerResponse } from "./ledger.ts";
import type { LedgerAnswer } from "./ledger.ts";
import { budgetPeriodAt } from "./period.ts";
import type { BudgetPeriod } from "./period.ts";
import { classifyRow } from "./price-rows.ts";

export interface HistoryStore {
  // Summaries of the stored documents of one month (partition key /month).
  readSummaries(month: string): Promise<ReadonlyMap<string, StoredSummary>>;
  write(doc: ChargebackDailyDocument): Promise<void>;
}

// The Cosmos operations behind the store (azure.ts): one single-partition query and an upsert.
export interface HistoryContainer {
  querySummaries(month: string): Promise<Array<StoredSummary & { id: string }>>;
  upsert(doc: ChargebackDailyDocument): Promise<void>;
}

// Summaries are read once per month and host instance every SUMMARY_CACHE_MINUTES (AUD-C1), and updated after each
// successful write. Another instance's writes are seen at the next refresh; the plan's guards hold either way.
export const SUMMARY_CACHE_MINUTES = 60;

export function createCachedHistoryStore(container: HistoryContainer, now: () => Date): HistoryStore {
  const cache = new Map<string, { readAt: number; summaries: Map<string, StoredSummary> }>();
  return {
    async readSummaries(month) {
      const hit = cache.get(month);
      if (hit !== undefined && now().getTime() - hit.readAt < SUMMARY_CACHE_MINUTES * 60_000) return hit.summaries;
      const readAt = now().getTime();
      const summaries = new Map((await container.querySummaries(month)).map(({ id, ...summary }) => [id, summary]));
      cache.set(month, { readAt, summaries });
      return summaries;
    },
    async write(doc) {
      await container.upsert(doc);
      cache.get(doc.month)?.summaries.set(doc.id, storedSummaryOf(doc));
    },
  };
}

export interface HistoryStepInput {
  closeAfterDays: number;
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

async function readTail(input: HistoryStepInput, tail: BudgetPeriod): Promise<HistoryRow[]> {
  const query = buildLedgerQuery(input.ledgerKql, tail, input.gatewayResourceId);
  const answer = await input.queryLedger(query, `${tail.start.toISOString()}/${tail.end.toISOString()}`);
  return parseLedgerResponse(answer.body, input.ledgerMaxRows).map((row) => ({ row, classified: classifyRow(row, tail, input.rateCard, input.schedule) }));
}

async function writeAll(docs: ChargebackDailyDocument[], store: HistoryStore, lease: Lease, concurrency: number): Promise<number> {
  let next = 0;
  let written = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < docs.length) {
      const doc = docs[next++];
      try {
        await lease.ensure();
        await store.write(doc);
        written += 1;
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, docs.length) }, worker));
  if (failure !== undefined) throw new HistoryFailure(failure instanceof LeaseLostError ? "lease_lost" : "history_write_failed", failure);
  return written;
}

function errorCode(error: unknown): string | null {
  if (error instanceof LedgerReadError) return error.code ?? null;
  const value = typeof error === "object" && error !== null ? ((error as { code?: unknown }).code ?? (error as { statusCode?: unknown }).statusCode) : undefined;
  const code = value === undefined ? null : String(value);
  return code !== null && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : null;
}

export async function runHistoryStep(input: HistoryStepInput): Promise<HistoryLine> {
  const counts = { historyDocuments: 0, historyWritten: 0, historyUnchanged: 0, historyNotDue: 0, historyClosedSkipped: 0, historyShrinkRefused: 0 };
  try {
    const store = input.store;
    if (store === undefined) throw new HistoryFailure("history_store_missing");
    const tail = previousMonthTail(input.period, input.now, input.closeAfterDays);
    const rows = tail === null ? input.rows : [...input.rows, ...(await step("history_ledger_read_failed", () => readTail(input, tail)))];
    const options = { now: input.now, closeAfterDays: input.closeAfterDays, rateCardVersion: input.rateCard.version, contractScheduleVersion: input.schedule.version };
    const docs = buildDailyDocuments(rows, options);
    const months = [...new Set(docs.map((d) => d.month))].sort();
    const plans: HistoryPlan[] = [];
    for (const month of months) {
      const stored = await step("history_read_failed", () => store.readSummaries(month));
      plans.push(planHistoryWrites(docs.filter((d) => d.month === month), stored, input.now));
    }
    counts.historyDocuments = docs.length;
    for (const plan of plans) {
      counts.historyUnchanged += plan.unchanged;
      counts.historyNotDue += plan.notDue;
      counts.historyClosedSkipped += plan.closedSkipped;
      counts.historyShrinkRefused += plan.shrinkRefused;
    }
    counts.historyWritten = await writeAll(plans.flatMap((p) => p.writes), store, input.lease, input.writeConcurrency);
    return { historyOutcome: "written", historyReason: null, ...counts };
  } catch (error) {
    const failure = error instanceof HistoryFailure ? error : new HistoryFailure(error instanceof LedgerReadError ? error.reason : "history_failed", error);
    return { historyOutcome: "failed", historyReason: failure.reason, historyErrorCode: errorCode(failure.cause), ...counts };
  }
}
