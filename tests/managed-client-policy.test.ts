import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderManagedClientResources } from "../infra/gateway/managed-clients.ts";
import { renderPolicy } from "../infra/gateway/render.ts";
import { parseApimXml } from "../infra/gateway/apim-xml.ts";
import type { GatewayConfig } from "../infra/gateway/config.ts";
import { sampleConfig } from "./helpers/gateway-fixtures.ts";
import { runExpressions } from "./helpers/policy-csharp.ts";

function fixture() {
  const gateway = sampleConfig() as GatewayConfig;
  gateway.entra.authorityHost = "https://login.microsoftonline.com";
  gateway.entra.v1IssuerHost = "https://sts.windows.net";
  const clientId = gateway.entra.audiences.find((a) => !a.startsWith("api://"))!;
  gateway.entra.delegatedClientAppIds.push(clientId);
  const managed = {
    schemaVersion: 1, tenantId: gateway.entra.tenantId, clientId, scope: `${clientId}/access_as_user`,
    gatewayUrl: `${gateway.apim.gatewayBaseUrl}/${gateway.apim.apiPath}`, projectHeaderName: gateway.resolver.projectHeaderName,
    refreshMinutes: 2, desktop: { chat: true, cowork: true, code: true },
    deployments: [{ backendId: "backend-by-data", id: "model-a", displayName: "Model", createdAt: "2026-10-01T00:00:00Z" }],
  };
  return { gateway, managed };
}
test("experimental APIM operations are generated separately and preserve current inference policy bytes", () => {
  const { gateway, managed } = fixture();
  const before = renderPolicy(gateway).policyXml;
  const result = renderManagedClientResources(gateway, managed);
  assert.equal((result.combinedRegistry.match(/Windows Registry Editor Version 5\.00/g) ?? []).length, 1);
  assert.match(result.combinedRegistry, /HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude\]/);
  assert.match(result.combinedRegistry, /HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\]/);
  const updated = structuredClone(managed);
  updated.deployments.push({ ...updated.deployments[0], id: "model-b" });
  updated.desktop.cowork = false;
  assert.equal(renderManagedClientResources(gateway, updated).combinedRegistry, result.combinedRegistry);
  assert.equal(renderPolicy(gateway).policyXml, before);
  assert.deepEqual(result.operations.map((o) => [o.name, o.method, o.urlTemplate]), [
    ["get-client-bootstrap", "GET", "/ccof/client/bootstrap"], ["get-client-models", "GET", "/v1/models"],
  ]);
  for (const operation of result.operations) {
    assert.equal(parseApimXml(operation.policyXml).name, "policies");
    assert.doesNotMatch(operation.policyXml, /<base\s*\/>/);
    assert.match(operation.policyXml, /<validate-jwt id="ccof-jwt"/);
    assert.match(operation.policyXml, /<value>no-store<\/value>/);
    assert.match(operation.policyXml, /<authentication-managed-identity/);
    assert.match(operation.policyXml, /\/api\/me\/client-config/);
    assert.match(operation.policyXml, /new JProperty\("personId", \(string\)context\.Variables\["ccofOid"\]\)/);
    assert.doesNotMatch(operation.policyXml, /context\.Request\.Body|context\.Request\.Url\.Query|forward-request/);
  }
});
test("both operations use the existing JWT, scope, client and oid guards exactly", () => {
  const { gateway, managed } = fixture();
  const source = parseApimXml(renderPolicy(gateway).usagePolicyXml);
  const pick = (xml: ReturnType<typeof parseApimXml>) => {
    const inbound = xml.children.find((n) => n.kind === "element" && n.name === "inbound");
    assert.ok(inbound?.kind === "element");
    return inbound.children.filter((n) => n.kind === "element"
      && (n.name === "validate-jwt" || n.attributes.some((a) => a.name === "name" && ["ccofOid", "ccofClientAppId", "ccofRefusal"].includes(a.value))))
      .map((n) => JSON.parse(JSON.stringify(n, (k, v) => k === "line" ? undefined : v)));
  };
  const expected = pick(source);
  assert.equal(expected.length, 4);
  for (const operation of renderManagedClientResources(gateway, managed).operations) assert.deepEqual(pick(parseApimXml(operation.policyXml)), expected);
});
test("binding mismatches, unknown backend models and unadmitted Desktop clients are refused before generation", () => {
  const { gateway, managed } = fixture();
  for (const change of [
    { tenantId: "aaaaaaaa-0000-4000-8000-000000000001" },
    { gatewayUrl: "https://another.example.test/anthropic" }, { projectHeaderName: "x-another" },
    { scope: `${managed.clientId}/wrong_scope` },
    { deployments: [{ ...managed.deployments[0], id: "not-deployed" }] },
  ]) assert.throws(() => renderManagedClientResources(gateway, { ...managed, ...change }), /managed_client/);
  gateway.entra.delegatedClientAppIds = gateway.entra.delegatedClientAppIds.filter((id) => id !== managed.clientId);
  assert.throws(() => renderManagedClientResources(gateway, managed), /managed_client/);
});
test("compiled response guards refuse malformed success and preserve unauthorized versus unavailable", () => {
  const { gateway, managed } = fixture();
  const policy = renderManagedClientResources(gateway, managed).operations[0].policyXml;
  const attribute = (name: string) => {
    const root = parseApimXml(policy);
    const inbound = root.children.find((n) => n.kind === "element" && n.name === "inbound");
    assert.ok(inbound?.kind === "element");
    const variable = inbound.children.find((n) => n.kind === "element"
      && n.name === "set-variable" && n.attributes.some((a) => a.name === "name" && a.value === name));
    const value = variable?.kind === "element" ? variable.attributes.find((a) => a.name === "value")?.value : undefined;
    assert.ok(value, name);
    return value;
  };
  const body = { schema: "ccof.managed-client.v1", document: { $schemaVersion: 1, inferenceProvider: "gateway", inferenceModels: [{ name: "model-a" }] } };
  const vectors = [
    { label: "valid", method: "Guard", vars: { ccofResolverResponse: { status: 200, body } }, expected: JSON.stringify(body.document) },
    { label: "wrong schema", method: "Guard", vars: { ccofResolverResponse: { status: 200, body: { ...body, schema: "wrong" } } }, expected: "" },
    { label: "no document", method: "Guard", vars: { ccofResolverResponse: { status: 200, body: { schema: body.schema } } }, expected: "" },
    { label: "empty document", method: "Guard", vars: { ccofResolverResponse: { status: 200, body: { ...body, document: {} } } }, expected: "" },
    { label: "refused", method: "Status", vars: { ccofResolverResponse: { status: 403, body: {} }, ccofDiscoveryBody: "" }, expected: 403 },
    { label: "group selection required", method: "Status", vars: { ccofResolverResponse: { status: 400, body: { error: "project_selection_required" } }, ccofDiscoveryBody: "" }, expected: 400 },
    { label: "other internal 400", method: "Status", vars: { ccofResolverResponse: { status: 400, body: { error: "invalid_request" } }, ccofDiscoveryBody: "" }, expected: 503 },
    { label: "absent", method: "Status", vars: { ccofDiscoveryBody: "" }, expected: 503 },
  ];
  const results = runExpressions({ Guard: attribute("ccofDiscoveryBody"), Status: attribute("ccofDiscoveryStatus") }, vectors);
  vectors.forEach((vector, i) => assert.deepEqual(results[i], vector.expected, vector.label));
  const [publicSelection] = runExpressions({ Body: attribute("ccofDiscoveryPublicBody") }, [
    { label: "selection guidance", method: "Body", vars: { ccofDiscoveryStatus: 400 }, expected: null, json: true },
  ]);
  assert.ok(publicSelection && typeof publicSelection === "object");
  assert.equal((publicSelection as { code: string }).code, "project_selection_required");
  assert.match(JSON.stringify(publicSelection), /distinct group priorities/);
  assert.doesNotMatch(JSON.stringify(publicSelection), /projectId|backendId|personId/);
});
test("the Functions route and standalone operation module wire opt-in discovery without default deployment changes", () => {
  const app = readFileSync(new URL("../src/resolver/function-app.ts", import.meta.url), "utf8");
  assert.match(app, /route: "me\/client-config"/);
  assert.match(app, /CCOF_MANAGED_CLIENT_CONFIG/);
  const bicep = readFileSync(new URL("../infra/gateway/managed-clients.bicep", import.meta.url), "utf8");
  assert.match(bicep, /Microsoft.ApiManagement\/service\/apis\/operations/);
  assert.doesNotMatch(bicep, /roleAssignments|sites\/config|userAssignedIdentities/);
});
