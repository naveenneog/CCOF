// Onboarded group documents at the sync and reconciler read boundaries
// (ADR-0034 decision 4): a `kind: "group"` document in the `projects`
// container becomes one scope whose memberships carry the group's priority,
// surfaces and chargeback ID.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../src/sync/plan.ts";
import type { PlanInput } from "../src/sync/plan-types.ts";
import { readProjectDocument } from "../src/sync/projects.ts";
import { readRegistry } from "../src/reconciler/registry.ts";
import type { GroupMember, GroupReadResult } from "../src/sync/graph.ts";
import { PERSON_A, projectDoc } from "./helpers/sync-fakes.ts";
import { GROUP_A, groupDoc, restrictedPolicy } from "./helpers/group-fixtures.ts";

const NOW = new Date("2026-10-22T12:00:00.000Z");

function groupsOf(entries: Record<string, GroupMember[]>): Map<string, GroupReadResult> {
  return new Map(Object.entries(entries).map(([groupId, members]) => [groupId, { ok: true, groupId, members, pages: 1, retries: 0 }]));
}

function input(docs: unknown[], members: Record<string, GroupMember[]>, existing: PlanInput["existing"] = []): PlanInput {
  return {
    projects: docs.map(readProjectDocument),
    groups: groupsOf(members),
    existing,
    memberTypes: ["user"],
    removalLimits: { maxRemovalsPerRun: 10, maxRemovalFraction: 0.5 },
    now: NOW,
  };
}

test("the sync reads a group document as one scope carrying the group's attributes", () => {
  const read = readProjectDocument(groupDoc());
  if (!read.ok) assert.fail(JSON.stringify(read.problems));
  assert.equal(read.projectId, GROUP_A);
  assert.equal(read.classifications.length, 1);
  assert.deepEqual(read.classifications[0].group, { priority: 100, surfaces: ["chat", "code"], chargebackId: "WBS-1234.01", restrictedFamiliesApproved: false,
    perUserBudget: (groupDoc() as { budget: { perUser: unknown } }).budget.perUser });
  assert.equal(read.classifications[0].classification, "group");
});

test("a baseline project may not use the reserved scope code 'group'", () => {
  const doc = projectDoc("PILOT1");
  const classifications = doc.classifications as Record<string, unknown>;
  classifications.group = classifications.STD;
  delete classifications.STD;
  const read = readProjectDocument(doc);
  assert.equal(read.ok, false);
  if (!read.ok) assert.ok(read.problems.includes("classifications.group:reserved_code"), read.problems.join(","));
  const registry = readRegistry([doc], []);
  assert.ok(registry.problems.some((p) => p.code === "classification_invalid" && p.classification === "group" && p.field === "(reserved_code)"));
  assert.equal(registry.scopes.has("PILOT1:group"), false);
});

test("an invalid group document is refused under its group id, so the sync freezes only that group", () => {
  const read = readProjectDocument(groupDoc(GROUP_A, { priority: 0 }));
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.projectId, GROUP_A);
  assert.deepEqual(read.problems, ["priority:invalid"]);
});

test("a group member's membership carries priority, surfaces and chargeback ID", () => {
  const plan = planSync(input([groupDoc()], { [GROUP_A]: [{ id: PERSON_A, kind: "user" }] }));
  assert.equal(plan.writes.length, 1);
  const [membership] = plan.writes[0].document.projectMemberships;
  assert.deepEqual(membership.perUserBudget, (groupDoc() as { budget: { perUser: unknown } }).budget.perUser);
  assert.equal(membership.projectId, GROUP_A);
  assert.equal(membership.classification, "group");
  assert.equal(membership.classificationGroupId, GROUP_A);
  assert.equal(membership.priority, 100);
  assert.deepEqual(membership.surfaces, ["chat", "code"]);
  assert.equal(membership.chargebackId, "WBS-1234.01");
  assert.equal(membership.restrictedFamiliesApproved, false);
  assert.equal(membership.classification, "group");
  assert.equal(membership.aggregateMode, "notify");
  const perUser = { amount: 50, currency: "USD", period: "monthly" };
  const capDoc = groupDoc(GROUP_A, { budget: { mode: "cap", perUser, groupCap: { amount: 1000, currency: "USD", period: "monthly" } } });
  const capped = planSync(input([capDoc], { [GROUP_A]: [{ id: PERSON_A, kind: "user" }] }));
  assert.equal(capped.writes[0].document.projectMemberships[0].aggregateMode, "strict");
});

test("an approved group's Mythos policy reaches the membership", () => {
  const doc = groupDoc(GROUP_A, { familyPolicy: restrictedPolicy(), restrictedFamiliesApproved: true });
  const plan = planSync(input([doc], { [GROUP_A]: [{ id: PERSON_A, kind: "user" }] }));
  const [membership] = plan.writes[0].document.projectMemberships;
  assert.equal(membership.restrictedFamiliesApproved, true);
  assert.deepEqual(membership.familyPolicy.families.mythos?.models, ["claude-mythos-1"]);
  assert.deepEqual(readRegistry([doc], []).problems, []);
});

