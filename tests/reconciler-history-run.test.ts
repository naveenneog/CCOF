// Chargeback history in a reconciler run (ADR-0044), with fakes: written after the budget states from the rows the
// run already read, unchanged documents skipped, the previous month's open days read with one extra query, and a
// history failure that never fails the budget run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryConflictError, createCachedHistoryStore } from "../src/reconciler/history-run.ts";
import type { HistoryContainer } from "../src/reconciler/history-run.ts";
import { runReconciler } from "../src/reconciler/run.ts";
import type { RunAssets } from "../src/reconciler/run.ts";
import { readReconcilerSettings } from "../src/reconciler/settings.ts";
import type { ReconcilerSettings } from "../src/reconciler/settings.ts";
import { FakeAzure, LEDGER_KQL, ManualClock, MemoryHistory, ledgerBody } from "./helpers/reconciler-fakes.ts";
import type { FakeAzureOptions } from "./helpers/reconciler-fakes.ts";
import { PERSON_A, entitlementDoc, ledgerRow, packagedRateCard, packagedSchedule, pilotProject, validSettings } from "./helpers/reconciler-fixtures.ts";

const card = packagedRateCard();
const assets: RunAssets = { rateCard: card, schedule: packagedSchedule(card), ledgerKql: LEDGER_KQL };
const FULL = { input: 1000, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, inferenceGeo: "global" };
const HISTORY = { RECONCILER_HISTORY_CONTAINER: "chargebackDaily", RECONCILER_HISTORY_CLOSE_AFTER_DAYS: "2" };

function settings(overrides: Record<string, string> = {}): ReconcilerSettings {
  const result = readReconcilerSettings(validSettings(overrides));
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.settings;
}

const charged = (timestamp: string) => ({ ...ledgerRow({ ...FULL, timestamp, ingestedAt: timestamp }), chargebackId: "WBS-100" });

function pilot(options: FakeAzureOptions): FakeAzure {
  return new FakeAzure({
    projects: [pilotProject()],
    entitlements: [entitlementDoc(PERSON_A, [{ projectId: "CCOFPILOT01", classification: "STD" }])],
    ledger: ledgerBody([charged("2026-10-11T12:00:00.0000000Z"), charged("2026-10-10T12:00:00.0000000Z")]),
    ...options,
  });
}

async function run(azure: FakeAzure, at: string, overrides: Record<string, string> = HISTORY, extra: { historyTimeBudgetMs?: number } = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const summary = await runReconciler(settings(overrides), assets, azure.deps(), { now: new ManualClock(at).now, newRunId: () => "run-1", log: (l) => lines.push(JSON.parse(l)), ...extra });
  return { summary, runLine: lines.find((l) => l.schema === "ccof.reconciler.run.v1") as Record<string, unknown> };
}

test("a run with history writes one document per day after the budget states and reports it on the run line", async () => {
  const history = new MemoryHistory();
  const { summary, runLine } = await run(pilot({ history }), "2026-10-11T13:00:00Z");
  assert.equal(summary.outcome, "written");
  assert.deepEqual(history.writes.map((d) => [d.day, d.chargebackId, d.requests, d.closed]).sort(), [["2026-10-10", "WBS-100", 1, false], ["2026-10-11", "WBS-100", 1, false]]);
  assert.deepEqual([runLine.historyOutcome, runLine.historyDocuments, runLine.historyWritten, runLine.historyUnchanged], ["written", 2, 2, 0]);
  assert.deepEqual(history.reads, ["2026-10"]);
});

test("the next run with the same rows writes nothing", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  await run(azure, "2026-10-11T13:00:00Z");
  const { runLine } = await run(azure, "2026-10-11T13:01:00Z");
  assert.equal(history.writes.length, 2);
  assert.deepEqual([runLine.historyWritten, runLine.historyUnchanged], [0, 2]);
});

test("without history settings no history is read or written and the run line has no history fields", async () => {
  const history = new MemoryHistory();
  const { runLine } = await run(pilot({ history }), "2026-10-11T13:00:00Z", {});
  assert.deepEqual([history.reads.length, history.writes.length, "historyOutcome" in runLine], [0, 0, false]);
});

