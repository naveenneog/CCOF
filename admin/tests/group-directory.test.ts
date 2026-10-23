// Entra group lookup for onboarding (G6): Graph application permissions
// Group.ReadBasic.All (search, read) and GroupMember.ReadBasic.All (member count),
// UNKNOWNS G-R4. Advanced queries need ConsistencyLevel: eventual.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGroupDirectory } from "../src/group-directory.ts";

const GROUP = "abcdef01-2345-4678-9abc-def012345678";
const credential = { getToken: async () => ({ token: "graph-token", expiresOnTimestamp: Date.now() + 3600000 }) };
const ENABLED = { ADMIN_GROUP_SEARCH_ENABLED: "true" };

function transport(responses: Record<string, { status: number; body: unknown }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFake = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    const key = Object.keys(responses).find((k) => String(url).includes(k));
    const r = key ? responses[key] : { status: 500, body: {} };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  };
  return { calls, fetch: fetchFake as typeof fetch };
}

const noLog = () => {};

test("search sends a quoted displayName $search, security groups only, with eventual consistency", async () => {
  const t = transport({ "/groups?": { status: 200, body: { value: [
    { id: GROUP, displayName: "Payments engineering", description: null, securityEnabled: true },
    { id: "not-a-guid", displayName: "bad", securityEnabled: true },
  ] } } });
  const result = await createGroupDirectory(ENABLED, credential, t.fetch).search("Pay ments", noLog);
  assert.equal(result.state, "available");
  assert.deepEqual(result.groups, [{ id: GROUP, displayName: "Payments engineering", description: null, securityEnabled: true }]);
  const url = new URL(t.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://graph.microsoft.com/v1.0/groups");
  assert.equal(url.searchParams.get("$search"), '"displayName:Pay ments"');
  assert.equal(url.searchParams.get("$filter"), "securityEnabled eq true");
  assert.equal(t.calls[0].headers.ConsistencyLevel, "eventual");
  assert.equal(t.calls[0].headers.authorization, "Bearer graph-token");
});

test("get reads one group and its direct member count", async () => {
  const t = transport({
    [`/groups/${GROUP}/members/$count`]: { status: 200, body: "42" },
    [`/groups/${GROUP}?`]: { status: 200, body: { id: GROUP, displayName: "Payments engineering", description: "d", securityEnabled: true } },
  });
  const result = await createGroupDirectory(ENABLED, credential, t.fetch).get(GROUP, noLog);
  assert.deepEqual(result, { state: "available", group: { id: GROUP, displayName: "Payments engineering", description: "d", securityEnabled: true, memberCount: 42 } });
  assert.ok(t.calls.every((c) => c.headers.ConsistencyLevel === "eventual"));
});

test("provider failures map to explicit states, never an empty success", async () => {
  const dir = (status: number) => createGroupDirectory(ENABLED, credential, transport({ "/groups": { status, body: {} } }).fetch);
  assert.equal((await dir(403).search("x", noLog)).state, "permission_required");
  assert.equal((await dir(401).search("x", noLog)).state, "permission_required");
  assert.equal((await dir(500).search("x", noLog)).state, "unavailable");
  assert.equal((await dir(400).search("x", noLog)).state, "rejected");
  assert.equal((await dir(404).get(GROUP, noLog)).state, "not_found");
  assert.equal((await dir(403).get(GROUP, noLog)).state, "permission_required");
});

test("a malformed member count or group body is unavailable, not trusted", async () => {
  const t = transport({
    [`/groups/${GROUP}/members/$count`]: { status: 200, body: "lots" },
    [`/groups/${GROUP}?`]: { status: 200, body: { id: GROUP, displayName: "x", securityEnabled: true } },
  });
  assert.equal((await createGroupDirectory(ENABLED, credential, t.fetch).get(GROUP, noLog)).state, "unavailable");
  const other = transport({
    [`/groups/${GROUP}/members/$count`]: { status: 200, body: "3" },
    [`/groups/${GROUP}?`]: { status: 200, body: { id: "11111111-1111-4111-8111-111111111111", displayName: "x", securityEnabled: true } },
  });
  assert.equal((await createGroupDirectory(ENABLED, credential, other.fetch).get(GROUP, noLog)).state, "unavailable");
});

test("disabled unless ADMIN_GROUP_SEARCH_ENABLED=true, and no Graph call is made", async () => {
  const t = transport({});
  const dir = createGroupDirectory({}, credential, t.fetch);
  assert.equal((await dir.search("x", noLog)).state, "disabled");
  assert.equal((await dir.get(GROUP, noLog)).state, "disabled");
  assert.equal(t.calls.length, 0);
});

test("members lists the group's direct user members (id and display name), and says when there are more", async () => {
  const member = "11111111-2222-4333-8444-555555555555";
  const t = transport({ [`/groups/${GROUP}/members/microsoft.graph.user`]: { status: 200, body: {
    value: [{ id: member.toUpperCase(), displayName: "Ada Lovelace" }, { id: "not-a-guid", displayName: "x" }, { id: member.replace("1111", "2222"), displayName: null }],
    "@odata.nextLink": "https://graph.microsoft.com/v1.0/next",
  } } });
  const result = await createGroupDirectory(ENABLED, credential, t.fetch).members(GROUP, noLog);
  assert.deepEqual(result, { state: "available", members: [{ id: member, displayName: "Ada Lovelace" }, { id: member.replace("1111", "2222"), displayName: null }], truncated: true });
  const url = new URL(t.calls[0].url);
  assert.equal(url.pathname, `/v1.0/groups/${GROUP}/members/microsoft.graph.user`);
  assert.equal(url.searchParams.get("$select"), "id,displayName");
  assert.equal((await createGroupDirectory({}, credential, t.fetch).members(GROUP, noLog)).state, "disabled");
  assert.equal((await createGroupDirectory(ENABLED, credential, transport({ "/groups": { status: 403, body: {} } }).fetch).members(GROUP, noLog)).state, "permission_required");
  assert.equal((await createGroupDirectory(ENABLED, credential, transport({ "/groups": { status: 200, body: { value: "x" } } }).fetch).members(GROUP, noLog)).state, "unavailable");
});
