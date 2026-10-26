// Group onboarding API (ADR-0034, ROADMAP G6): find an Entra group, onboard it,
// edit and retire it. Group documents live in the projects container.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { handleGroupRequest } from "../src/groups.ts";
import type { GroupApiDependencies, GroupDirectory, GroupRequest } from "../src/groups.ts";
import type { ProjectStore, StoredProject } from "../src/api.ts";
import { handleAdminRequest } from "../src/api.ts";
import { createCosmosProjectStore } from "../src/cosmos-store.ts";
import { createAuthenticator, readAuthConfig } from "../src/auth.ts";
import { createMemoryChangeLog } from "../src/change-log.ts";
import type { Doc } from "../src/validation.ts";
import { readBackendSettings } from "../src/backend-settings.ts";
import type { BackendSettings } from "../src/backend-settings.ts";
import { readProjectDocument } from "../../src/sync/projects.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const AUDIENCE = "api://ccof-admin-test";
const CLIENT = "00000000-0000-4000-8000-000000000002";
const EDITOR = "00000000-0000-4000-8000-0000000000e1";
const READER = "00000000-0000-4000-8000-0000000000a1";
const GROUP = "abcdef01-2345-4678-9abc-def012345678";

const unlimited = { tokensPerMinute: null, tokenQuota: null, tokenQuotaPeriod: null };
function groupBody(overrides: Doc = {}): Doc {
  return {
    groupId: GROUP, displayName: "Payments engineering", backendId: "backend01", priority: 100, chargebackId: "WBS-1234.01",
    budget: { mode: "autoScale", perUser: { amount: 50, currency: "USD", period: "monthly" }, groupCap: null },
    restrictedFamiliesApproved: false,
    familyPolicy: { aggregateLimits: { person: unlimited, group: unlimited }, families: { sonnet: { models: ["claude-sonnet-5"], person: unlimited, group: unlimited } } },
    surfaces: ["code", "chat"], cacheProfile: { expectedCacheReadPercent: 50, basis: "suggested" },
    ...overrides,
  };
}

class FakeStore implements ProjectStore {
  docs = new Map<string, StoredProject>();
  version = 0;
  private tag() { return `"etag-${++this.version}"`; }
  async list() { return [...this.docs.values()].map((p) => structuredClone(p)); }
  async read(id: string) { const p = this.docs.get(id); return p ? structuredClone(p) : null; }
  async create(doc: Doc) {
    const id = String(doc.projectId);
    if (this.docs.has(id)) return "conflict" as const;
    const etag = this.tag();
    this.docs.set(id, { doc: { ...structuredClone(doc), _etag: etag, _ts: 1 }, etag });
    return etag;
  }
  async replace(doc: Doc, etag: string) {
    const id = String(doc.projectId);
    const cur = this.docs.get(id);
    if (!cur || cur.etag !== etag) return "precondition_failed" as const;
    const next = this.tag();
    this.docs.set(id, { doc: { ...structuredClone(doc), _etag: next }, etag: next });
    return next;
  }
}

const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
const token = (oid: string) => new SignJWT({ tid: TENANT, oid, azp: CLIENT, scp: "Projects.Manage" })
  .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
  .setAudience(AUDIENCE).setIssuedAt().setExpirationTime("10m").sign(privateKey);
const auth = readAuthConfig({
  ADMIN_TENANT_ID: TENANT, ADMIN_AUDIENCE: AUDIENCE, ADMIN_SCOPE: "Projects.Manage",
  ADMIN_ALLOWED_CLIENT_IDS: CLIENT, ADMIN_READER_IDS: READER, ADMIN_EDITOR_IDS: EDITOR,
});

class FakeDirectory implements GroupDirectory {
  searches: string[] = [];
  async search(text: string) {
    this.searches.push(text);
    return { state: "available" as const, groups: [{ id: GROUP, displayName: "Payments engineering", description: null, securityEnabled: true }] };
  }
  async get(id: string) {
    return id === GROUP
      ? { state: "available" as const, group: { id: GROUP, displayName: "Payments engineering", description: null, securityEnabled: true, memberCount: 42 } }
      : { state: "not_found" as const };
  }
  async members(id: string) {
    return id === GROUP
      ? { state: "available" as const, members: [{ id: READER, displayName: "Reader person" }], truncated: false }
      : { state: "not_found" as const };
  }
}

