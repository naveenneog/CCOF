// Chargeback history in the usage export (ADR-0044). The reconciler writes one document per UTC day, chargeback ID,
// group, classification, person and model to the chargebackDaily container (src/reconciler/history.ts). The export
// reads the part of its range before the boundary (the first UTC month start the Log Analytics workspace still holds
// whole) from there, the rest from Log Analytics, and merges the rows per chargeback ID, group and person.

import type { Container } from "@azure/cosmos";
import { ApiError } from "./auth.ts";
import { ccuToUsdText } from "./units.ts";
import type { Doc } from "./validation.ts";
import type { GroupMetadata } from "../../analytics/workbooks/chargeback-queries.ts";
import { Money } from "../../src/cost/money.ts";
import { isUtcInstant } from "../../analytics/workbooks/queries.ts";

type TokenTotals = Record<"input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h", number>;

// The stored document (src/reconciler/history.ts ChargebackDailyDocument).
export interface HistoryDoc {
  id: string; schema: string; month: string; day: string;
  chargebackId: string; projectId: string; classification: string; personId: string; model: string;
  requests: number; pricedRequests: number; partialRequests: number; unpricedRequests: number; unattributedRequests: number;
  tokens: TokenTotals; tokensKnownRequests: TokenTotals;
  listCcu: string; contractCcu: string; rateCardVersion: string; contractScheduleVersion: string;
  closed: boolean; computedAt: string; contentHash: string;
}

export interface HistoryStore {
  // The documents of one month (the partition) with fromDay <= day < toDay.
  listDays(month: string, fromDay: string, toDay: string): Promise<HistoryDoc[]>;
  // The month's coverage (src/reconciler/history.ts CoverageDocument): the days history holds, open or closed, and
  // the earliest instant a document of the month can expire (null: never). Null: the reconciler never covered it.
  readCoverage(month: string): Promise<Coverage | null>;
}

export interface Coverage { days: Readonly<Record<string, "open" | "closed">>; expiresAt: string | null }

// A day whose documents expire within this margin is refused as expired: Cosmos DB stops returning a document once
// its time to live has passed, and the export's reads take time (ADR-0044 decision 9).
export const HISTORY_EXPIRY_MARGIN_MS = 86_400_000;

// retentionHeldFrom (ADMIN_LOG_RETENTION_HELD_FROM, ADR-0043): after Stage 5 raised the workspace retention, the
// oldest instant the workspace then held; null otherwise.
export interface HistorySettings { container: string; retentionDays: number; retentionHeldFrom: string | null }
export interface Range { from: string; to: string }
export interface HistoryFilters { project: string; group: string; developer: string; model: string; family: string; classification: string; chargeback: string }

// The export's column names that history can fill, in the Log Analytics report's meaning.
export const HISTORY_COLUMNS = [
  "chargebackId", "projectLabel", "person", "requests", "pricedRequests", "partialRequests", "unpricedRequests", "unattributedRequests",
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheWrite5mTokens", "cacheWrite1hTokens",
  "knownListCcu", "listCcu", "knownListUsd", "listUsd", "completeness", "periodStart", "periodEnd", "basis", "rateCardVersion", "retentionTruncated",
] as const;
const COUNTS = ["requests", "pricedRequests", "partialRequests", "unpricedRequests", "unattributedRequests"] as const;
const TOKENS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;
// Worst first, as the report's rollup decides it (analytics/workbooks/queries.ts).
const COMPLETENESS = ["retention_truncated", "unattributed", "unpriced_usage", "partial", "complete"];
const COSMOS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const DAY_MS = 86_400_000;

