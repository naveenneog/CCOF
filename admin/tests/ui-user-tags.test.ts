// Console helpers for user tags (admin/ui-v3/lib/user-tags.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadedTagFor, personProblem, suggestPath, tagProblem, tagWrite } from "../ui-v3/lib/user-tags.ts";
import { toCsv } from "../ui-v3/lib/format.ts";
import * as tagUi from "../ui-v3/lib/user-tags.ts";

const PERSON = "ABCDEF01-2345-4678-9ABC-DEF012345678";

test("label settings are usable only after a successful valid read, never stale on failure", () => {
  const data = { label: "WBS ID", exists: true, etag: '"s1"' };
  assert.equal(tagUi.loadedLabel(data, false, null), "WBS ID");
  for (const [d, loading, error] of [[data, true, null], [data, false, new Error("offline")], [null, false, null], [{ label: "=cmd" }, false, null]] as const) {
    assert.equal(tagUi.loadedLabel(d, loading, error), null);
  }
});

test("downloaded chargeback CSV uses the label while preserving machine-keyed values and safe cells", () => {
  const csv = toCsv(["person", "userTag", "chargebackId"], [{ person: "=cmd", userTag: "WBS-1", chargebackId: "WBS-2" }], {}, "person");
  assert.equal(csv, "\nperson,person (userTag),person (chargebackId)\n'=cmd,WBS-1,WBS-2\n");
  assert.throws(() => toCsv(["userTag"], [{ userTag: "WBS-1" }], {}, "=cmd"), /invalid/);
});

test("a tag is checked with the server's rule; empty means 'no tag'", () => {
  for (const ok of ["", "WBS-1.2", "CC/900", "a"]) assert.equal(tagProblem(ok), null, ok);
  for (const bad of [" WBS", "=SUM(1)", "-x", "a b", "A".repeat(65)]) assert.notEqual(tagProblem(bad), null, bad);
  assert.equal(personProblem(PERSON), null);
  assert.notEqual(personProblem("not-a-guid"), null);
});

test("suggestions are requested only for text that could be a tag", () => {
  assert.equal(suggestPath(""), "/api/user-tags?search=");
  assert.equal(suggestPath(" wbs/1 "), "/api/user-tags?search=wbs%2F1");
  assert.equal(suggestPath("a b"), null);
  assert.equal(suggestPath("x".repeat(65)), null);
});

test("setting a tag creates with If-None-Match for a new person and changes with the ETag otherwise; empty clears", () => {
  assert.deepEqual(tagWrite(PERSON, "WBS-1", null), { path: `/api/user-tags/people/${PERSON.toLowerCase()}`, body: { tag: "WBS-1" }, ifNoneMatch: "*" });
  assert.deepEqual(tagWrite(PERSON, "", { etag: '"e1"' }), { path: `/api/user-tags/people/${PERSON.toLowerCase()}`, body: { tag: null }, ifMatch: '"e1"' });
});

test("a person's loaded tag counts only once it was loaded for that same person", () => {
  const data = { personId: PERSON.toLowerCase(), exists: true, tag: "WBS-1" };
  assert.deepEqual(loadedTagFor(PERSON, data, false, '"e1"'), { ready: true, exists: true, tag: "WBS-1", etag: '"e1"' });
  assert.equal(loadedTagFor(PERSON, data, true, '"e1"').ready, false, "still loading");
  assert.equal(loadedTagFor("abcdef01-2345-4678-9abc-def012345679", data, false, '"e1"').ready, false, "loaded for another person");
  assert.deepEqual(loadedTagFor(PERSON, { personId: PERSON.toLowerCase(), exists: false, tag: null }, false, null), { ready: true, exists: false, tag: "", etag: null });
  assert.equal(loadedTagFor(PERSON, null, false, null).ready, false);
});
