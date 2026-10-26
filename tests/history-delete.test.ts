// The chargeback history deletion tool (scripts/history/delete-chargeback-history.ts, council round 3 R3-5) against a
// fake chargebackDaily container: what-if by default, whole-month and one-person deletion with the coverage record kept
// consistent, months the reconciler may still write refused, and the command line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COVERAGE_ID, DeleteRefused, deleteHistory, firstProtectedMonth, parseArgs } from "../scripts/history/delete-chargeback-history.ts";
import type { CoverageRead, HistoryDeleteContainer } from "../scripts/history/delete-chargeback-history.ts";

const NOW = new Date("2026-10-26T00:00:00Z");
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

interface Doc { id: string; month: string; personId?: string; [key: string]: unknown }

function fakeContainer(docs: Doc[]) {
  const items = new Map<string, Doc & { _etag: string }>(docs.map((d) => [`${d.month}|${d.id}`, { ...d, _etag: "e1" }]));
  const calls: string[] = [];
  const container: HistoryDeleteContainer = {
    async listIds(month, personId) {
      calls.push(`list ${month} ${personId ?? "*"}`);
      return [...items.values()].filter((d) => d.month === month && d.id !== COVERAGE_ID && (personId === null || d.personId === personId)).map((d) => d.id);
    },
    async deleteItem(id, month) {
      calls.push(`delete ${month}/${id}`);
      items.delete(`${month}|${id}`);
    },
    async readCoverage(month): Promise<CoverageRead | null> {
      const c = items.get(`${month}|${COVERAGE_ID}`);
      if (c === undefined) return null;
      const { _etag, ...doc } = c;
      return { doc, etag: String(_etag) };
    },
    async replaceCoverage(doc, etag) {
      const key = `${String(doc.month)}|${COVERAGE_ID}`;
      if (items.get(key)?._etag !== etag) throw Object.assign(new Error("precondition failed"), { code: 412 });
      calls.push(`replace ${String(doc.month)}/coverage`);
      items.set(key, { ...(doc as Doc), _etag: "e2" });
    },
    async deleteCoverage(month, etag) {
      if (items.get(`${month}|${COVERAGE_ID}`)?._etag !== etag) throw Object.assign(new Error("precondition failed"), { code: 412 });
      calls.push(`delete ${month}/coverage`);
      items.delete(`${month}|${COVERAGE_ID}`);
    },
  };
  return { container, items, calls };
}

const monthDocs = (month: string): Doc[] => [
  { id: COVERAGE_ID, month, days: { [`${month}-01`]: "closed" }, expiresAt: null },
  { id: `${month}-01|a`, month, personId: ALICE },
  { id: `${month}-02|a`, month, personId: ALICE },
  { id: `${month}-01|b`, month, personId: BOB },
];

test("what-if (the default) counts the documents and deletes nothing", async () => {
  const { container, items, calls } = fakeContainer([...monthDocs("2025-01"), ...monthDocs("2025-02")]);
  const results = await deleteHistory(container, { months: ["2025-02", "2025-01"], personId: null, confirm: false, now: NOW });
  assert.deepEqual(results, [
    { month: "2025-01", documents: 3, deleted: 0, coverage: "kept" },
    { month: "2025-02", documents: 3, deleted: 0, coverage: "kept" },
  ]);
  assert.equal(items.size, 8);
  assert.equal(calls.filter((c) => c.startsWith("delete") || c.startsWith("replace")).length, 0);
  assert.equal(parseArgs(["--endpoint", "https://acct.documents.azure.com:443/", "--database", "ccof", "--month", "2025-01"]).confirm, false);
});

test("a whole month: the coverage record is deleted first, then every document of that month only", async () => {
  const { container, items, calls } = fakeContainer([...monthDocs("2025-01"), ...monthDocs("2025-02")]);
  const results = await deleteHistory(container, { months: ["2025-01"], personId: null, confirm: true, now: NOW });
  assert.deepEqual(results, [{ month: "2025-01", documents: 3, deleted: 3, coverage: "deleted" }]);
  assert.equal(calls.filter((c) => c.startsWith("delete"))[0], "delete 2025-01/coverage", "coverage first: a stopped run leaves the month refused, not covered with documents missing");
  assert.deepEqual([...items.keys()].filter((k) => k.startsWith("2025-01")), []);
  assert.equal([...items.keys()].filter((k) => k.startsWith("2025-02")).length, 4);
});

