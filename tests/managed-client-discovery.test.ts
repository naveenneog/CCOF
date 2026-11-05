import { test } from "node:test";
import assert from "node:assert/strict";
import { readManagedClientConfig, registryBootstrap, codeDiscoverySettings, registryCodeDiscovery } from "../src/managed-clients/config.ts";
import { handleClientDiscoveryRequest, handleConfiguredClientDiscoveryRequest } from "../src/managed-clients/handler.ts";
import { activeMembership, POLICY, activeBudgetState } from "./helpers/resolver-fixtures.ts";
import { fixture, settings, GROUP, OTHER, PERSON, MODEL, NEW_MODEL } from "./helpers/managed-client-fixtures.ts";
const config = () => readManagedClientConfig(settings());

test("the stable registry bootstrap contains only trust anchors, not models, features or credentials", () => {
  const original = registryBootstrap(config());
  const changed = settings();
  changed.deployments.push({ backendId: activeMembership.backendId, id: NEW_MODEL, displayName: "New Sonnet", createdAt: "2026-10-02T00:00:00Z" });
  changed.desktop.cowork = false;
  assert.equal(registryBootstrap(readManagedClientConfig(changed)), original);
  assert.match(original, /Windows Registry Editor Version 5\.00/);
  assert.match(original, /HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude\]/);
  assert.match(original, /"bootstrapUrl"="https:\/\/gateway.example.test\/ccof\/ccof\/client\/bootstrap"/);
  assert.match(original, /"bootstrapOidc"=/);
  assert.doesNotMatch(original, /claude-sonnet|apiKey|token"|coworkTabEnabled|forceLoginMethod|inferenceGatewayManagedClaudeCode/i);
  assert.match(original, /openid offline_access aaaaaaaa-0000-4000-8000-000000000002\/access_as_user/);
});

test("standalone Code uses plain gateway discovery without pinning models or enabling external traffic", () => {
  const policy = codeDiscoverySettings(config());
  assert.equal(policy.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(policy.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(policy.env.ANTHROPIC_BASE_URL, settings().gatewayUrl);
  assert.match(policy.apiKeyHelper, /%USERPROFILE%.*ccof-token\.cmd/);
  assert.doesNotMatch(JSON.stringify(policy), /forceLoginMethod|availableModels|DEFAULT_SONNET|claude-sonnet/);
  assert.match(registryCodeDiscovery(config()), /HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\]/);
  const changed = settings();
  changed.desktop.chat = false;
  assert.equal(registryCodeDiscovery(readManagedClientConfig(changed)), registryCodeDiscovery(config()));
});

test("the Functions setting is explicitly opt-in and invalid configuration fails without exposing its contents", async () => {
  const f = fixture();
  assert.equal((await handleConfiguredClientDiscoveryRequest(f.request(), f.runtime, undefined)).status, 404);
  assert.equal((await handleConfiguredClientDiscoveryRequest(f.request(), f.runtime, '{"secret":"never-log"}')).status, 503);
  assert.doesNotMatch(f.logs.join("\n"), /never-log/);
  assert.equal((await handleConfiguredClientDiscoveryRequest(f.request(), f.runtime, JSON.stringify(settings()))).status, 200);
});

test("bootstrap reuses admission, returns exact deployed and allowed models, and never exposes routing internals", async () => {
  const f = fixture();
  const response = await handleClientDiscoveryRequest(f.request(), f.runtime, config());
  assert.equal(response.status, 200);
  const doc = response.jsonBody.document as Record<string, unknown>;
  assert.equal(doc.inferenceProvider, "gateway");
  assert.equal(doc.inferenceGatewayBaseUrl, settings().gatewayUrl);
  assert.deepEqual(doc.inferenceModels, [{ name: MODEL, labelOverride: "Sonnet", anthropicFamilyTier: "sonnet" }]);
  assert.equal(doc.chatTabEnabled, true);
  assert.equal(doc.coworkTabEnabled, true);
  assert.equal(doc.desktopHome, "standard");
  assert.equal(doc.isClaudeCodeForDesktopEnabled, true);
  assert.deepEqual(doc.inferenceCustomHeaders, { "x-ccof-project": GROUP });
  assert.equal((doc.inferenceIdpOidc as Record<string, unknown>).bearerTokenType, "access_token");
  assert.doesNotMatch(JSON.stringify(doc), /another-backend|backendId|chargebackId|personId|budgetCcu/);
  assert.equal(f.logs.length, 0);
});

test("adding and removing a model and switching Desktop home only changes server responses, not the reg file", async () => {
  const f = fixture();
  const before = registryBootstrap(config());
  const changed = settings();
  changed.deployments.push({ backendId: activeMembership.backendId, id: NEW_MODEL, displayName: "New Sonnet", createdAt: "2026-10-02T00:00:00Z" });
  f.membership.familyPolicy.families.sonnet.models.push(NEW_MODEL);
  let response = await handleClientDiscoveryRequest(f.request("models"), f.runtime, readManagedClientConfig(changed));
  assert.equal(response.status, 200);
  assert.deepEqual((response.jsonBody.document as { data: { id: string }[] }).data.map((m) => m.id), [MODEL, NEW_MODEL]);
  f.membership.familyPolicy.families.sonnet.models = [NEW_MODEL];
  changed.desktop.cowork = false;
  response = await handleClientDiscoveryRequest(f.request(), f.runtime, readManagedClientConfig(changed));
  const doc = response.jsonBody.document as Record<string, unknown>;
  assert.deepEqual((doc.inferenceModels as { name: string }[]).map((m) => m.name), [NEW_MODEL]);
  assert.equal(doc.desktopHome, "off");
  assert.equal(doc.chatTabEnabled, false);
  assert.equal(doc.coworkTabEnabled, false);
  assert.equal(registryBootstrap(readManagedClientConfig(changed)), before);
});

test("models pagination metadata and per-person selection do not advertise models from another group/backend", async () => {
  const f = fixture();
  const response = await handleClientDiscoveryRequest(f.request("models"), f.runtime, config());
  assert.equal(response.status, 200);
  assert.deepEqual(response.jsonBody.document, {
    data: [{ id: MODEL, type: "model", display_name: "Sonnet", created_at: "2026-10-01T00:00:00Z" }],
    has_more: false, first_id: MODEL, last_id: MODEL,
  });
  const bad = { ...f.request(), body: { ...f.request().body, projectId: OTHER } };
  assert.equal((await handleClientDiscoveryRequest(bad, f.runtime, config())).status, 403);
  const elsewhere = settings();
  elsewhere.deployments[1] = { ...elsewhere.deployments[1], id: MODEL, displayName: "Wrong backend" };
  const result = await handleClientDiscoveryRequest(f.request("models"), f.runtime, readManagedClientConfig(elsewhere));
  assert.deepEqual((result.jsonBody.document as { data: { display_name: string }[] }).data.map((m) => m.display_name), ["Sonnet"]);
});

test("authentication, membership, backend and budget refusals cannot turn into a successful catalog", async () => {
  for (const change of ["platform", "principal", "membership", "backend", "budget"] as const) {
    const f = fixture();
    const request = f.request();
    if (change === "platform") request.platformAuthEnabled = false;
    if (change === "principal") request.authenticatedPrincipal = false;
    if (change === "membership") f.entitlement.projectMemberships = [];
    if (change === "backend" && f.runtime.readiness.ready) f.runtime.readiness.reads.readBackend = async () => ({
      id: activeMembership.backendId, backendId: activeMembership.backendId, status: "disabled", apiFormat: "anthropic-messages", auth: { mode: "backend-entity" },
    });
    if (change === "budget" && f.runtime.readiness.ready) {
      f.runtime.readiness.budgetEnforcement = { mode: "budget-state", staleness: POLICY };
      f.runtime.readiness.reads.readBudgetState = async () => ({ ...activeBudgetState, exhausted: true });
    }
    const response = await handleClientDiscoveryRequest(request, f.runtime, config());
    assert.notEqual(response.status, 200, change);
    assert.equal(response.jsonBody.document, undefined, change);
  }
});

test("revoked membership and deployments with no admitted intersection fail closed", async () => {
  const f = fixture();
  f.membership.status = "inactive";
  assert.equal((await handleClientDiscoveryRequest(f.request(), f.runtime, config())).status, 403);
  f.membership.status = "active";
  const changed = settings();
  changed.deployments = changed.deployments.filter((m) => m.backendId !== activeMembership.backendId);
  const response = await handleClientDiscoveryRequest(f.request(), f.runtime, readManagedClientConfig(changed));
  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.document, undefined);
});

