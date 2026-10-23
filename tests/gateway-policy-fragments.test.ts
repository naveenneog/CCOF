// API Management refused the rendered gateway policy on a Standard v2 instance created 2026-10-23
// ("Policy size exceeds allowed limit of 16 KB"); the same service accepted a 68 KB policy fragment.
// The deployed form is a small API policy that includes one fragment per section (ADR-0039).
import assert from "node:assert/strict";
import { test } from "node:test";
import { attr, descendants, parseApimXml, type XmlElement } from "../infra/gateway/apim-xml.ts";
import type { GatewayConfig } from "../infra/gateway/config.ts";
import { API_POLICY_LIMIT_BYTES, renderPolicy, splitPolicyForDeployment } from "../infra/gateway/render.ts";
import { sampleConfig } from "./helpers/gateway-fixtures.ts";

const rendered = renderPolicy(sampleConfig() as GatewayConfig);
const SECTIONS = ["inbound", "backend", "outbound", "on-error"] as const;
const elements = (node: XmlElement | undefined): XmlElement[] => (node?.children ?? []).filter((c): c is XmlElement => c.kind === "element");
const section = (root: XmlElement, name: string): XmlElement | undefined => elements(root).find((c) => c.name === name);

test("the rendered policy is larger than the API policy limit, so it needs fragments", () => {
  assert.ok(Buffer.byteLength(rendered.policyXml, "utf8") > API_POLICY_LIMIT_BYTES);
});

test("the deployed API policy is under the limit and includes one fragment per section", () => {
  const { apiPolicyXml, fragments } = rendered.deployment;
  assert.ok(Buffer.byteLength(apiPolicyXml, "utf8") < API_POLICY_LIMIT_BYTES, `${Buffer.byteLength(apiPolicyXml, "utf8")} bytes`);
  const root = parseApimXml(apiPolicyXml);
  assert.equal(root.name, "policies");
  for (const name of SECTIONS) {
    const node = section(root, name);
    assert.ok(node, `<${name}> is present`);
    const includes = elements(node).filter((c) => c.name === "include-fragment");
    assert.deepEqual(includes.map((c) => attr(c, "fragment-id")), [fragments.find((f) => f.id.startsWith(`${rendered.apiId}-${name}-`))?.id]);
  }
  for (const f of fragments) assert.match(f.id, new RegExp(`^${rendered.apiId}-(inbound|backend|outbound|on-error)-[0-9a-f]{12}$`));
  assert.equal(fragments.length, SECTIONS.length);
});

test("fragment IDs follow their content, so a new policy never changes the fragments of the live one", () => {
  const changed = splitPolicyForDeployment(rendered.policyXml.replace("<outbound>", "<outbound><!-- changed -->"), rendered.apiId);
  const before = new Map(rendered.deployment.fragments.map((f) => [f.id.replace(/-[0-9a-f]{12}$/, ""), f.id]));
  for (const f of changed.fragments) {
    const key = f.id.replace(/-[0-9a-f]{12}$/, "");
    if (key.endsWith("-outbound")) assert.notEqual(f.id, before.get(key));
    else assert.equal(f.id, before.get(key));
  }
});

test("<base /> stays in the API policy where the rendered policy had it, and no fragment carries one", () => {
  const original = parseApimXml(rendered.policyXml);
  const deployed = parseApimXml(rendered.deployment.apiPolicyXml);
  for (const name of SECTIONS) {
    const had = elements(section(original, name))[0]?.name === "base";
    const has = elements(section(deployed, name))[0]?.name === "base";
    assert.equal(has, had, name);
  }
  for (const f of rendered.deployment.fragments) {
    const root = parseApimXml(f.xml);
    assert.equal(root.name, "fragment");
    assert.equal(descendants(root).filter((n) => n.name === "base").length, 0, f.id);
  }
});

test("putting each fragment back in place gives the rendered policy byte for byte", () => {
  const { apiPolicyXml, fragments } = rendered.deployment;
  let joined = apiPolicyXml;
  for (const f of fragments) {
    const body = f.xml.slice("<fragment>".length, -"</fragment>".length);
    joined = joined.replace(`<include-fragment fragment-id="${f.id}" />`, () => body);
  }
  assert.equal(joined, rendered.policyXml);
});

test("a policy whose section tag is missing or repeated is refused, not split", () => {
  assert.throws(() => splitPolicyForDeployment(rendered.policyXml.replace("<outbound>", "<outbound-x>"), "api"), /exactly one <outbound>/);
  assert.throws(() => splitPolicyForDeployment(rendered.policyXml.replace("</backend>", "</backend><!-- <backend> -->"), "api"), /exactly one <backend>/);
});

// APIM names a policy fragment with at most 80 characters, `(^[\w]+$)|(^[\w][\w\-]+[\w]$)` (Learn,
// Microsoft.ApiManagement service/policyFragments); the longest suffix is "-on-error-" + 12 hex = 22, and the
// gateway schema allows apiId ^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$.
test("every apiId the schema allows that fits APIM's fragment name limit is split; longer ones are refused", () => {
  for (const apiId of ["claude_messages", "a".repeat(58)]) {
    const { fragments } = splitPolicyForDeployment(rendered.policyXml, apiId);
    for (const f of fragments) {
      assert.ok(f.id.length <= 80, `${f.id.length}`);
      assert.match(f.id, /^\w[\w-]+\w$/);
    }
  }
  assert.throws(() => splitPolicyForDeployment(rendered.policyXml, "a".repeat(59)), /cannot name a policy fragment/);
  assert.throws(() => splitPolicyForDeployment(rendered.policyXml, "-api"), /cannot name a policy fragment/);
});