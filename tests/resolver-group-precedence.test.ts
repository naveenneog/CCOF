// Precedence when a person is in several onboarded groups (ADR-0034 decision 5,
// UNKNOWNS G-A1): a selector names the group; without one, the lowest priority
// applies; equal lowest priorities, or any baseline project among the
// candidates, are refused with project_selection_required as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRequest } from "../src/resolver/decide.ts";
import { activeMembership, context, entitlementWithMembership, fakeReads } from "./helpers/resolver-fixtures.ts";

const G1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const G2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const G3 = "33333333-cccc-4ccc-8ccc-333333333333";

function group(groupId: string, priority: number) {
  const { subscriptionId: _ignored, ...base } = activeMembership;
  return { ...base, projectId: groupId, classification: "group", classificationGroupId: groupId, priority,
    surfaces: ["code"], chargebackId: null, restrictedFamiliesApproved: false };
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

test("without a selector the group with the lowest priority applies, whatever the stored order", async () => {
  assert.equal(await selected([group(G1, 100), group(G2, 10), group(G3, 50)]), G2);
  assert.equal(await selected([group(G2, 10), group(G1, 100)]), G2);
});

test("equal lowest priorities are refused rather than guessed", async () => {
  assert.equal(await selected([group(G1, 10), group(G2, 10), group(G3, 50)]), "refused:project_selection_required");
});

test("a selector chooses its group even when another has a lower priority", async () => {
  assert.equal(await selected([group(G1, 100), group(G2, 10)], G1), G1);
});

test("a baseline project among the candidates keeps the explicit-selection rule", async () => {
  assert.equal(await selected([group(G1, 10), activeMembership]), "refused:project_selection_required");
});

test("a single group needs no selector; inactive memberships do not compete", async () => {
  assert.equal(await selected([group(G1, 100)]), G1);
  assert.equal(await selected([group(G1, 100), { ...group(G2, 1), status: "removed" }]), G1);
});

test("a duplicated winning group is refused as an invalid record, never resolved", async () => {
  assert.equal(await selected([group(G1, 10), group(G1, 10), group(G2, 50)]), "refused:entitlement_record_invalid");
});

test("a malformed priority on any candidate keeps the explicit-selection rule", async () => {
  for (const priority of [0, -1, 1.5, "1", null]) {
    assert.equal(await selected([group(G1, 10), { ...group(G2, 50), priority }]), "refused:project_selection_required", String(priority));
  }
});
