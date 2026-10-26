// Chargeback history (ADR-0044): daily totals per UTC day, chargeback ID, project (group), classification, person
// and model, from the ledger rows a reconciler run already priced, and the plan of which documents to write. Pure:
// the rows, the stored summaries and the clock are inputs. history-run.ts reads and writes.

import { createHash } from "node:crypto";
import type { Decimal } from "decimal.js";
import { CHARGEBACK_ID } from "../contracts/group-registration.ts";
import { Money } from "../cost/money.ts";
import type { TokenCategory } from "../cost/token-categories.ts";
import type { LedgerRow } from "./ledger.ts";
import type { ClassifiedRow } from "./price-rows.ts";

export const HISTORY_SCHEMA = "ccof.chargeback.daily.v1";
// An open day's document is rewritten at most this often (AUD-C1); closing writes are not deferred.
export const OPEN_REWRITE_MINUTES = 60;
// At most this many documents are written per run, whole days, oldest first (ADR-0044 decision 7); the rest wait for
// the next run. A first day larger than this is still written whole.
export const HISTORY_MAX_WRITES_PER_RUN = 1000;
// One coverage document per month (id COVERAGE_ID, no day): the days history holds, so that a day without usage is
// told apart from a day history never read (ADR-0044 decision 8).
export const COVERAGE_SCHEMA = "ccof.chargeback.coverage.v1";
export const COVERAGE_ID = "coverage";

const DAY_MS = 86_400_000;
const UTC_INSTANT = /^(\d{4}-\d{2})-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const CATEGORIES: ReadonlyArray<readonly [TokenCategory, keyof LedgerRow]> = [
  ["input", "inputTokens"],
  ["output", "outputTokens"],
  ["cacheRead", "cacheReadTokens"],
  ["cacheWrite5m", "cacheWrite5mTokens"],
  ["cacheWrite1h", "cacheWrite1hTokens"],
];

export interface HistoryRow {
  row: LedgerRow;
  classified: ClassifiedRow;
}

export interface HistoryKey {
  day: string;
  chargebackId: string;
  projectId: string;
  classification: string;
  personId: string;
  model: string;
}

export type TokenTotals = Record<TokenCategory, number>;

export interface ChargebackDailyDocument extends HistoryKey {
  id: string;
  schema: typeof HISTORY_SCHEMA;
  month: string;
  requests: number;
  pricedRequests: number;
  partialRequests: number;
  unpricedRequests: number;
  unattributedRequests: number;
  tokens: TokenTotals;
  tokensKnownRequests: TokenTotals;
  // Exact decimal strings: list price (the report's basis) and the contract amount (the budget's basis).
  listCcu: string;
  contractCcu: string;
  rateCardVersion: string;
  contractScheduleVersion: string;
  closed: boolean;
  computedAt: string;
  contentHash: string;
  // Seconds to live from this write (ADR-0044 decision 9); absent without ttlDays.
  ttl?: number;
}

// open: written from a whole read, still changing; closed: final (every document of the day closed, or none).
export type DayState = "open" | "closed";

export interface CoverageDocument {
  id: typeof COVERAGE_ID;
  schema: typeof COVERAGE_SCHEMA;
  month: string;
  days: Record<string, DayState>;
  computedAt: string;
  // The earliest instant a document of the month can expire (ADR-0044 decision 9); null: documents never expire.
  // Absent in a coverage written before expiry was recorded.
  expiresAt?: string | null;
  // -1 with ttlDays: the coverage itself never expires, so an expired month is told apart from one never covered.
  ttl?: number;
}

// What the reconciler keeps of a stored document to plan the next write; etag, when known, makes the write conditional.
export interface StoredSummary {
  key: HistoryKey;
  contentHash: string;
  closed: boolean;
  requests: number;
  computedAt: string;
  etag?: string;
}

export interface BuildOptions {
  now: Date;
  closeAfterDays: number;
  rateCardVersion: string;
  contractScheduleVersion: string;
}

