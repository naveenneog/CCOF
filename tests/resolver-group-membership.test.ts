// The resolver and an onboarded group's membership (ADR-0034): the scope code
// `group`, the explicit restricted-family approval, and the attributes the
// gateway needs (surfaces, chargeback ID) returned with the decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRequest } from "../src/resolver/decide.ts";
import { validateMembership } from "../src/resolver/freshness.ts";
import { activeMembership, context, entitlementWithMembership, fakeReads, STD_FAMILY_POLICY } from "./helpers/resolver-fixtures.ts";

const GROUP_ID = "abcdef01-2345-4678-9abc-def012345678";
const unlimited = { tokensPerMinute: null, tokenQuota: null, tokenQuotaPeriod: null };
const MYTHOS_POLICY = { ...STD_FAMILY_POLICY, families: { ...STD_FAMILY_POLICY.families, mythos: { models: ["claude-mythos-1"], person: unlimited, group: unlimited } } };

function groupMembership(overrides: Record<string, unknown> = {}) {
  const { subscriptionId: _ignored, ...base } = activeMembership;
  return {
    ...base,
    projectId: GROUP_ID,
    classification: "group",
    classificationGroupId: GROUP_ID,
    classificationGroupDisplayName: "Payments engineering",
    priority: 100,
    surfaces: ["chat", "code"],
    chargebackId: "WBS-1234.01",
    restrictedFamiliesApproved: false,
    ...overrides,
  };
}

function readsFor(membership: Record<string, unknown>) {
  return fakeReads({
    readEntitlement: async () => ({ ...entitlementWithMembership, projectMemberships: [membership] }),
    readBudgetState: async () => ({ id: `person-1:${GROUP_ID}`, personId: "person-1", projectId: GROUP_ID, classification: "group",
      spentSoFar: 1, currency: "USD", realtimeCeilingTokensPerMinute: 4200, exhausted: false,
      reconciledAt: "2026-10-09T06:12:00Z", validUntil: "2026-10-09T06:17:00Z" }),
  });
}

test("a group membership resolves with its surfaces, chargeback ID and approval flag", async () => {
  const result = await resolveRequest({ personId: "person-1" }, readsFor(groupMembership()), context());
  if (result.refused) assert.fail(JSON.stringify(result));
  assert.equal(result.projectId, GROUP_ID);
  assert.equal(result.classification, "group");
  assert.deepEqual(result.surfaces, ["chat", "code"]);
  assert.equal(result.chargebackId, "WBS-1234.01");
  assert.equal(result.restrictedFamiliesApproved, false);
});

test("an approved group's Mythos policy is valid; without approval the record is refused", async () => {
  const approved = await resolveRequest({ personId: "person-1" }, readsFor(groupMembership({ familyPolicy: MYTHOS_POLICY, restrictedFamiliesApproved: true })), context());
  if (approved.refused) assert.fail(JSON.stringify(approved));
  assert.equal(approved.restrictedFamiliesApproved, true);
  const unapproved = await resolveRequest({ personId: "person-1" }, readsFor(groupMembership({ familyPolicy: MYTHOS_POLICY })), context());
  assert.equal(unapproved.refused, true);
});

test("group attributes are validated; a malformed one makes the membership invalid", () => {
  for (const [field, value] of [
    ["restrictedFamiliesApproved", "true"], ["restrictedFamiliesApproved", undefined],
    ["surfaces", []], ["surfaces", ["email"]], ["surfaces", ["code", "code"]], ["surfaces", undefined],
    ["chargebackId", "WBS 1"], ["chargebackId", "=1+1"], ["chargebackId", undefined],
    ["priority", 0], ["priority", undefined],
  ] as [string, unknown][]) {
    const membership: Record<string, unknown> = groupMembership();
    if (value === undefined) delete membership[field];
    else membership[field] = value;
    const checked = validateMembership(membership);
    assert.equal(checked.ok, false, `${field}=${JSON.stringify(value)}`);
    if (!checked.ok) assert.equal(checked.detail, "invalid_group_attributes");
  }
});

test("approval on a baseline membership grants nothing and is not returned", async () => {
  const membership = { ...activeMembership, familyPolicy: MYTHOS_POLICY, restrictedFamiliesApproved: true };
  assert.equal(validateMembership(membership).ok, false);
  const baseline = await resolveRequest({ personId: "person-1", subscriptionId: "sub-abc" }, fakeReads(), context());
  if (baseline.refused) assert.fail(JSON.stringify(baseline));
  assert.equal("surfaces" in baseline, false);
  assert.equal("chargebackId" in baseline, false);
  assert.equal("restrictedFamiliesApproved" in baseline, false);
});
