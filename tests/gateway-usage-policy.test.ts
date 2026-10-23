// GET /ccof/me/usage (docs/USAGE.md): the operation policy rendered from policy/my-usage.template.xml.
// It checks the token exactly as /v1/messages does, sends the resolver only the token's oid, and passes
// on only a well-formed usage answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTemplates, renderPolicy } from "../infra/gateway/render.ts";
import type { GatewayConfig } from "../infra/gateway/config.ts";
import { validateGatewayConfig } from "../infra/gateway/config.ts";
import { parseApimXml } from "../infra/gateway/apim-xml.ts";
import { sampleConfig } from "./helpers/gateway-fixtures.ts";
import { runExpressions } from "./helpers/policy-csharp.ts";

const templates = loadTemplates();
const config = sampleConfig() as GatewayConfig;
const rendered = renderPolicy(config);

// The four token-check elements, cut from a template by their opening markers.
function identityBlocks(text: string): string[] {
  const lf = text.replace(/\r\n/g, "\n");
  const grab = (re: RegExp) => {
    const m = lf.match(re);
    assert.ok(m, `missing ${re}`);
    return m[0];
  };
  return [
    grab(/ {4}<validate-jwt id="ccof-jwt"[\s\S]*?<\/validate-jwt>/),
    grab(/ {4}<set-variable name="ccofOid" value="@\{[\s\S]*?\}" \/>/),
    grab(/ {4}<set-variable name="ccofClientAppId" value="@\{[\s\S]*?\}" \/>/),
    grab(/ {4}<set-variable name="ccofRefusal" value="@\{\n[\s\S]*?\n {4}\}" \/>/),
  ];
}

test("the usage operation checks the token byte-for-byte as /v1/messages does", () => {
  assert.ok(templates.usage, "loadTemplates must load my-usage.template.xml");
  assert.deepEqual(identityBlocks(templates.usage), identityBlocks(templates.main));
});

test("a rendered usage policy is well-formed, fully filled, and does not run the API-scope policy", () => {
  assert.ok(rendered.usagePolicyXml);
  assert.ok(!rendered.usagePolicyXml.includes("%%"));
  assert.equal(parseApimXml(rendered.usagePolicyXml).name, "policies");
  assert.doesNotMatch(rendered.usagePolicyXml.replace(/<!--[\s\S]*?-->/g, ""), /<base\s*\/>/, "no <base />: the claude-messages policy must not run for this operation");
  assert.match(rendered.usagePolicySha256, /^[0-9a-f]{64}$/);
  // The same tenant, audiences and scope as the messages policy.
  for (const value of [config.entra.tenantId, config.entra.delegatedScope, ...config.entra.audiences]) {
    assert.ok(rendered.usagePolicyXml.includes(value), value);
  }
});

test("the resolver URL is the messages resolver URL with /api/me/usage", () => {
  const expected = config.resolver.url.replace(/\/api\/resolve$/, "/api/me/usage");
  assert.notEqual(expected, config.resolver.url);
  assert.ok(rendered.usagePolicyXml.includes(`<set-url>${expected}</set-url>`));
  const odd = { ...structuredClone(config), resolver: { ...config.resolver, url: "https://resolver.example.test/api/decide" } };
  assert.throws(() => renderPolicy(odd), /resolver\.url must end with \/api\/resolve/);
});

