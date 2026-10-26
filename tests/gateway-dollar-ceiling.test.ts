import assert from "node:assert/strict";
import { test } from "node:test";
import { attr, descendants, parseApimXml } from "../infra/gateway/apim-xml.ts";
import type { GatewayConfig } from "../infra/gateway/config.ts";
import { renderPolicy } from "../infra/gateway/render.ts";
import { resolveRequest } from "../src/resolver/decide.ts";
import { sampleConfig } from "./helpers/gateway-fixtures.ts";
import { runExpressions, type Vector } from "./helpers/policy-csharp.ts";
import { activeBudgetState, context, fakeReads, tokenLimitsOnlyContext } from "./helpers/resolver-fixtures.ts";

const all = descendants(parseApimXml(renderPolicy(sampleConfig() as GatewayConfig).policyXml));
function expression(name: string): string {
  const element = all.find((e) => e.name === "set-variable" && attr(e, "name") === name);
  assert.ok(element, name);
  return attr(element, "value")!;
}
const methods = {
  Resolve: expression("ccofResolverResult"),
  Cache: expression("ccofCachedDecisionValid"),
  PersonTpm: expression("ccofPersonTpm"),
  PacingTpm: expression("ccofPersonCeilingTpm"),
  PacingKey: expression("ccofPersonCeilingKey"),
  PacingReset: expression("ccofPersonCeilingResetSeconds"),
  ErrorKind: expression("ccofErrorKind"),
  RetryAfter: expression("ccofErrorRetryAfter"),
  ErrorBody: expression("ccofErrorBody"),
  RefusalStatus: expression("ccofRefusalStatus"),
  RefusalBody: expression("ccofRefusalBody"),
};

async function decision(ceiling: number | null) {
  const result = await resolveRequest({ personId: "person-1" }, fakeReads({
    readBudgetState: async () => ({ ...activeBudgetState, realtimeCeilingTokensPerMinute: ceiling }),
  }), ceiling === null ? tokenLimitsOnlyContext() : context());
  assert.equal(result.refused, false);
  return { ...result, resolverOutcome: "success" };
}

test("the actual resolver monetary ceiling survives APIM normalization and cached revalidation", async () => {
  const body = await decision(7);
  const [result] = runExpressions(methods, [{
    label: "normalize ceiling", method: "Resolve", vars: { ccofResolverResponse: { status: 200, body } },
    json: true, expected: null,
  }]) as Array<{ o: string; d: Record<string, unknown> }>;
  assert.equal(result.o, "allow");
  assert.equal(result.d.personCeilingTokensPerMinute, 7);
  assert.equal(result.d.budgetEnforcement, "budget-state");
  assert.deepEqual(runExpressions(methods, [{
    label: "cached monetary decision", method: "Cache", vars: { ccofCached: { d: result.d } }, expected: true,
  }]), [true]);
});

test("a zero-token monetary remainder produces a cacheable budget refusal (projected), not an unlimited allow", async () => {
  const body = await decision(0);
  const [result] = runExpressions(methods, [{
    label: "sub-token remainder", method: "Resolve", vars: { ccofResolverResponse: { status: 200, body } },
    json: true, expected: null,
  }]) as Array<Record<string, unknown>>;
  assert.equal(result.o, "refuse");
  assert.equal(result.c, "budget_projected");
  assert.equal(result.rp, body.projectId);
  assert.equal(result.b, "fresh");
});

