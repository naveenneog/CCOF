// Individual user tags (owner decision 2026-10-23, UNKNOWNS G-A2): a tag set per person in the admin
// console is the chargeback ID their group memberships carry, so every request is stamped with it
// (ADR-0025 request-time attribution). The group's own chargeback ID is the default for members
// without a tag. When the tags cannot be read, a member keeps the chargeback ID already stored.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../src/sync/plan.ts";
import type { PlanInput } from "../src/sync/plan-types.ts";
import { readProjectDocument } from "../src/sync/projects.ts";
import type { GroupMember, GroupReadResult } from "../src/sync/graph.ts";
import { MAX_SAVED_TAGS, mergeSavedTags, readUserTagDocument, readUserTagPages, suggestTags, userTagDocumentId, userTagMap } from "../src/contracts/user-tags.ts";
import { PERSON_A } from "./helpers/sync-fakes.ts";
import { GROUP_A, groupDoc } from "./helpers/group-fixtures.ts";
import * as tagContract from "../src/contracts/user-tags.ts";

test("deployment tag labels are bounded safe display text, not tag values", () => {
  assert.equal(tagContract.isUserTagLabel("WBS ID"), true);
  assert.equal(tagContract.isUserTagLabel("Équipe / coût"), true);
  for (const bad of ["", " ", " WBS", "WBS ", "=SUM(1)", "+x", "-x", "@x", "\t=x", "A\nB", "A\u007fB", "A\u0085B", "A".repeat(65), null]) {
    assert.equal(tagContract.isUserTagLabel(bad), false, JSON.stringify(bad));
  }
});

test("tag display headers remain unique without changing the source column keys", () => {
  const columns = ["chargebackId", "person", "userTag", "Person (chargebackId)"];
  assert.deepEqual(tagContract.userTagHeaders(columns, "person"), ["person (chargebackId) 2", "person", "person (userTag)", "Person (chargebackId)"]);
  assert.deepEqual(columns, ["chargebackId", "person", "userTag", "Person (chargebackId)"]);
  assert.throws(() => tagContract.userTagHeaders(columns, "=x"), /invalid/);
});

const NOW = new Date("2026-10-23T12:00:00.000Z");
const PERSON_B = "00000000-0000-4000-8000-00000000000b";

function input(userTags: PlanInput["userTags"], existing: PlanInput["existing"] = [], now = NOW): PlanInput {
  const members: GroupMember[] = [{ id: PERSON_A, kind: "user" }, { id: PERSON_B, kind: "user" }];
  const groups = new Map<string, GroupReadResult>([[GROUP_A, { ok: true, groupId: GROUP_A, members, pages: 1, retries: 0 }]]);
  return { projects: [readProjectDocument(groupDoc())], groups, existing, memberTypes: ["user"], removalLimits: { maxRemovalsPerRun: 10, maxRemovalFraction: 0.5 }, now, ...(userTags !== undefined ? { userTags } : {}) };
}

const chargebackOf = (plan: ReturnType<typeof planSync>, personId: string) =>
  plan.writes.find((w) => w.document.id === personId)?.document.projectMemberships[0]?.chargebackId;

test("a member's user tag becomes the chargeback ID of their group membership; others keep the group's default", () => {
  const plan = planSync(input(new Map([[PERSON_A, "WBS-77.1"]])));
  assert.equal(chargebackOf(plan, PERSON_A), "WBS-77.1");
  assert.equal(chargebackOf(plan, PERSON_B), "WBS-1234.01");
});

test("without user tags configured, the group's chargeback ID applies", () => {
  assert.equal(chargebackOf(planSync(input(undefined)), PERSON_A), "WBS-1234.01");
});

test("a changed user tag rewrites the membership; unreadable tags keep the stored chargeback ID", () => {
  const first = planSync(input(new Map([[PERSON_A, "WBS-77.1"]])));
  const stored = first.writes.map((w, i) => ({ doc: { ...w.document, lastVerifiedAt: "2026-10-23T11:30:00.000Z" } as Record<string, unknown>, etag: `"e${i}"` }));
  const later = new Date("2026-10-23T12:30:00.000Z");
  assert.equal(planSync(input(new Map([[PERSON_A, "WBS-77.1"]]), stored, later)).writes.length, 0, "unchanged tags write nothing");
  const changed = planSync(input(new Map([[PERSON_A, "CC-900"]]), stored, later));
  assert.deepEqual(changed.writes.map((w) => [w.document.id, w.document.projectMemberships[0].chargebackId]), [[PERSON_A, "CC-900"]]);
  const unreadable = planSync(input(null, stored, later));
  assert.equal(unreadable.writes.length, 0, "an unreadable tag store must not reset tags to the group default");
});

