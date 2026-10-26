// Chargeback history in the usage export (ADR-0044): months before the Log Analytics window come from the
// chargebackDaily container, later ones from Log Analytics as before, merged per chargeback ID, group and person.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Container } from "@azure/cosmos";
import { HISTORY_COLUMNS, createCosmosHistoryStore, historyBoundary, historyRows, mergeUsageRows, readHistorySettings, splitRange } from "../src/history.ts";
import type { HistoryDoc, HistoryStore } from "../src/history.ts";
import { handleV3Request } from "../src/v3.ts";
import type { V3Dependencies } from "../src/v3.ts";
import { QueryCache } from "../src/chargeback.ts";
import type { Capability, LogTable, Operations } from "../src/operations.ts";
import type { Doc } from "../src/validation.ts";
import { createMemoryUserTagStore } from "../src/user-tags.ts";

const NOW = new Date("2026-10-19T12:00:00Z");
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const GROUP = "abcdef01-2345-4678-9abc-def012345678";

function doc(day: string, changes: Partial<HistoryDoc> = {}): HistoryDoc {
  return {
    id: `${day}-${changes.personId ?? P1}-${changes.model ?? "claude-haiku-4-5"}`, schema: "ccof.chargeback.daily.v1", month: day.slice(0, 7), day,
    chargebackId: "WBS-1", projectId: "G1", classification: "group", personId: P1, model: "claude-haiku-4-5",
    requests: 2, pricedRequests: 2, partialRequests: 0, unpricedRequests: 0, unattributedRequests: 0,
    tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    tokensKnownRequests: { input: 2, output: 2, cacheRead: 2, cacheWrite5m: 2, cacheWrite1h: 2 },
    listCcu: "0.15", contractCcu: "0.15", rateCardVersion: "rc-1", contractScheduleVersion: "cs-1", closed: true, computedAt: "2026-09-04T00:00:00.000Z", contentHash: "h",
    ...changes,
  };
}

test("history settings: absent is off, a valid container is read, an invalid one is refused", () => {
  assert.equal(readHistorySettings({}), null);
  assert.deepEqual(readHistorySettings({ ADMIN_CHARGEBACK_HISTORY_CONTAINER: "chargebackDaily", ADMIN_LOG_RETENTION_DAYS: "30" }), { container: "chargebackDaily", retentionDays: 30, retentionHeldFrom: null });
  assert.deepEqual(readHistorySettings({ ADMIN_CHARGEBACK_HISTORY_CONTAINER: "chargebackDaily" }), { container: "chargebackDaily", retentionDays: 90, retentionHeldFrom: null });
  assert.deepEqual(readHistorySettings({ ADMIN_CHARGEBACK_HISTORY_CONTAINER: "chargebackDaily", ADMIN_LOG_RETENTION_DAYS: "90", ADMIN_LOG_RETENTION_HELD_FROM: "2026-09-10T00:00:00.000Z" }), { container: "chargebackDaily", retentionDays: 90, retentionHeldFrom: "2026-09-10T00:00:00.000Z" });
  assert.equal(readHistorySettings({ ADMIN_CHARGEBACK_HISTORY_CONTAINER: "chargebackDaily", ADMIN_LOG_RETENTION_HELD_FROM: "10 September" }), "invalid");
  assert.equal(readHistorySettings({ ADMIN_CHARGEBACK_HISTORY_CONTAINER: "bad/name" }), "invalid");
  assert.equal(readHistorySettings({ ADMIN_CHARGEBACK_HISTORY_CONTAINER: "chargebackDaily", ADMIN_LOG_RETENTION_DAYS: "0" }), "invalid");
});