// ADR-0047: the configured person limit keeps its own counter and value; the monetary ceiling runs on a
// separate pacing counter, so a budget change cannot leave a debt on the configured counter.
test("the configured person TPM and the monetary pacing ceiling are separate limits; token-only mode has no pacing", async () => {
  const vectors: Vector[] = [];
  for (const [ceiling, configured, expectedPerson, expectedPacing] of [[7, 1000000, 1000000, 7], [4200, 100, 100, 4200], [7, null, 0, 7], [null, 100, 100, 0], [null, null, 0, 0]]) {
    const body = await decision(ceiling);
    if (!("familyPolicy" in body)) assert.fail("expected success");
    const d = structuredClone(body);
    d.familyPolicy.aggregateLimits.person.tokensPerMinute = configured;
    vectors.push({ label: `person ${ceiling}/${configured}`, method: "PersonTpm", vars: { ccofDecision: d }, expected: expectedPerson });
    vectors.push({ label: `pacing ${ceiling}/${configured}`, method: "PacingTpm", vars: { ccofDecision: d }, expected: expectedPacing });
  }
  assert.deepEqual(runExpressions(methods, vectors), vectors.map((v) => v.expected));
});

async function keyedDecision(state: Record<string, unknown>) {
  const result = await resolveRequest({ personId: "person-1" }, fakeReads({
    readBudgetState: async () => ({ ...activeBudgetState, realtimeCeilingTokensPerMinute: 7, ...state }) as never,
  }), context());
  assert.equal(result.refused, false);
  return { ...result, resolverOutcome: "success" } as Record<string, unknown>;
}

test("the pacing counter key comes from the resolver's budget period and amount, survives normalization and caching, and is validated", async () => {
  const body = await keyedDecision({ period: "2026-10", budgetCcu: "10000" });
  const [normalized] = runExpressions(methods, [{ label: "keyed", method: "Resolve", vars: { ccofResolverResponse: { status: 200, body } }, json: true, expected: null }]) as Array<{ o: string; d: Record<string, unknown> }>;
  assert.equal(normalized.o, "allow");
  assert.equal(normalized.d.personCeilingKey, "2026-10_10000");
  const legacy = await decision(7);
  const vectors: Vector[] = [
    { label: "cached keyed", method: "Cache", vars: { ccofCached: { d: normalized.d } }, expected: true },
    { label: "key read", method: "PacingKey", vars: { ccofDecision: normalized.d }, expected: "2026-10_10000" },
    { label: "no key: one shared fallback key", method: "PacingKey", vars: { ccofDecision: legacy }, expected: "-" },
    { label: "cached without key stays valid", method: "Cache", vars: { ccofCached: { d: legacy } }, expected: true },
  ];
  for (const bad of ["2026-10_1:x", "2026-13_1", "2026-10_", "2026-10_-1", "2026-10_1e5", "x".repeat(60), 7, null]) {
    vectors.push({ label: `cached ${JSON.stringify(bad)}`, method: "Cache", vars: { ccofCached: { d: { ...normalized.d, personCeilingKey: bad } } }, expected: false });
    vectors.push({ label: `resolver ${JSON.stringify(bad)}`, method: "Resolve", vars: { ccofResolverResponse: { status: 200, body: { ...body, personCeilingKey: bad } } }, json: true, expected: { o: "unavailable" } });
  }
  const tokenOnly = await decision(null);
  vectors.push({ label: "token-only with a key", method: "Resolve", vars: { ccofResolverResponse: { status: 200, body: { ...tokenOnly, personCeilingKey: "2026-10_1" } } }, json: true, expected: { o: "unavailable" } });
  assert.deepEqual(runExpressions(methods, vectors), vectors.map((v) => v.expected));
});

test("the pacing key's month bounds Retry-After: seconds to the month's end plus the allow cache time", () => {
  const allowTtl = (sampleConfig() as GatewayConfig).entitlementCache.allowTtlSeconds;
  const [future, past, none, bad] = runExpressions(methods, [
    { label: "future", method: "PacingReset", vars: { ccofPersonCeilingKey: "2999-12_1" }, expected: null },
    { label: "past", method: "PacingReset", vars: { ccofPersonCeilingKey: "2000-01_1" }, expected: null },
    { label: "none", method: "PacingReset", vars: { ccofPersonCeilingKey: "-" }, expected: null },
    { label: "bad month", method: "PacingReset", vars: { ccofPersonCeilingKey: "2026-13_1" }, expected: null },
  ]) as number[];
  const expected = Math.ceil((Date.UTC(3000, 0, 1) - Date.now()) / 1000) + allowTtl;
  assert.ok(Math.abs(future - expected) <= 60, `future month: ${future} vs ${expected}`);
  assert.equal(past, 1 + allowTtl);
  assert.equal(none, 0);
  assert.equal(bad, 0);
});

