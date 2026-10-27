// Local demonstration server for the admin console. NOT deployed: Build-AdminPackage.ps1 packages only
// dist/ and ui-dist/, and tsconfig compiles src/ only. It binds to 127.0.0.1, uses an in-memory
// registry and a demo authenticator ("Bearer demo-editor" / "Bearer demo-reader"), and runs the same
// request handler (src/api.ts) and asset server (src/ui.ts) as the Function App.
//
//   node dev/serve.ts                      -> http://127.0.0.1:7171/api/console
//   DEMO_REGISTRY=down node dev/serve.ts   -> every registry call fails as it does without a network path
//   DEMO_REGISTRY=empty node dev/serve.ts  -> first-run state

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handleAdminRequest } from "../src/api.ts";
import type { ProjectStore, StoredProject } from "../src/api.ts";
import { ApiError } from "../src/auth.ts";
import type { Authenticator } from "../src/auth.ts";
import { serveUi, serveUiV3 } from "../src/ui.ts";
import type { Doc } from "../src/validation.ts";
import { handleV2Request } from "../src/v2.ts";
import type { CatalogStore } from "../src/v2.ts";
import { createOperations } from "../src/operations.ts";
import type { Operations } from "../src/operations.ts";
import { handleV3Request } from "../src/v3.ts";
import { createMemoryChangeLog } from "../src/change-log.ts";
import { createMemoryLimitsStore } from "../src/sync-limits.ts";
import { QueryCache } from "../src/chargeback.ts";
import { createDemoTelemetry } from "./demo-data.ts";
import type { DemoGroup } from "./demo-data.ts";
import { createDemoGroups } from "./demo-groups.ts";
import { handleGroupRequest } from "../src/groups.ts";
import { createMemoryUserTagStore, handleUserTagRequest } from "../src/user-tags.ts";
import type { GroupDirectory } from "../src/groups.ts";
import { readBackendSettings } from "../src/backend-settings.ts";

// Synthetic Entra groups for the demo; the demo never calls Microsoft Graph.
const DEMO_ENTRA_GROUPS = [
  ...createDemoGroups().map((g, i) => ({
    id: String(g.groupId), displayName: String(g.displayName), description: "Demo security group",
    securityEnabled: true, memberCount: 3 + i % 6,
  })),
  { id: "9c3e4d5f-6a7b-4c8d-8e9f-102132435465", displayName: "Research sandbox", description: "Available to onboard", securityEnabled: true, memberCount: 3 },
  { id: "ad4f5e60-7b8c-4d9e-9f01-213243546576", displayName: "Operations sandbox", description: "Available to onboard", securityEnabled: true, memberCount: 3 },
];
const demoGroupDirectory: GroupDirectory = {
  async search(text) { return { state: "available", groups: DEMO_ENTRA_GROUPS.filter((g) => g.displayName.toLowerCase().includes(text.toLowerCase())).map(({ memberCount: _m, ...g }) => g) }; },
  async get(id) { const g = DEMO_ENTRA_GROUPS.find((x) => x.id === id); return g ? { state: "available", group: g } : { state: "not_found" }; },
  async members(id) {
    return DEMO_ENTRA_GROUPS.some((x) => x.id === id)
      ? { state: "available", truncated: false, members: [1, 2, 3].map((n) => ({ id: `abcdef01-2345-4678-9abc-def01234567${n}`, displayName: `Demo member ${n}` })) }
      : { state: "not_found" };
  },
};

const PORT = Number(process.env.PORT ?? 7171);
const UI = fileURLToPath(new URL("../ui-dist/", import.meta.url));
const UI_V3 = fileURLToPath(new URL("../ui-dist-v3/", import.meta.url));
const mode = process.env.DEMO_REGISTRY ?? "seeded";