// The days the run read whole (the current month to now, the previous month's open tail): only their stored
// documents can be compared with what the run computed.
export interface PlanOptions extends BuildOptions {
  coveredDays: ReadonlySet<string>;
  maxWrites?: number;
}

export interface HistoryPlan {
  // The first loweringCount writes lower a stored count; they must all finish before the others start, so that an
  // interrupted run can leave a day too low (repaired by the next run) but never counted twice.
  writes: ChargebackDailyDocument[];
  loweringCount: number;
  unchanged: number;
  notDue: number;
  closedSkipped: number;
  // New, changed or zeroed documents of a day that already has a closed document: never written.
  closedRefused: number;
  shrinkRefused: number;
  // Writes left for a later run by the per-run write budget.
  budgetDeferred: number;
  // The state of each covered day once this plan's writes are done; budget-deferred days are not in it.
  coverage: Map<string, DayState>;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const valid = (value: unknown, pattern: RegExp): string => (typeof value === "string" && pattern.test(value) ? value : "");
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const zeroTokens = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

// A Cosmos id may not hold / \ ? or #, and a chargeback ID may hold "/": the id is a digest of the key.
export function historyDocumentId(key: HistoryKey): string {
  return sha256(JSON.stringify([key.day, key.chargebackId, key.projectId, key.classification, key.personId, key.model]));
}

// The largest Cosmos DB time to live: a 32-bit signed number of seconds.
export const MAX_TTL_SECONDS = 2_147_483_647;

// Every document of a month, and so every day of it, expires at one instant: ttlDays after the month ends.
export function monthExpiry(month: string, ttlDays: number): Date {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m, 1) + ttlDays * DAY_MS);
}

// The time to live of a write at `now` that should expire at `expiry`: capped at MAX_TTL_SECONDS, at least 1.
export function ttlSeconds(expiry: Date, now: Date): number {
  return Math.max(1, Math.min(MAX_TTL_SECONDS, Math.round((expiry.getTime() - now.getTime()) / 1000)));
}

export function isDayClosed(day: string, now: Date, closeAfterDays: number): boolean {
  return now.getTime() >= Date.parse(`${day}T00:00:00Z`) + (1 + closeAfterDays) * DAY_MS;
}

// Valid ids are kept even when the row is not attributed, as the report keeps them (analytics/workbooks/pricing.kql).
function keyOf({ row }: HistoryRow, day: string): HistoryKey {
  return {
    day,
    chargebackId: valid(row.chargebackId, CHARGEBACK_ID),
    projectId: valid(row.projectId, ID),
    classification: valid(row.classification, ID),
    personId: valid(row.personId, GUID).toLowerCase(),
    model: valid(row.model, MODEL),
  };
}

// Every token count known and zero: no usage, left out as the report leaves it out (admin chargeback queries).
const zeroUsage = (row: LedgerRow): boolean => CATEGORIES.every(([, column]) => row[column] === 0);

interface Tally {
  key: HistoryKey;
  counts: { requests: number; pricedRequests: number; partialRequests: number; unpricedRequests: number; unattributedRequests: number };
  tokens: TokenTotals;
  known: TokenTotals;
  listCcu: Decimal;
  contractCcu: Decimal;
}

function addRow(tally: Tally, { row, classified }: HistoryRow): void {
  const { outcome } = classified;
  tally.counts.requests += 1;
  if (classified.attribution === null) tally.counts.unattributedRequests += 1;
  if (outcome.kind === "unpriced") tally.counts.unpricedRequests += 1;
  if (outcome.kind === "priced" || outcome.kind === "partial") {
    tally.counts[`${outcome.kind}Requests`] += 1;
    tally.listCcu = tally.listCcu.plus(outcome.listCcu);
    tally.contractCcu = tally.contractCcu.plus(outcome.ccu);
  }
  for (const [category, column] of CATEGORIES) {
    const value = row[column];
    if (!isCount(value)) continue;
    tally.tokens[category] += value;
    tally.known[category] += 1;
  }
}

