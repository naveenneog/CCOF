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
}

// What the reconciler keeps of a stored document to plan the next write.
export interface StoredSummary {
  contentHash: string;
  closed: boolean;
  requests: number;
  computedAt: string;
}

export interface BuildOptions {
  now: Date;
  closeAfterDays: number;
  rateCardVersion: string;
  contractScheduleVersion: string;
}

export interface HistoryPlan {
  writes: ChargebackDailyDocument[];
  unchanged: number;
  notDue: number;
  closedSkipped: number;
  shrinkRefused: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const valid = (value: unknown, pattern: RegExp): string => (typeof value === "string" && pattern.test(value) ? value : "");
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const zeroTokens = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

// A Cosmos id may not hold / \ ? or #, and a chargeback ID may hold "/": the id is a digest of the key.
export function historyDocumentId(key: HistoryKey): string {
  return sha256(JSON.stringify([key.day, key.chargebackId, key.projectId, key.classification, key.personId, key.model]));
}

export function isDayClosed(day: string, now: Date, closeAfterDays: number): boolean {
  return now.getTime() >= Date.parse(`${day}T00:00:00Z`) + (1 + closeAfterDays) * DAY_MS;
}

function keyOf({ row, classified }: HistoryRow, day: string): HistoryKey {
  const attributed = classified.attribution !== null;
  return {
    day,
    chargebackId: valid(row.chargebackId, CHARGEBACK_ID),
    projectId: attributed ? valid(row.projectId, ID) : "",
    classification: attributed ? valid(row.classification, ID) : "",
    personId: attributed ? valid(row.personId, GUID).toLowerCase() : "",
    model: valid(row.model, MODEL),
  };
}

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
  return {
    id: historyDocumentId(tally.key),
    schema: HISTORY_SCHEMA,
    ...totals,
    computedAt: options.now.toISOString(),
    contentHash: sha256(JSON.stringify(totals)),
  };
}

// Rows refused before any backend call carry no usage and rows without a valid time have no day: both are left out.
export function buildDailyDocuments(rows: readonly HistoryRow[], options: BuildOptions): ChargebackDailyDocument[] {
  const tallies = new Map<string, Tally>();
  for (const historyRow of rows) {
    if (historyRow.classified.outcome.kind === "no_usage") continue;
    const timestamp = historyRow.row.timestamp;
    if (typeof timestamp !== "string" || !UTC_INSTANT.test(timestamp)) continue;
    const key = keyOf(historyRow, timestamp.slice(0, 10));
    const id = historyDocumentId(key);
    let tally = tallies.get(id);
    if (tally === undefined) {
      tally = {
        key,
        counts: { requests: 0, pricedRequests: 0, partialRequests: 0, unpricedRequests: 0, unattributedRequests: 0 },
        tokens: zeroTokens(),
        known: zeroTokens(),
        listCcu: new Money(0),
        contractCcu: new Money(0),
      };
      tallies.set(id, tally);
    }
    addRow(tally, historyRow);
  }
  return [...tallies.values()].map((tally) => toDocument(tally, options)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const storedSummaryOf = (doc: ChargebackDailyDocument): StoredSummary => ({
  contentHash: doc.contentHash,
  closed: doc.closed,
  requests: doc.requests,
  computedAt: doc.computedAt,
});

export function planHistoryWrites(docs: readonly ChargebackDailyDocument[], stored: ReadonlyMap<string, StoredSummary>, now: Date): HistoryPlan {
  const plan: HistoryPlan = { writes: [], unchanged: 0, notDue: 0, closedSkipped: 0, shrinkRefused: 0 };
  for (const doc of docs) {
    const current = stored.get(doc.id);
    if (current === undefined) plan.writes.push(doc);
    else if (current.closed) plan.closedSkipped += 1;
    else if (doc.requests < current.requests) plan.shrinkRefused += 1;
    else if (doc.contentHash === current.contentHash) plan.unchanged += 1;
    else if (!doc.closed && now.getTime() - Date.parse(current.computedAt) < OPEN_REWRITE_MINUTES * 60_000) plan.notDue += 1;
    else plan.writes.push(doc);
  }
  return plan;
}
