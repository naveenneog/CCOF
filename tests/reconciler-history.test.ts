// Chargeback history (ADR-0044): daily documents from the rows a reconciler run already priced, and the plan of
// which ones to write. Pure: rows, the stored summaries and the clock are inputs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MAX_WRITES_PER_RUN,
  OPEN_REWRITE_MINUTES,
  buildDailyDocuments,
  historyDocumentId,
  isDayClosed,
  mergeCoverage,
  planHistoryWrites,
  storedSummaryOf,
} from "../src/reconciler/history.ts";
import type { ChargebackDailyDocument, HistoryRow, StoredSummary } from "../src/reconciler/history.ts";
import type { LedgerRow } from "../src/reconciler/ledger.ts";
import { budgetPeriodAt } from "../src/reconciler/period.ts";
import { classifyRow } from "../src/reconciler/price-rows.ts";
import { PERSON_A, PERSON_B, ledgerRow, packagedRateCard, packagedSchedule } from "./helpers/reconciler-fixtures.ts";
import type { LedgerRowSpec } from "./helpers/reconciler-fixtures.ts";

const card = packagedRateCard();
const schedule = packagedSchedule(card);
const FULL = { input: 1000, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, inferenceGeo: "global" };
const versions = { rateCardVersion: card.version, contractScheduleVersion: schedule.version };

function row(spec: LedgerRowSpec & { chargebackId?: string } = {}): HistoryRow {
  const raw = { ...ledgerRow({ ...FULL, ...spec }), chargebackId: spec.chargebackId ?? "WBS-100" } as LedgerRow;
  const at = new Date(String(raw.timestamp));
  return { row: raw, classified: classifyRow(raw, budgetPeriodAt(at), card, schedule) };
}

const at = (iso: string) => new Date(iso);
const build = (rows: HistoryRow[], now = "2026-10-11T13:00:00Z", closeAfterDays = 2) =>
  buildDailyDocuments(rows, { now: at(now), closeAfterDays, ...versions });

function stored(doc: ChargebackDailyDocument, changes: Partial<StoredSummary> = {}): Map<string, StoredSummary> {
  return new Map([[doc.id, { ...storedSummaryOf(doc), ...changes }]]);
}

// The plan for days the run read whole: every day of the documents and the stored summaries.
const plan = (docs: ChargebackDailyDocument[], summaries: ReadonlyMap<string, StoredSummary>, now: string, closeAfterDays = 2) =>
  planHistoryWrites(docs, summaries, { now: at(now), closeAfterDays, ...versions, coveredDays: new Set([...docs.map((d) => d.day), ...[...summaries.values()].map((s) => s.key.day)]) });

test("one document per day, chargeback ID, group, classification, person and model, with summed totals", () => {
  const docs = build([
    row({ timestamp: "2026-10-11T08:00:00.0000000Z" }),
    row({ timestamp: "2026-10-11T09:00:00.0000000Z" }),
    row({ timestamp: "2026-10-10T09:00:00.0000000Z" }),
    row({ timestamp: "2026-10-11T09:00:00.0000000Z", personId: PERSON_B }),
    row({ timestamp: "2026-10-11T09:00:00.0000000Z", chargebackId: "WBS-200" }),
  ]);
  assert.equal(docs.length, 4);
  const main = docs.find((d) => d.day === "2026-10-11" && d.personId === PERSON_A && d.chargebackId === "WBS-100");
  assert.ok(main);
  assert.deepEqual(
    [main.month, main.projectId, main.classification, main.model, main.requests, main.pricedRequests, main.tokens.input, main.tokens.output, main.listCcu, main.contractCcu],
    ["2026-10", "CCOFPILOT01", "STD", "claude-haiku-4-5-20251001", 2, 2, 2000, 200, "0.3", "0.3"],
  );
  assert.equal(main.schema, "ccof.chargeback.daily.v1");
});

test("the id is deterministic: the same key gives the same id, a different key another, and it is Cosmos-safe", () => {
  const key = { day: "2026-10-11", chargebackId: "WBS/100", projectId: "CCOFPILOT01", classification: "STD", personId: PERSON_A, model: "m" };
  assert.equal(historyDocumentId(key), historyDocumentId({ ...key }));
  assert.notEqual(historyDocumentId(key), historyDocumentId({ ...key, model: "n" }));
  assert.match(historyDocumentId(key), /^[0-9a-f]{64}$/);
  const docs = [build([row()]), build([row()])];
  assert.equal(docs[0][0].id, docs[1][0].id);
  assert.equal(docs[0][0].contentHash, docs[1][0].contentHash);
});

