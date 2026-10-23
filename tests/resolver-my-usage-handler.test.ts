// POST /api/me/usage on the resolver (called only by APIM, ADR-0009): the same platform gate and
// deadline as /api/resolve, a body that carries only the person ID APIM took from the token's oid,
// and an answer with no amounts in the log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMyUsageRequest } from "../src/resolver/http-handler.ts";
import type { ResolverRuntime } from "../src/resolver/http-handler.ts";
import type { ResolveDependencies } from "../src/resolver/decide.ts";
import { activeMembership, entitlementWithMembership, fakeReads, RESOLVE_NOW } from "./helpers/resolver-fixtures.ts";
import { readResolverConfig, RESOLVER_SETTINGS } from "../src/resolver/config.ts";

const OID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const authenticated = { platformAuthEnabled: true, authenticatedPrincipal: true };

function reads(): ResolveDependencies {
  return fakeReads({
    readEntitlement: async (personId: string) => ({ ...entitlementWithMembership, id: personId, personId, projectMemberships: [activeMembership] }),
    readBudgetState: async (personId: string, projectId: string) => ({ id: `${personId}:${projectId}`, personId, projectId, classification: "STD",
      spentCcu: "1234.5", budgetCcu: "5000", exhausted: false, period: "2026-10", computedAt: "2026-10-09T06:10:00Z",
      validUntil: "2026-10-09T06:20:00Z", completeness: "partial", realtimeCeilingTokensPerMinute: 1 }) as never,
    readAggregateBudgetState: async (scopeId: string) => ({ scopeId, spentCcu: "9", budgetCcu: "99", exhausted: false, mode: "strict",
      computedAt: "2026-10-09T06:10:00Z", validUntil: "2026-10-09T06:20:00Z" }) as never,
  });
}

function runtime(options: { reads?: ResolveDependencies; logs?: string[]; usageGroupTotals?: boolean; deadlineMs?: number } = {}): ResolverRuntime {
  const logs = options.logs ?? [];
  return {
    readiness: { ready: true, budgetEnforcement: { mode: "token-limits-only" }, requestDeadlineMs: options.deadlineMs ?? 5000,
      reads: options.reads ?? reads(), usageGroupTotals: options.usageGroupTotals ?? false },
    now: () => RESOLVE_NOW,
    log: (line) => logs.push(line),
  };
}

test("200 with the caller's own figures for the person ID in the body", async () => {
  const res = await handleMyUsageRequest({ ...authenticated, body: { personId: OID } }, runtime());
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.schema, "ccof.usage.v1");
  const [scope] = res.jsonBody.scopes as Record<string, unknown>[];
  assert.deepEqual(scope.spent, { ccu: "1234.5", usd: "12.345" });
  assert.equal(scope.completeness, "partial");
  assert.equal("group" in scope, false);
});

test("group totals follow the deployment setting", async () => {
  const res = await handleMyUsageRequest({ ...authenticated, body: { personId: OID } }, runtime({ usageGroupTotals: true }));
  assert.equal(res.jsonBody.groupTotals, "shown");
  assert.deepEqual(((res.jsonBody.scopes as Record<string, any>[])[0].group), { remaining: { ccu: "90", usd: "0.9" } });
});

test("the platform gate applies exactly as on /api/resolve", async () => {
  assert.equal((await handleMyUsageRequest({ platformAuthEnabled: false, authenticatedPrincipal: true, body: { personId: OID } }, runtime())).status, 503);
  assert.equal((await handleMyUsageRequest({ platformAuthEnabled: true, authenticatedPrincipal: false, body: { personId: OID } }, runtime())).status, 401);
});

test("the body must hold only a lower-case GUID person ID (and an optional request ID)", async () => {
  for (const body of [undefined, null, {}, { personId: "" }, { personId: "person-1" }, { personId: OID.toUpperCase() },
    { personId: OID, projectId: "P1" }, { personId: OID, other: 1 }, [OID]]) {
    const res = await handleMyUsageRequest({ ...authenticated, body }, runtime());
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.jsonBody, { error: "invalid_request" });
  }
  assert.equal((await handleMyUsageRequest({ ...authenticated, body: { personId: OID, requestId: "abc-123" } }, runtime())).status, 200);
});

test("a failed or slow read is 503 temporarily_unavailable, logged without amounts", async () => {
  const logs: string[] = [];
  const failing = fakeReads({ readEntitlement: async () => { throw Object.assign(new Error("boom https://x"), { code: 503 }); } });
  const res = await handleMyUsageRequest({ ...authenticated, body: { personId: OID } }, runtime({ reads: failing, logs }));
  assert.equal(res.status, 503);
  assert.equal(res.jsonBody.error, "temporarily_unavailable");
  const event = JSON.parse(logs[0]);
  assert.equal(event.reason, "registry_read_failed");
  assert.equal(event.route, "me/usage");
  assert.ok(!logs[0].includes("https://x"));

  const slow = fakeReads({ readEntitlement: () => new Promise(() => {}) });
  const late = await handleMyUsageRequest({ ...authenticated, body: { personId: OID } }, runtime({ reads: slow, deadlineMs: 20 }));
  assert.equal(late.status, 503);
});

test("a successful answer logs nothing (no amounts, no person ID)", async () => {
  const logs: string[] = [];
  await handleMyUsageRequest({ ...authenticated, body: { personId: OID } }, runtime({ logs }));
  assert.deepEqual(logs, []);
});

test("RESOLVER_USAGE_GROUP_TOTALS: absent is hidden; true/false exact; anything else is a configuration problem", () => {
  const base = { COSMOS_ENDPOINT: "https://x.documents.azure.com:443/", COSMOS_DATABASE: "ccof", RESOLVER_COSMOS_REQUEST_TIMEOUT_MS: "2000",
    RESOLVER_COSMOS_RETRY_ATTEMPTS: "2", RESOLVER_COSMOS_RETRY_MAX_WAIT_SECONDS: "2", RESOLVER_REQUEST_DEADLINE_MS: "4000",
    RESOLVER_BUDGET_ENFORCEMENT: "token-limits-only" };
  const read = (value?: string) => readResolverConfig(value === undefined ? base : { ...base, [RESOLVER_SETTINGS.usageGroupTotals]: value });
  const absent = read();
  assert.ok(absent.ok && absent.config.usageGroupTotals === false);
  const on = read("true");
  assert.ok(on.ok && on.config.usageGroupTotals === true);
  const off = read("false");
  assert.ok(off.ok && off.config.usageGroupTotals === false);
  for (const bad of ["TRUE", "yes", "1", " true"]) {
    const result = read(bad);
    assert.ok(!result.ok && result.problems.some((p) => p.setting === "RESOLVER_USAGE_GROUP_TOTALS" && p.problem === "not_boolean"), bad);
  }
});
