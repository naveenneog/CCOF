import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { handleConfiguredClientDiscoveryRequest } from "../src/managed-clients/handler.ts";
import { readManagedClientConfig, registryBootstrap, registryCodeDiscovery } from "../src/managed-clients/config.ts";
import { fixture, settings, MODEL, NEW_MODEL } from "./helpers/managed-client-fixtures.ts";

test("HTTP discovery observes backend-only rollout/removal and capability changes with unchanged registry artifacts", async () => {
  const f = fixture();
  const state = settings();
  const artifact = () => createHash("sha256").update(registryBootstrap(readManagedClientConfig(state)))
    .update(registryCodeDiscovery(readManagedClientConfig(state))).digest("hex");
  const original = artifact();
  // This is a local APIM boundary stub, not a JWT-validation or Azure deployment acceptance test.
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const representation = url.pathname.endsWith("/v1/models") ? "models" : "bootstrap";
    const response = await handleConfiguredClientDiscoveryRequest({
      ...f.request(representation), authenticatedPrincipal: req.headers.authorization === "Bearer local-fixture",
    }, f.runtime, JSON.stringify(state));
    res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(response.status === 200 ? response.jsonBody.document : response.jsonBody));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const read = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { authorization: "Bearer local-fixture" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.json();
  };
  try {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    assert.deepEqual((await read("/v1/models?limit=1000")).data.map((m: { id: string }) => m.id), [MODEL]);
    state.deployments.push({ ...state.deployments[0], id: NEW_MODEL, displayName: "New Sonnet" });
    // Not visible merely because a backend has it: the group must admit the model too.
    assert.deepEqual((await read("/v1/models")).data.map((m: { id: string }) => m.id), [MODEL]);
    f.membership.familyPolicy.families.sonnet.models.push(NEW_MODEL);
    assert.deepEqual((await read("/v1/models")).data.map((m: { id: string }) => m.id), [MODEL, NEW_MODEL]);
    assert.equal((await read("/ccof/client/bootstrap")).desktopHome, "standard");
    state.desktop.cowork = false;
    assert.equal((await read("/ccof/client/bootstrap")).desktopHome, "off");
    f.membership.familyPolicy.families.sonnet.models = [NEW_MODEL];
    assert.deepEqual((await read("/v1/models")).data.map((m: { id: string }) => m.id), [NEW_MODEL]);
    assert.equal(artifact(), original);
    f.entitlement.projectMemberships = [];
    assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer local-fixture" } })).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