test("unknown token categories are not summed and are counted as known per category", () => {
  const [doc] = build([row({ cacheRead: null }), row({ cacheRead: 50 })]);
  assert.equal(doc.requests, 2);
  assert.equal(doc.partialRequests, 1);
  assert.equal(doc.tokens.cacheRead, 50);
  assert.equal(doc.tokensKnownRequests.cacheRead, 1);
  assert.equal(doc.tokensKnownRequests.input, 2);
});

test("a row without attribution keeps its valid ids, as the report does, and is counted unattributed; an unpriced model is counted unpriced", () => {
  const docs = build([row({ attributionKnown: false, model: "claude-haiku-4-5-20251001" }), row({ model: "claude-unknown-9" })]);
  const unattributed = docs.find((d) => d.unattributedRequests === 1);
  assert.deepEqual([unattributed?.personId, unattributed?.projectId, unattributed?.classification, unattributed?.requests], [PERSON_A, "CCOFPILOT01", "STD", 1]);
  const [invalid] = build([row({ attributionKnown: false, personId: "not-a-guid" })]);
  assert.equal(invalid.personId, "");
  const unpriced = docs.find((d) => d.model === "claude-unknown-9");
  assert.deepEqual([unpriced?.unpricedRequests, unpriced?.listCcu], [1, "0"]);
});

test("a chargeback ID or model that fails its pattern is stored empty, never as free text", () => {
  const [doc] = build([row({ chargebackId: "=cmd|x", model: "bad model" })]);
  assert.deepEqual([doc.chargebackId, doc.model], ["", ""]);
});

test("a day closes closeAfterDays whole days after it ends", () => {
  assert.equal(isDayClosed("2026-10-08", at("2026-10-10T23:59:59Z"), 2), false);
  assert.equal(isDayClosed("2026-10-08", at("2026-10-11T00:00:00Z"), 2), true);
  const docs = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z" }), row({ timestamp: "2026-10-09T12:00:00.0000000Z" })], "2026-10-11T00:00:00Z");
  assert.deepEqual(docs.map((d) => [d.day, d.closed]).sort(), [["2026-10-08", true], ["2026-10-09", false]]);
});

test("the month boundary: rows of the last day of a month go to that month's partition", () => {
  const [doc] = build([row({ timestamp: "2026-10-31T23:59:59.0000000Z" })], "2026-11-01T00:05:00Z");
  assert.deepEqual([doc.month, doc.day, doc.closed], ["2026-10", "2026-10-31", false]);
  const [closed] = build([row({ timestamp: "2026-10-31T23:59:59.0000000Z" })], "2026-11-03T00:00:00Z");
  assert.equal(closed.closed, true);
});

test("a new document is written; an unchanged one is skipped", () => {
  const [doc] = build([row()]);
  assert.deepEqual(plan([doc], new Map(), "2026-10-11T13:00:00Z").writes.map((d) => d.id), [doc.id]);
  const result = plan([doc], stored(doc, { computedAt: "2026-10-11T10:00:00.000Z" }), "2026-10-11T13:00:00Z");
  assert.deepEqual([result.writes.length, result.unchanged], [0, 1]);
});

test("a late row changes the open day's totals and it is written again once the stored copy is old enough", () => {
  const first = build([row()]);
  const later = build([row(), row({ ingestedAt: "2026-10-11T12:59:00.0000000Z" })]);
  const old = stored(first[0], { computedAt: "2026-10-11T11:59:00.000Z" });
  const recent = stored(first[0], { computedAt: "2026-10-11T12:30:00.000Z" });
  assert.equal(plan(later, old, "2026-10-11T13:00:00Z").writes[0]?.requests, 2);
  const deferred = plan(later, recent, "2026-10-11T13:00:00Z");
  assert.deepEqual([deferred.writes.length, deferred.notDue], [0, 1]);
  assert.equal(OPEN_REWRITE_MINUTES, 60);
});

test("closing a day writes it at once, even if the open copy was written a minute ago", () => {
  const open = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z" })], "2026-10-10T23:59:00Z");
  const closing = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z" })], "2026-10-11T00:00:00Z");
  const result = plan(closing, stored(open[0], { computedAt: "2026-10-10T23:59:00.000Z" }), "2026-10-11T00:00:00Z");
  assert.equal(result.writes[0]?.closed, true);
});