const BACKENDS: BackendSettings = readBackendSettings({ ADMIN_BACKENDS: JSON.stringify([
  { id: "backend01", deployments: ["claude-sonnet-5", "claude-haiku-4-5"] }, { id: "backend02", deployments: ["claude-opus-5"] }]) });

function setup(directory: GroupDirectory | null = new FakeDirectory(), backends: BackendSettings = BACKENDS) {
  const store = new FakeStore();
  const changeLog = createMemoryChangeLog();
  const lines: string[] = [];
  let ids = 0;
  const deps: GroupApiDependencies = {
    authenticate: createAuthenticator(auth, keys), store, changeLog, directory, backends,
    log: (l) => lines.push(l), now: () => new Date("2026-10-22T12:00:00Z"), newId: () => `req-${++ids}`,
  };
  const call = async (method: string, path: string, opts: { oid?: string; body?: unknown; ifMatch?: string; query?: Record<string, string> } = {}) => {
    const headers: Record<string, string | null> = { authorization: `Bearer ${await token(opts.oid ?? EDITOR)}`, "if-match": opts.ifMatch ?? null };
    const req: GroupRequest = {
      method, path, headers: (n) => headers[n.toLowerCase()] ?? null, query: (n) => opts.query?.[n] ?? null,
      body: opts.body === undefined ? null : JSON.stringify(opts.body),
    };
    return handleGroupRequest(req, deps);
  };
  return { store, changeLog, lines, call };
}

test("an editor onboards a group; the stored document is a valid group the sync reads", async () => {
  const { store, changeLog, call } = setup();
  const res = await call("POST", "/api/groups", { body: groupBody() });
  assert.equal(res.status, 201);
  const stored = store.docs.get(GROUP)!.doc;
  assert.equal(stored.kind, "group");
  assert.equal(stored.id, GROUP);
  assert.equal(stored.projectId, GROUP);
  assert.equal(stored.status, "active");
  const read = readProjectDocument(stored);
  assert.ok(read.ok, JSON.stringify(read));
  assert.equal([...changeLog.records.values()][0].outcome, "created");
});

test("onboarding refuses an invalid group with field problems, and a reader cannot write", async () => {
  const { call } = setup();
  const bad = await call("POST", "/api/groups", { body: groupBody({ priority: 0, chargebackId: "WBS 1" }) });
  assert.equal(bad.status, 422);
  assert.deepEqual((bad.jsonBody as Doc).problems, ["priority:invalid", "chargebackId:invalid"]);
  const extra = await call("POST", "/api/groups", { body: groupBody({ status: "retired" }) });
  assert.equal(extra.status, 422);
  const reader = await call("POST", "/api/groups", { oid: READER, body: groupBody() });
  assert.equal(reader.status, 403);
});

test("a group already onboarded, or a project with the same id, is a conflict", async () => {
  const { store, call } = setup();
  assert.equal((await call("POST", "/api/groups", { body: groupBody() })).status, 201);
  assert.equal((await call("POST", "/api/groups", { body: groupBody() })).status, 409);
  store.docs.clear();
  await store.create({ id: GROUP, projectId: GROUP, displayName: "legacy", status: "active" });
  assert.equal((await call("POST", "/api/groups", { body: groupBody() })).status, 409);
});

test("list and read show only group documents", async () => {
  const { store, call } = setup();
  const LEGACY = "11111111-2222-4333-8444-555555555555";
  await store.create({ id: LEGACY, projectId: LEGACY, displayName: "legacy", status: "active", classifications: {} });
  await call("POST", "/api/groups", { body: groupBody() });
  const list = await call("GET", "/api/groups", { oid: READER });
  assert.equal(list.status, 200);
  const groups = (list.jsonBody as { groups: Doc[] }).groups;
  assert.deepEqual(groups.map((g) => [g.groupId, g.displayName, g.status, g.chargebackId, g.priority]), [[GROUP, "Payments engineering", "active", "WBS-1234.01", 100]]);
  assert.equal((await call("GET", `/api/groups/${GROUP}`, { oid: READER })).status, 200);
  const legacy = await call("GET", `/api/groups/${LEGACY}`, { oid: READER });
  assert.equal(legacy.status, 404);
  assert.equal((legacy.jsonBody as Doc).error, "group_not_found");
});

