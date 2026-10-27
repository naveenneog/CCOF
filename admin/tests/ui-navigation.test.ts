import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const GROUP = "abcdef01-2345-4678-9abc-def012345678";
const LEGACY = "PROJECT01";
const cap = (rows: object[]) => ({ state: "available", data: { rows,
  period: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" } } });
const budgets = [GROUP, LEGACY].map((projectId) => ({
  projectId, classification: projectId === GROUP ? "group" : "STD", spentCcu: "50", spentUsd: "0.5",
  budgetCcu: "100", budgetUsd: "1", usedPercent: "50", computedAt: new Date().toISOString(),
}));
const costs = [GROUP, LEGACY].map((projectLabel) => ({
  projectLabel, knownListUsd: "0.5", listUsd: "0.5", requests: 1, tokensSpent: 20,
  unpricedRequests: 0, unattributedRequests: 0, completeness: "complete",
}));
const replies: Record<string, object> = {
  "/api/v2/budgets": { state: "available", data: { groups: budgets, totals: {} } },
  "/api/v3/reconciler/snapshots": cap(budgets),
  "/api/v3/reconciler/summary": cap([]),
  "/api/v3/reconciler/runs": cap([]),
  "/api/v3/chargeback/projects": cap(costs),
  "/api/v3/chargeback/groups": cap([{ ...costs[0], groupId: GROUP, groupNameSnapshots: ["Engineering"] }]),
  "/api/v3/chargeback/totals": cap([]),
  "/api/v3/chargeback/trend": cap([]),
  "/api/v3/chargeback/coverage": cap([]),
  "/api/v3/audit": cap([GROUP, LEGACY].map((projectId) => ({ projectId, operation: "settings", outcome: "updated" }))),
  "/api/v3/audit/changes": cap([GROUP, LEGACY].map((projectId) => ({ projectId, operation: "settings", outcome: "updated" }))),
  "/api/v2/projects": { projects: [{ projectId: LEGACY, backendId: "foundry-main" }] },
  "/api/groups": { groups: [
    { groupId: GROUP, displayName: "Engineering", backendId: "foundry-main" },
    { groupId: "abcdef01-2345-4678-9abc-def012345679", displayName: "Other backend", backendId: "elsewhere" },
  ] },
  [`/api/groups/${GROUP}`]: { groupId: GROUP, displayName: "Engineering" },
  [`/api/projects/${LEGACY}`]: { classifications: { STD: { groupId: "11111111-2222-4333-8444-555555555555" } } },
  "/api/v2/inventory": { state: "available", data: { resources: [], backends: [{ backendId: "foundry-main", host: "example.test" }] } },
};

interface Harness {
  renderPage(name: string, replies: Record<string, object>): string;
  reads: string[];
}
let scratch: string;
let ui: Harness;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ccof-ui-navigation-"));
  const outfile = join(scratch, "ui.mjs");
  await build({
    stdin: {
      contents: `
        import { createElement } from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { Budgets } from "./ui-v3/pages/budgets.tsx";
        import { Reconciler } from "./ui-v3/pages/reconciler.tsx";
        import { Overview } from "./ui-v3/pages/overview.tsx";
        import { Audit } from "./ui-v3/pages/audit.tsx";
        import { Foundry } from "./ui-v3/pages/foundry.tsx";
        import { configure, reads } from "./ui-v3/lib/api.ts";
        export { reads };
        const pages = { Budgets, Reconciler, Overview, Audit, Foundry };
        export function renderPage(name, replies) {
          configure(replies);
          return renderToStaticMarkup(createElement(pages[name], { query: new URLSearchParams("source=changes&view=projects") }));
        }`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "ts",
    },
    outfile, bundle: true, platform: "node", format: "esm", jsx: "automatic", logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: [{
      name: "fixture-reads",
      setup(plugin) {
        plugin.onLoad({ filter: /ui-v3[\\/]lib[\\/]api\.ts$/ }, () => ({
          contents: `
            export const reads = [];
            let replies = {};
            export function configure(next) { replies = next; reads.length = 0; }
            export function useQuery(path) {
              if (path) reads.push(path);
              return { data: path ? replies[path.split("?")[0]] ?? { state: "unavailable", reason: "fixture_not_configured" } : null,
                loading: false, error: null, etag: null, observedAt: null, reload() {} };
            }
            export function qs(params) {
              const p = new URLSearchParams();
              for (const [k,v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "" && v !== false) p.set(k, String(v));
              return p.size ? "?" + p : "";
            }
            export async function api() { throw new Error("No writes in navigation tests"); }
            export function errorMessage(e) { return String(e); }`,
          loader: "js",
        }));
      },
    }],
  });
  ui = await import(pathToFileURL(outfile).href);
});
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

for (const name of ["Budgets", "Reconciler", "Overview", "Audit"]) {
  test(`${name}: group references open Groups and legacy references keep their project page`, () => {
    const html = ui.renderPage(name, replies);
    assert.ok(html.includes(`href="#/groups/${GROUP}"`), `${name} must link to the group, not a legacy project`);
    assert.ok(!html.includes(`href="#/projects/${GROUP}`), `${name} must not send group IDs to the legacy project page`);
    const section = name === "Budgets" || name === "Reconciler" ? "/budgets" : name === "Audit" ? "/activity" : "";
    assert.ok(html.includes(`href="#/projects/${LEGACY}${section}"`), `${name} must retain legacy links`);
  });
}

test("shared group screens show no Classification field or column for group records; the legacy pages keep it", async () => {
  const src = (p: string) => readFile(new URL(`../ui-v3/${p}`, import.meta.url), "utf8");
  for (const page of ["pages/chargeback.tsx", "pages/reconciler.tsx"]) {
    assert.doesNotMatch(await src(page), /<Field label="Classification">/, `${page}: no free-text classification filter`);
  }
  const html = ui.renderPage("Budgets", { ...replies, "/api/v3/reconciler/snapshots": cap([budgets[0]]) });
  assert.ok(!/<th[^>]*>[^<]*(classification|Classification)[^<]*<\/th>/.test(html) && !/<th[^>]*>Group<\/th>/.test(html), "snapshot table has no classification column for groups");
  assert.ok(!html.includes(">group<"), "the internal 'group' scope code is not shown as data");
  assert.match(await src("pages/projects.tsx"), /label="Classification"/, "legacy projects keep their classification filter");
  assert.match(await src("pages/new-project.tsx"), /label="Classification"/, "legacy project creation keeps classification codes");
});

test("Chargeback's project table and ranking share the group-aware route", async () => {
  const { scopePath } = await import("../ui-v3/lib/router.ts");
  assert.equal(scopePath(GROUP), `/groups/${GROUP}`);
  assert.equal(scopePath(GROUP.toUpperCase(), "budgets"), `/groups/${GROUP}`);
  assert.equal(scopePath(LEGACY, "activity"), `/projects/${LEGACY}/activity`);
  assert.equal(scopePath("x/y"), "/projects/x%2Fy");
  const page = await readFile(new URL("../ui-v3/pages/chargeback.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/href\(scopePath\(r\.projectLabel\)\)/g) ?? []).length, 2, "table and ranking both use the same route");
});

test("Budgets uses the group registration API and group ID for the burn-down", () => {
  ui.renderPage("Budgets", replies);
  assert.ok(ui.reads.includes(`/api/groups/${GROUP}`), "read the group registration rather than /api/projects");
  assert.ok(!ui.reads.includes(`/api/projects/${GROUP}`));
  const trend = ui.reads.find((p) => p.startsWith("/api/v3/chargeback/trend?"));
  assert.equal(new URL(trend ?? "", "https://example.test").searchParams.get("group"), GROUP);
});

test("Budgets retains the classification's Entra ID for a legacy project's burn-down", () => {
  ui.renderPage("Budgets", { ...replies, "/api/v2/budgets": { state: "available", data: { groups: [budgets[1]], totals: {} } } });
  assert.ok(ui.reads.includes(`/api/projects/${LEGACY}`));
  const trend = ui.reads.find((p) => p.startsWith("/api/v3/chargeback/trend?"));
  assert.equal(new URL(trend ?? "", "https://example.test").searchParams.get("group"), "11111111-2222-4333-8444-555555555555");
});

test("Budgets explains a missing group ID instead of drawing a zero-cost burn-down", () => {
  const html = ui.renderPage("Budgets", { ...replies, [`/api/groups/${GROUP}`]: {} });
  assert.ok(html.includes("No Entra group ID is recorded for this budget."));
  assert.ok(!ui.reads.some((p) => p.startsWith("/api/v3/chargeback/trend?")));
});

test("Foundry lists linked groups and legacy projects, not groups on a different backend", () => {
  const html = ui.renderPage("Foundry", replies);
  assert.ok(html.includes(`href="#/groups/${GROUP}"`));
  assert.ok(html.includes(`href="#/projects/${LEGACY}"`));
  assert.ok(!html.includes("Other backend"));
});
