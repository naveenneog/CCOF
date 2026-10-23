// Precedence when a person is in several onboarded groups (ADR-0034 decision 5, owner decision
// 2026-10-23: "person in multiple groups will receive a group with higher usage spend", UNKNOWNS G-A1):
// a selector names the group; without one, the group where the person has spent the most this UTC
// month applies. Spend is the reconciler's spentCcu in the person's budgetState for that group; no
// state for the current month counts as zero. Equal spend falls back to the lower priority; anything
// still tied, a malformed priority, or any baseline project among the candidates is refused with
// project_selection_required. A malformed spend is budget_state_invalid.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRequest } from "../src/resolver/decide.ts";
import { activeMembership, context, entitlementWithMembership, fakeReads } from "./helpers/resolver-fixtures.ts";
import { Money } from "../src/cost/money.ts";

const G1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const G2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const G3 = "33333333-cccc-4ccc-8ccc-333333333333";
// RESOLVE_NOW is 2026-10-09T06:15:00Z, so the current budget period is 2026-10.
const NOW_PERIOD = "2026-10";

function group(groupId: string, priority: number) {
  const { subscriptionId: _ignored, ...base } = activeMembership;
  return { ...base, projectId: groupId, classification: "group", classificationGroupId: groupId, priority,
    surfaces: ["code"], chargebackId: null, restrictedFamiliesApproved: false };
}

type Spend = { spentCcu?: unknown; period?: unknown; exhausted?: boolean } | null;

function state(projectId: string, spend: Spend) {
  if (spend === null) return null;
  return { id: `person-1:${projectId}`, personId: "person-1", projectId, classification: "group",
    spentCcu: "0", budgetCcu: "5000", period: NOW_PERIOD, realtimeCeilingTokensPerMinute: 4200, exhausted: false,
    computedAt: "2026-10-09T06:12:00Z", validUntil: "2026-10-09T06:17:00Z", ...spend };
}

function reads(memberships: unknown[], spend: Record<string, Spend>, calls: string[] = []) {
  return fakeReads({
    readEntitlement: async () => ({ ...entitlementWithMembership, projectMemberships: memberships }),
    readBudgetState: async (_person: string, projectId: string) => {
      calls.push(projectId);
      // The chosen group's own budget check needs a valid state; a group without one here has spent nothing.
      return state(projectId, Object.hasOwn(spend, projectId) ? spend[projectId] : {});
    },
  });
}

async function selected(memberships: unknown[], spend: Record<string, Spend> = {}, projectId?: string) {
  const result = await resolveRequest({ personId: "person-1", ...(projectId ? { projectId } : {}) }, reads(memberships, spend), context());
  return result.refused ? `refused:${result.reason}` : result.projectId;
}

test("without a selector the group with the higher month-to-date spend applies, whatever its priority or position", async () => {
  const spend = { [G1]: { spentCcu: "120" }, [G2]: { spentCcu: "4500.25" }, [G3]: { spentCcu: "900" } };
  assert.equal(await selected([group(G1, 1), group(G2, 100), group(G3, 50)], spend), G2);
  assert.equal(await selected([group(G2, 100), group(G1, 1)], spend), G2);
});

test("spend is compared as an exact decimal, not as text", async () => {
  assert.equal(await selected([group(G1, 1), group(G2, 100)], { [G1]: { spentCcu: "9.75" }, [G2]: { spentCcu: "10.5" } }), G2);
  assert.equal(await selected([group(G1, 100), group(G2, 1)], { [G1]: { spentCcu: "100" }, [G2]: { spentCcu: "99.999" } }), G1);
});

test("spend with more digits than any fixed cap, as the reconciler writes it, is compared exactly", async () => {
  // The reconciler writes Money(...).toFixed() (src/reconciler/reconcile-person.ts): no exponent, no digit limit.
  const long = new Money("123").plus("0.000000000000000000000000000000000000001").toFixed();
  assert.ok(long.length > 40, long);
  assert.equal(await selected([group(G1, 1), group(G2, 100)], { [G1]: { spentCcu: "123" }, [G2]: { spentCcu: long } }), G2);
  assert.equal(await selected([group(G1, 1), group(G2, 100)], { [G1]: { spentCcu: "1".repeat(35) }, [G2]: { spentCcu: "9" } }), G1);
  // No reader-side length cap: values that differ only in the 500th fractional digit are still ordered exactly.
  const tail = "0".repeat(498);
  assert.equal(await selected([group(G1, 1), group(G2, 100)], { [G1]: { spentCcu: `7.${tail}1` }, [G2]: { spentCcu: `7.${tail}2` } }), G2);
});

