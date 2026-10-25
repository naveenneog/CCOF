// Chargeback history in a reconciler run (ADR-0044), with fakes: written after the budget states from the rows the
// run already read, unchanged documents skipped, the previous month's open days read with one extra query, and a
// history failure that never fails the budget run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCachedHistoryStore } from "../src/reconciler/history-run.ts";
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

async function run(azure: FakeAzure, at: string, overrides: Record<string, string> = HISTORY) {
  const lines: Array<Record<string, unknown>> = [];
  const summary = await runReconciler(settings(overrides), assets, azure.deps(), { now: new ManualClock(at).now, newRunId: () => "run-1", log: (l) => lines.push(JSON.parse(l)) });
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
  assert.deepEqual(history.writes.map((d) => [d.month, d.day, d.closed]).sort(), [["2026-10", "2026-10-29", true], ["2026-10", "2026-10-31", false], ["2026-11", "2026-11-01", false]]);
  assert.deepEqual(history.reads.sort(), ["2026-10", "2026-11"]);
  assert.equal(runLine.historyOutcome, "written");
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

test("the cached store reads a month's summaries once per 60 minutes and keeps them current after each write", async () => {
  const queries: string[] = [];
  const upserts: string[] = [];
  const container: HistoryContainer = {
    querySummaries: async (month) => {
      queries.push(month);
      return [{ id: "a", contentHash: "h1", closed: false, requests: 1, computedAt: "2026-10-11T12:00:00.000Z" }];
    },
    upsert: async (doc) => {
      upserts.push(doc.id);
    },
  };
  const clock = new ManualClock("2026-10-11T13:00:00Z");
  const store = createCachedHistoryStore(container, clock.now);
  assert.equal((await store.readSummaries("2026-10")).get("a")?.contentHash, "h1");
  const [doc] = (await (async () => {
    const history = new MemoryHistory();
    await run(pilot({ history }), "2026-10-11T13:00:00Z");
    return history.writes;
  })());
  await store.write(doc);
  clock.advance(59 * 60);
  const cached = await store.readSummaries("2026-10");
  assert.deepEqual([queries.length, upserts, cached.get(doc.id)?.contentHash], [1, [doc.id], doc.contentHash]);
  clock.advance(60);
  await store.readSummaries("2026-10");
  assert.equal(queries.length, 2);
});

test("a failed upsert leaves the cached summary unchanged", async () => {
  const container: HistoryContainer = { querySummaries: async () => [], upsert: async () => { throw new Error("503"); } };
  const store = createCachedHistoryStore(container, new ManualClock("2026-10-11T13:00:00Z").now);
  const history = new MemoryHistory();
  await run(pilot({ history }), "2026-10-11T13:00:00Z");
  await store.readSummaries("2026-10");
  await assert.rejects(store.write(history.writes[0]));
  assert.equal((await store.readSummaries("2026-10")).size, 0);
});