test("tied memberships require an explicit selection rather than silently choosing or denying a valid user", async () => {
  const f = fixture();
  f.entitlement.projectMemberships.push({ ...structuredClone(f.membership), projectId: OTHER, classificationGroupId: OTHER });
  const ambiguous = await handleClientDiscoveryRequest(f.request(), f.runtime, config());
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.jsonBody.error, "project_selection_required");
  assert.equal(ambiguous.jsonBody.document, undefined);
  const selected = await handleClientDiscoveryRequest({ ...f.request(), body: { ...f.request().body, projectId: GROUP } }, f.runtime, config());
  assert.equal(selected.status, 200);
});

test("malformed requests are refused and a registry read failure is explicit", async () => {
  const f = fixture();
  for (const body of [null, {}, { personId: PERSON, representation: "anything" }, { ...f.request().body, token: "do-not-log" }]) {
    assert.equal((await handleClientDiscoveryRequest({ ...f.request(), body }, f.runtime, config())).status, 400);
  }
  if (f.runtime.readiness.ready) f.runtime.readiness.reads.readEntitlement = async () => { throw new Error("do-not-log"); };
  const result = await handleClientDiscoveryRequest(f.request(), f.runtime, config());
  assert.equal(result.status, 503);
  assert.doesNotMatch(f.logs.join("\n"), /do-not-log/);
});

test("configuration rejects unsafe URL/scope/header values, invalid types, duplicate metadata and unknown keys", () => {
  const changes = [
    { gatewayUrl: "http://gateway.example.test" }, { gatewayUrl: "https://localhost/ccof" },
    { gatewayUrl: "https://gateway.example.test/ccof/v1/messages" }, { gatewayUrl: "https://user:pass@gateway.example.test/ccof" },
    { scope: "api://different-app/access_as_user" }, { projectHeaderName: "Authorization" }, { refreshMinutes: 1 },
    { schemaVersion: "1" }, { desktop: { cowork: "true", chat: true, code: true } }, { unexpected: true },
    { deployments: [...settings().deployments, settings().deployments[0]] },
  ];
  for (const change of changes) assert.throws(() => readManagedClientConfig({ ...settings(), ...change }), /managed_client_config/);
});