test("a user tag document is read only with a matching id, a valid person and a valid tag or null", () => {
  const doc = { id: userTagDocumentId(PERSON_A.toUpperCase()), scopeId: userTagDocumentId(PERSON_A), kind: "userTag", schemaVersion: 1, personId: PERSON_A, tag: "WBS-1", updatedAt: "2026-10-23T10:00:00.000Z", updatedBy: PERSON_B };
  assert.equal(userTagDocumentId(PERSON_A.toUpperCase()), `userTag-${PERSON_A}`);
  assert.deepEqual(readUserTagDocument(doc), { personId: PERSON_A, tag: "WBS-1" });
  assert.deepEqual(readUserTagDocument({ ...doc, tag: null }), { personId: PERSON_A, tag: null });
  for (const bad of [{ ...doc, kind: "other" }, { ...doc, id: "userTag-x" }, { ...doc, tag: "has space" }, { ...doc, tag: "=cmd" }, { ...doc, personId: "not-a-guid" }, null]) {
    assert.equal(readUserTagDocument(bad), null, JSON.stringify(bad));
  }
});

test("the tag map skips invalid documents and cleared tags, and refuses an oversized container", () => {
  const doc = (personId: string, tag: string | null) => ({ id: userTagDocumentId(personId), kind: "userTag", personId, tag });
  const map = userTagMap([doc(PERSON_A.toUpperCase(), "WBS-1"), doc(PERSON_B, null), { ...doc(PERSON_B, "X-1"), id: "wrong" }]);
  assert.deepEqual([...map.entries()], [[PERSON_A, "WBS-1"]]);
  assert.throws(() => userTagMap([doc(PERSON_A, "A"), doc(PERSON_B, "B")], 1), /user_tags_too_many/);
});

test("tags are read page by page and reading stops as soon as the limit is passed", async () => {
  const doc = (n: number) => ({ id: userTagDocumentId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`), kind: "userTag", personId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, tag: `T-${n}` });
  const pages = [[doc(1), doc(2)], [doc(3), doc(4)], [doc(5), doc(6)], [doc(7)]];
  let fetched = 0;
  const next = async () => ({ resources: pages[fetched++] ?? [], hasMore: fetched < pages.length });
  assert.equal((await readUserTagPages(next, 10)).size, 7);
  fetched = 0;
  await assert.rejects(readUserTagPages(next, 3), /user_tags_too_many/);
  assert.equal(fetched, 2, "no page is read after the limit is passed");
});

test("suggestions match case-insensitively, prefixes first, bounded", () => {
  const saved = ["WBS-100", "wbs-200", "CC-WBS", "OPS-1"];
  assert.deepEqual(suggestTags(saved, "wbs"), ["WBS-100", "wbs-200", "CC-WBS"]);
  assert.deepEqual(suggestTags(saved, ""), ["CC-WBS", "OPS-1", "WBS-100", "wbs-200"]);
  assert.equal(suggestTags(Array.from({ length: 50 }, (_, i) => `T-${i}`), "T", 20).length, 20);
});

test("saving a tag adds it once, keeps the list sorted and bounded, and refuses an invalid tag", () => {
  assert.deepEqual(mergeSavedTags(["B-1", "A-1"], "C-1"), ["A-1", "B-1", "C-1"]);
  assert.deepEqual(mergeSavedTags(["A-1"], "A-1"), ["A-1"]);
  assert.throws(() => mergeSavedTags([], "bad tag"), /invalid/);
  const full = Array.from({ length: MAX_SAVED_TAGS }, (_, i) => `T-${String(i).padStart(5, "0")}`);
  assert.throws(() => mergeSavedTags(full, "NEW-1"), /saved_tags_full/);
  assert.deepEqual(mergeSavedTags(full, "T-00001"), full);
});