test("a pacing refusal is classified apart from the configured TPM, says it is the budget guard, and has an honest Retry-After", () => {
  const kinds = runExpressions(methods, [
    { label: "pacing", method: "ErrorKind", policyId: "ccof-limit-budget-person", status: 429, reason: "TokenLimitExceeded", expected: null },
    { label: "pacing consumed", method: "ErrorKind", policyId: "ccof-limit-budget-person-consumed", status: 429, reason: "TokenLimitExceeded", expected: null },
    { label: "configured", method: "ErrorKind", policyId: "ccof-limit-person-rate", status: 429, reason: "TokenLimitExceeded", expected: null },
  ]);
  assert.deepEqual(kinds, ["budget_pacing", "budget_pacing", "person_rate"]);
  const retry = (after: number, reset: number | undefined) => ({ label: `${after}/${reset}`, method: "RetryAfter", expected: null,
    vars: { ccofErrorKind: "budget_pacing", ccofRetryAfter: after, ...(reset === undefined ? {} : { ccofPersonCeilingResetSeconds: reset }) } });
  assert.deepEqual(runExpressions(methods, [retry(25607, 3600), retry(25607, 0), retry(25607, 99999), retry(40, undefined)]), ["3600", "25607", "25607", "40"]);
  const group = "4a5b6c7d-0000-4000-8000-000000000001";
  const [pacing, configured] = runExpressions(methods, [
    { label: "pacing body", method: "ErrorBody", json: true, expected: null, vars: { ccofErrorKind: "budget_pacing", ccofProjectId: group, ccofClassification: "group" } },
    { label: "configured body", method: "ErrorBody", json: true, expected: null, vars: { ccofErrorKind: "person_rate", ccofProjectId: group, ccofClassification: "group" } },
  ]) as Array<{ error: { type: string; message: string } }>;
  assert.equal(pacing.error.type, "rate_limit_error");
  assert.match(pacing.error.message, /budget guard/);
  assert.match(pacing.error.message, /raising the budget/i);
  assert.match(pacing.error.message, new RegExp(`group ${group}`));
  assert.doesNotMatch(pacing.error.message, /You have reached your tokens-per-minute limit/);
  assert.equal(configured.error.type, "rate_limit_error");
  assert.match(configured.error.message, new RegExp(`tokens-per-minute limit in group ${group}`));
  assert.doesNotMatch(configured.error.message, /budget guard/);
});

test("the pacing counter is its own llm-token-limit, keyed by project, person and the budget key, after the configured person limit", () => {
  const limits = all.filter((e) => e.name === "llm-token-limit");
  const ids = limits.map((e) => attr(e, "id"));
  const pacing = limits.filter((e) => attr(e, "id")!.startsWith("ccof-limit-budget-person"));
  assert.deepEqual(pacing.map((e) => attr(e, "id")), ["ccof-limit-budget-person-consumed", "ccof-limit-budget-person"]);
  for (const limit of pacing) {
    assert.equal(attr(limit, "counter-key"), '@("pb:" + (string)context.Variables["ccofProjectId"] + ":" + (string)context.Variables["ccofOid"] + ":" + (string)context.Variables["ccofPersonCeilingKey"])');
    assert.equal(attr(limit, "tokens-per-minute"), '@((int)context.Variables["ccofPersonCeilingTpm"])');
    assert.equal(attr(limit, "token-quota"), undefined);
    assert.equal(attr(limit, "retry-after-variable-name"), "ccofRetryAfter");
    assert.equal(attr(limit, "remaining-tokens-header-name"), undefined);
  }
  assert.equal(attr(pacing[0], "tokens-consumed-header-name"), "x-test-tokens-consumed");
  assert.equal(attr(pacing[1], "tokens-consumed-header-name"), undefined);
  assert.ok(ids.indexOf("ccof-limit-budget-person-consumed") > ids.indexOf("ccof-limit-person-quota"), "pacing runs after the configured person limit");
});

