// Surface enforcement in the rendered APIM policy (ADR-0034 decision 6): the
// calling client application (azp/appid) maps to a surface; a group's decision
// lists its allowed surfaces. Runs the actual rendered C# expressions.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { attr, descendants, parseApimXml } from "../infra/gateway/apim-xml.ts";
import type { XmlElement } from "../infra/gateway/apim-xml.ts";
import type { GatewayConfig } from "../infra/gateway/config.ts";
import { renderPolicy } from "../infra/gateway/render.ts";
import { sampleConfig } from "./helpers/gateway-fixtures.ts";
import { runExpressions } from "./helpers/policy-csharp.ts";
import type { Vector } from "./helpers/policy-csharp.ts";

const CODE_APP = "00000000-0000-0000-0000-00000000000f";
const CHAT_APP = "00000000-0000-0000-0000-00000000000c";

function expressions(config: Record<string, any>): (name: string) => string {
  const all = descendants(parseApimXml(renderPolicy(config as GatewayConfig).policyXml));
  return (name: string) => {
    const element = all.find((e) => e.name === "set-variable" && attr(e, "name") === name);
    assert.ok(element, `missing policy expression ${name}`);
    return attr(element, "value")!;
  };
}

const enforcedConfig = sampleConfig();
enforcedConfig.entra.surfaceClients = [{ clientAppId: CODE_APP, surface: "code" }, { clientAppId: CHAT_APP, surface: "chat" }];
const enforced = expressions(enforcedConfig);
const open = expressions(sampleConfig());

const nullLimit = () => ({ tokensPerMinute: null, tokenQuota: null, tokenQuotaPeriod: null });
function decision(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    decisionVersion: 3, resolverOutcome: "success", projectId: "abcdef01-2345-4678-9abc-def012345678", classification: "group",
    classificationGroupId: "abcdef01-2345-4678-9abc-def012345678", backendId: "foundry-example",
    familyPolicy: {
      aggregateLimits: { person: nullLimit(), group: nullLimit() },
      families: { haiku: { models: ["claude-haiku-4-5"], person: nullLimit(), group: nullLimit() } },
    },
    surfaces: ["chat", "code"], chargebackId: "WBS-1", restrictedFamiliesApproved: false,
    ...overrides,
  };
}

test("a group request whose surface is not allowed is refused before any token counter", () => {
  const all = descendants(parseApimXml(renderPolicy(enforcedConfig as GatewayConfig).policyXml));
  const refusal = all.find((e) => e.name === "when" && attr(e, "condition") === '@(!(bool)context.Variables["ccofSurfaceAllowed"])');
  assert.ok(refusal, "a when branch tests ccofSurfaceAllowed");
  const set = refusal.children.find((c): c is XmlElement => c.kind === "element" && c.name === "set-variable" && attr(c, "name") === "ccofRefusal");
  assert.equal(set && attr(set, "value"), "surface_not_allowed");
  const firstLimit = all.findIndex((e) => e.name === "llm-token-limit");
  assert.ok(all.indexOf(refusal) < firstLimit, "surface refusal precedes every token counter");
});

test("actual C#: client app maps to surface; a group's decision admits only its surfaces", () => {
  const methods = {
    Resolve: enforced("ccofResolverResult"),
    CacheValid: enforced("ccofCachedDecisionValid"),
    Surface: enforced("ccofSurface"),
    Allowed: enforced("ccofSurfaceAllowed"),
    AllowedOpen: open("ccofSurfaceAllowed"),
    SurfaceOpen: open("ccofSurface"),
    RefusalStatus: enforced("ccofRefusalStatus"),
    RefusalBody: enforced("ccofRefusalBody"),
  };
  const vectors: Vector[] = [];
  const both = (label: string, body: Record<string, unknown>, allowed: boolean) => {
    vectors.push({ label, method: "Resolve", vars: { ccofResolverResponse: { status: 200, body } }, json: true, property: "o", expected: allowed ? "allow" : "unavailable" });
    vectors.push({ label: `${label} cached`, method: "CacheValid", vars: { ccofCached: { d: body } }, expected: allowed });
  };

  vectors.push({ label: "code app", method: "Surface", vars: { ccofClientAppId: CODE_APP }, expected: "code" });
  vectors.push({ label: "chat app", method: "Surface", vars: { ccofClientAppId: CHAT_APP }, expected: "chat" });
  vectors.push({ label: "unmapped app", method: "Surface", vars: { ccofClientAppId: "00000000-0000-0000-0000-0000000000ee" }, expected: "" });
  vectors.push({ label: "no mapping configured", method: "SurfaceOpen", vars: { ccofClientAppId: CODE_APP }, expected: "" });

  both("group with surfaces", decision(), true);
  vectors.push({ label: "surfaces copied", method: "Resolve", vars: { ccofResolverResponse: { status: 200, body: decision() } }, json: true,
    property: "d.surfaces", expected: ["chat", "code"] });
  both("baseline without surfaces", decision({ classification: "STD", surfaces: undefined }), true);
  for (const [label, surfaces] of [
    ["missing on a group", undefined], ["not an array", "code"], ["empty", []], ["unknown", ["email"]],
    ["duplicate", ["code", "code"]], ["not a string", [1]], ["too many", ["chat", "code", "cowork", "design", "m365", "chat"]],
  ] as [string, unknown][]) {
    both(`surfaces ${label}`, decision({ surfaces }), false);
  }

  const allowed = (label: string, method: string, d: Record<string, unknown>, surface: string, expected: boolean) =>
    vectors.push({ label, method, vars: { ccofDecision: d, ccofSurface: surface }, expected });
  allowed("allowed surface", "Allowed", decision(), "code", true);
  allowed("surface not in the group's list", "Allowed", decision({ surfaces: ["chat"] }), "code", false);
  allowed("unmapped client under enforcement", "Allowed", decision(), "", false);
  allowed("baseline decision is not surface-scoped", "Allowed", decision({ classification: "STD", surfaces: undefined }), "", true);
  allowed("no mapping configured: not enforced", "AllowedOpen", decision({ surfaces: ["chat"] }), "", true);

  vectors.push({ label: "refusal status", method: "RefusalStatus", vars: { ccofRefusal: "surface_not_allowed" }, expected: 403 });
  vectors.push({ label: "refusal body", method: "RefusalBody", vars: { ccofRefusal: "surface_not_allowed", ccofSelector: "", ccofModel: "claude-haiku-4-5", ccofSurface: "code" },
    json: true, property: "error.message", expected: "This application (code) is not enabled for your Claude group. Ask your platform team to enable it, or use an enabled application. Request id: 00000000-0000-0000-0000-000000000001." });

  const results = runExpressions(methods, vectors);
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    const value = v.property ? v.property.split(".").reduce((x: any, key) => x?.[key], results[i]) : results[i];
    assert.deepEqual(value, v.expected, v.label);
  }
});