test("early in a month the previous month's open days are read with one extra query and closed when due", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  azure.options.ledger = async () => {
    const last = azure.queries.at(-1)?.timespan ?? "";
    return last.startsWith("2026-11-01")
      ? ledgerBody([charged("2026-11-01T01:00:00.0000000Z")])
      : ledgerBody([charged("2026-10-29T12:00:00.0000000Z"), charged("2026-10-31T23:00:00.0000000Z")]);
  };
  const { runLine } = await run(azure, "2026-11-01T02:00:00Z");
  assert.deepEqual(azure.queries.map((q) => q.timespan), ["2026-11-01T00:00:00.000Z/2026-12-01T00:00:00.000Z", "2026-10-29T00:00:00.000Z/2026-11-01T00:00:00.000Z"]);
  // A day due to close is first written open with its final totals, then closed by the next run.
  assert.deepEqual(history.writes.map((d) => [d.month, d.day, d.closed]).sort(), [["2026-10", "2026-10-29", false], ["2026-10", "2026-10-31", false], ["2026-11", "2026-11-01", false]]);
  assert.deepEqual(history.reads.sort(), ["2026-10", "2026-11"]);
  assert.equal(runLine.historyOutcome, "written");
  await run(azure, "2026-11-01T02:01:00Z");
  assert.deepEqual([...history.docs.values()].map((d) => [d.day, d.closed]).sort(), [["2026-10-29", true], ["2026-10-31", false], ["2026-11-01", false]]);
});

test("after the previous month's last day has closed there is no extra query", async () => {
  const azure = pilot({ history: new MemoryHistory() });
  azure.options.ledger = ledgerBody([charged("2026-11-03T01:00:00.0000000Z")]);
  await run(azure, "2026-11-04T00:00:00Z");
  assert.equal(azure.queries.length, 1);
});

test("a history write failure is reported on the run line and does not fail the budget run", async () => {
  const history = new MemoryHistory();
  history.failWrite = Object.assign(new Error("throttled"), { code: 429 });
  const azure = pilot({ history });
  const { summary, runLine } = await run(azure, "2026-10-11T13:00:00Z");
  assert.equal(summary.outcome, "written");
  assert.equal(azure.budgetStates.length, 1);
  assert.deepEqual([runLine.historyOutcome, runLine.historyReason, runLine.historyErrorCode], ["failed", "history_write_failed", "429"]);
});

test("history settings without a wired history store fail history only", async () => {
  const { summary, runLine } = await run(pilot({}), "2026-10-11T13:00:00Z");
  assert.deepEqual([summary.outcome, runLine.historyOutcome, runLine.historyReason], ["written", "failed", "history_store_missing"]);
});

test("a failed budget run writes no history", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history, failProjects: new Error("down") });
  const { summary } = await run(azure, "2026-10-11T13:00:00Z");
  assert.equal(summary.outcome, "failed");
  assert.deepEqual([history.reads.length, history.writes.length], [0, 0]);
});

const KEY = { day: "2026-10-11", chargebackId: "WBS-100", projectId: "CCOFPILOT01", classification: "STD", personId: PERSON_A, model: "m" };

async function firstDocument() {
  const history = new MemoryHistory();
  await run(pilot({ history }), "2026-10-11T13:00:00Z");
  return history.writes[0];
}

