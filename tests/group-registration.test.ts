// Onboarded group documents (ADR-0034): the contract parser and the
// restricted-family rule shared with the baseline CYB classification.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readGroupRegistration } from "../src/contracts/group-registration.ts";
import { GROUP_SCOPE_CODE, parseFamilyPolicy } from "../src/contracts/model-families.ts";
import { GROUP_A, groupDoc, restrictedPolicy } from "./helpers/group-fixtures.ts";

function problemsOf(doc: unknown): string[] {
  const result = readGroupRegistration(doc);
  if (result.ok) assert.fail("expected the document to be refused");
  return result.problems;
}

function registrationOf(doc: unknown) {
  const result = readGroupRegistration(doc);
  if (!result.ok) assert.fail(JSON.stringify(result.problems));
  return result.registration;
}

test("a valid group document yields a typed registration", () => {
  const reg = registrationOf(groupDoc());
  assert.equal(reg.groupId, GROUP_A);
  assert.equal(reg.displayName, "Payments engineering");
  assert.equal(reg.priority, 100);
  assert.equal(reg.chargebackId, "WBS-1234.01");
  assert.equal(reg.restrictedFamiliesApproved, false);
  assert.deepEqual(reg.surfaces, ["chat", "code"]);
  assert.equal(reg.budget.mode, "autoScale");
  assert.equal(reg.retiredAt, null);
  assert.deepEqual(reg.cacheProfile, { expectedCacheReadPercent: 80, basis: "suggested" });
});

test("id and the partition key must equal the lower-case group id exactly", () => {
  const lettered = "abcdef01-2345-4678-9abc-def012345678";
  registrationOf(groupDoc(lettered));
  const upper = lettered.toUpperCase();
  assert.ok(problemsOf(groupDoc(lettered, { id: upper, groupId: upper, projectId: upper })).includes("groupId:invalid"));
  assert.ok(problemsOf(groupDoc(lettered, { id: upper })).includes("id:not_equal_to_groupId"));
  assert.ok(problemsOf(groupDoc(lettered, { projectId: upper })).includes("projectId:not_equal_to_groupId"));
  assert.ok(problemsOf(groupDoc(GROUP_A, { projectId: "PILOT1" })).includes("projectId:not_equal_to_groupId"));
  const noPartition = groupDoc();
  delete noPartition.projectId;
  assert.ok(problemsOf(noPartition).includes("projectId:not_equal_to_groupId"));
});

test("each invalid field is reported by path and code, never by value", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ kind: "project" }, "kind:invalid"],
    [{ unexpected: true }, "document:unexpected_key"],
    [{ groupId: "not-a-guid", id: "not-a-guid", projectId: "not-a-guid" }, "groupId:invalid"],
    [{ displayName: "" }, "displayName:invalid"],
    [{ displayName: "x".repeat(257) }, "displayName:invalid"],
    [{ status: "paused" }, "status:invalid"],
    [{ backendId: "bad id" }, "backendId:invalid"],
    [{ priority: 0 }, "priority:invalid"],
    [{ priority: 1.5 }, "priority:invalid"],
    [{ priority: "1" }, "priority:invalid"],
    [{ priority: 10001 }, "priority:invalid"],
    [{ restrictedFamiliesApproved: "yes" }, "restrictedFamiliesApproved:invalid"],
    [{ surfaces: [] }, "surfaces:invalid"],
    [{ surfaces: ["code", "code"] }, "surfaces:invalid"],
    [{ surfaces: ["email"] }, "surfaces:invalid"],
    [{ cacheProfile: { expectedCacheReadPercent: 101, basis: "custom" } }, "cacheProfile:invalid"],
    [{ cacheProfile: { expectedCacheReadPercent: -1, basis: "custom" } }, "cacheProfile:invalid"],
    [{ cacheProfile: { expectedCacheReadPercent: 50, basis: "guess" } }, "cacheProfile:invalid"],
    [{ cacheProfile: { expectedCacheReadPercent: 50, basis: "custom", note: "x" } }, "cacheProfile:invalid"],
    [{ familyPolicy: {} }, "familyPolicy:invalid_family_policy"],
  ];
  for (const [overrides, expected] of cases) {
    const problems = problemsOf(groupDoc(GROUP_A, overrides));
    assert.ok(problems.includes(expected), `${JSON.stringify(overrides)} → ${problems.join(",")}`);
    for (const problem of problems) assert.doesNotMatch(problem, /email|guess|paused|bad id/);
  }
});

