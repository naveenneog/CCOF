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

test("a zero-token monetary remainder produces a cacheable budget refusal, not an unlimited allow", async () => {
  const body = await decision(0);
  const [result] = runExpressions(methods, [{
    label: "sub-token remainder", method: "Resolve", vars: { ccofResolverResponse: { status: 200, body } },
    json: true, expected: null,
  }]) as Array<Record<string, unknown>>;
  assert.equal(result.o, "refuse");
  assert.equal(result.c, "budget_exhausted");
  assert.equal(result.rp, body.projectId);
  assert.equal(result.b, "fresh");
});

test("monetary admission tightens person TPM without increasing configured limits or changing token-only mode", async () => {
  const vectors: Vector[] = [];
  for (const [ceiling, configured, expected] of [[7, 1000000, 7], [4200, 100, 100], [7, null, 7], [null, 100, 100], [null, null, 0]]) {
    const body = await decision(ceiling);
    if (!("familyPolicy" in body)) assert.fail("expected success");
    const d = structuredClone(body);
    d.familyPolicy.aggregateLimits.person.tokensPerMinute = configured;
    vectors.push({ label: `${ceiling}/${configured}`, method: "PersonTpm", vars: { ccofDecision: d }, expected });
  }
  assert.deepEqual(runExpressions(methods, vectors), vectors.map((v) => v.expected));
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