test("the cached store reads a month's summaries once per 60 minutes, writes conditionally and keeps its etags current", async () => {
  const queries: string[] = [];
  const writes: Array<[string, string | undefined]> = [];
  const container: HistoryContainer = {
    querySummaries: async (month) => {
      queries.push(month);
      return [{ id: "a", key: KEY, contentHash: "h1", closed: false, requests: 1, computedAt: "2026-10-11T12:00:00.000Z", etag: "e-a" }];
    },
    write: async (doc, etag) => {
      writes.push([doc.id, etag]);
      return `e-${writes.length}`;
    },
    readCoverage: async () => null,
    writeCoverage: async () => "e-c",
  };
  const clock = new ManualClock("2026-10-11T13:00:00Z");
  const store = createCachedHistoryStore(container, clock.now);
  assert.equal((await store.readSummaries("2026-10")).get("a")?.contentHash, "h1");
  const doc = await firstDocument();
  await store.write(doc);
  await store.write(doc);
  await store.write({ ...doc, id: "a" });
  clock.advance(59 * 60);
  const cached = await store.readSummaries("2026-10");
  assert.deepEqual(writes, [[doc.id, undefined], [doc.id, "e-1"], ["a", "e-a"]], "create when absent, then If-Match with the latest etag");
  assert.deepEqual([queries.length, cached.get(doc.id)?.contentHash, cached.get(doc.id)?.etag], [1, doc.contentHash, "e-2"]);
  clock.advance(60);
  await store.readSummaries("2026-10");
  assert.equal(queries.length, 2);
});

test("a write conflict (another instance wrote first) drops the month's cache and fails history for this run", async () => {
  let queries = 0;
  const container: HistoryContainer = {
    querySummaries: async () => { queries += 1; return []; },
    write: async () => { throw new HistoryConflictError(); },
    readCoverage: async () => null,
    writeCoverage: async () => "e-c",
  };
  const store = createCachedHistoryStore(container, new ManualClock("2026-10-11T13:00:00Z").now);
  await store.readSummaries("2026-10");
  await assert.rejects(store.write(await firstDocument()), HistoryConflictError);
  await store.readSummaries("2026-10");
  assert.equal(queries, 2);
  const history = new MemoryHistory();
  history.failWrite = new HistoryConflictError();
  const { runLine } = await run(pilot({ history }), "2026-10-11T13:00:00Z");
  assert.deepEqual([runLine.historyOutcome, runLine.historyReason], ["failed", "history_conflict"]);
});

test("a failed write leaves the cached summary unchanged", async () => {
  const container: HistoryContainer = { querySummaries: async () => [], write: async () => { throw new Error("503"); }, readCoverage: async () => null, writeCoverage: async () => "e-c" };
  const store = createCachedHistoryStore(container, new ManualClock("2026-10-11T13:00:00Z").now);
  await store.readSummaries("2026-10");
  await assert.rejects(store.write(await firstDocument()));
  assert.equal((await store.readSummaries("2026-10")).size, 0);
});

for (const [name, failWhen, left] of [
  ["the zeroing write", (doc: { requests: number }) => doc.requests === 0, 1],
  ["the raising write", (doc: { requests: number }) => doc.requests > 0, 0],
] as const) {
  test(`a run interrupted at ${name} of a moved row never leaves a double count, and the next run repairs it`, async () => {
    const history = new MemoryHistory();
    const azure = pilot({ history, ledger: ledgerBody([{ ...charged("2026-10-11T12:00:00.0000000Z"), chargebackId: "" }]) });
    await run(azure, "2026-10-11T12:30:00Z");
    azure.options.ledger = ledgerBody([charged("2026-10-11T12:00:00.0000000Z")]);
    history.failWhen = failWhen;
    // One write at a time: the order of the writes decides what an interruption leaves behind.
    const interrupted = await run(azure, "2026-10-11T13:31:00Z", { ...HISTORY, RECONCILER_WRITE_CONCURRENCY: "1" });
    const total = () => [...history.docs.values()].filter((d) => d.day === "2026-10-11").reduce((n, d) => n + d.requests, 0);
    assert.deepEqual([interrupted.runLine.historyOutcome, total()], ["failed", left]);
    history.failWhen = undefined;
    await run(azure, "2026-10-11T14:32:00Z");
    assert.equal(total(), 1);
  });
}
// ---- history never holds up budgets (ADR-0044 decision 7) ----
const BUDGET_LEASE = "ccof-budget-reconciler";
const HISTORY_LEASE = "ccof-chargeback-history";