test("a closed day is never written again, even with more rows", () => {
  const [closedDoc] = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z" })], "2026-10-11T00:00:00Z");
  const more = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z" }), row({ timestamp: "2026-10-08T13:00:00.0000000Z" })], "2026-10-12T00:00:00Z");
  const result = plan(more, stored(closedDoc), "2026-10-12T00:00:00Z");
  assert.deepEqual([result.writes.length, result.closedSkipped], [0, 1]);
});

test("a document is never replaced by one with fewer requests (rows aged out or a short read)", () => {
  const [two] = build([row(), row()]);
  const [one] = build([row()]);
  const result = plan([one], stored(two, { computedAt: "2026-10-11T00:00:00.000Z" }), "2026-10-11T13:00:00Z");
  assert.deepEqual([result.writes.length, result.shrinkRefused], [0, 1]);
});

test("a request with every token count known and zero is no usage, as in the report, and is left out", () => {
  const docs = build([row({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }), row({ input: 0, output: 0, cacheRead: null, cacheWrite5m: 0, cacheWrite1h: 0 })]);
  assert.deepEqual(docs.map((d) => d.requests), [1]);
});

test("a row that moves to another key (its trace arrived later) is not counted twice: the old document is zeroed", () => {
  const before = build([row({ requestId: "r-1", chargebackId: "" })]);
  const first = plan(before, new Map(), "2026-10-11T13:00:00Z");
  const summaries = new Map(first.writes.map((d) => [d.id, { ...storedSummaryOf(d), computedAt: "2026-10-11T11:00:00.000Z" }]));
  const after = build([row({ requestId: "r-1", chargebackId: "WBS-100" })]);
  const second = plan(after, summaries, "2026-10-11T13:00:00Z");
  const byCharge = Object.fromEntries(second.writes.map((d) => [d.chargebackId, d.requests]));
  assert.deepEqual(byCharge, { "": 0, "WBS-100": 1 });
  assert.deepEqual([second.writes[0].requests, second.loweringCount], [0, 1], "lowering writes come first, so an interrupted run can only undercount");
  assert.equal(second.writes.reduce((n, d) => n + d.requests, 0), 1);
});

test("a day is written as a whole: a recent write of the day defers every change of that day, including a moved row", () => {
  const before = build([row({ chargebackId: "" })]);
  const summaries = new Map(before.map((d) => [d.id, { ...storedSummaryOf(d), computedAt: "2026-10-11T12:30:00.000Z" }]));
  const after = build([row({ chargebackId: "WBS-100" })]);
  const deferred = plan(after, summaries, "2026-10-11T13:00:00Z");
  assert.deepEqual([deferred.writes.length, deferred.notDue], [0, 2]);
});

test("closing a day whose documents changed writes the final totals open first, and closes them at the next run", () => {
  const before = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z", chargebackId: "" })], "2026-10-09T00:00:00Z");
  const summaries = new Map(before.map((d) => [d.id, storedSummaryOf(d)]));
  const after = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z", chargebackId: "WBS-100" })], "2026-10-11T00:00:00Z");
  const settling = plan(after, summaries, "2026-10-11T00:00:00Z");
  assert.deepEqual(settling.writes.map((d) => [d.chargebackId, d.requests, d.closed]).sort(), [["", 0, false], ["WBS-100", 1, false]]);
  for (const d of settling.writes) summaries.set(d.id, storedSummaryOf(d));
  const closing = plan(after, summaries, "2026-10-11T00:01:00Z");
  assert.deepEqual(closing.writes.map((d) => [d.chargebackId, d.requests, d.closed]).sort(), [["", 0, true], ["WBS-100", 1, true]]);
});

test("a closed day is frozen as a whole: a key that moves after the close adds no new document", () => {
  const [closedDoc] = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z", chargebackId: "" })], "2026-10-11T00:00:00Z");
  const moved = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z", chargebackId: "WBS-100" })], "2026-10-12T00:00:00Z");
  const result = plan(moved, stored(closedDoc), "2026-10-12T00:00:00Z");
  assert.deepEqual([result.writes.length, result.closedRefused], [0, 1]);
});

test("a close interrupted part-way is finished by the next run: documents still open with final totals are closed", () => {
  const rows = [row({ timestamp: "2026-10-08T12:00:00.0000000Z" }), row({ timestamp: "2026-10-08T12:00:00.0000000Z", personId: PERSON_B })];
  const open = build(rows, "2026-10-10T12:00:00Z");
  const closed = build(rows, "2026-10-11T00:00:00Z");
  const summaries = new Map([[closed[0].id, storedSummaryOf(closed[0])], [open[1].id, storedSummaryOf(open[1])]]);
  const result = plan(closed, summaries, "2026-10-11T00:05:00Z");
  assert.deepEqual([result.writes.map((d) => [d.id, d.closed]), result.closedSkipped, result.closedRefused], [[[closed[1].id, true]], 1, 0]);
  const changed = build([...rows, row({ timestamp: "2026-10-08T13:00:00.0000000Z", personId: PERSON_B })], "2026-10-11T00:00:00Z");
  const refused = plan(changed, summaries, "2026-10-11T00:05:00Z");
  assert.deepEqual([refused.writes.length, refused.closedRefused], [0, 1]);
});

