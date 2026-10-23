// Export for Power BI (ADR-0034, ROADMAP G7b): per chargeback ID, group and person usage for a
// period, and each onboarded group's configuration, as JSON or CSV from the admin API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleV3Request } from "../src/v3.ts";
import type { V3Dependencies } from "../src/v3.ts";
import { QueryCache } from "../src/chargeback.ts";
import type { Capability, LogTable, Operations, QueryMeta } from "../src/operations.ts";
import type { ProjectStore } from "../src/api.ts";
import type { Doc } from "../src/validation.ts";
import { EXPORT_ROWS_MAX, toCsv } from "../src/export.ts";
import { createMemoryUserTagStore } from "../src/user-tags.ts";

const rateCard = JSON.parse(await readFile(new URL("../../config/rate-card.json", import.meta.url), "utf8")) as Doc;
const sources = {
  ledger: await readFile(new URL("../../analytics/ledger.kql", import.meta.url), "utf8"),
  pricing: await readFile(new URL("../../analytics/workbooks/pricing.kql", import.meta.url), "utf8"),
  budgets: await readFile(new URL("../../analytics/workbooks/budgets.kql", import.meta.url), "utf8"),
};
const WS = "11111111-2222-4333-8444-555555555555";
const APIM = "/subscriptions/3c1d5a0e-8f2b-4c6d-9e1a-7b2f4d8c0a11/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim";
const ENV = { ADMIN_WORKSPACE_ID: WS, ADMIN_GATEWAY_RESOURCE_ID: APIM, ADMIN_LOG_RESOURCE_IDS: APIM.replace("ApiManagement/service/apim", "Web/sites/r") };
const NOW = new Date("2026-10-19T12:00:00Z");
const GROUP = "abcdef01-2345-4678-9abc-def012345678";
const disabled = async (): Promise<Capability> => ({ state: "disabled", observedAt: NOW.toISOString() });

const groupDoc: Doc = {
  id: GROUP, kind: "group", groupId: GROUP, projectId: GROUP, displayName: "Payments, \"core\"", status: "active", retiredAt: null,
  backendId: "backend01", priority: 10, chargebackId: "WBS-1234.01",
  budget: { mode: "cap", perUser: { amount: 50, currency: "USD", period: "monthly" }, groupCap: { amount: 500, currency: "USD", period: "monthly" } },
  restrictedFamiliesApproved: false, familyPolicy: { aggregateLimits: {}, families: {} }, surfaces: ["chat", "code"],
  cacheProfile: { expectedCacheReadPercent: 50, basis: "suggested" },
};

function setup(table: (meta: QueryMeta, query: string) => LogTable = () => ({
  columns: [{ name: "chargebackId", type: "string" }, { name: "projectLabel", type: "string" }, { name: "person", type: "string" }, { name: "knownListUsd", type: "decimal" }],
  rows: [["WBS-1234.01", GROUP, "00000000-0000-4000-8000-000000000001", "1.25"]],
})) {
  const queries: string[] = [];
  const operations: Operations = {
    groups: disabled, inventory: disabled, deployments: disabled, logs: disabled, health: disabled, retail: disabled, billed: disabled,
    query: async (_w, query, _t, meta) => { queries.push(query); return table(meta, query); },
  };
  const projects: ProjectStore = {
    list: async () => [{ doc: groupDoc, etag: '"g"' }, { doc: { id: "P1", projectId: "P1", status: "active", classifications: {} }, etag: '"p"' }],
    read: async () => null, create: async () => "conflict", replace: async () => "precondition_failed",
  };
  const deps: V3Dependencies = {
    authenticate: async () => ({ oid: "reader", canWrite: false }), projects, catalogStore: null, userTagStore: createMemoryUserTagStore(),
    defaultCatalog: { schemaVersion: 1, models: [], rateCard }, operations, env: ENV, sources, cache: new QueryCache(),
    now: () => NOW, newId: () => "req-1", log: () => {},
  };
  const call = (path: string) => handleV3Request({ method: "GET", path: `/api/v3/${path}`, headers: () => "Bearer x", body: null }, deps);
  return { call, queries, deps };
}

test("CSV quotes every field and neutralises spreadsheet formulas", () => {
  const csv = toCsv(["a", "b", "c"], [["=SUM(1)", "x,\"y\"", null], [12.5, "+1", "-2"], ["@cmd", "\tz", "ok"]]);
  assert.equal(csv, '"a","b","c"\r\n"\'=SUM(1)","x,""y""",""\r\n"12.5","\'+1","\'-2"\r\n"\'@cmd","\'\tz","ok"\r\n');
});

test("export/groups lists each onboarded group's configuration, not baseline projects", async () => {
  const { call } = setup();
  const json = await call("export/groups?format=json");
  assert.equal(json.status, 200);
  const rows = (json.jsonBody as { rows: Doc[] }).rows;
  assert.deepEqual(rows, [{
    groupId: GROUP, displayName: "Payments, \"core\"", status: "active", chargebackId: "WBS-1234.01", priority: 10,
    budgetMode: "cap", perUserAmount: 50, perUserCurrency: "USD", groupCapAmount: 500, groupCapCurrency: "USD",
    surfaces: "chat;code", expectedCacheReadPercent: 50, cacheBasis: "suggested", restrictedFamiliesApproved: false,
  }]);
  const csv = await call("export/groups?format=csv");
  assert.equal(csv.headers?.["content-type"], "text/csv; charset=utf-8");
  assert.match(String(csv.body), /^"groupId","displayName","status","chargebackId"/);
  assert.match(String(csv.body), /"Payments, ""core"""/);
});