test("history runs after the budget states are written and the budget lease is released, under its own lease", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  const seen: Array<[number, boolean | undefined, boolean | undefined]> = [];
  history.before = async () => {
    seen.push([azure.budgetStates.length, azure.leases.docs.get(BUDGET_LEASE)?.doc.released, azure.leases.docs.get(HISTORY_LEASE)?.doc.released]);
  };
  const { runLine } = await run(azure, "2026-10-11T13:00:00Z");
  assert.equal(runLine.historyOutcome, "written");
  assert.ok(seen.length > 0);
  assert.deepEqual(seen[0], [1, true, false], "budget state written, budget lease released, history lease held");
  assert.equal(azure.leases.docs.get(HISTORY_LEASE)?.doc.released, true);
});

test("a hung history is stopped at its time budget: the run returns, budget states written and both leases released", async () => {
  const history = new MemoryHistory();
  history.before = () => new Promise(() => {});
  const azure = pilot({ history });
  const started = Date.now();
  const { summary, runLine } = await run(azure, "2026-10-11T13:00:00Z", HISTORY, { historyTimeBudgetMs: 50 });
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual([summary.outcome, azure.budgetStates.length, azure.leases.docs.get(BUDGET_LEASE)?.doc.released], ["written", 1, true]);
  assert.deepEqual([runLine.historyOutcome, runLine.historyReason], ["failed", "history_time_budget"]);
});

test("a slow history stops writing at its time budget and releases its lease when the write in flight ends", async () => {
  const history = new MemoryHistory();
  let calls = 0;
  history.before = () => (++calls > 1 ? new Promise((resolve) => setTimeout(resolve, 100)) : Promise.resolve());
  const azure = pilot({ history });
  const { runLine } = await run(azure, "2026-10-11T13:00:00Z", { ...HISTORY, RECONCILER_WRITE_CONCURRENCY: "1" }, { historyTimeBudgetMs: 50 });
  assert.equal(runLine.historyReason, "history_time_budget");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual([history.writes.length, azure.leases.docs.get(HISTORY_LEASE)?.doc.released], [1, true], "no write starts after the budget; the lease is released");
});

test("a failing history leaves the budget states written and the budget lease released", async () => {
  const history = new MemoryHistory();
  history.before = async () => { throw new Error("cosmos down"); };
  const azure = pilot({ history });
  const { summary, runLine } = await run(azure, "2026-10-11T13:00:00Z");
  assert.deepEqual([summary.outcome, azure.budgetStates.length, azure.leases.docs.get(BUDGET_LEASE)?.doc.released], ["written", 1, true]);
  assert.deepEqual([runLine.historyOutcome, runLine.historyReason, azure.leases.docs.get(HISTORY_LEASE)?.doc.released], ["failed", "history_read_failed", true]);
});

test("while another run holds the history lease, history is skipped and the budget run is not", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  azure.leases.docs.set(HISTORY_LEASE, { doc: { id: HISTORY_LEASE, holder: "other", acquiredAt: "", renewedAt: "", leaseExpiresAt: "2026-10-11T14:00:00.000Z", released: false }, etag: "e" });
  const { summary, runLine } = await run(azure, "2026-10-11T13:00:00Z");
  assert.deepEqual([summary.outcome, azure.budgetStates.length, runLine.historyOutcome, runLine.historyReason, history.reads.length], ["written", 1, "skipped", "history_lease_held", 0]);
});

test("the first run covers every day of the current month to now, days without usage too; coverage follows the documents", async () => {
  const history = new MemoryHistory();
  const { runLine } = await run(pilot({ history }), "2026-10-11T13:00:00Z");
  const days = history.coverage.get("2026-10")?.days ?? {};
  const expected = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, i < 8 ? "closed" : "open"]));
  assert.deepEqual(days, expected);
  assert.deepEqual([history.coverage.get("2026-10")?.schema, history.coverage.get("2026-10")?.id, runLine.historyCoverageWritten], ["ccof.chargeback.coverage.v1", "coverage", 1]);
  const again = await run(pilot({ history }), "2026-10-11T13:01:00Z");
  assert.equal(again.runLine.historyCoverageWritten, 0, "unchanged coverage is not rewritten");
});

test("coverage is not written when a history write fails", async () => {
  const history = new MemoryHistory();
  history.failWrite = new Error("503");
  await run(pilot({ history }), "2026-10-11T13:00:00Z");
  assert.equal(history.coverage.size, 0);
});