test("the boundary is the first UTC month start the workspace still holds whole", () => {
  assert.equal(historyBoundary(NOW, 30).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(historyBoundary(new Date("2026-10-31T12:00:00Z"), 30).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(historyBoundary(new Date("2026-10-01T00:00:00Z"), 30).toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(historyBoundary(NOW, 90).toISOString(), "2026-08-01T00:00:00.000Z");
});

test("a range is split at the boundary; the history part must be whole UTC days", () => {
  const b = new Date("2026-10-01T00:00:00Z");
  assert.deepEqual(splitRange({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" }, b), { history: null, logs: { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" } });
  assert.deepEqual(splitRange({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" }, b), { history: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" }, logs: null });
  assert.deepEqual(splitRange({ from: "2026-09-15T00:00:00.000Z", to: "2026-10-10T06:00:00.000Z" }, b), { history: { from: "2026-09-15T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" }, logs: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-10T06:00:00.000Z" } });
  assert.throws(() => splitRange({ from: "2026-09-15T06:00:00.000Z", to: "2026-10-10T00:00:00.000Z" }, b), /history_range_not_whole_days/);
  assert.throws(() => splitRange({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-20T12:00:00.000Z" }, b), /history_range_not_whole_days/);
});

test("history rows: one per chargeback ID, group and person, filtered, with the report's labels and amounts", () => {
  const docs = [
    doc("2026-09-01"), doc("2026-09-02"), doc("2026-09-02", { model: "claude-sonnet-5" }),
    doc("2026-09-03", { personId: P2, partialRequests: 1, pricedRequests: 1, listCcu: "1" }),
    doc("2026-09-03", { chargebackId: "", projectId: "", classification: "", personId: "", unattributedRequests: 2, listCcu: "0" }),
  ];
  const rows = historyRows(docs, { project: "", group: "", developer: "", model: "", family: "", classification: "", chargeback: "" }, [], { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
  const p1 = rows.find((r) => r.person === P1);
  assert.deepEqual([p1?.chargebackId, p1?.projectLabel, p1?.requests, p1?.inputTokens, p1?.knownListCcu, p1?.listCcu, p1?.knownListUsd, p1?.completeness],
    ["WBS-1", "G1", 6, 3000, "0.45", "0.45", "0.0045", "complete"]);
  const p2 = rows.find((r) => r.person === P2);
  assert.deepEqual([p2?.listCcu, p2?.knownListCcu, p2?.completeness], [null, "1", "partial"]);
  const none = rows.find((r) => r.chargebackId === "(none)");
  assert.deepEqual([none?.projectLabel, none?.person, none?.completeness], ["(unattributed)", "(unknown Entra object id)", "unattributed"]);
  assert.deepEqual(Object.keys(p1 ?? {}), [...HISTORY_COLUMNS]);
  const onlySonnet = historyRows(docs, { project: "", group: "", developer: "", model: "", family: "sonnet", classification: "", chargeback: "" }, [], { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(onlySonnet.map((r) => r.requests), [2]);
  const byGroup = historyRows(docs, { project: "", group: GROUP, developer: "", model: "", family: "", classification: "", chargeback: "" },
    [{ projectId: "G1", classification: "group", groupId: GROUP, displayName: null }], { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(byGroup.map((r) => r.person).sort(), [P1, P2]);
});

test("a zeroed document (its request moved to another key) adds no row", () => {
  const zero = doc("2026-09-04", { chargebackId: "", requests: 0, pricedRequests: 0, listCcu: "0", tokensKnownRequests: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
  const rows = historyRows([zero, doc("2026-09-04")], { project: "", group: "", developer: "", model: "", family: "", classification: "", chargeback: "" }, [], { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(rows.map((r) => r.chargebackId), ["WBS-1"]);
});
test("merging adds counts, tokens and amounts by key and empties columns history cannot fill", () => {
  const history = historyRows([doc("2026-09-30")], { project: "", group: "", developer: "", model: "", family: "", classification: "", chargeback: "" }, [], { from: "2026-09-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" });
  const laColumns = ["chargebackId", "projectLabel", "person", "requests", "knownListCcu", "listCcu", "knownListUsd", "listUsd", "inputTokens", "failedRequests", "completeness", "periodStart", "periodEnd"];
  const la: Doc[] = [
    { chargebackId: "WBS-1", projectLabel: "G1", person: P1, requests: 3, knownListCcu: "1.5", listCcu: "1.5", knownListUsd: "0.015", listUsd: "0.015", inputTokens: 10, failedRequests: 1, completeness: "complete", periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-10T00:00:00Z" },
    { chargebackId: "WBS-2", projectLabel: "G1", person: P2, requests: 1, knownListCcu: null, listCcu: null, knownListUsd: null, listUsd: null, inputTokens: null, failedRequests: 0, completeness: "unpriced_usage", periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-10T00:00:00Z" },
  ];
  const period = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" };
  const merged = mergeUsageRows(la, laColumns, history, period);
  assert.deepEqual(merged.columns, laColumns);
  const both = merged.rows.find((r) => r.chargebackId === "WBS-1");
  assert.deepEqual([both?.requests, both?.knownListCcu, both?.listCcu, both?.knownListUsd, both?.inputTokens, both?.failedRequests, both?.completeness], [5, "1.65", "1.65", "0.0165", 1010, null, "complete"]);
  const logsOnly = merged.rows.find((r) => r.chargebackId === "WBS-2");
  assert.deepEqual([logsOnly?.failedRequests, logsOnly?.completeness], [0, "unpriced_usage"]);
  // Every row of a split export covers the whole export period, not the Log Analytics part.
  assert.deepEqual(merged.rows.map((r) => [r.periodStart, r.periodEnd]), [[period.from, period.to], [period.from, period.to]]);
  assert.deepEqual(mergeUsageRows([], null, history, period).columns, [...HISTORY_COLUMNS]);
});

// ---- export/usage end to end ----
const rateCard = JSON.parse(await readFile(new URL("../../config/rate-card.json", import.meta.url), "utf8")) as Doc;
const sources = {
  ledger: await readFile(new URL("../../analytics/ledger.kql", import.meta.url), "utf8"),
  pricing: await readFile(new URL("../../analytics/workbooks/pricing.kql", import.meta.url), "utf8"),
  budgets: await readFile(new URL("../../analytics/workbooks/budgets.kql", import.meta.url), "utf8"),
};
const WS = "11111111-2222-4333-8444-555555555555";
const APIM = "/subscriptions/3c1d5a0e-8f2b-4c6d-9e1a-7b2f4d8c0a11/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim";
const HISTORY_ENV = { ADMIN_WORKSPACE_ID: WS, ADMIN_GATEWAY_RESOURCE_ID: APIM, ADMIN_CHARGEBACK_HISTORY_CONTAINER: "chargebackDaily", ADMIN_LOG_RETENTION_DAYS: "30" };
const disabled = async (): Promise<Capability> => ({ state: "disabled", observedAt: NOW.toISOString() });

const SEPTEMBER = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, "0")}`, "closed"])) as Record<string, "open" | "closed">;

function setup(env: Record<string, string> = HISTORY_ENV, docs: HistoryDoc[] = [doc("2026-09-01"), doc("2026-09-30")], coverage: Record<string, Record<string, "open" | "closed">> = { "2026-09": SEPTEMBER }, expires: Record<string, string> = {}) {
  const timespans: string[] = [];
  const reads: Array<{ month: string; fromDay: string; toDay: string }> = [];
  const operations: Operations = {
    groups: disabled, inventory: disabled, deployments: disabled, logs: disabled, health: disabled, retail: disabled, billed: disabled,
    query: async (_w, _q, timespan): Promise<LogTable> => {
      timespans.push(timespan);
      return { columns: [{ name: "chargebackId", type: "string" }, { name: "projectLabel", type: "string" }, { name: "person", type: "string" }, { name: "requests", type: "long" }],
        rows: [["WBS-1", "G1", P1, 1]] };
    },
  };
  const chargebackHistory: HistoryStore = {
    listDays: async (month, fromDay, toDay) => {
      reads.push({ month, fromDay, toDay });
      return docs.filter((d) => d.month === month && d.day >= fromDay && d.day < toDay);
    },
    readCoverage: async (month) => (coverage[month] ? { days: coverage[month], expiresAt: expires[month] ?? null } : null),
  };
  const deps: V3Dependencies = {
    authenticate: async () => ({ oid: "reader", canWrite: false }), projects: null, catalogStore: null, userTagStore: createMemoryUserTagStore(),
    defaultCatalog: { schemaVersion: 1, models: [], rateCard }, operations, env, sources, cache: new QueryCache(),
    now: () => NOW, newId: () => "req-1", log: () => {}, chargebackHistory,
  };
  const call = (path: string) => handleV3Request({ method: "GET", path: `/api/v3/${path}`, headers: () => "******", body: null }, deps);
  return { call, timespans, reads, deps };
}

test("the previous month beyond the workspace window is exported from history, with the administrator's tag heading", async () => {
  const { call, timespans, reads, deps } = setup();
  await deps.userTagStore!.writeSettings({ label: "WBS ID" }, null);
  const csv = await call("export/usage?period=previous&format=csv");
  assert.equal(csv.status, 200, JSON.stringify(csv.jsonBody));
  assert.deepEqual(timespans, []);
  assert.deepEqual(reads, [{ month: "2026-09", fromDay: "2026-09-01", toDay: "2026-10-01" }]);
  const [header, first] = String(csv.body).split("\r\n");
  assert.equal(header, HISTORY_COLUMNS.map((c) => `"${c === "chargebackId" ? "WBS ID" : c}"`).join(","));
  assert.match(first, /^"WBS-1","G1","00000000-0000-4000-8000-000000000001","4"/);
  const json = await call("export/usage?period=previous&format=json");
  assert.deepEqual((json.jsonBody as Doc).sources, [{ source: "chargebackHistory", from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", openDays: [] }]);
});

test("a range across the boundary reads history before it and Log Analytics after it, and merges the rows", async () => {
  const { call, timespans } = setup();
  const json = await call("export/usage?period=custom&from=2026-09-30T00:00:00Z&to=2026-10-10T00:00:00Z&format=json");
  assert.equal(json.status, 200, JSON.stringify(json.jsonBody));
  assert.deepEqual(timespans, ["2026-10-01T00:00:00.000Z/2026-10-10T00:00:00.000Z"]);
  const rows = (json.jsonBody as { rows: Doc[] }).rows;
  assert.deepEqual(rows.map((r) => [r.chargebackId, r.requests]), [["WBS-1", 3]]);
});

test("the current month stays on Log Analytics; without the history setting nothing changes", async () => {
  const withHistory = setup();
  await withHistory.call("export/usage?period=month&format=json");
  assert.deepEqual([withHistory.timespans.length, withHistory.reads.length], [1, 0]);
  const without = setup({ ADMIN_WORKSPACE_ID: WS, ADMIN_GATEWAY_RESOURCE_ID: APIM });
  await without.call("export/usage?period=previous&format=json");
  assert.deepEqual([without.timespans, without.reads.length], [["2026-09-01T00:00:00.000Z/2026-10-01T00:00:00.000Z"], 0]);
});

test("filters history cannot apply, a partial-day history range and a missing store are refused", async () => {
  const { call, deps } = setup();
  const backend = await call("export/usage?period=previous&backend=foundry-eus2&format=json");
  assert.deepEqual([backend.status, (backend.jsonBody as Doc).error], [400, "backend_filter_not_in_history"]);
  const partial = await call("export/usage?period=custom&from=2026-09-15T06:00:00Z&to=2026-10-10T00:00:00Z&format=json");
  assert.deepEqual([partial.status, (partial.jsonBody as Doc).error], [400, "history_range_not_whole_days"]);
  deps.chargebackHistory = null;
  const missing = await call("export/usage?period=previous&format=json");
  assert.deepEqual([missing.status, (missing.jsonBody as Doc).error], [503, "chargeback_history_not_configured"]);
  const invalid = setup({ ...HISTORY_ENV, ADMIN_LOG_RETENTION_DAYS: "x" });
  const refused = await invalid.call("export/usage?period=previous&format=json");
  assert.deepEqual([refused.status, (refused.jsonBody as Doc).error], [503, "chargeback_history_settings_invalid"]);
});

test("a history range with a day history never covered is refused naming the days; covered days still open are listed", async () => {
  const partial = { ...SEPTEMBER };
  for (let d = 1; d <= 14; d++) delete partial[`2026-09-${String(d).padStart(2, "0")}`];
  const { call } = setup(HISTORY_ENV, [doc("2026-09-20")], { "2026-09": partial });
  for (const format of ["json", "csv"]) {
    const refused = await call(`export/usage?period=previous&format=${format}`);
    assert.deepEqual([refused.status, (refused.jsonBody as Doc).error], [409, "history_not_covered"]);
    assert.deepEqual((refused.jsonBody as Doc).uncoveredDays, Array.from({ length: 14 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`));
  }
  const narrowed = await call("export/usage?period=custom&from=2026-09-15T00:00:00Z&to=2026-10-01T00:00:00Z&format=json");
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed.jsonBody));
  const none = setup(HISTORY_ENV, [], {});
  assert.equal((await none.call("export/usage?period=previous&format=json")).status, 409, "no coverage document: nothing is covered");
  const open = setup(HISTORY_ENV, undefined, { "2026-09": { ...SEPTEMBER, "2026-09-30": "open" } });
  const json = await open.call("export/usage?period=previous&format=json");
  assert.deepEqual((json.jsonBody as { sources: Doc[] }).sources[0].openDays, ["2026-09-30"]);
  // The CSV has no sources: its open days are in a response header, empty when there are none.
  const csv = await open.call("export/usage?period=previous&format=csv");
  assert.deepEqual([csv.status, csv.headers?.["x-ccof-history-open-days"]], [200, "2026-09-30"]);
  const closed = await setup().call("export/usage?period=previous&format=csv");
  assert.equal(closed.headers?.["x-ccof-history-open-days"], "");
  const logsOnly = await setup().call("export/usage?period=month&format=csv");
  assert.equal(logsOnly.headers?.["x-ccof-history-open-days"], undefined, "no history part: no header");
});

test("a history range with a day whose documents expired, or expire within a day, is refused naming the days", async () => {
  const september = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  for (const expiresAt of ["2026-10-19T00:00:00.000Z", "2026-10-20T06:00:00.000Z"]) {
    const { call } = setup(HISTORY_ENV, undefined, { "2026-09": SEPTEMBER }, { "2026-09": expiresAt });
    for (const format of ["json", "csv"]) {
      const refused = await call(`export/usage?period=previous&format=${format}`);
      assert.deepEqual([refused.status, (refused.jsonBody as Doc).error, (refused.jsonBody as Doc).expiresAt], [409, "history_expired", expiresAt], expiresAt);
      assert.deepEqual((refused.jsonBody as Doc).expiredDays, september);
    }
  }
  const later = setup(HISTORY_ENV, undefined, { "2026-09": SEPTEMBER }, { "2026-09": "2026-10-20T12:00:01.000Z" });
  assert.equal((await later.call("export/usage?period=previous&format=json")).status, 200, "more than a day before expiry");
});

test("the Cosmos store reads the coverage's days and expiry; a coverage written before expiry was recorded has none", async () => {
  const stored: Record<string, unknown> = { "2026-09": { days: SEPTEMBER, expiresAt: "2027-10-06T00:00:00.000Z" }, "2026-08": { days: SEPTEMBER } };
  const container = { item: (id: string, month: string) => ({ read: async () => ({ resource: id === "coverage" ? stored[month] : undefined }) }) } as unknown as Container;
  const store = createCosmosHistoryStore(container);
  assert.deepEqual(await store.readCoverage("2026-09"), { days: SEPTEMBER, expiresAt: "2027-10-06T00:00:00.000Z" });
  assert.deepEqual(await store.readCoverage("2026-08"), { days: SEPTEMBER, expiresAt: null });
  assert.equal(await store.readCoverage("2026-07"), null);
});

// ADR-0043/0044: after a retention change the workspace holds rows from the later of now - retention and the
// instant Stage 5 recorded (ADMIN_LOG_RETENTION_HELD_FROM): raising retention does not bring back deleted rows.
test("the boundary follows what the workspace holds after retention is raised, lowered or left unchanged", () => {
  const raisedOn = "2026-09-10T00:00:00.000Z"; // 30 days held when raised to 90 on 10 October
  assert.equal(historyBoundary(NOW, 90, raisedOn).toISOString(), "2026-10-01T00:00:00.000Z", "raised: September is not in the workspace yet");
  assert.equal(historyBoundary(new Date("2027-01-15T00:00:00Z"), 90, raisedOn).toISOString(), "2026-11-01T00:00:00.000Z", "once now - retention passes the recorded instant, retention alone decides");
  assert.equal(historyBoundary(NOW, 30, null).toISOString(), "2026-10-01T00:00:00.000Z", "lowered: no instant is recorded");
  assert.equal(historyBoundary(NOW, 90, null).toISOString(), "2026-08-01T00:00:00.000Z", "unchanged");
});

test("after retention is raised, the months the workspace never held are exported from history", async () => {
  const { call, timespans, reads } = setup({ ...HISTORY_ENV, ADMIN_LOG_RETENTION_DAYS: "90", ADMIN_LOG_RETENTION_HELD_FROM: "2026-09-10T00:00:00.000Z" });
  const json = await call("export/usage?period=previous&format=json");
  assert.equal(json.status, 200, JSON.stringify(json.jsonBody));
  assert.deepEqual([timespans, reads.map((r) => r.month)], [[], ["2026-09"]]);
});