test("a baseline project and a group stay separate scopes", () => {
  const registry = readRegistry([projectDoc("PILOT1"), groupDoc()], []);
  assert.deepEqual([...registry.scopes.keys()].sort(), [`${GROUP_A}:group`, "PILOT1:PRM", "PILOT1:STD"]);
});

test("a changed chargeback ID rewrites the membership with a new denormalizedAt", () => {
  const first = planSync(input([groupDoc()], { [GROUP_A]: [{ id: PERSON_A, kind: "user" }] }));
  const stored = { doc: { ...first.writes[0].document, lastVerifiedAt: "2026-10-22T11:00:00.000Z" }, etag: '"e1"' };
  const unchanged = planSync({ ...input([groupDoc()], { [GROUP_A]: [{ id: PERSON_A, kind: "user" }] }, [stored]), now: new Date("2026-10-22T12:30:00.000Z") });
  assert.equal(unchanged.writes.length, 0);
  const later = new Date("2026-10-22T13:00:00.000Z");
  const changed = planSync({ ...input([groupDoc(GROUP_A, { chargebackId: "WBS-9999" })], { [GROUP_A]: [{ id: PERSON_A, kind: "user" }] }, [stored]), now: later });
  assert.equal(changed.writes.length, 1);
  const [membership] = changed.writes[0].document.projectMemberships;
  assert.equal(membership.chargebackId, "WBS-9999");
  assert.equal(membership.denormalizedAt, later.toISOString());
});

test("a changed per-user budget rewrites the membership, since it decides precedence", () => {
  const first = planSync(input([groupDoc()], { [GROUP_A]: [{ id: PERSON_A, kind: "user" }] }));
  const stored = { doc: { ...first.writes[0].document, lastVerifiedAt: "2026-10-22T11:00:00.000Z" }, etag: '"e1"' };
  const perUser = { amount: 99, currency: "USD", period: "monthly" };
  const changed = planSync({ ...input([groupDoc(GROUP_A, { budget: { mode: "autoScale", perUser, groupCap: null } })], { [GROUP_A]: [{ id: PERSON_A, kind: "user" }] }, [stored]), now: new Date("2026-10-22T13:00:00.000Z") });
  assert.equal(changed.writes.length, 1);
  assert.deepEqual(changed.writes[0].document.projectMemberships[0].perUserBudget, perUser);
});

test("a retired group removes every member's membership even beyond the removal limits, as a retired project does", () => {
  const people = [PERSON_A, "00000000-0000-4000-8000-00000000000b", "00000000-0000-4000-8000-00000000000c"];
  const first = planSync(input([groupDoc()], { [GROUP_A]: people.map((id) => ({ id, kind: "user" as const })) }));
  const stored = first.writes.map((w, i) => ({ doc: w.document as unknown as Record<string, unknown>, etag: `"e${i}"` }));
  const retired = planSync({ ...input([groupDoc(GROUP_A, { status: "retired", retiredAt: "2026-10-22T11:30:00Z" })], {}, stored),
    removalLimits: { maxRemovalsPerRun: 0, maxRemovalFraction: 0 } });
  assert.equal(retired.writes.length, people.length);
  assert.ok(retired.writes.every((w) => w.document.projectMemberships.length === 0));
});

test("a retired group removes its members' memberships", () => {
  const first = planSync(input([groupDoc()], { [GROUP_A]: [{ id: PERSON_A, kind: "user" }] }));
  const stored = { doc: first.writes[0].document as unknown as Record<string, unknown>, etag: '"e1"' };
  const retired = planSync(input([groupDoc(GROUP_A, { status: "retired", retiredAt: "2026-10-22T11:30:00Z" })], {}, [stored]));
  assert.equal(retired.writes.length, 1);
  assert.deepEqual(retired.writes[0].document.projectMemberships, []);
});

test("the reconciler registers a group document's scope and budgets", () => {
  const registry = readRegistry([groupDoc()], []);
  assert.deepEqual(registry.problems, []);
  const scope = registry.scopes.get(`${GROUP_A}:group`);
  assert.equal(scope?.personBudgetCcu.toString(), "5000");
  assert.equal(scope?.aggregateBudgetCcu, null);
});

test("the reconciler gives a cap group its shared cap in strict mode, and skips a retired group", () => {
  const perUser = { amount: 50, currency: "USD", period: "monthly" };
  const capped = readRegistry([groupDoc(GROUP_A, { budget: { mode: "cap", perUser, groupCap: { amount: 1000, currency: "USD", period: "monthly" } } })], []);
  const scope = capped.scopes.get(`${GROUP_A}:group`);
  assert.equal(scope?.aggregateBudgetCcu?.toString(), "100000");
  assert.equal(scope?.aggregateMode, "strict");
  const retired = readRegistry([groupDoc(GROUP_A, { status: "retired", retiredAt: "2026-10-22T11:30:00Z" })], []);
  assert.equal(retired.scopes.size, 0);
  assert.deepEqual(retired.problems, []);
});

test("the reconciler reports an invalid group document and registers nothing for it", () => {
  const registry = readRegistry([groupDoc(GROUP_A, { budget: null })], []);
  assert.equal(registry.scopes.size, 0);
  assert.deepEqual(registry.problems, [{ code: "project_invalid", projectId: GROUP_A }]);
});