test("a zero ceiling under the budget is a projected-spend refusal that says it can clear, not 'used up'", async () => {
  const body = await decision(0);
  const [result] = runExpressions(methods, [{
    label: "projected", method: "Resolve", vars: { ccofResolverResponse: { status: 200, body } }, json: true, expected: null,
  }]) as Array<Record<string, unknown>>;
  assert.equal(result.o, "refuse");
  assert.equal(result.c, "budget_projected");
  const group = "4a5b6c7d-0000-4000-8000-000000000001";
  const [status, refusal, exhausted] = runExpressions(methods, [
    { label: "status", method: "RefusalStatus", vars: { ccofRefusal: "budget_projected" }, expected: null },
    { label: "body", method: "RefusalBody", json: true, expected: null, vars: { ccofRefusal: "budget_projected", ccofProjectId: group, ccofClassification: "group", ccofSelector: "", ccofModel: "m" } },
    { label: "used up", method: "RefusalBody", json: true, expected: null, vars: { ccofRefusal: "budget_exhausted", ccofProjectId: group, ccofClassification: "group", ccofSelector: "", ccofModel: "m" } },
  ]) as [number, { error: { type: string; message: string } }, { error: { type: string; message: string } }];
  assert.equal(status, 403);
  assert.equal(refusal.error.type, "permission_error");
  assert.doesNotMatch(refusal.error.message, /used up/);
  assert.match(refusal.error.message, /recorded spend catches up/);
  assert.match(refusal.error.message, new RegExp(`group ${group}`));
  assert.match(exhausted.error.message, /used up/);
  assert.doesNotMatch(exhausted.error.message, /CCU|project /);
  const cachedRefusal = all.find((e) => e.name === "set-variable" && attr(e, "name") === "ccofRefusal" && attr(e, "value")!.includes("ccofCached"));
  assert.match(attr(cachedRefusal!, "value")!, /"budget_projected"/);
});

test("malformed or legacy monetary decisions are not reusable as fresh or last-known-good allows", async () => {
  const body = await decision(7);
  const vectors: Vector[] = [];
  const invalid = [
    { personCeilingTokensPerMinute: undefined }, { personCeilingTokensPerMinute: null },
    { personCeilingTokensPerMinute: "7" }, { personCeilingTokensPerMinute: -1 },
    { personCeilingTokensPerMinute: 0.5 }, { personCeilingTokensPerMinute: 2147483648 },
    { budgetEnforcement: undefined }, { budgetEnforcement: "unknown" },
    { budgetEnforcement: "token-limits-only", personCeilingTokensPerMinute: 7 },
  ];
  for (const edit of invalid) {
    const d = { ...body, ...edit };
    vectors.push({ label: JSON.stringify(edit), method: "Cache", vars: { ccofCached: { d } }, expected: false });
    vectors.push({ label: `resolver ${JSON.stringify(edit)}`, method: "Resolve",
      vars: { ccofResolverResponse: { status: 200, body: d } }, json: true, expected: { o: "unavailable" } });
  }
  vectors.push({ label: "cached zero never reusable", method: "Cache", vars: { ccofCached: { d: { ...body, personCeilingTokensPerMinute: 0 } } }, expected: false });
  assert.deepEqual(runExpressions(methods, vectors), vectors.map((v) => v.expected));
});