class MemoryStore implements ProjectStore {
  docs = new Map<string, StoredProject>();
  n = 0;
  tag() { return `"demo-${++this.n}"`; }
  fail() { if (mode === "down") throw Object.assign(new Error("Request blocked by network rules"), { code: 403 }); }
  async list() { this.fail(); return [...this.docs.values()].map((p) => structuredClone(p)); }
  async listPage(query: { search: string; tag: string; backendId: string; limit: number; cursor?: string; tags?: string[]; classification?: string }) {
    // Like the Cosmos store (cosmos-store.ts), onboarded group documents are not projects.
    const all = (await this.list()).filter((p) => p.doc.kind !== "group" && `${p.doc.projectId} ${p.doc.displayName}`.toLowerCase().includes(query.search.toLowerCase()) &&
      (!query.tag || Array.isArray(p.doc.adminTags) && p.doc.adminTags.includes(query.tag)) && (!query.backendId || p.doc.backendId === query.backendId) &&
      (query.tags ?? []).every((t) => Array.isArray(p.doc.adminTags) && p.doc.adminTags.includes(t)) &&
      (!query.classification || Object.hasOwn(p.doc.classifications as Doc, query.classification)))
      .sort((a, b) => String(a.doc.projectId).localeCompare(String(b.doc.projectId)));
    const start = Number(query.cursor ?? 0);
    return { items: all.slice(start, start + query.limit), cursor: start + query.limit < all.length ? String(start + query.limit) : undefined };
  }
  async read(id: string) { this.fail(); const p = this.docs.get(id); return p ? structuredClone(p) : null; }
  async create(doc: Doc) {
    this.fail();
    if (this.docs.has(String(doc.projectId))) return "conflict" as const;
    const etag = this.tag();
    this.docs.set(String(doc.projectId), { doc: structuredClone(doc), etag });
    return etag;
  }
  async replace(doc: Doc, etag: string) {
    this.fail();
    const cur = this.docs.get(String(doc.projectId));
    if (!cur || cur.etag !== etag) return "precondition_failed" as const;
    const next = this.tag();
    this.docs.set(String(doc.projectId), { doc: structuredClone(doc), etag: next });
    return next;
  }
}

const store = new MemoryStore();
if (mode === "seeded") {
  for (const doc of createDemoGroups()) await store.create(doc);
}

const authenticate: Authenticator = async (authorization) => {
  if (authorization === "Bearer demo-editor") return { oid: "00000000-0000-4000-8000-0000000000e1", canWrite: true };
  if (authorization === "Bearer demo-reader") return { oid: "00000000-0000-4000-8000-0000000000a1", canWrite: false };
  throw new ApiError(401, "bearer_token_required");
};
const rateCard = JSON.parse(await readFile(new URL("../ui-dist/rate-card.json", import.meta.url), "utf8"));
const defaultCatalog = { schemaVersion: 1, rateCard, models: rateCard.entries.map((entry: Doc) => ({
  family: String(entry.model).split("-")[1], model: entry.model, deployment: entry.model, backendId: "",
})) };
// As Stage 5 writes ADMIN_BACKENDS: the demo's two live backends, each with every rate-card model deployed.
const demoBackends = readBackendSettings({ ADMIN_BACKENDS: process.env.ADMIN_BACKENDS ?? JSON.stringify(["foundry-eus2", "foundry-swc"].map((id) => ({
  id, deployments: rateCard.entries.map((entry: Doc) => String(entry.model)) }))) });
let catalog: { doc: Doc; etag: string } | null = null;
const catalogStore: CatalogStore = {
  async read() { return catalog ? structuredClone(catalog) : null; },
  async save(doc, etag) {
    if (catalog && catalog.etag !== etag || !catalog && etag) return null;
    catalog = { doc: structuredClone(doc), etag: `"catalog-${randomUUID()}"` };
    return catalog.etag;
  },
};
// Demo change record and removal limits (memory only); Azure uses the adminConfig container.
const changeLog = createMemoryChangeLog();
const limitsStore = createMemoryLimitsStore();
const userTagStore = createMemoryUserTagStore();
const realOperations = createOperations({}, { getToken: async () => { throw new Error("Demo must not acquire real tokens"); } }, console.log);

