// Chargeback ID and surface on the request path (ADR-0034 decision 7, ROADMAP G7a): the gateway
// validates the decision's chargeback ID, keeps it in the cached decision, and writes it and the
// request's surface into the ccof.usage.v1 trace. Runs the actual rendered C# expressions.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { attr, descendants, parseApimXml } from "../infra/gateway/apim-xml.ts";
import type { GatewayConfig } from "../infra/gateway/config.ts";
import { renderPolicy } from "../infra/gateway/render.ts";
import { sampleConfig } from "./helpers/gateway-fixtures.ts";
import { runExpressions } from "./helpers/policy-csharp.ts";
import type { Vector } from "./helpers/policy-csharp.ts";

const all = descendants(parseApimXml(renderPolicy(sampleConfig() as GatewayConfig).policyXml));
const expression = (name: string) => {
  const element = all.find((e) => e.name === "set-variable" && attr(e, "name") === name);
  assert.ok(element, `missing policy expression ${name}`);
  return attr(element, "value")!;
};

const nullLimit = () => ({ tokensPerMinute: null, tokenQuota: null, tokenQuotaPeriod: null });
const GROUP = "abcdef01-2345-4678-9abc-def012345678";
function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decisionVersion: 3, resolverOutcome: "success", projectId: GROUP, classification: "group", classificationGroupId: GROUP,
    budgetEnforcement: "token-limits-only", personCeilingTokensPerMinute: null,
    backendId: "foundry-example",
    familyPolicy: { aggregateLimits: { person: nullLimit(), group: nullLimit() }, families: { haiku: { models: ["claude-haiku-4-5"], person: nullLimit(), group: nullLimit() } } },
    surfaces: ["code"], chargebackId: "WBS-1234.01", restrictedFamiliesApproved: false,
    ...overrides,
  };
}

test("actual C#: chargeback ID is validated, cached and traced with the surface", () => {
  const methods = {
    Resolve: expression("ccofResolverResult"),
    CacheValid: expression("ccofCachedDecisionValid"),
    Chargeback: expression("ccofChargebackId"),
    Usage: expression("ccofUsageTrace"),
  };
  const vectors: Vector[] = [];
  const both = (label: string, body: Record<string, unknown>, allowed: boolean) => {
    vectors.push({ label, method: "Resolve", vars: { ccofResolverResponse: { status: 200, body } }, json: true, property: "o", expected: allowed ? "allow" : "unavailable" });
    vectors.push({ label: `${label} cached`, method: "CacheValid", vars: { ccofCached: { d: body } }, expected: allowed });
  };
  both("valid chargeback ID", decision(), true);
  both("null chargeback ID", decision({ chargebackId: null }), true);
  both("baseline without chargeback ID", decision({ classification: "STD", surfaces: undefined, chargebackId: undefined }), true);
  for (const bad of ["WBS 1", "=1+1", "", "x".repeat(65), "a,b", 7, ["WBS"]]) both(`chargeback ID ${JSON.stringify(bad)}`, decision({ chargebackId: bad }), false);
  vectors.push({ label: "chargeback ID copied", method: "Resolve", vars: { ccofResolverResponse: { status: 200, body: decision() } }, json: true,
    property: "d.chargebackId", expected: "WBS-1234.01" });
  vectors.push({ label: "decision variable", method: "Chargeback", vars: { ccofDecision: decision() }, expected: "WBS-1234.01" });
  vectors.push({ label: "decision variable when null", method: "Chargeback", vars: { ccofDecision: decision({ chargebackId: null }) }, expected: "" });

  const usageVars = {
    ccofBackendId: "foundry-example", ccofModel: "claude-haiku-4-5", ccofOid: "person1", ccofProjectId: GROUP, ccofClassification: "group",
    ccofClassificationGroupId: GROUP, ccofClassificationGroupDisplayName: "", ccofModelFamily: "haiku", ccofDecision: decision(), ccofStream: true,
  };
  vectors.push({ label: "trace chargeback", method: "Usage", vars: { ...usageVars, ccofChargebackId: "WBS-1234.01", ccofSurface: "code" }, json: true, property: "chargebackId", expected: "WBS-1234.01" });
  vectors.push({ label: "trace surface", method: "Usage", vars: { ...usageVars, ccofChargebackId: "WBS-1234.01", ccofSurface: "code" }, json: true, property: "surface", expected: "code" });
  vectors.push({ label: "trace without chargeback", method: "Usage", vars: { ...usageVars, ccofChargebackId: "", ccofSurface: "" }, json: true, property: "chargebackId", expected: null });
  vectors.push({ label: "trace without surface", method: "Usage", vars: { ...usageVars, ccofChargebackId: "", ccofSurface: "" }, json: true, property: "surface", expected: null });

  const results = runExpressions(methods, vectors);
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    const value = v.property ? v.property.split(".").reduce((x: any, key) => x?.[key], results[i]) : results[i];
    assert.deepEqual(value, v.expected, v.label);
  }
});