test("an update needs If-Match, changes only editable fields and is recorded", async () => {
  const { changeLog, call } = setup();
  const created = await call("POST", "/api/groups", { body: groupBody() });
  const etag = created.headers!.etag;
  assert.equal((await call("PUT", `/api/groups/${GROUP}`, { body: { chargebackId: "WBS-9" } })).status, 428);
  assert.equal((await call("PUT", `/api/groups/${GROUP}`, { body: { chargebackId: "WBS-9" }, ifMatch: '"stale"' })).status, 412);
  assert.equal((await call("PUT", `/api/groups/${GROUP}`, { body: { groupId: "x" }, ifMatch: etag })).status, 422);
  assert.equal((await call("PUT", `/api/groups/${GROUP}`, { body: { status: "retired" }, ifMatch: etag })).status, 422);
  const ok = await call("PUT", `/api/groups/${GROUP}`, { body: { chargebackId: "WBS-9", budget: { mode: "cap", perUser: { amount: 50, currency: "USD", period: "monthly" }, groupCap: { amount: 500, currency: "USD", period: "monthly" } } }, ifMatch: etag });
  assert.equal(ok.status, 200);
  const record = [...changeLog.records.values()].find((r) => r.outcome === "updated");
  assert.ok(record?.changes.some((c) => c.path === "chargebackId" && c.before === "WBS-1234.01" && c.after === "WBS-9"));
  const invalid = await call("PUT", `/api/groups/${GROUP}`, { body: { budget: { mode: "cap", perUser: { amount: 50, currency: "USD", period: "monthly" }, groupCap: null } }, ifMatch: ok.headers!.etag });
  assert.equal(invalid.status, 422);
});

test("retire needs the group id repeated, is one way, and the sync then removes members", async () => {
  const { store, call } = setup();
  const created = await call("POST", "/api/groups", { body: groupBody() });
  assert.equal((await call("POST", `/api/groups/${GROUP}/retire`, { body: { confirmGroupId: "other" }, ifMatch: created.headers!.etag })).status, 422);
  const retired = await call("POST", `/api/groups/${GROUP}/retire`, { body: { confirmGroupId: GROUP }, ifMatch: created.headers!.etag });
  assert.equal(retired.status, 200);
  const doc = store.docs.get(GROUP)!.doc;
  assert.equal(doc.status, "retired");
  assert.equal(doc.retiredAt, "2026-10-22T12:00:00.000Z");
  const read = readProjectDocument(doc);
  assert.ok(read.ok && read.retired);
  assert.equal((await call("PUT", `/api/groups/${GROUP}`, { body: { priority: 5 }, ifMatch: retired.headers!.etag })).status, 409);
});

test("the project API and paged project listing never return a group document", async () => {
  const { store, call } = setup();
  await call("POST", "/api/groups", { body: groupBody() });
  const deps = {
    authenticate: createAuthenticator(auth, keys), store, log: () => {}, now: () => new Date("2026-10-22T12:00:00Z"), newId: () => "p-1",
  };
  const headers: Record<string, string> = { authorization: `Bearer ${await token(READER)}` };
  const project = (path: string) => handleAdminRequest({ method: "GET", path, headers: (n) => headers[n.toLowerCase()] ?? null, body: null }, deps);
  assert.deepEqual(((await project("/api/projects")).jsonBody as { projects: unknown[] }).projects, []);
  const read = await project(`/api/projects/${GROUP}`);
  assert.equal(read.status, 404);

  const queries: string[] = [];
  const container = { items: { query: (q: { query: string }) => { queries.push(q.query); return { fetchNext: async () => ({ resources: [], continuationToken: undefined }) }; } } };
  await createCosmosProjectStore(container as never).listPage!({ search: "", tag: "", backendId: "", limit: 10 });
  assert.match(queries[0], /WHERE \(NOT IS_DEFINED\(c\.kind\) OR c\.kind != "group"\)/);
});