test("a stored document of a day the run did not read is left alone", () => {
  const [old] = build([row({ timestamp: "2026-09-30T12:00:00.0000000Z" })], "2026-10-01T00:00:00Z");
  const result = planHistoryWrites([], new Map([[old.id, storedSummaryOf(old)]]), { now: at("2026-10-11T13:00:00Z"), closeAfterDays: 2, ...versions, coveredDays: new Set(["2026-10-11"]) });
  assert.deepEqual(result, { writes: [], loweringCount: 0, unchanged: 0, notDue: 0, closedSkipped: 0, closedRefused: 0, shrinkRefused: 0, budgetDeferred: 0, coverage: new Map([["2026-10-11", "open"]]) });
});
test("a run writes at most maxWrites documents, whole days, oldest first; a first day larger than that is written whole", () => {
  const docs = build([
    row({ timestamp: "2026-10-11T09:00:00.0000000Z" }), row({ timestamp: "2026-10-11T09:00:00.0000000Z", personId: PERSON_B }),
    row({ timestamp: "2026-10-10T09:00:00.0000000Z" }), row({ timestamp: "2026-10-09T09:00:00.0000000Z" }),
  ]);
  const options = { now: at("2026-10-11T13:00:00Z"), closeAfterDays: 2, ...versions, coveredDays: new Set(["2026-10-09", "2026-10-10", "2026-10-11"]) };
  const limited = planHistoryWrites(docs, new Map(), { ...options, maxWrites: 3 });
  assert.deepEqual([limited.writes.map((d) => d.day).sort(), limited.budgetDeferred], [["2026-10-09", "2026-10-10"], 2]);
  const oneDay = planHistoryWrites(docs.filter((d) => d.day === "2026-10-11"), new Map(), { ...options, maxWrites: 1 });
  assert.deepEqual([oneDay.writes.length, oneDay.budgetDeferred], [2, 0]);
  assert.equal(HISTORY_MAX_WRITES_PER_RUN, 1000);
});

test("coverage records every covered day the plan completes: closed once all its documents are, open otherwise, none for deferred days", () => {
  const docs = build([row({ timestamp: "2026-10-08T12:00:00.0000000Z" }), row({ timestamp: "2026-10-10T12:00:00.0000000Z" }), row({ timestamp: "2026-10-11T09:00:00.0000000Z" })]);
  const coveredDays = new Set(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
  const options = { now: at("2026-10-11T13:00:00Z"), closeAfterDays: 2, ...versions, coveredDays };
  const first = planHistoryWrites(docs, new Map(), options);
  // 07 had no usage and is due: closed. 08 is due but its document is new: written open first.
  assert.deepEqual(Object.fromEntries(first.coverage), { "2026-10-07": "closed", "2026-10-08": "open", "2026-10-09": "open", "2026-10-10": "open", "2026-10-11": "open" });
  const summaries = new Map(first.writes.map((d) => [d.id, storedSummaryOf(d)]));
  const second = planHistoryWrites(docs, summaries, { ...options, now: at("2026-10-11T13:01:00Z") });
  assert.equal(second.coverage.get("2026-10-08"), "closed");
  const deferred = planHistoryWrites(docs, new Map(), { ...options, maxWrites: 1 });
  assert.deepEqual([deferred.coverage.has("2026-10-08"), deferred.coverage.has("2026-10-10"), deferred.coverage.get("2026-10-07")], [true, false, "closed"]);
});

test("coverage merges: days are added, open becomes closed, a closed day never reopens", () => {
  const stored = { "2026-10-01": "closed", "2026-10-02": "open" } as const;
  const merged = mergeCoverage(stored, new Map([["2026-10-01", "open"], ["2026-10-02", "closed"], ["2026-10-03", "open"]]));
  assert.deepEqual(merged, { "2026-10-01": "closed", "2026-10-02": "closed", "2026-10-03": "open" });
  assert.equal(mergeCoverage(merged, new Map([["2026-10-03", "open"]])), null, "no change: nothing to write");
});