test("one person: only their documents go; the coverage notes the deletion without their ID, before any delete", async () => {
  const { container, items, calls } = fakeContainer(monthDocs("2025-01"));
  const results = await deleteHistory(container, { months: ["2025-01"], personId: ALICE, confirm: true, now: NOW });
  assert.deepEqual(results, [{ month: "2025-01", documents: 2, deleted: 2, coverage: "noted" }]);
  assert.equal(calls.find((c) => c.startsWith("delete") || c.startsWith("replace")), "replace 2025-01/coverage");
  assert.deepEqual([...items.values()].filter((d) => d.id !== COVERAGE_ID).map((d) => d.personId), [BOB]);
  const coverage = items.get(`2025-01|${COVERAGE_ID}`)!;
  assert.deepEqual(coverage.days, { "2025-01-01": "closed" });
  assert.deepEqual(coverage.personDeletions, [{ deletedAt: NOW.toISOString(), documents: 2 }]);
  assert.ok(!JSON.stringify(coverage).includes(ALICE), "the coverage record must not hold the deleted person's ID");
});

test("one person given in upper case deletes the same documents: history stores personId in lower case", async () => {
  const carol = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const docs = [...monthDocs("2025-01"), { id: "d-carol", month: "2025-01", personId: carol, day: "2025-01-01" }];
  const { container, items } = fakeContainer(docs);
  const results = await deleteHistory(container, { months: ["2025-01"], personId: carol.toUpperCase(), confirm: true, now: NOW });
  assert.deepEqual(results, [{ month: "2025-01", documents: 1, deleted: 1, coverage: "noted" }]);
  assert.ok(![...items.values()].some((d) => d.personId === carol), "the upper-case request must delete the stored lower-case documents");
  assert.equal(parseArgs(["--endpoint", "https://acct.documents.azure.com:443/", "--database", "ccof", "--month", "2025-01", "--person", carol.toUpperCase()]).personId, carol);
});

test("a person with no documents in the month changes nothing", async () => {
  const { container, calls } = fakeContainer(monthDocs("2025-01"));
  const results = await deleteHistory(container, { months: ["2025-01"], personId: "33333333-3333-4333-8333-333333333333", confirm: true, now: NOW });
  assert.deepEqual(results, [{ month: "2025-01", documents: 0, deleted: 0, coverage: "kept" }]);
  assert.equal(calls.filter((c) => !c.startsWith("list")).length, 0);
});

test("a coverage record changed since it was read stops the month before any document is deleted", async () => {
  const { container, items } = fakeContainer(monthDocs("2025-01"));
  const racing: HistoryDeleteContainer = { ...container, readCoverage: async (m) => ({ ...(await container.readCoverage(m))!, etag: "stale" }) };
  await assert.rejects(deleteHistory(racing, { months: ["2025-01"], personId: null, confirm: true, now: NOW }), /precondition/);
  assert.equal(items.size, 4);
});

test("the previous month and later are refused: the reconciler may still write them", async () => {
  assert.equal(firstProtectedMonth(NOW), "2026-09");
  assert.equal(firstProtectedMonth(new Date("2026-01-05T00:00:00Z")), "2025-12");
  const { container, calls } = fakeContainer(monthDocs("2026-09"));
  await assert.rejects(deleteHistory(container, { months: ["2026-08", "2026-09"], personId: null, confirm: true, now: NOW }), (e: unknown) => e instanceof DeleteRefused && e.code === "history_month_too_recent" && /2026-09/.test(e.message) && !/2026-08,/.test(e.message));
  assert.deepEqual(calls, []);
  const ok = await deleteHistory(container, { months: ["2026-08"], personId: null, confirm: false, now: NOW });
  assert.equal(ok[0].month, "2026-08");
});

test("the command line: months, person, confirm and the endpoint are checked", async () => {
  const base = ["--endpoint", "https://acct.documents.azure.com:443/", "--database", "ccof"];
  const args = parseArgs([...base, "--month", "2025-01", "--month", "2025-02", "--person", ALICE, "--confirm"]);
  assert.deepEqual({ months: args.months, personId: args.personId, confirm: args.confirm, container: args.container }, { months: ["2025-01", "2025-02"], personId: ALICE, confirm: true, container: "chargebackDaily" });
  for (const bad of [
    ["--database", "ccof", "--month", "2025-01"],
    ["--endpoint", "https://acct.documents.azure.com:443/", "--month", "2025-01"],
    [...base, "--month"],
    [...base, "--month", "2025-01", "--force"],
  ]) assert.throws(() => parseArgs(bad), (e: unknown) => e instanceof DeleteRefused && e.code === "history_delete_usage", bad.join(" "));
  for (const months of [[], ["2025-13"], ["2025-1"]]) {
    await assert.rejects(deleteHistory(fakeContainer([]).container, { months, personId: null, confirm: false, now: NOW }), (e: unknown) => e instanceof DeleteRefused && e.code === "history_delete_usage");
  }
});