test("directory search finds Entra groups; text is bounded, quote-free and not blank", async () => {
  const directory = new FakeDirectory();
  const { call } = setup(directory);
  const res = await call("GET", "/api/groups/directory", { oid: READER, query: { search: "Payments" } });
  assert.equal(res.status, 200);
  assert.equal((res.jsonBody as { groups: Doc[] }).groups[0].id, GROUP);
  for (const bad of ["", "   ", "a\"b", "a\\b", "x".repeat(101)]) {
    assert.equal((await call("GET", "/api/groups/directory", { oid: READER, query: { search: bad } })).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(directory.searches, ["Payments"]);
  const one = await call("GET", `/api/groups/directory/${GROUP}`, { oid: READER });
  assert.equal((one.jsonBody as { group: Doc }).group.memberCount, 42);
  assert.equal((await call("GET", "/api/groups/directory/not-a-guid", { oid: READER })).status, 404);
});

test("directory not configured is an explicit 503, not an empty result", async () => {
  const { call } = setup(null);
  const res = await call("GET", "/api/groups/directory", { oid: READER, query: { search: "Payments" } });
  assert.equal(res.status, 503);
  assert.equal((res.jsonBody as Doc).error, "group_directory_not_configured");
});

test("cache suggestion for a set of surfaces names its evidence", async () => {
  const { call } = setup();
  const res = await call("GET", "/api/groups/cache-suggestion", { oid: READER, query: { surfaces: "code,chat" } });
  assert.equal(res.status, 200);
  assert.deepEqual((res.jsonBody as Doc).suggestion, { percent: 50, from: [{ surface: "chat", basis: "assumed" }] });
  assert.equal((await call("GET", "/api/groups/cache-suggestion", { oid: READER, query: { surfaces: "code,email" } })).status, 400);
});

test("a group's directory members are listed for any reader, so a person can be picked to tag", async () => {
  const h = setup();
  await h.call("POST", "/api/groups", { body: groupBody() });
  const r = await h.call("GET", `/api/groups/directory/${GROUP}/members`, { oid: READER });
  assert.deepEqual([r.status, r.jsonBody], [200, { members: [{ id: READER, displayName: "Reader person" }], truncated: false }]);
  assert.equal((await h.call("GET", `/api/groups/directory/${GROUP.replace("abcdef01", "abcdef02")}/members`)).status, 404);
  assert.equal((await h.call("POST", `/api/groups/directory/${GROUP}/members`)).status, 405);
  assert.equal((await setup(null).call("GET", `/api/groups/directory/${GROUP}/members`)).status, 503);
});

test("members are listed only for an active onboarded group, never for any other directory group", async () => {
  const h = setup();
  assert.equal((await h.call("GET", `/api/groups/directory/${GROUP}/members`, { oid: READER })).status, 404, "not onboarded");
  const created = await h.call("POST", "/api/groups", { body: groupBody() });
  await h.call("POST", `/api/groups/${GROUP}/retire`, { body: { confirmGroupId: GROUP }, ifMatch: created.headers.etag });
  assert.equal((await h.call("GET", `/api/groups/directory/${GROUP}/members`, { oid: READER })).status, 404, "retired");
});

test("a display name must have visible text and no control characters, on create and edit (ADMIN-5)", async () => {
  const { call } = setup();
  const bidi = [..."\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069"];
  for (const displayName of [" ", "\u3000", "\t=1+1", "a\r\n=1+1", "a\u0000b", "a\u0085b", "\u200B", " \u200B\u200C\u200D\u2060 ", ...bidi.map((c) => `Eng${c}team`)]) {
    const res = await call("POST", "/api/groups", { body: groupBody({ displayName }) });
    assert.equal(res.status, 422, JSON.stringify(displayName));
    assert.deepEqual((res.jsonBody as Doc).problems, ["displayName:invalid"], JSON.stringify(displayName));
  }
  const created = await call("POST", "/api/groups", { body: groupBody({ displayName: "Payments – Zürich team" }) });
  assert.equal(created.status, 201);
  const edit = await call("PUT", `/api/groups/${GROUP}`, { body: { displayName: "x\ty" }, ifMatch: created.headers!.etag });
  assert.deepEqual([edit.status, (edit.jsonBody as Doc).problems], [422, ["displayName:invalid"]]);
  for (const displayName of ["\u200B", ...bidi.map((c) => `Eng${c}team`)]) {
    const edited = await call("PUT", `/api/groups/${GROUP}`, { body: { displayName }, ifMatch: created.headers!.etag });
    assert.deepEqual([edited.status, (edited.jsonBody as Doc).problems], [422, ["displayName:invalid"]], JSON.stringify(displayName));
  }
  const valid = await call("PUT", `/api/groups/${GROUP}`, { body: { displayName: "فريق العربية – 東京 – تیم\u200Cها" }, ifMatch: created.headers!.etag });
  assert.equal(valid.status, 200, "ordinary RTL text and contextual joiners are not bidi overrides");
});

test("a group link that is not a group ID is group_not_found, not route_not_found (ADMIN-7)", async () => {
  const { call } = setup();
  for (const [method, path] of [["GET", "/api/groups/onboard"], ["GET", "/api/groups/not-a-guid"], ["PUT", "/api/groups/abc"], ["POST", "/api/groups/abc/retire"]]) {
    const res = await call(method, path, { ifMatch: '"x"', body: { confirmGroupId: "abc" } });
    assert.deepEqual([res.status, (res.jsonBody as Doc).error], [404, "group_not_found"], `${method} ${path}`);
  }
  assert.equal(((await call("GET", "/api/groups/abc/other")).jsonBody as Doc).error, "route_not_found");
});

test("onboarding refuses a backend or model the deployment does not have, naming the allowed values (ADMIN-1)", async () => {
  const { call, store } = setup();
  const backend = await call("POST", "/api/groups", { body: groupBody({ backendId: "no-such-backend" }) });
  assert.equal(backend.status, 422);
  assert.deepEqual((backend.jsonBody as Doc).problems, ["backendId:not_deployed"]);
  assert.deepEqual(((backend.jsonBody as Doc).allowed as Doc).backendIds, ["backend01", "backend02"]);
  const haiku = { models: ["claude-haiku-9-9"], person: unlimited, group: unlimited };
  const policy = { aggregateLimits: { person: unlimited, group: unlimited }, families: { haiku } };
  const model = await call("POST", "/api/groups", { body: groupBody({ familyPolicy: policy }) });
  assert.equal(model.status, 422);
  assert.deepEqual((model.jsonBody as Doc).problems, ["familyPolicy.families.haiku.models:not_deployed"]);
  assert.deepEqual(((model.jsonBody as Doc).allowed as Doc).deployments, ["claude-haiku-4-5", "claude-sonnet-5"]);
  assert.equal(store.docs.size, 0, "nothing stored");
});

test("an edit checks a new backend against every model, and only new models against the backend (ADMIN-1)", async () => {
  const { call, store } = setup();
  const created = await call("POST", "/api/groups", { body: groupBody() });
  const moved = await call("PUT", `/api/groups/${GROUP}`, { body: { backendId: "backend02" }, ifMatch: created.headers!.etag });
  assert.deepEqual([moved.status, (moved.jsonBody as Doc).problems], [422, ["familyPolicy.families.sonnet.models:not_deployed"]]);
  // A model stored before this check (or removed from the deployment since) does not block other edits.
  const doc = store.docs.get(GROUP)!;
  ((doc.doc.familyPolicy as Doc).families as Doc).sonnet = { models: ["claude-sonnet-5", "claude-sonnet-old"], person: unlimited, group: unlimited };
  const edit = await call("PUT", `/api/groups/${GROUP}`, { body: { chargebackId: "WBS-9", familyPolicy: doc.doc.familyPolicy }, ifMatch: doc.etag });
  assert.equal(edit.status, 200, JSON.stringify(edit.jsonBody));
});

test("without the deployment's backend list, onboarding is refused rather than unchecked; other edits still work (ADMIN-1)", async () => {
  for (const env of [{}, { ADMIN_BACKENDS: "not json" }, { ADMIN_BACKENDS: '[{"id":"bad id","deployments":[]}]' }]) {
    const { call } = setup(new FakeDirectory(), readBackendSettings(env));
    const res = await call("POST", "/api/groups", { body: groupBody() });
    assert.deepEqual([res.status, (res.jsonBody as Doc).error], [503, env.ADMIN_BACKENDS ? "backend_list_invalid" : "backend_list_not_configured"], JSON.stringify(env));
  }
  const { call, store } = setup(new FakeDirectory(), readBackendSettings({}));
  await store.create({ ...groupBody(), id: GROUP, kind: "group", projectId: GROUP, status: "active", retiredAt: null });
  const edit = await call("PUT", `/api/groups/${GROUP}`, { body: { chargebackId: "WBS-9" }, ifMatch: store.docs.get(GROUP)!.etag });
  assert.equal(edit.status, 200, JSON.stringify(edit.jsonBody));
});

test("the console reads the deployment's backends and their deployments (ADMIN-1)", async () => {
  const res = await setup().call("GET", "/api/groups/backends", { oid: READER });
  assert.equal(res.status, 200);
  assert.deepEqual(res.jsonBody, { state: "configured", backends: [
    { id: "backend01", deployments: ["claude-haiku-4-5", "claude-sonnet-5"] }, { id: "backend02", deployments: ["claude-opus-5"] }] });
  const none = await setup(new FakeDirectory(), readBackendSettings({})).call("GET", "/api/groups/backends", { oid: READER });
  assert.deepEqual(none.jsonBody, { state: "not_configured", backends: [] });
});