test("Cosmos system properties are accepted", () => {
  registrationOf(groupDoc(GROUP_A, { _rid: "r", _etag: '"e"', _ts: 1 }));
});

test("chargeback IDs: null allowed, absent refused, and only CSV/KQL/query-safe characters", () => {
  assert.equal(registrationOf(groupDoc(GROUP_A, { chargebackId: null })).chargebackId, null);
  const doc = groupDoc();
  delete doc.chargebackId;
  assert.ok(problemsOf(doc).includes("chargebackId:invalid"));
  for (const ok of ["WBS-1234.01", "C.10000.01/02", "a", "x".repeat(64)]) registrationOf(groupDoc(GROUP_A, { chargebackId: ok }));
  for (const bad of ["", "WBS 1", "x".repeat(65), "a'b", 'a"b', "a,b", "a=b", "a%20", "a\nb", "a\\b", "-1", "=1+1", "+1", "@cmd", ".hidden", "/root"]) {
    const problems = problemsOf(groupDoc(GROUP_A, { chargebackId: bad }));
    assert.deepEqual(problems, ["chargebackId:invalid"], JSON.stringify(bad));
  }
});

test("budget modes: autoScale has no group cap, cap requires one", () => {
  const perUser = { amount: 50, currency: "USD", period: "monthly" };
  const cap = { amount: 1000, currency: "USD", period: "monthly" };
  assert.ok(problemsOf(groupDoc(GROUP_A, { budget: { mode: "autoScale", perUser, groupCap: cap } })).includes("budget.groupCap:invalid"));
  assert.ok(problemsOf(groupDoc(GROUP_A, { budget: { mode: "cap", perUser, groupCap: null } })).includes("budget.groupCap:invalid"));
  assert.ok(problemsOf(groupDoc(GROUP_A, { budget: { mode: "pool", perUser, groupCap: null } })).includes("budget.mode:invalid"));
  assert.ok(problemsOf(groupDoc(GROUP_A, { budget: { mode: "autoScale", perUser, groupCap: null, extra: 1 } })).includes("budget:invalid"));
  assert.ok(problemsOf(groupDoc(GROUP_A, { budget: { mode: "autoScale", perUser } })).includes("budget.groupCap:invalid"));
  assert.ok(problemsOf(groupDoc(GROUP_A, { budget: { mode: "autoScale", perUser: { amount: -1, currency: "USD", period: "monthly" }, groupCap: null } }))
    .includes("budget.perUser:invalid"));
  assert.equal(registrationOf(groupDoc(GROUP_A, { budget: { mode: "cap", perUser, groupCap: cap } })).budget.mode, "cap");
});

test("Fable and Mythos in a group require restrictedFamiliesApproved", () => {
  assert.ok(problemsOf(groupDoc(GROUP_A, { familyPolicy: restrictedPolicy() })).includes("familyPolicy:family_classification_forbidden"));
  assert.equal(registrationOf(groupDoc(GROUP_A, { familyPolicy: restrictedPolicy(), restrictedFamiliesApproved: true })).restrictedFamiliesApproved, true);
});

test("restricted families: CYB as before; the group code only with approval; no other code, approved or not", () => {
  const allowed = (code: string, approved: boolean) => parseFamilyPolicy(restrictedPolicy(), code, approved).ok;
  assert.equal(allowed("CYB", false), true);
  assert.equal(allowed(GROUP_SCOPE_CODE, true), true);
  assert.equal(allowed(GROUP_SCOPE_CODE, false), false);
  for (const code of ["restricted", "standard", "STD", "cyb", "Group"]) {
    assert.equal(allowed(code, true), false, code);
    assert.equal(allowed(code, false), false, code);
  }
});

test("retiredAt: required and valid when retired, null or absent when active", () => {
  assert.ok(problemsOf(groupDoc(GROUP_A, { status: "retired" })).includes("retiredAt:invalid"));
  assert.ok(problemsOf(groupDoc(GROUP_A, { status: "retired", retiredAt: "yesterday" })).includes("retiredAt:invalid"));
  assert.ok(problemsOf(groupDoc(GROUP_A, { retiredAt: "2026-10-22T10:00:00Z" })).includes("retiredAt:invalid"));
  assert.equal(registrationOf(groupDoc(GROUP_A, { retiredAt: null })).retiredAt, null);
  const retired = registrationOf(groupDoc(GROUP_A, { status: "retired", retiredAt: "2026-10-22T10:00:00Z" }));
  assert.equal(retired.status, "retired");
  assert.equal(retired.retiredAt, "2026-10-22T10:00:00Z");
});