// ---- Demo-only synthetic telemetry (dev/demo-data.ts); never used in Azure. ----
const demoGroups: DemoGroup[] = mode === "seeded" ? (await store.list()).map(({ doc }, i) => ({
  groupId: String(doc.groupId), groupName: String(doc.displayName), members: 3 + i % 6,
  personBudgetUsd: Number(((doc.budget as Doc).perUser as Doc).amount),
  groupBudgetUsd: (doc.budget as Doc).groupCap === null ? null : Number(((doc.budget as Doc).groupCap as Doc).amount),
  backendId: String(doc.backendId), models: Object.values((doc.familyPolicy as Doc).families as Doc).flatMap((f) => (f as Doc).models as string[]),
})) : [];
const telemetry = createDemoTelemetry(rateCard, demoGroups);
const auditLines: Doc[] = [];
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const editorOid = "00000000-0000-4000-8000-0000000000e1";
if (mode === "seeded") {
  auditLines.push(
    { at: at(60 * 26), requestId: randomUUID(), operation: "group.create", outcome: "created", projectId: demoGroups[1].groupId, actorOid: editorOid, d: {} },
    { at: at(60 * 5), requestId: randomUUID(), operation: "group.update", outcome: "updated", projectId: demoGroups[0].groupId, actorOid: editorOid,
      d: { changes: [{ path: "familyPolicy.families.sonnet.person.tokensPerMinute", before: 15000, after: 20000 }] } },
    { at: at(60 * 3), requestId: randomUUID(), operation: "group.update", outcome: "updated", projectId: demoGroups[0].groupId, actorOid: editorOid,
      d: { changes: [{ path: "chargebackId", before: null, after: "DEMO-1" }] } },
    { at: at(50), requestId: randomUUID(), operation: "group.update", outcome: "refused", projectId: demoGroups[1].groupId, actorOid: "00000000-0000-4000-8000-0000000000a1",
      d: { status: 403, code: "write_permission_required" } },
  );
}
// Captures the demo server's own audit lines, so changes made in the browser appear in Audit and Activity.
const demoLog = (line: string) => {
  console.log(line);
  try {
    const d = JSON.parse(line) as Doc;
    if (d.schema === "ccof.admin.audit.v1") auditLines.push({ at: d.at, requestId: d.requestId, operation: d.operation, outcome: d.outcome, projectId: d.projectId ?? "", actorOid: d.actorOid ?? "", d });
  } catch { /* not JSON */ }
};
const now = () => new Date().toISOString();
const operations: Operations = mode === "seeded" ? {
  ...realOperations,
  logs: async (kind) => kind === "budgets" ? { state: "available", observedAt: now(), data: telemetry.groupBudgetLines() }
    : kind === "runs" ? { state: "available", observedAt: now(), data: [{ schema: "ccof.reconciler.run.v1", runId: randomUUID(), outcome: "written", reason: null, statesWritten: 120, observedAt: at(4) }] }
      : { state: "available", observedAt: now(), data: auditLines.map((a) => ({ ...(a.d as Doc), observedAt: a.at })) },
  inventory: async () => ({ state: "available", observedAt: now(), data: {
    resources: [
      { id: "/subscriptions/3c1d5a0e-8f2b-4c6d-9e1a-7b2f4d8c0a11/resourceGroups/ccof-rg/providers/Microsoft.ApiManagement/service/ccof-apim", name: "ccof-apim", type: "Microsoft.ApiManagement/service", region: "eastus2", provisioningState: "Succeeded", runtimeState: "unknown", lifecycle: "observed", publicNetworkAccess: "Disabled", backendIds: [] },
      { id: "/subscriptions/3c1d5a0e-8f2b-4c6d-9e1a-7b2f4d8c0a11/resourceGroups/ccof-rg/providers/Microsoft.CognitiveServices/accounts/foundry-eus2", name: "foundry-eus2", type: "Microsoft.CognitiveServices/accounts", region: "eastus2", provisioningState: "Succeeded", runtimeState: "unknown", lifecycle: "observed", publicNetworkAccess: "Disabled", backendIds: ["foundry-eus2"] },
      { id: "/subscriptions/3c1d5a0e-8f2b-4c6d-9e1a-7b2f4d8c0a11/resourceGroups/ccof-rg/providers/Microsoft.CognitiveServices/accounts/foundry-swc", name: "foundry-swc", type: "Microsoft.CognitiveServices/accounts", region: "swedencentral", provisioningState: "Succeeded", runtimeState: "unknown", lifecycle: "observed", publicNetworkAccess: "Disabled", backendIds: ["foundry-swc"] },
      { id: "/subscriptions/3c1d5a0e-8f2b-4c6d-9e1a-7b2f4d8c0a11/resourceGroups/ccof-old/providers/Microsoft.CognitiveServices/accounts/foundry-wus3", name: "foundry-wus3", type: "Microsoft.CognitiveServices/accounts", region: "westus3", provisioningState: "unknown", runtimeState: "unknown", lifecycle: "not_found", publicNetworkAccess: "unknown", backendIds: [] },
    ],
    backends: [{ backendId: "foundry-eus2", apimId: "ccof-apim", host: "foundry-eus2.services.ai.azure.com" }, { backendId: "foundry-swc", apimId: "ccof-apim", host: "foundry-swc.services.ai.azure.com" }, { backendId: "foundry-wus3", apimId: "ccof-apim", host: "foundry-wus3.services.ai.azure.com" }],
    truncated: false, warnings: [],
  } }),
  deployments: async (id) => ({ state: "available", observedAt: now(), data: { truncated: false, deployments: id.endsWith("foundry-swc")
    ? [{ name: "claude-sonnet-5", model: "claude-sonnet-5", state: "Succeeded" }, { name: "claude-haiku-4-5", model: "claude-haiku-4-5", state: "Succeeded" }]
    : [{ name: "claude-sonnet-5", model: "claude-sonnet-5", state: "Succeeded" }, { name: "claude-haiku-4-5", model: "claude-haiku-4-5", state: "Succeeded" }, { name: "claude-opus-5-5", model: "claude-opus-5-5", state: "Succeeded" }] } }),
  health: async () => ({ state: "available", observedAt: now(), data: [
    { name: "Gateway (APIM)", state: "endpoint_responding", httpStatus: 200, observedAt: now(), evidence: "HTTP response only; not model inference, billing or timer freshness" },
    { name: "Resolver function", state: "endpoint_responding", httpStatus: 200, observedAt: now(), evidence: "HTTP response only; not model inference, billing or timer freshness" },
    { name: "Foundry westus3", state: "unreachable", reason: "dns_network_tls_or_timeout", observedAt: now() },
  ] }),
  query: async (_workspaceId, _query, _timespan, meta) => telemetry.query(meta, auditLines),
} : realOperations;
const demoEnv = mode === "seeded" ? {
  ADMIN_WORKSPACE_ID: "11111111-2222-4333-8444-555555555555",
  ADMIN_GATEWAY_RESOURCE_ID: "/subscriptions/3c1d5a0e-8f2b-4c6d-9e1a-7b2f4d8c0a11/resourceGroups/ccof-rg/providers/Microsoft.ApiManagement/service/ccof-apim",
  ADMIN_LOG_RESOURCE_IDS: "/subscriptions/3c1d5a0e-8f2b-4c6d-9e1a-7b2f4d8c0a11/resourceGroups/ccof-rg/providers/Microsoft.Web/sites/ccof-reconciler",
  ADMIN_RECONCILER_INTERVAL_MINUTES: "5",
  // Demo values, not a real tenant.
  ADMIN_TENANT_ID: "0f1e2d3c-4b5a-4968-8776-655443322110",
  ADMIN_CLIENT_ID: "5d6e7f80-9a1b-4c2d-8e3f-405162738495",
  ADMIN_GATEWAY_URL: "https://ccof-apim.azure-api.net/claude",
} : {};
const kql = (name: string) => readFile(new URL(`../kql/${name}`, import.meta.url), "utf8");
const sources = await Promise.all([kql("ledger.kql"), kql("pricing.kql"), kql("budgets.kql")]).then(([ledger, pricing, budgets]) => ({ ledger, pricing, budgets })).catch(() => null);
const v3Cache = new QueryCache();
// Synthetic labels only: the demo never queries the real directory.
const directory = {
  lookup: async (ids: string[]) => ({
    state: "available" as const, observedAt: now(), data: { users: ids.map((objectId) => ({
      objectId, state: "resolved" as const, expiresAt: Date.now() + 300000,
      displayName: `Demo User ${objectId.slice(0, 8)}`,
      userPrincipalName: `demo-${objectId.slice(0, 8)}@example.invalid`,
    })) },
  }),
};
const V3_ENABLED = process.env.ADMIN_V3_ENABLED !== "false";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const send = (status: number, headers: Record<string, string> | undefined, body: string) => { res.writeHead(status, headers); res.end(body); };
  const sendJson = (status: number, value: unknown, headers: Record<string, string> = {}) =>
    send(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }, JSON.stringify(value));

  if (url.pathname === "/" ) return send(302, { location: V3_ENABLED ? "/api/console-v3#/overview" : "/api/console", "cache-control": "no-store" }, "");
  const ui = /^\/api\/console(?:\/([^/]*))?$/.exec(url.pathname);
  if (ui) {
    const asset = ui[1] ?? "";
    if (asset === "config") return sendJson(200, { configured: true, demo: true });
    if (asset === "me") {
      try { const actor = await authenticate(req.headers.authorization ?? null); return sendJson(200, { canWrite: actor.canWrite }); }
      catch (err) { return sendJson((err as ApiError).status ?? 500, { error: (err as ApiError).code ?? "internal_error" }); }
    }
    const r = await serveUi(asset, UI);
    return send(r.status, r.headers, r.body);
  }
  const uiV3 = /^\/api\/console-v3(?:\/([^/]*))?$/.exec(url.pathname);
  if (uiV3) {
    const asset = uiV3[1] ?? "";
    if (!V3_ENABLED) return send(404, { "content-type": "text/plain" }, "Not found");
    if (asset === "config") return sendJson(200, { configured: true, demo: true });
    const r = await serveUiV3(asset, V3_ENABLED, UI_V3);
    return send(r.status, r.headers, r.body);
  }
  if (url.pathname.startsWith("/api/groups")) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : null;
    const r = await handleGroupRequest({
      method: req.method ?? "GET", path: url.pathname, query: (n) => url.searchParams.get(n), body,
      headers: (n: string) => { const v = req.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; },
    }, { authenticate, store, changeLog, directory: demoGroupDirectory, backends: demoBackends, log: demoLog, now: () => new Date(), newId: randomUUID });
    return sendJson(r.status, r.jsonBody, r.headers);
  }
  if (url.pathname.startsWith("/api/user-tags")) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : null;
    const r = await handleUserTagRequest({
      method: req.method ?? "GET", path: url.pathname, query: (n) => url.searchParams.get(n), body,
      headers: (n: string) => { const v = req.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; },
    }, { authenticate, store: userTagStore, changeLog, log: demoLog, now: () => new Date(), newId: randomUUID });
    return sendJson(r.status, r.jsonBody, r.headers);
  }
  if (url.pathname.startsWith("/api/projects") || url.pathname.startsWith("/api/v2/") || url.pathname.startsWith("/api/v3/")) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : null;
    const request = { method: req.method ?? "GET", path: url.pathname + url.search, headers: (n: string) => { const v = req.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; }, body };
    if (url.pathname.startsWith("/api/v3/") && !V3_ENABLED) return sendJson(404, { error: "route_not_found" });
    const r = url.pathname.startsWith("/api/v3/")
      ? await handleV3Request(request, { authenticate, projects: store, catalogStore, changeLog, limitsStore, userTagStore, defaultCatalog, operations, directory, env: demoEnv, sources, cache: v3Cache, log: demoLog, now: () => new Date(), newId: randomUUID })
      : url.pathname.startsWith("/api/v2/")
        ? await handleV2Request(request, { authenticate, projects: store, catalogStore, changeLog, defaultCatalog, operations, log: demoLog, now: () => new Date(), newId: randomUUID })
        : await handleAdminRequest(request, { authenticate, store, changeLog, log: demoLog, now: () => new Date(), newId: randomUUID });
    if (r.body !== undefined) return send(r.status, r.headers ?? {}, r.body);
    return sendJson(r.status, r.jsonBody, r.headers);
  }
  send(404, { "content-type": "text/plain" }, "Not found");
});

server.listen(PORT, "127.0.0.1", () => console.log(`CCOF admin demo (${mode}) at http://127.0.0.1:${PORT}/api/console and /api/console-v3`));