// ---- expiry (ADR-0044 decision 9): a month's documents expire together, and the coverage says when ----
const TTL = { ...HISTORY, RECONCILER_HISTORY_TTL_DAYS: "400" };
const OCTOBER_EXPIRES = Date.parse("2026-11-01T00:00:00Z") + 400 * 86_400_000;
const expiryOf = (writtenAt: string, ttl: number | undefined) => Date.parse(writtenAt) + (ttl ?? NaN) * 1000;

test("with ttlDays every document of a month expires ttlDays after the month ends, whenever it is written", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  await run(azure, "2026-10-11T13:00:00Z", TTL);
  azure.options.ledger = ledgerBody([charged("2026-10-11T12:00:00.0000000Z"), charged("2026-10-11T12:30:00.0000000Z"), charged("2026-10-10T12:00:00.0000000Z")]);
  await run(azure, "2026-10-11T14:30:00Z", TTL);
  assert.deepEqual(history.writes.map((d) => d.ttl), [Math.round((OCTOBER_EXPIRES - Date.parse("2026-10-11T13:00:00Z")) / 1000), Math.round((OCTOBER_EXPIRES - Date.parse("2026-10-11T13:00:00Z")) / 1000), Math.round((OCTOBER_EXPIRES - Date.parse("2026-10-11T14:30:00Z")) / 1000)]);
  assert.deepEqual([expiryOf("2026-10-11T13:00:00Z", history.writes[0].ttl), expiryOf("2026-10-11T14:30:00Z", history.writes[2].ttl)], [OCTOBER_EXPIRES, OCTOBER_EXPIRES]);
  const coverage = history.coverage.get("2026-10");
  assert.deepEqual([coverage?.expiresAt, coverage?.ttl], [new Date(OCTOBER_EXPIRES).toISOString(), -1], "the coverage records the expiry and never expires itself");
});

test("without ttlDays no document carries a time to live and the coverage has no expiry", async () => {
  const history = new MemoryHistory();
  await run(pilot({ history }), "2026-10-11T13:00:00Z");
  assert.deepEqual([history.writes.every((d) => d.ttl === undefined), history.coverage.get("2026-10")?.expiresAt, history.coverage.get("2026-10")?.ttl], [true, null, undefined]);
});

test("the coverage keeps the earliest expiry of any write: a lower ttlDays lowers it, a higher one does not raise it", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  await run(azure, "2026-10-11T13:00:00Z", TTL);
  await run(azure, "2026-10-11T13:01:00Z", { ...HISTORY, RECONCILER_HISTORY_TTL_DAYS: "500" });
  assert.equal(history.coverage.get("2026-10")?.expiresAt, new Date(OCTOBER_EXPIRES).toISOString());
  const lowered = await run(azure, "2026-10-11T13:02:00Z", { ...HISTORY, RECONCILER_HISTORY_TTL_DAYS: "300" });
  assert.deepEqual([history.coverage.get("2026-10")?.expiresAt, lowered.runLine.historyCoverageWritten], [new Date(OCTOBER_EXPIRES - 100 * 86_400_000).toISOString(), 1], "rewritten although no day changed");
});

test("ttlDays set after documents were written without one: the coverage assumes they expire ttlDays after the month starts", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  await run(azure, "2026-10-11T13:00:00Z");
  await run(azure, "2026-10-11T13:01:00Z", TTL);
  assert.equal(history.coverage.get("2026-10")?.expiresAt, new Date(Date.parse("2026-10-01T00:00:00Z") + 400 * 86_400_000).toISOString());
});

test("ttlDays removed (the container no longer expires anything): the coverage expiry is cleared", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  await run(azure, "2026-10-11T13:00:00Z", TTL);
  await run(azure, "2026-10-11T13:01:00Z");
  assert.equal(history.coverage.get("2026-10")?.expiresAt, null);
});