test("a winner by priority with no budget state is refused by its own budget check, not moved to another group", async () => {
  assert.equal(await selected([group(G1, 1), group(G2, 100)], { [G1]: null, [G2]: null }), "refused:budget_state_missing");
});

test("a group with no state, or a state from an earlier month, counts as no spend this month", async () => {
  assert.equal(await selected([group(G1, 1), group(G2, 100)], { [G1]: null, [G2]: { spentCcu: "3" } }), G2);
  assert.equal(await selected([group(G1, 1), group(G2, 100)], { [G1]: { spentCcu: "90000", period: "2026-09" }, [G2]: { spentCcu: "3" } }), G2);
});

test("equal spend, including no spend at the start of a month, falls back to the lower priority", async () => {
  assert.equal(await selected([group(G1, 100), group(G2, 10), group(G3, 50)], { [G1]: { spentCcu: "40" }, [G2]: { spentCcu: "40.0" }, [G3]: { spentCcu: "1" } }), G2);
  assert.equal(await selected([group(G1, 100), group(G2, 10)], { [G1]: { spentCcu: "0" }, [G2]: { spentCcu: "0" } }), G2);
  assert.equal(await selected([group(G1, 100), group(G2, 10)], { [G1]: { spentCcu: "0" }, [G2]: { spentCcu: "800", period: "2026-09" } }), G2);
});

test("equal spend and equal priorities are refused rather than guessed", async () => {
  assert.equal(await selected([group(G1, 10), group(G2, 10), group(G3, 50)], { [G1]: { spentCcu: "7" }, [G2]: { spentCcu: "7" }, [G3]: { spentCcu: "1" } }), "refused:project_selection_required");
});

test("a selector chooses its group even when another has spent more", async () => {
  assert.equal(await selected([group(G1, 100), group(G2, 10)], { [G1]: { spentCcu: "1" }, [G2]: { spentCcu: "9000" } }, G1), G1);
});

test("the higher-spend group is refused when exhausted, never skipped for another group", async () => {
  assert.equal(await selected([group(G1, 1), group(G2, 100)], { [G1]: { spentCcu: "10" }, [G2]: { spentCcu: "5000", exhausted: true } }), "refused:budget_exhausted");
});

test("a malformed spend on any candidate is budget_state_invalid, not a guess", async () => {
  for (const spentCcu of [-1, "-1", "1e3", "abc", "", null, 12, " 5", "5.", ".5"]) {
    assert.equal(await selected([group(G1, 10), group(G2, 50)], { [G1]: { spentCcu: "5" }, [G2]: { spentCcu } }), "refused:budget_state_invalid", JSON.stringify(spentCcu));
  }
});

test("a baseline project among the candidates keeps the explicit-selection rule, without reading spend", async () => {
  for (const baseline of [activeMembership, { ...activeMembership, priority: 1 }]) {
    const calls: string[] = [];
    const result = await resolveRequest({ personId: "person-1" }, reads([group(G1, 10), baseline], { [G1]: { spentCcu: "1" } }, calls), context());
    assert.equal(result.refused ? result.reason : result.projectId, "project_selection_required");
    assert.deepEqual(calls, []);
  }
});

test("a single group needs no comparison; inactive memberships do not compete", async () => {
  assert.equal(await selected([group(G1, 100)]), G1);
  assert.equal(await selected([group(G1, 100), { ...group(G2, 1), status: "removed" }], { [G1]: { spentCcu: "1" }, [G2]: { spentCcu: "99999" } }), G1);
});

test("a duplicated winning group is refused as an invalid record, never resolved", async () => {
  assert.equal(await selected([group(G1, 10), group(G1, 10), group(G2, 50)], { [G1]: { spentCcu: "900" }, [G2]: { spentCcu: "1" } }), "refused:entitlement_record_invalid");
});

test("a malformed priority on any candidate keeps the explicit-selection rule", async () => {
  for (const priority of [0, -1, 1.5, "1", null, 10_001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await selected([group(G1, 10), { ...group(G2, 50), priority }]), "refused:project_selection_required", String(priority));
  }
});

test("a failed spend read fails the request rather than choosing without it", async () => {
  const deps = fakeReads({
    readEntitlement: async () => ({ ...entitlementWithMembership, projectMemberships: [group(G1, 1), group(G2, 2)] }),
    readBudgetState: async () => { throw Object.assign(new Error("cosmos unavailable"), { code: 503 }); },
  });
  await assert.rejects(resolveRequest({ personId: "person-1" }, deps, context()), /cosmos unavailable/);
});