function toDocument(tally: Tally, options: BuildOptions): ChargebackDailyDocument {
  const closed = isDayClosed(tally.key.day, options.now, options.closeAfterDays);
  const totals = {
    ...tally.key,
    month: tally.key.day.slice(0, 7),
    ...tally.counts,
    tokens: tally.tokens,
    tokensKnownRequests: tally.known,
    listCcu: tally.listCcu.toFixed(),
    contractCcu: tally.contractCcu.toFixed(),
    rateCardVersion: options.rateCardVersion,
    contractScheduleVersion: options.contractScheduleVersion,
    closed,
  };
  const doc: ChargebackDailyDocument = { id: historyDocumentId(tally.key), schema: HISTORY_SCHEMA, ...totals, computedAt: options.now.toISOString(), contentHash: "" };
  return withClosed(doc, closed);
}

// The content hash covers every total and `closed`, in the document's field order.
function totalsHash(doc: ChargebackDailyDocument, closed: boolean): string {
  const { id: _id, schema: _schema, computedAt: _computedAt, contentHash: _contentHash, ...totals } = doc;
  return sha256(JSON.stringify({ ...totals, closed }));
}

const withClosed = (doc: ChargebackDailyDocument, closed: boolean): ChargebackDailyDocument => ({ ...doc, closed, contentHash: totalsHash(doc, closed) });

const emptyTally = (key: HistoryKey): Tally => ({
  key,
  counts: { requests: 0, pricedRequests: 0, partialRequests: 0, unpricedRequests: 0, unattributedRequests: 0 },
  tokens: zeroTokens(),
  known: zeroTokens(),
  listCcu: new Money(0),
  contractCcu: new Money(0),
});

