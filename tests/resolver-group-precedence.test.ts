// Precedence when a person is in several onboarded groups (ADR-0034 decision 5, owner decision
// 2026-10-23, UNKNOWNS G-A1): a selector names the group; without one, the group with the higher
// per-user monthly budget (compared in CCU, 100 CCU = 1 USD) applies; equal budgets fall back to the
// lower priority; anything still tied, a missing or malformed budget, or any baseline project among
// the candidates is refused with project_selection_required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRequest } from "../src/resolver/decide.ts";
import { activeMembership, context, entitlementWithMembership, fakeReads } from "./helpers/resolver-fixtures.ts";

const G1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const G2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const G3 = "33333333-cccc-4ccc-8ccc-333333333333";
const ccu = (amount: number) => ({ amount, currency: "CCU", period: "monthly" });
const usd = (amount: number) => ({ amount, currency: "USD", period: "monthly" });

function group(groupId: string, priority: number, perUserBudget: unknown = ccu(5000)) {
  const { subscriptionId: _ignored, ...base } = activeMembership;
  return { ...base, projectId: groupId, classification: "group", classificationGroupId: groupId, priority,
    surfaces: ["code"], chargebackId: null, restrictedFamiliesApproved: false, perUserBudget };
}

function reads(memberships: unknown[]) {
  return fakeReads({
    readEntitlement: async () => ({ ...entitlementWithMembership, projectMemberships: memberships }),
    readBudgetState: async (_person: string, projectId: string) => ({ id: `person-1:${projectId}`, personId: "person-1", projectId,
      classification: "group", spentSoFar: 1, currency: "USD", realtimeCeilingTokensPerMinute: 4200, exhausted: false,
      reconciledAt: "2026-10-09T06:12:00Z", validUntil: "2026-10-09T06:17:00Z" }),
  });
}

async function selected(memberships: unknown[], projectId?: string) {
  const result = await resolveRequest({ personId: "person-1", ...(projectId ? { projectId } : {}) }, reads(memberships), context());
  return result.refused ? `refused:${result.reason}` : result.projectId;
}

test("without a selector the group with the higher per-user budget applies, whatever its priority or position", async () => {
  assert.equal(await selected([group(G1, 1, ccu(5000)), group(G2, 100, ccu(20000)), group(G3, 50, ccu(10000))]), G2);
  assert.equal(await selected([group(G2, 100, ccu(20000)), group(G1, 1, ccu(5000))]), G2);
});

test("budgets in USD and CCU are compared in CCU (100 CCU = 1 USD)", async () => {
  assert.equal(await selected([group(G1, 1, ccu(25000)), group(G2, 100, usd(300))]), G2);
  assert.equal(await selected([group(G1, 100, ccu(25000)), group(G2, 1, usd(200))]), G1);
});

test("equal budgets fall back to the lower priority", async () => {
  assert.equal(await selected([group(G1, 100, usd(50)), group(G2, 10, ccu(5000)), group(G3, 50, ccu(100))]), G2);
});

test("equal budgets and equal priorities are refused rather than guessed", async () => {
  assert.equal(await selected([group(G1, 10, ccu(5000)), group(G2, 10, usd(50)), group(G3, 50, ccu(100))]), "refused:project_selection_required");
});

test("a selector chooses its group even when another has a higher budget", async () => {
  assert.equal(await selected([group(G1, 100, ccu(100)), group(G2, 10, ccu(90000))], G1), G1);
});

test("a baseline project among the candidates keeps the explicit-selection rule", async () => {
  assert.equal(await selected([group(G1, 10), activeMembership]), "refused:project_selection_required");
});

test("a single group needs no selector; inactive memberships do not compete", async () => {
  assert.equal(await selected([group(G1, 100)]), G1);
  assert.equal(await selected([group(G1, 100, ccu(1)), { ...group(G2, 1, ccu(99999)), status: "removed" }]), G1);
});

test("a duplicated winning group is refused as an invalid record, never resolved", async () => {
  assert.equal(await selected([group(G1, 10, ccu(9000)), group(G1, 10, ccu(9000)), group(G2, 50)]), "refused:entitlement_record_invalid");
});

test("a malformed priority on any candidate keeps the explicit-selection rule", async () => {
  for (const priority of [0, -1, 1.5, "1", null, 10_001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await selected([group(G1, 10), { ...group(G2, 50), priority }]), "refused:project_selection_required", String(priority));
  }
});

test("a missing or malformed per-user budget on any candidate keeps the explicit-selection rule", async () => {
  const { perUserBudget: _drop, ...noBudget } = group(G2, 50, ccu(90000));
  assert.equal(await selected([group(G1, 10), noBudget]), "refused:project_selection_required", "missing");
  for (const bad of [null, ccu(-1), { amount: 5, currency: "EUR", period: "monthly" }, { amount: 5, currency: "CCU", period: "daily" }]) {
    assert.equal(await selected([group(G1, 10), group(G2, 50, bad)]), "refused:project_selection_required", JSON.stringify(bad));
  }
});