test("nothing from the request is read: the resolver gets only the token's oid and the request id", () => {
  assert.doesNotMatch(templates.usage ?? "", /context\.Request\./);
  const send = rendered.usagePolicyXml.match(/<send-request[\s\S]*?<\/send-request>/)?.[0] ?? "";
  assert.match(send, /new JProperty\("personId", \(string\)context\.Variables\["ccofOid"\]\)/);
  assert.match(send, /new JProperty\("requestId", context\.RequestId\.ToString\(\)\)/);
  assert.equal((send.match(/JProperty\(/g) ?? []).length, 2, "no other field in the resolver request");
});

test("per-person rate limit: 10 per 60 s by default, or admission.usage; its own counter", () => {
  assert.match(rendered.usagePolicyXml, /<rate-limit-by-key id="ccof-usage-person" calls="10" renewal-period="60" counter-key="@\("ccof-usage:" \+/);
  const tuned = structuredClone(config) as GatewayConfig & { admission: { usage?: unknown } };
  tuned.admission.usage = { calls: 3, renewalPeriodSeconds: 30 };
  assert.ok(validateGatewayConfig(tuned).ok);
  assert.match(renderPolicy(tuned).usagePolicyXml, /calls="3" renewal-period="30"/);
  const bad = structuredClone(tuned) as typeof tuned;
  bad.admission.usage = { calls: 0, renewalPeriodSeconds: 30 };
  assert.ok(!validateGatewayConfig(bad).ok);
});

test("only a 200 whose body has schema ccof.usage.v1 and a scopes array is passed on; otherwise 503", () => {
  const guard = rendered.usagePolicyXml.match(/<set-variable name="ccofUsageBody"[\s\S]*?" \/>/)?.[0] ?? "";
  assert.match(guard, /response\.StatusCode != 200/);
  assert.match(guard, /\(string\)body\["schema"\] == "ccof\.usage\.v1" && body\["scopes"\] is JArray/);
  assert.match(rendered.usagePolicyXml, /<set-status code="503" reason="Service Unavailable" \/>/);
  assert.match(rendered.usagePolicyXml, /<value>no-store<\/value>/);
  // "skip" would still add the header when absent (Learn, set-header): only a 429 carries Retry-After.
  assert.match(rendered.usagePolicyXml, /<set-header name="Retry-After" exists-action="@\(\(int\)context\.Variables\["ccofUsageErrorStatus"\] == 429 \? "override" : "delete"\)">/);
});

test("the template carries no environment literal and the digest covers it", () => {
  const broken = { ...templates, usage: (templates.usage ?? "").replace("%%RESOLVER_USAGE_URL%%", "https://resolver.example.test/api/me/usage") };
  assert.throws(() => renderPolicy(config, { templates: broken }), /literal/);
  const changed = { ...templates, usage: `${templates.usage}\n<!-- changed -->\n` };
  assert.notEqual(renderPolicy(config, { templates: changed }).usagePolicySha256, rendered.usagePolicySha256);
});

test("the template on disk is the one loaded", () => {
  const disk = readFileSync(new URL("../infra/gateway/policy/my-usage.template.xml", import.meta.url), "utf8");
  assert.equal(disk, templates.usage);
});

// The rendered C# expressions, compiled and run (tests/helpers/policy-csharp.ts). The harness builds an
// IResponse only for the variable ccofResolverResponse, so the guard is run with that name.
test("compiled: the response guard and the error mapping behave as documented", () => {
  const attr = (name: string) => {
    const m = rendered.usagePolicyXml.match(new RegExp(`<set-variable name="${name}" value="(@[\\s\\S]*?)" />`));
    assert.ok(m, name);
    return m[1].replace(/&quot;/g, '"').replace(/ccofUsageResponse/g, "ccofResolverResponse");
  };
  const ok = { schema: "ccof.usage.v1", period: "2026-10", groupTotals: "hidden", truncated: false, scopes: [] };
  const vectors = [
    { label: "200 usage", method: "Guard", vars: { ccofResolverResponse: { status: 200, body: ok } }, expected: JSON.stringify(ok) },
    { label: "200 other schema", method: "Guard", vars: { ccofResolverResponse: { status: 200, body: { ...ok, schema: "ccof.other" } } }, expected: "" },
    { label: "200 scopes not array", method: "Guard", vars: { ccofResolverResponse: { status: 200, body: { ...ok, scopes: {} } } }, expected: "" },
    { label: "503 from resolver", method: "Guard", vars: { ccofResolverResponse: { status: 503, body: ok } }, expected: "" },
    { label: "no response", method: "Guard", vars: {}, expected: "" },
    { label: "rate limited", method: "Status", policyId: "ccof-usage-person", expected: 429 },
    { label: "other error", method: "Status", policyId: "something-else", expected: 500 },
    { label: "retry-after from the limit", method: "Retry", vars: { ccofRetryAfter: 17 }, expected: "17" },
    { label: "retry-after default", method: "Retry", vars: {}, expected: "60" },
  ];
  const results = runExpressions({ Guard: attr("ccofUsageBody"), Status: attr("ccofUsageErrorStatus"), Retry: attr("ccofUsageRetryAfter") }, vectors);
  vectors.forEach((v, i) => assert.deepEqual(results[i], v.expected, v.label));
});