test("a time to live longer than Cosmos DB holds is capped, and the coverage records the capped expiry", async () => {
  const history = new MemoryHistory();
  await run(pilot({ history }), "2026-10-11T13:00:00Z", { ...HISTORY, RECONCILER_HISTORY_TTL_DAYS: "24855" });
  assert.deepEqual([history.writes[0].ttl, history.coverage.get("2026-10")?.expiresAt], [2_147_483_647, new Date(Date.parse("2026-10-11T13:00:00Z") + 2_147_483_647_000).toISOString()]);
});

// ---- every run-line field and reason the documentation names (council round 2, N1) ----
test("a key that appears for a closed day is refused and counted as historyClosedRefused", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history, ledger: ledgerBody([charged("2026-10-05T12:00:00.0000000Z")]) });
  await run(azure, "2026-10-08T01:00:00Z");
  await run(azure, "2026-10-08T01:01:00Z");
  assert.equal([...history.docs.values()].find((d) => d.day === "2026-10-05")?.closed, true);
  azure.options.ledger = ledgerBody([charged("2026-10-05T12:00:00.0000000Z"), { ...charged("2026-10-05T13:00:00.0000000Z"), chargebackId: "WBS-200" }]);
  const { runLine } = await run(azure, "2026-10-08T02:30:00Z");
  assert.deepEqual([runLine.historyOutcome, runLine.historyClosedRefused, runLine.historyClosedSkipped], ["written", 1, 1]);
});

test("an open day whose total would fall is not written and is counted as historyShrinkRefused", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history, ledger: ledgerBody([charged("2026-10-11T10:00:00.0000000Z"), charged("2026-10-11T11:00:00.0000000Z")]) });
  await run(azure, "2026-10-11T12:00:00Z");
  azure.options.ledger = ledgerBody([charged("2026-10-11T10:00:00.0000000Z")]);
  const { runLine } = await run(azure, "2026-10-11T13:30:00Z");
  assert.deepEqual([runLine.historyOutcome, runLine.historyShrinkRefused, [...history.docs.values()][0].requests], ["written", 1, 2]);
});

test("writes beyond the per-run limit wait for the next run and are counted as historyBudgetDeferred", async () => {
  const history = new MemoryHistory();
  const many = Array.from({ length: 1000 }, (_, i) => ({ ...charged("2026-10-10T12:00:00.0000000Z"), chargebackId: `WBS-${i}` }));
  const azure = pilot({ history, ledger: ledgerBody([...many, charged("2026-10-11T12:00:00.0000000Z")]) });
  const { runLine } = await run(azure, "2026-10-11T13:00:00Z");
  assert.deepEqual([runLine.historyOutcome, runLine.historyWritten, runLine.historyBudgetDeferred], ["written", 1000, 1]);
  assert.equal(history.coverage.get("2026-10")?.days["2026-10-11"], undefined, "a deferred day is not covered yet");
});

test("a history lease that cannot be written fails history with history_lease_unavailable and its code", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  const create = azure.leases.create.bind(azure.leases);
  azure.leases.create = async (doc: Parameters<typeof create>[0]) => {
    if (doc.id === HISTORY_LEASE) throw Object.assign(new Error("unavailable"), { code: 503 });
    return create(doc);
  };
  const { summary, runLine } = await run(azure, "2026-10-11T13:00:00Z");
  assert.deepEqual([summary.outcome, runLine.historyOutcome, runLine.historyReason, runLine.historyErrorCode], ["written", "failed", "history_lease_unavailable", "503"]);
});

test("a failed read of the previous month's open days fails history with history_ledger_read_failed", async () => {
  const history = new MemoryHistory();
  const azure = pilot({ history });
  azure.options.ledger = async () => {
    if ((azure.queries.at(-1)?.timespan ?? "").startsWith("2026-10-")) throw Object.assign(new Error("timeout"), { code: 504 });
    return ledgerBody([charged("2026-11-01T01:00:00.0000000Z")]);
  };
  const { summary, runLine } = await run(azure, "2026-11-01T02:00:00Z");
  assert.deepEqual([summary.outcome, runLine.historyOutcome, runLine.historyReason], ["written", "failed", "history_ledger_read_failed"]);
});