export function readHistorySettings(env: Readonly<Record<string, string | undefined>>): HistorySettings | null | "invalid" {
  const container = env.ADMIN_CHARGEBACK_HISTORY_CONTAINER?.trim();
  if (!container) return null;
  const raw = env.ADMIN_LOG_RETENTION_DAYS?.trim();
  const retentionDays = raw ? Number(raw) : 90;
  const retentionHeldFrom = env.ADMIN_LOG_RETENTION_HELD_FROM?.trim() || null;
  if (!COSMOS_NAME.test(container) || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 4383) return "invalid";
  if (retentionHeldFrom !== null && !isUtcInstant(retentionHeldFrom)) return "invalid";
  return { container, retentionDays, retentionHeldFrom };
}

// The first UTC month start the workspace still holds whole, but never after the current month's start: the current
// month always comes from Log Analytics, as before. The workspace holds rows from now - retentionDays, or, after
// a raised retention, from the later of that and retentionHeldFrom (deleted rows do not come back).
export function historyBoundary(now: Date, retentionDays: number, retentionHeldFrom: string | null = null): Date {
  const oldest = new Date(Math.max(now.getTime() - retentionDays * DAY_MS, retentionHeldFrom === null ? -Infinity : Date.parse(retentionHeldFrom)));
  const start = Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), 1);
  const whole = start === oldest.getTime() ? start : Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth() + 1, 1);
  return new Date(Math.min(whole, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

const wholeDay = (iso: string) => Date.parse(iso) % DAY_MS === 0;

export function splitRange(range: Range, boundary: Date): { history: Range | null; logs: Range | null } {
  const b = boundary.toISOString();
  if (Date.parse(range.from) >= boundary.getTime()) return { history: null, logs: range };
  const history = { from: range.from, to: Date.parse(range.to) <= boundary.getTime() ? range.to : b };
  if (!wholeDay(history.from) || !wholeDay(history.to)) throw new ApiError(400, "history_range_not_whole_days");
  return { history, logs: Date.parse(range.to) > boundary.getTime() ? { from: b, to: range.to } : null };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// One listDays call per month of the history part.
export async function readHistoryDocs(store: HistoryStore, range: Range): Promise<HistoryDoc[]> {
  const docs: HistoryDoc[] = [];
  const end = Date.parse(range.to);
  for (let at = Date.parse(range.from); at < end;) {
    const start = new Date(at);
    const next = Math.min(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1), end);
    docs.push(...(await store.listDays(day(at).slice(0, 7), day(at), day(next))));
    at = next;
  }
  return docs;
}

const familyOf = (model: string) => (/^claude-(haiku|sonnet|opus|fable|mythos)(?:[-.]|$)/i.exec(model)?.[1] ?? "unknown").toLowerCase();

function matches(doc: HistoryDoc, f: HistoryFilters, groupOf: Map<string, string>): boolean {
  return (!f.project || doc.projectId === f.project) && (!f.developer || doc.personId === f.developer) && (!f.model || doc.model === f.model)
    && (!f.family || familyOf(doc.model) === f.family) && (!f.classification || doc.classification === f.classification)
    && (!f.chargeback || doc.chargebackId === f.chargeback)
    // An onboarded group's project ID is its group ID (ADR-0034); a mapped classification group also matches.
    && (!f.group || doc.projectId.toLowerCase() === f.group || groupOf.get(`${doc.projectId}|${doc.classification}`) === f.group);
}

const worst = (a: string, b: string) => (COMPLETENESS.indexOf(a) <= COMPLETENESS.indexOf(b) ? a : b);
const usd = (ccu: string | null) => (ccu === null ? null : ccuToUsdText(ccu));

function completenessOf(row: Doc): string {
  if (Number(row.unattributedRequests) > 0) return "unattributed";
  if (Number(row.unpricedRequests) > 0) return "unpriced_usage";
  if (Number(row.partialRequests) > 0) return "partial";
  return "complete";
}

// The days of a history range the reconciler never covered (refused: no data there is not zero usage), the covered
// days whose documents expired or expire within HISTORY_EXPIRY_MARGIN_MS (refused: some of their documents may be
// gone), and the covered days not yet closed (at most an hour behind the ledger). One point read per month.
export async function historyCoverage(store: HistoryStore, range: Range, now: Date): Promise<{ uncovered: string[]; expired: string[]; expiresAt: string | null; open: string[] }> {
  const result = { uncovered: [] as string[], expired: [] as string[], expiresAt: null as string | null, open: [] as string[] };
  const months = new Map<string, Coverage | null>();
  for (let at = Date.parse(range.from); at < Date.parse(range.to); at += DAY_MS) {
    const d = day(at);
    if (!months.has(d.slice(0, 7))) months.set(d.slice(0, 7), await store.readCoverage(d.slice(0, 7)));
    const coverage = months.get(d.slice(0, 7));
    const state = coverage?.days[d];
    if (state === undefined) result.uncovered.push(d);
    else if (coverage?.expiresAt && Date.parse(coverage.expiresAt) - HISTORY_EXPIRY_MARGIN_MS <= now.getTime()) {
      result.expired.push(d);
      if (result.expiresAt === null || coverage.expiresAt < result.expiresAt) result.expiresAt = coverage.expiresAt;
    }
    else if (state !== "closed") result.open.push(d);
  }
  return result;
}

// Rows per chargeback ID, group and person, labelled as the report labels them (analytics/workbooks/pricing.kql).
export function historyRows(docs: readonly HistoryDoc[], filters: HistoryFilters, groups: readonly GroupMetadata[], period: Range): Doc[] {
  const groupOf = new Map(groups.map((g) => [`${g.projectId}|${g.classification}`, g.groupId.toLowerCase()]));
  const rows = new Map<string, { row: Doc; known: Record<string, number>; ccu: InstanceType<typeof Money>; versions: Set<string> }>();
  for (const doc of docs) {
    if (!matches(doc, filters, groupOf)) continue;
    const label = { chargebackId: doc.chargebackId || "(none)", projectLabel: doc.projectId || "(unattributed)", person: doc.personId || "(unknown Entra object id)" };
    const key = JSON.stringify(Object.values(label));
    let entry = rows.get(key);
    if (entry === undefined) {
      const row: Doc = { ...label };
      for (const c of COUNTS) row[c] = 0;
      for (const t of TOKENS) row[`${t}Tokens`] = 0;
      entry = { row, known: Object.fromEntries(TOKENS.map((t) => [t, 0])), ccu: new Money(0), versions: new Set() };
      rows.set(key, entry);
    }
    for (const c of COUNTS) entry.row[c] = Number(entry.row[c]) + doc[c];
    for (const t of TOKENS) {
      entry.row[`${t}Tokens`] = Number(entry.row[`${t}Tokens`]) + doc.tokens[t];
      entry.known[t] += doc.tokensKnownRequests[t];
    }
    entry.ccu = entry.ccu.plus(doc.listCcu);
    entry.versions.add(doc.rateCardVersion);
  }
  // A key whose requests all moved to another key (src/reconciler/history.ts zeroes it) has no row, as in the report.
  return [...rows.values()].filter(({ row }) => Number(row.requests) > 0).map(({ row, known, ccu, versions }) => {
    const knownCost = Number(row.pricedRequests) + Number(row.partialRequests) > 0 ? ccu.toFixed() : null;
    const completeness = completenessOf(row);
    const list = completeness === "complete" && Number(row.requests) > 0 ? knownCost : null;
    const out: Doc = {};
    const values: Doc = {
      ...row, ...Object.fromEntries(TOKENS.map((t) => [`${t}Tokens`, known[t] > 0 ? row[`${t}Tokens`] : null])),
      knownListCcu: knownCost, listCcu: list, knownListUsd: usd(knownCost), listUsd: usd(list), completeness,
      periodStart: period.from, periodEnd: period.to, basis: "fixed list price, not invoice", rateCardVersion: [...versions].sort().join(";"), retentionTruncated: false,
    };
    for (const column of HISTORY_COLUMNS) out[column] = values[column];
    return out;
  });
}

const ADDITIVE = new Set<string>([...COUNTS, ...TOKENS.map((t) => `${t}Tokens`)]);
const keyOf = (row: Doc) => JSON.stringify([row.chargebackId, row.projectLabel, row.person]);
const sumDecimal = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" ? new Money(a).plus(b).toFixed() : null);

function mergeRow(la: Doc, history: Doc, columns: readonly string[]): Doc {
  const merged: Doc = {};
  for (const column of columns) {
    if (ADDITIVE.has(column)) merged[column] = la[column] === null && history[column] === null ? null : Number(la[column] ?? 0) + Number(history[column] ?? 0);
    else if (column === "knownListCcu") merged[column] = la[column] === null ? history[column] : history[column] === null ? la[column] : sumDecimal(la[column], history[column]);
    else if (column === "listCcu") merged[column] = sumDecimal(la[column], history[column]);
    else if (column === "completeness") merged[column] = worst(String(la[column]), String(history[column]));
    else if (["chargebackId", "projectLabel", "person", "periodStart", "periodEnd", "basis", "retentionTruncated"].includes(column)) merged[column] = la[column];
    else if (column === "rateCardVersion") merged[column] = [...new Set([...String(history[column]).split(";"), String(la[column])])].sort().join(";");
    else merged[column] = null;
  }
  merged.knownListUsd = columns.includes("knownListUsd") ? usd(merged.knownListCcu as string | null) : merged.knownListUsd;
  merged.listUsd = columns.includes("listUsd") ? usd(merged.listCcu as string | null) : merged.listUsd;
  return Object.fromEntries(columns.map((c) => [c, merged[c]]));
}

// Log Analytics rows (null columns: there were none) with history rows; sorted as the report sorts them. Every row
// carries the whole export period: a Log Analytics row only covers the part after the boundary.
export function mergeUsageRows(laRows: readonly Doc[], laColumns: readonly string[] | null, history: readonly Doc[], period: Range): { columns: string[]; rows: Doc[] } {
  const columns = laColumns === null ? [...HISTORY_COLUMNS] : [...laColumns];
  const byKey = new Map(history.map((row) => [keyOf(row), row]));
  const rows = laRows.map((row) => {
    const match = byKey.get(keyOf(row));
    if (match === undefined) return row;
    byKey.delete(keyOf(row));
    return mergeRow(row, match, columns);
  });
  for (const row of byKey.values()) rows.push(Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
  for (const row of rows) {
    if (columns.includes("periodStart")) row.periodStart = period.from;
    if (columns.includes("periodEnd")) row.periodEnd = period.to;
  }
  const usdOf = (row: Doc) => (typeof row.knownListUsd === "string" ? Number(row.knownListUsd) : -Infinity);
  rows.sort((a, b) => String(a.chargebackId).localeCompare(String(b.chargebackId)) || String(a.projectLabel).localeCompare(String(b.projectLabel)) || usdOf(b) - usdOf(a));
  return { columns, rows };
}

// The chargebackDaily container: one single-partition query per month, only the indexed fields in its filter.
export function createCosmosHistoryStore(container: Container): HistoryStore {
  return {
    async listDays(month, fromDay, toDay) {
      const query = { query: "SELECT * FROM c WHERE c.month = @month AND c.day >= @from AND c.day < @to", parameters: [{ name: "@month", value: month }, { name: "@from", value: fromDay }, { name: "@to", value: toDay }] };
      const { resources } = await container.items.query<HistoryDoc>(query, { partitionKey: month }).fetchAll();
      return resources;
    },
    async readCoverage(month) {
      try {
        const { resource } = await container.item("coverage", month).read<{ days?: Record<string, "open" | "closed">; expiresAt?: string | null }>();
        return resource?.days ? { days: resource.days, expiresAt: resource.expiresAt ?? null } : null;
      } catch (error) {
        if ((error as { code?: unknown }).code === 404) return null;
        throw error;
      }
    },
  };
}