test("export/usage returns per chargeback ID, group and person rows for the period", async () => {
  const { call, queries } = setup();
  const json = await call("export/usage?period=month&chargeback=WBS-1234.01&format=json");
  assert.equal(json.status, 200, JSON.stringify(json.jsonBody));
  const body = json.jsonBody as Doc;
  assert.deepEqual(body.columns, ["chargebackId", "projectLabel", "person", "knownListUsd"]);
  assert.equal((body.rows as Doc[]).length, 1);
  assert.equal((body.filters as Doc).chargeback, "WBS-1234.01");
  assert.match(queries[0], /by chargebackId, projectLabel, person/);
  assert.match(queries[0], new RegExp(`take ${EXPORT_ROWS_MAX}\\b|ReportRows > ${EXPORT_ROWS_MAX}`));
  const csv = await call("export/usage?period=month&format=csv");
  assert.equal(csv.status, 200);
  assert.equal(String(csv.body).split("\r\n")[0], '"User tag","projectLabel","person","knownListUsd"');
});

test("configured export label changes CSV headings only and never loses tag values on collision", async () => {
  const { call, deps } = setup();
  await deps.userTagStore!.writeSettings({ label: "person" }, null);
  const csv = await call("export/usage?period=month&format=csv");
  assert.equal(String(csv.body).split("\r\n")[0], '"person (chargebackId)","projectLabel","person","knownListUsd"');
  assert.match(String(csv.body), /"WBS-1234.01"/);
  const json = await call("export/usage?period=month&format=json");
  assert.deepEqual((json.jsonBody as Doc).columns, ["chargebackId", "projectLabel", "person", "knownListUsd"]);
  assert.equal(((json.jsonBody as Doc).rows as Doc[])[0].chargebackId, "WBS-1234.01");
  deps.userTagStore!.readSettings = async () => { throw new Error("unavailable"); };
  assert.equal((await call("export/usage?period=month&format=csv")).status, 500);
  assert.equal(((await call("export/usage?period=month&format=csv")).jsonBody as Doc).error, "user_tag_settings_unavailable");
  assert.equal((await call("export/usage?period=month&format=json")).status, 200);
  deps.userTagStore = null;
  assert.equal((await call("export/usage?period=month&format=csv")).status, 503);
});

test("export refuses filters it cannot apply, and echoes every filter it applied", async () => {
  const { call } = setup();
  for (const param of ["tags=finance", "offset=10", "limit=5", "interval=hour"]) {
    const res = await call(`export/usage?period=month&${param}`);
    assert.equal(res.status, 400, param);
    assert.equal((res.jsonBody as Doc).error, "unknown_parameter", param);
  }
  const json = await call("export/usage?period=month&family=opus&backend=foundry-eus2&classification=group&chargeback=WBS-1");
  assert.deepEqual((json.jsonBody as Doc).filters, { project: "", group: "", developer: "", model: "", backend: "foundry-eus2", family: "opus", classification: "group", chargeback: "WBS-1" });
});

test("a truncated export says so in both formats", async () => {
  const rows = Array.from({ length: 2 }, (_, i) => [`WBS-${i}`, GROUP, "p", "1", 5001, true]);
  const { call } = setup(() => ({
    columns: [{ name: "chargebackId", type: "string" }, { name: "projectLabel", type: "string" }, { name: "person", type: "string" }, { name: "knownListUsd", type: "decimal" },
      { name: "reportRows", type: "long" }, { name: "truncated", type: "bool" }],
    rows,
  }));
  const csv = await call("export/usage?period=month&format=csv");
  assert.equal(csv.status, 200);
  assert.equal(csv.headers?.["x-ccof-truncated"], "true");
  assert.equal(csv.headers?.["x-ccof-row-limit"], String(EXPORT_ROWS_MAX));
  const json = await call("export/usage?period=month&format=json");
  assert.equal((json.jsonBody as Doc).truncated, true);
  assert.equal(json.headers?.["x-ccof-truncated"], "true");
});

test("a missing rate card is reported as export_unavailable with the capability", async () => {
  const { call, deps } = setup();
  deps.defaultCatalog = null;
  const res = await call("export/usage?period=month&format=csv");
  assert.equal(res.status, 503);
  assert.equal((res.jsonBody as Doc).error, "export_unavailable");
});

test("export refuses an unknown format or view, and reports an unavailable source as 503", async () => {
  const { call } = setup();
  assert.equal((await call("export/usage?period=month&format=xml")).status, 400);
  assert.equal((await call("export/other?format=json")).status, 404);
  const failing = setup(() => { throw new Error("boom"); });
  const unavailable = await failing.call("export/usage?period=month&format=csv");
  assert.equal(unavailable.status, 503);
  assert.equal((unavailable.jsonBody as Doc).error, "export_unavailable");
  assert.equal(((unavailable.jsonBody as Doc).capability as Doc).state, "unavailable");
});
