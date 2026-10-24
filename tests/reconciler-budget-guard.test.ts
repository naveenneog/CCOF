// ADR-0040: projected spend (recorded + recent rate x lag), an always-on rate guard and a warning threshold.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRow } from "../src/reconciler/ledger.ts";
import { budgetPeriodAt } from "../src/reconciler/period.ts";
import { classifyRow } from "../src/reconciler/price-rows.ts";
import { reconcile, type BudgetGuard } from "../src/reconciler/reconcile.ts";
import { readRegistry } from "../src/reconciler/registry.ts";
import { PERSON_A, PERSON_B, entitlementDoc, ledgerRow, packagedRateCard, packagedSchedule, pilotProject } from "./helpers/reconciler-fixtures.ts";
import type { LedgerRowSpec } from "./helpers/reconciler-fixtures.ts";

const card = packagedRateCard();
const schedule = packagedSchedule(card);
const computedAt = new Date("2026-10-11T13:00:00.000Z");
const period = budgetPeriodAt(computedAt);
const GUARD: BudgetGuard = { warnPercent: 80, overshootPercent: 5, projectionMinutes: 5 };

// Haiku 4.5 input at USD 1 per million tokens = 100 CCU per million; the pilot person budget is 25,000 CCU and the
// worst case is 0.0011 CCU per token (tests/reconciler-reconcile.test.ts).
const spend = (ccu: number, ingestedAt: string): LedgerRowSpec => ({ input: ccu * 10_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, inferenceGeo: "global", ingestedAt, timestamp: ingestedAt.replace(/:\d\d\.\d+Z$/, ":00.0000000Z") });
const OLD = "2026-10-11T12:30:00.0000000Z";   // outside the 5-minute rate window
const RECENT = "2026-10-11T12:58:00.0000000Z"; // inside it

function person(rows: LedgerRowSpec[], guard?: BudgetGuard) {
  const registry = readRegistry([pilotProject()], [entitlementDoc(PERSON_A, [{ projectId: "CCOFPILOT01", classification: "STD" }])]);
  const classified = rows.map((spec) => classifyRow(ledgerRow(spec) as LedgerRow, period, card, schedule));
  const result = reconcile({ registry, rows: classified, rateCard: card, contractScheduleVersion: schedule.version, period, computedAt, validUntil: new Date("2026-10-11T13:10:00.000Z"), ...(guard ? { guard } : {}) });
  return result.persons.find((p) => p.doc.personId === PERSON_A)?.doc as unknown as Record<string, unknown>;
}

test("without the guard settings the document is unchanged (no warning or projection fields)", () => {
  const doc = person([spend(1000, OLD)]);
  assert.equal("warning" in doc, false);
  assert.equal("projectedCcu" in doc, false);
  assert.equal(doc.realtimeCeilingTokensPerMinute, Math.floor((25_000 - 1000) / 0.0011));
});

test("below the warning, the rate guard bounds the ceiling: 5% of the budget per 5 minutes", () => {
  const doc = person([spend(1000, OLD)], GUARD);
  assert.equal(doc.warning, false);
  assert.equal(doc.projectedCcu, "1000");
  assert.equal(doc.realtimeCeilingTokensPerMinute, Math.floor(25_000 * 0.05 / 5 / 0.0011)); // 227,272
});

test("spend ingested in the last 5 minutes is projected over the lag; older spend is not", () => {
  // 15,000 old + 3,000 recent: rate 600 CCU/min, projected 18,000 + 3,000 = 21,000 (84%).
  const doc = person([spend(15_000, OLD), spend(3000, RECENT)], { ...GUARD, overshootPercent: 20 });
  assert.equal(doc.spentCcu, "18000");
  assert.equal(doc.projectedCcu, "21000");
  assert.equal(doc.warning, true);
  assert.equal(doc.exhausted, false);
  // After the warning: (25,000 - 21,000) / 5 / 0.0011 = 727,272, below the 20% guard (909,090).
  assert.equal(doc.realtimeCeilingTokensPerMinute, 727_272);
  const quiet = person([spend(18_000, OLD)], { ...GUARD, overshootPercent: 20 });
  assert.equal(quiet.projectedCcu, "18000");
  assert.equal(quiet.warning, false);
});

test("projected spend at the budget gives a zero ceiling (refused) while exhausted keeps its recorded meaning", () => {
  // 21,000 old + 3,000 recent: projected 24,000 + 3,000 = 27,000 >= 25,000.
  const doc = person([spend(21_000, OLD), spend(3000, RECENT)], GUARD);
  assert.equal(doc.warning, true);
  assert.equal(doc.exhausted, false);
  assert.equal(doc.realtimeCeilingTokensPerMinute, 0);
});

test("recorded spend at the budget is exhausted with a zero ceiling, as before", () => {
  const doc = person([spend(25_000, OLD)], GUARD);
  assert.equal(doc.exhausted, true);
  assert.equal(doc.warning, true);
  assert.equal(doc.realtimeCeilingTokensPerMinute, 0);
});

test("the recent rate is per person: another member's recent spend does not move this person's projection", () => {
  const registry = readRegistry([pilotProject()], [
    entitlementDoc(PERSON_A, [{ projectId: "CCOFPILOT01", classification: "STD" }]),
    entitlementDoc(PERSON_B, [{ projectId: "CCOFPILOT01", classification: "STD" }]),
  ]);
  const rows = [spend(1000, OLD), { ...spend(3000, RECENT), personId: PERSON_B.toUpperCase() }]
    .map((spec) => classifyRow(ledgerRow(spec) as LedgerRow, period, card, schedule));
  const result = reconcile({ registry, rows, rateCard: card, contractScheduleVersion: schedule.version, period, computedAt, validUntil: new Date("2026-10-11T13:10:00.000Z"), guard: GUARD });
  const doc = (id: string) => result.persons.find((p) => p.doc.personId === id)?.doc;
  assert.equal(doc(PERSON_A)?.projectedCcu, "1000");
  assert.equal(doc(PERSON_B)?.projectedCcu, "6000"); // 3,000 + 3,000/5 x 5, matched although the ledger's ID is upper case
});