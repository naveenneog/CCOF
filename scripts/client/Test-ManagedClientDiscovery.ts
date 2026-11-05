// Explicit local protocol probe using an installed Claude Code entry point. No Azure call, policy import or real inference.
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, settings } from "../../tests/helpers/managed-client-fixtures.ts";
import { handleConfiguredClientDiscoveryRequest } from "../../src/managed-clients/handler.ts";
import { readManagedClientConfig, codeDiscoverySettings, registryBootstrap, registryCodeDiscovery } from "../../src/managed-clients/config.ts";

const [entry, output] = process.argv.slice(2);
if (!entry || !output || !existsSync(entry)) throw new Error("usage: node scripts/client/Test-ManagedClientDiscovery.ts <installed-claude.exe-or-cli.js> <private-output-dir>");
const executable = entry.endsWith(".js") ? process.execPath : path.resolve(entry);
const prefix = entry.endsWith(".js") ? [path.resolve(entry)] : [];
if (process.platform === "win32") {
  const check = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "if ((Test-Path 'HKLM:\\SOFTWARE\\Policies\\ClaudeCode') -or (Test-Path 'HKCU:\\SOFTWARE\\Policies\\ClaudeCode')) { exit 3 }"], { encoding: "utf8" });
  if (check.status !== 0 || existsSync(path.join(process.env.ProgramData ?? "C:\\ProgramData", "ClaudeCode", "managed-settings.json"))) {
    throw new Error("Existing Code managed policy: this probe will not override it. Use an approved isolated machine.");
  }
}
const scratch = mkdtempSync(path.join(tmpdir(), "ccof-managed-probe-"));
const profile = path.join(scratch, "claude-profile");
mkdirSync(profile);
mkdirSync(output, { recursive: true });
const f = fixture();
const state = settings();
const initialModel = "claude-haiku-4-5";
const newModel = "claude-haiku-4-5-ccof-rollout";
state.deployments = [{ ...state.deployments[0], id: initialModel, displayName: "Initial local model" }];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const desktopReg = registryBootstrap(readManagedClientConfig(state));
const codeReg = registryCodeDiscovery(readManagedClientConfig(state));
const requests: { path: string; phase: number; model?: string }[] = [];
let phase = 1;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, "http://localhost");
    const authorized = req.headers.authorization === "Bearer local-fixture";
    requests.push({ path: url.pathname, phase });
    const result = await handleConfiguredClientDiscoveryRequest({
      ...f.request(url.pathname.endsWith("/v1/models") ? "models" : "bootstrap"), authenticatedPrincipal: authorized,
    }, f.runtime, JSON.stringify(state));
    if (result.status !== 200) { res.writeHead(result.status); res.end(JSON.stringify(result.jsonBody)); return; }
    if (url.pathname === "/v1/models" || url.pathname === "/ccof/client/bootstrap") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(result.jsonBody.document)); return;
    }
    if (url.pathname !== "/v1/messages" || req.method !== "POST") { res.writeHead(404); res.end(); return; }
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 1024 * 1024) { res.writeHead(413); res.end(); return; }
    }
    const body = JSON.parse(text);
    requests[requests.length - 1].model = body.model;
    const allowed = await handleConfiguredClientDiscoveryRequest(f.request("models"), f.runtime, JSON.stringify(state));
    const models = (allowed.jsonBody.document as { data: { id: string }[] }).data;
    if (!models.some((model) => model.id === body.model)) { res.writeHead(403); res.end(); return; }
    const message = {
      id: "msg_local_probe", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "gateway OK" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "gateway OK" } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    event("message_stop", {});
    res.end();
  } catch {
    res.writeHead(500);
    res.end('{"error":"local_probe_failed"}');
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const policy = codeDiscoverySettings(readManagedClientConfig(state));
// Local fake credential replaces the helper only in this isolated protocol probe, never in the generated bundle.
const env = { ...process.env, ...policy.env, CLAUDE_CONFIG_DIR: profile, ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: "local-fixture", CI: "1", AZURE_CONFIG_DIR: path.join(scratch, "az-logged-out") };
writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ env: { ...policy.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "local-fixture" } }));
async function run(model: string) {
  const child = spawn(executable, [...prefix, "-p", "Reply with exactly: gateway OK",
    "--model", model, "--output-format", "json", "--max-turns", "1", "--no-session-persistence"], {
    cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const [exit] = await once(child, "exit");
    if (exit !== 0) throw new Error(`Claude Code local probe failed (${exit}): ${stderr.slice(-1000)}`);
    const result = JSON.parse(stdout);
    assert.equal(result.is_error, false);
    assert.equal(result.result, "gateway OK");
    return { result: result.result, discoveryRequests: requests.filter((r) => r.phase === phase && r.path === "/v1/models").length };
  } finally { clearTimeout(timer); }
}
try {
  const version = spawnSync(executable, [...prefix, "--version"], { cwd: scratch, env, encoding: "utf8" }).stdout.trim();
  const before = await run(initialModel);
  assert.ok(before.discoveryRequests > 0, "the real client must request /v1/models, not only perform inference");
  phase = 2;
  state.deployments.push({ ...state.deployments[0], id: newModel, displayName: "Backend-only rollout" });
  f.membership.familyPolicy.families.haiku.models.push(newModel);
  const after = await run(newModel);
  assert.ok(after.discoveryRequests > 0);
  const cache = readFileSync(path.join(profile, "cache", "gateway-models.json"), "utf8");
  assert.ok(cache.includes(newModel), "the real client's discovery cache must contain the newly offered model");
  const bootstrap = await fetch(`${base}/ccof/client/bootstrap`, { headers: { authorization: "Bearer local-fixture" } }).then((r) => r.json());
  state.desktop.cowork = false;
  const disabled = await fetch(`${base}/ccof/client/bootstrap`, { headers: { authorization: "Bearer local-fixture" } }).then((r) => r.json());
  assert.equal(bootstrap.desktopHome, "standard");
  assert.equal(disabled.desktopHome, "off");
  assert.equal(registryBootstrap(readManagedClientConfig(state)), desktopReg);
  assert.equal(registryCodeDiscovery(readManagedClientConfig(state)), codeReg);
  writeFileSync(path.join(output, "bootstrap-enabled.json"), JSON.stringify(bootstrap, null, 2));
  writeFileSync(path.join(output, "bootstrap-disabled.json"), JSON.stringify(disabled, null, 2));
  const report = { client: version, before, after, registrySha256: { desktop: hash(desktopReg), code: hash(codeReg) },
    requests, newModelInClientCache: true, desktopSchemaAndHttpOnly: true, nativeDesktopNotExercised: true,
    realEntraOrFoundryNotExercised: true };
  writeFileSync(path.join(output, "probe-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + "\n");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(scratch, { recursive: true, force: true });
}
