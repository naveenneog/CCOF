// User tags (owner decision 2026-10-23): an admin tags a person with a chargeback ID; new tags are saved
// and suggested while typing; every change goes to the change record first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createAuthenticator, readAuthConfig } from "../src/auth.ts";
import { createMemoryChangeLog } from "../src/change-log.ts";
import { createCosmosUserTagStore, createMemoryUserTagStore, handleUserTagRequest } from "../src/user-tags.ts";
import type { UserTagDependencies } from "../src/user-tags.ts";
import { MAX_SAVED_TAGS, USER_TAG_SETTINGS_ID, userTagDocumentId } from "../../src/contracts/user-tags.ts";
import type { Container } from "@azure/cosmos";

const TENANT = "00000000-0000-4000-8000-000000000001";
const AUDIENCE = "api://ccof-admin-test";
const CLIENT = "00000000-0000-4000-8000-000000000002";
const EDITOR = "00000000-0000-4000-8000-0000000000e1";
const READER = "00000000-0000-4000-8000-0000000000a1";
const PERSON = "abcdef01-2345-4678-9abc-def012345678";
const PERSON_2 = "abcdef01-2345-4678-9abc-def012345679";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
const token = (oid: string) => new SignJWT({ tid: TENANT, oid, azp: CLIENT, scp: "Projects.Manage" })
  .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
  .setAudience(AUDIENCE).setIssuedAt().setExpirationTime("10m").sign(privateKey);
const auth = readAuthConfig({ ADMIN_TENANT_ID: TENANT, ADMIN_AUDIENCE: AUDIENCE, ADMIN_SCOPE: "Projects.Manage", ADMIN_ALLOWED_CLIENT_IDS: CLIENT, ADMIN_READER_IDS: READER, ADMIN_EDITOR_IDS: EDITOR });