// Rows without usage (refused before any backend call, or every token count zero) and rows without a valid time
// (no day) are left out.
export function buildDailyDocuments(rows: readonly HistoryRow[], options: BuildOptions): ChargebackDailyDocument[] {
  const tallies = new Map<string, Tally>();
  for (const historyRow of rows) {
    if (historyRow.classified.outcome.kind === "no_usage" || zeroUsage(historyRow.row)) continue;
    const timestamp = historyRow.row.timestamp;
    if (typeof timestamp !== "string" || !UTC_INSTANT.test(timestamp)) continue;
    const key = keyOf(historyRow, timestamp.slice(0, 10));
    const id = historyDocumentId(key);
    const tally = tallies.get(id) ?? emptyTally(key);
    tallies.set(id, tally);
    addRow(tally, historyRow);
  }
  return [...tallies.values()].map((tally) => toDocument(tally, options)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const storedSummaryOf = (doc: ChargebackDailyDocument): StoredSummary => ({
  key: { day: doc.day, chargebackId: doc.chargebackId, projectId: doc.projectId, classification: doc.classification, personId: doc.personId, model: doc.model },
  contentHash: doc.contentHash,
  closed: doc.closed,
  requests: doc.requests,
  computedAt: doc.computedAt,
});

const sum = (values: Iterable<{ requests: number }>): number => [...values].reduce((n, v) => n + v.requests, 0);

// A day is planned as a whole, because a row can move between documents of its day (a late trace adds its
// chargeback ID or person): a stored document the run no longer computes is zeroed, a day whose total would fall is
// refused, and an open day is rewritten only when its last write is OPEN_REWRITE_MINUTES old, all of it at once.
// Closing is two-phase and never deferred: a day due to close whose totals differ from the stored ones is written
// open first; once every document of the day holds its final totals, they are all written closed. A day with any
// closed document is frozen: its other documents may only be closed with unchanged totals (finishing an interrupted
// close); every new, changed or zeroed document of it is refused (closedRefused), so a key that moves after the close
// can never be counted twice.
export function planHistoryWrites(docs: readonly ChargebackDailyDocument[], stored: ReadonlyMap<string, StoredSummary>, options: PlanOptions): HistoryPlan {
  const plan: HistoryPlan = { writes: [], loweringCount: 0, unchanged: 0, notDue: 0, closedSkipped: 0, closedRefused: 0, shrinkRefused: 0, budgetDeferred: 0, coverage: new Map() };
  const byDay = new Map<string, { lowering: ChargebackDailyDocument[]; raising: ChargebackDailyDocument[] }>();
  const days = new Map<string, { docs: ChargebackDailyDocument[]; stored: Array<[string, StoredSummary]> }>();
  const dayOf = (day: string) => days.get(day) ?? days.set(day, { docs: [], stored: [] }).get(day)!;
  for (const doc of docs) dayOf(doc.day).docs.push(doc);
  for (const entry of stored) if (options.coveredDays.has(entry[1].key.day)) dayOf(entry[1].key.day).stored.push(entry);
  for (const [day, group] of days) {
    const lowering: ChargebackDailyDocument[] = [];
    const raising: ChargebackDailyDocument[] = [];
    byDay.set(day, { lowering, raising });
    const computed = new Set(group.docs.map((d) => d.id));
    const zeroed = group.stored.filter(([id, s]) => !computed.has(id) && !s.closed).map(([, s]) => toDocument(emptyTally(s.key), options));
    const all = [...group.docs, ...zeroed];
    // Stored open with exactly these totals: only `closed` would change.
    const settled = (doc: ChargebackDailyDocument) => stored.get(doc.id)?.contentHash === totalsHash(doc, false);
    if (group.stored.some(([, s]) => s.closed)) {
      plan.coverage.set(day, "closed");
      for (const doc of all) {
        if (stored.get(doc.id)?.closed) plan.closedSkipped += 1;
        else if (settled(doc)) raising.push(withClosed(doc, true));
        else plan.closedRefused += 1;
      }
      continue;
    }
    if (sum(all) < sum(group.stored.map(([, s]) => s))) {
      plan.shrinkRefused += all.length;
      plan.coverage.set(day, "open");
      continue;
    }
    const closing = isDayClosed(day, options.now, options.closeAfterDays);
    plan.coverage.set(day, closing && all.every(settled) ? "closed" : "open");
    if (closing && all.every(settled)) {
      raising.push(...all.map((doc) => withClosed(doc, true)));
      continue;
    }
    const lastWrite = Math.max(...group.stored.map(([, s]) => Date.parse(s.computedAt)));
    const due = closing || !(options.now.getTime() - lastWrite < OPEN_REWRITE_MINUTES * 60_000);
    for (const computedDoc of all) {
      const doc = closing ? withClosed(computedDoc, false) : computedDoc;
      const current = stored.get(doc.id);
      if (current?.contentHash === doc.contentHash) plan.unchanged += 1;
      else if (!due) plan.notDue += 1;
      else if (current !== undefined && doc.requests < current.requests) lowering.push(doc);
      else raising.push(doc);
    }
  }
  const selected: Array<{ lowering: ChargebackDailyDocument[]; raising: ChargebackDailyDocument[] }> = [];
  let count = 0;
  for (const day of [...byDay.keys()].sort()) {
    const writes = byDay.get(day)!;
    const n = writes.lowering.length + writes.raising.length;
    if (n === 0) continue;
    if (plan.budgetDeferred > 0 || (count > 0 && count + n > (options.maxWrites ?? Infinity))) {
      plan.budgetDeferred += n;
      plan.coverage.delete(day);
    }
    else {
      selected.push(writes);
      count += n;
    }
  }
  for (const day of options.coveredDays) if (!days.has(day)) plan.coverage.set(day, isDayClosed(day, options.now, options.closeAfterDays) ? "closed" : "open");
  plan.writes = selected.flatMap((w) => w.lowering);
  plan.loweringCount = plan.writes.length;
  plan.writes.push(...selected.flatMap((w) => w.raising));
  return plan;
}
// The stored coverage with a plan's: new days added, open days closed, a closed day never reopened. Null: no change.
export function mergeCoverage(stored: Readonly<Record<string, DayState>> | undefined, update: ReadonlyMap<string, DayState>): Record<string, DayState> | null {
  const days: Record<string, DayState> = { ...stored };
  let changed = false;
  for (const [day, state] of [...update].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (days[day] === state || days[day] === "closed") continue;
    days[day] = state;
    changed = true;
  }
  return changed ? Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1))) : null;
}