function harness() {
  const store = createMemoryUserTagStore();
  const changeLog = createMemoryChangeLog();
  const lines: string[] = [];
  let n = 0;
  const deps: UserTagDependencies = { authenticate: createAuthenticator(auth, keys), store, changeLog, log: (l) => lines.push(l), now: () => new Date("2026-10-23T10:00:00.000Z"), newId: () => `req-${++n}` };
  const call = async (method: string, path: string, opts: { as?: string; body?: unknown; ifMatch?: string; ifNoneMatch?: string; query?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${await token(opts.as ?? EDITOR)}` };
    if (opts.ifMatch) headers["if-match"] = opts.ifMatch;
    if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;
    return handleUserTagRequest({ method, path, query: (k) => opts.query?.[k] ?? null, headers: (k) => headers[k] ?? null, body: opts.body === undefined ? null : JSON.stringify(opts.body) }, deps);
  };
  return { store, changeLog, lines, call };
}

const tagOf = (h: ReturnType<typeof harness>, id = PERSON) => h.store.docs.get(userTagDocumentId(id))?.doc.tag;

test("deployment label defaults only when absent and an editor saves with optimistic concurrency and audit", async () => {
  const h = harness();
  const initial = await h.call("GET", "/api/user-tags/settings", { as: READER });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.jsonBody, { label: "User tag", exists: false, etag: null });
  assert.equal((await h.call("PUT", "/api/user-tags/settings", { body: { label: "WBS ID" } })).status, 428);
  assert.equal((await h.call("PUT", "/api/user-tags/settings", { as: READER, body: { label: "WBS ID" }, ifNoneMatch: "*" })).status, 403);
  const saved = await h.call("PUT", "/api/user-tags/settings", { body: { label: "WBS ID" }, ifNoneMatch: "*" });
  assert.equal(saved.status, 201);
  assert.equal(((await h.call("GET", "/api/user-tags/settings")).jsonBody as { label: string }).label, "WBS ID");
  assert.equal((await h.call("PUT", "/api/user-tags/settings", { body: { label: "Cost centre" }, ifNoneMatch: "*" })).status, 412);
  assert.equal((await h.call("PUT", "/api/user-tags/settings", { body: { label: "Cost centre" }, ifMatch: '"stale"' })).status, 412);
  assert.equal(h.changeLog.records.size, 1, "known stale clients are refused before creating an audit intent or attempting persistence");
  assert.equal((await h.call("PUT", "/api/user-tags/settings", { body: { label: "Cost centre" }, ifMatch: saved.headers.etag })).status, 200);
  const record = [...h.changeLog.records.values()][0];
  assert.deepEqual([record.operation, record.outcome, record.changes], ["userTag.settings", "created", [{ path: "label", before: "User tag", after: "WBS ID" }]]);
  assert.equal(h.store.saved, null, "renaming never changes saved tag values");
});

test("invalid labels and failed settings reads, writes or audit do not succeed or fall back", async () => {
  const h = harness();
  for (const label of ["", " ", "=SUM(1)", "+x", "-x", "@x", "a\nb", "A".repeat(65), 9]) {
    assert.equal((await h.call("PUT", "/api/user-tags/settings", { body: { label }, ifNoneMatch: "*" })).status, 422);
  }
  for (const body of [{}, { label: "WBS ID", extra: true }, { label: "WBS ID", tag: "x" }, null]) {
    assert.equal((await h.call("PUT", "/api/user-tags/settings", { body, ifNoneMatch: "*" })).status, 422);
  }
  assert.equal(h.changeLog.records.size, 0);
  h.changeLog.failAppend = true;
  assert.equal((await h.call("PUT", "/api/user-tags/settings", { body: { label: "WBS ID" }, ifNoneMatch: "*" })).status, 503);
  h.changeLog.failAppend = false;
  h.store.writeSettings = async () => { throw new Error("offline"); };
  assert.equal((await h.call("PUT", "/api/user-tags/settings", { body: { label: "WBS ID" }, ifNoneMatch: "*" })).status, 500);
  assert.equal([...h.changeLog.records.values()].at(-1)?.outcome, "unconfirmed");
  h.store.readSettings = async () => { throw new Error("offline"); };
  assert.equal((await h.call("GET", "/api/user-tags/settings")).status, 500);
});

test("a settings write race is recorded as refused and cannot overwrite the winner", async () => {
  const h = harness();
  h.store.writeSettings = async () => null;
  const response = await h.call("PUT", "/api/user-tags/settings", { body: { label: "WBS ID" }, ifNoneMatch: "*" });
  assert.equal(response.status, 412);
  assert.equal([...h.changeLog.records.values()].at(-1)?.outcome, "refused");
  assert.deepEqual((await h.call("GET", "/api/user-tags/settings")).jsonBody, { label: "User tag", exists: false, etag: null });
});

test("Cosmos label settings distinguish absence from corruption and provider failures, and persist with ETags", async () => {
  const id = USER_TAG_SETTINGS_ID;
  const doc = { id, scopeId: id, kind: id, schemaVersion: 1, label: "WBS ID", updatedAt: "2026-10-23T10:00:00.000Z", updatedBy: EDITOR };
  let resource: unknown = doc;
  let code = 0;
  let etag = '"s1"';
  const writes: unknown[] = [];
  const container = {
    item(itemId: string, partition: string) {
      assert.deepEqual([itemId, partition], [id, id]);
      return {
        async read() { if (code) throw { code }; return { resource, etag }; },
        async replace(value: unknown, options: unknown) { writes.push([value, options]); if (code) throw { code }; return { etag }; },
      };
    },
    items: { async create(value: unknown) { writes.push(value); if (code) throw { code }; return { etag }; } },
  } as unknown as Container;
  const store = createCosmosUserTagStore(container);
  assert.deepEqual(await store.readSettings(), { label: "WBS ID", etag });
  for (const bad of [{ ...doc, label: "=cmd" }, { ...doc, schemaVersion: 2 }, { ...doc, kind: "userTag" }, { ...doc, scopeId: "other" }, { ...doc, id: "other" }]) {
    resource = bad;
    await assert.rejects(store.readSettings(), /user_tag_settings_invalid/);
  }
  resource = doc; etag = "";
  await assert.rejects(store.readSettings(), /user_tag_settings_invalid/);
  await assert.rejects(store.writeSettings(doc, null), /user_tag_settings_etag_missing/);
  etag = '"s1"'; code = 404;
  assert.equal(await store.readSettings(), null);
  code = 503;
  await assert.rejects(store.readSettings());
  await assert.rejects(store.writeSettings(doc, null));
  code = 409;
  assert.equal(await store.writeSettings(doc, null), null);
  code = 412;
  assert.equal(await store.writeSettings(doc, '"s0"'), null);
  code = 0;
  assert.equal(await store.writeSettings(doc, '"s0"'), '"s1"');
  assert.deepEqual(writes.at(-1), [doc, { accessCondition: { type: "IfMatch", condition: '"s0"' } }]);
  assert.equal(await store.writeSettings(doc, null), '"s1"');
  assert.deepEqual(writes.at(-1), doc);
});

test("an editor tags a person: created with If-None-Match, saved for suggestions, recorded first", async () => {
  const h = harness();
  const r = await h.call("PUT", `/api/user-tags/people/${PERSON.toUpperCase()}`, { body: { tag: "WBS-1.2" }, ifNoneMatch: "*" });
  assert.equal(r.status, 201, JSON.stringify(r.jsonBody));
  assert.equal(tagOf(h), "WBS-1.2");
  assert.equal(r.headers.etag, h.store.docs.get(userTagDocumentId(PERSON))?.etag);
  assert.deepEqual(h.store.saved?.tags, ["WBS-1.2"]);
  const [record] = [...h.changeLog.records.values()];
  assert.deepEqual([record.operation, record.outcome, record.details.personId, record.changes], ["userTag.set", "created", PERSON, [{ path: "tag", before: null, after: "WBS-1.2" }]]);
  const stored = h.store.docs.get(userTagDocumentId(PERSON))?.doc;
  assert.deepEqual([stored?.kind, stored?.scopeId, stored?.updatedBy], ["userTag", userTagDocumentId(PERSON), EDITOR]);
});

test("a change needs the stored ETag; a stale one, a missing one or a create over an existing tag is refused", async () => {
  const h = harness();
  const created = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-1" }, ifNoneMatch: "*" });
  assert.equal((await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-2" } })).status, 428);
  assert.equal((await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-2" }, ifMatch: '"stale"' })).status, 412);
  assert.equal((await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-2" }, ifNoneMatch: "*" })).status, 412);
  assert.equal((await h.call("PUT", `/api/user-tags/people/${PERSON_2}`, { body: { tag: "WBS-2" }, ifMatch: '"x"' })).status, 404);
  assert.equal(tagOf(h), "WBS-1");
  assert.deepEqual([h.changeLog.records.size, h.store.saved?.tags], [1, ["WBS-1"]], "a refused change leaves no record and saves no tag");
  const updated = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-2" }, ifMatch: created.headers.etag });
  assert.equal(updated.status, 200);
  assert.equal(tagOf(h), "WBS-2");
  assert.deepEqual(h.store.saved?.tags, ["WBS-1", "WBS-2"]);
});

test("clearing a tag stores null and keeps the saved list; an unchanged tag writes nothing", async () => {
  const h = harness();
  const created = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-1" }, ifNoneMatch: "*" });
  const same = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-1" }, ifMatch: created.headers.etag });
  assert.deepEqual([same.status, (same.jsonBody as { changed: boolean }).changed, h.changeLog.records.size], [200, false, 1]);
  const cleared = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: null }, ifMatch: created.headers.etag });
  assert.equal(cleared.status, 200);
  assert.equal(tagOf(h), null);
  assert.deepEqual(h.store.saved?.tags, ["WBS-1"]);
});

test("a reader can read and get suggestions but cannot tag", async () => {
  const h = harness();
  await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-100" }, ifNoneMatch: "*" });
  await h.call("PUT", `/api/user-tags/people/${PERSON_2}`, { body: { tag: "CC-WBS" }, ifNoneMatch: "*" });
  const denied = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { as: READER, body: { tag: "X-1" }, ifMatch: '"x"' });
  assert.deepEqual([denied.status, (denied.jsonBody as { error: string }).error], [403, "write_permission_required"]);
  const suggest = await h.call("GET", "/api/user-tags", { as: READER, query: { search: "wbs" } });
  assert.deepEqual((suggest.jsonBody as { tags: string[] }).tags, ["WBS-100", "CC-WBS"]);
  const one = await h.call("GET", `/api/user-tags/people/${PERSON}`, { as: READER });
  assert.deepEqual([one.status, (one.jsonBody as { tag: string }).tag], [200, "WBS-100"]);
  const filtered = await h.call("GET", "/api/user-tags/people", { as: READER, query: { tag: "CC-WBS" } });
  assert.deepEqual((filtered.jsonBody as { people: { personId: string }[] }).people.map((p) => p.personId), [PERSON_2]);
  const none = await h.call("GET", `/api/user-tags/people/${"0".repeat(8)}-0000-4000-8000-000000000000`, { as: READER });
  assert.deepEqual([none.status, (none.jsonBody as { exists: boolean; tag: null }).exists, (none.jsonBody as { tag: null }).tag, none.headers.etag], [200, false, null, undefined]);
});

test("invalid input is refused before any write", async () => {
  const h = harness();
  for (const body of [{ tag: "has space" }, { tag: "=SUM(A1)" }, { tag: 7 }, { tag: "A".repeat(65) }, { tag: "ok", extra: 1 }, {}]) {
    const r = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body, ifNoneMatch: "*" });
    assert.equal(r.status, 422, JSON.stringify(body));
  }
  assert.equal((await h.call("GET", "/api/user-tags", { query: { search: "a b" } })).status, 400);
  assert.equal((await h.call("GET", "/api/user-tags/people", { query: { tag: "a b" } })).status, 400);
  assert.equal((await h.call("GET", "/api/user-tags/people", { query: { limit: "0" } })).status, 400);
  assert.equal((await h.call("PUT", "/api/user-tags/people/not-a-guid", { body: { tag: "A" }, ifNoneMatch: "*" })).status, 404);
  assert.equal((await h.call("DELETE", `/api/user-tags/people/${PERSON}`)).status, 405);
  assert.equal(h.store.docs.size + h.changeLog.records.size, 0);
  assert.equal(h.store.saved, null);
});

test("an unwritable change record or a full saved list refuses the change and writes no tag", async () => {
  const h = harness();
  h.changeLog.failAppend = true;
  assert.equal((await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-1" }, ifNoneMatch: "*" })).status, 503);
  assert.equal(h.store.docs.size, 0);
  assert.equal(h.store.saved, null, "a change that was not recorded saves no suggestion");
  h.changeLog.failAppend = false;
  h.store.saved = { tags: Array.from({ length: MAX_SAVED_TAGS }, (_, i) => `T-${String(i).padStart(5, "0")}`), etag: '"full"' };
  const full = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "NEW-1" }, ifNoneMatch: "*" });
  assert.deepEqual([full.status, (full.jsonBody as { error: string }).error], [409, "saved_tags_full"]);
  assert.equal(h.store.docs.size, 0);
  const existing = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "T-00001" }, ifNoneMatch: "*" });
  assert.equal(existing.status, 201, "a tag already saved can still be assigned when the list is full");
});

test("the tag is saved for suggestions only after the tag itself is written; a refused write saves nothing", async () => {
  const h = harness();
  const realReplace = h.store.replace;
  const created = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-1" }, ifNoneMatch: "*" });
  h.store.replace = async () => "precondition_failed";
  const raced = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "RACE-1" }, ifMatch: created.headers.etag });
  assert.equal(raced.status, 412);
  assert.deepEqual(h.store.saved?.tags, ["WBS-1"], "a tag whose write was refused is not suggested");
  assert.equal([...h.changeLog.records.values()].at(-1)?.outcome, "refused");
  h.store.replace = realReplace;
});

test("when the saved list cannot be updated, the tag still stands and the response says it was not saved for suggestions", async () => {
  const h = harness();
  h.store.writeSaved = async () => null;
  const r = await h.call("PUT", `/api/user-tags/people/${PERSON}`, { body: { tag: "WBS-9" }, ifNoneMatch: "*" });
  assert.deepEqual([r.status, (r.jsonBody as { suggestionSaved: boolean }).suggestionSaved, tagOf(h)], [201, false, "WBS-9"]);
  const record = [...h.changeLog.records.values()].at(-1);
  assert.deepEqual([record?.outcome, record?.details.suggestionSaved], ["created", false]);
});
