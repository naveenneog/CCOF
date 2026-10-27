import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  "/api/user-tags/settings": { label: "User tag" },
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
  renderPage(name: string, replies: Record<string, object>, query?: string): string;
  reads: string[];
}
let scratch: string;
let ui: Harness;

before(async () => {
  scratch = await mkdtemp(join(fileURLToPath(new URL("../", import.meta.url)), ".ui-navigation-"));
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
        import { Chargeback } from "./ui-v3/pages/chargeback.tsx";
        import { Page } from "./ui-v3/main.tsx";
        import { configure, reads } from "./ui-v3/lib/api.ts";
        export { reads };
        const pages = { Budgets, Reconciler, Overview, Audit, Foundry, Chargeback, Page };
        export function renderPage(name, replies, query = "source=changes&view=projects") {
          configure(replies);
          globalThis.location = { hash: name === "Page" ? "#/projects/PROJECT01/budgets" : "#/overview" };
          globalThis.matchMedia = () => ({ matches: false });
          return renderToStaticMarkup(createElement(pages[name], { query: new URLSearchParams(query) }));
        }`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "ts",
    },
    outfile, bundle: true, platform: "node", format: "esm", jsx: "automatic", logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: [{
      name: "fixture-reads",
      setup(plugin) {
        plugin.onLoad({ filter: /ui-v3[\\/]main\.tsx$/ }, async (args) => ({
          contents: (await readFile(args.path, "utf8"))
            .replace(/^try \{ applyTheme.*$/m, "")
            .replace("function Page()", "export function Page()")
            .replace(/^createRoot\(.*$/m, ""),
          loader: "tsx",
        }));
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

for (const name of ["Budgets", "Reconciler", "Overview", "Audit", "Chargeback"]) {
  test(`${name}: group references open Groups and historical IDs remain unlinked`, () => {
    const html = ui.renderPage(name, replies);
    assert.ok(html.includes(`href="#/groups/${GROUP}"`), `${name} must link to the group, not a legacy project`);
    assert.ok(!html.includes(`href="#/projects/${GROUP}`), `${name} must not send group IDs to the legacy project page`);
    assert.ok(!html.includes('href="#/projects/'), `${name} must not link to removed pages`);
    assert.ok(!html.includes("Classification") && !html.includes("classification"), `${name} must not expose classification`);
    assert.ok(!html.includes("Project tags") && !html.includes(">Projects<"), `${name} has no project controls`);
    if (name !== "Chargeback") assert.ok(html.includes(LEGACY), `${name} keeps historical records visible`);
  });
}

test("Overview keeps historical budget rows per access level distinct", () => {
  const rows = ["STD", "CYB"].map((classification) => ({ ...budgets[1], classification, usedPercent: "95" }));
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  let html: string;
  try {
    html = ui.renderPage("Overview", { ...replies, "/api/v2/budgets": { state: "available", data: { groups: [budgets[0], ...rows], totals: {} } } });
  } finally { console.error = original; }
  assert.ok(html.includes("STD") && html.includes("CYB"), "each historical access level must be identifiable");
  assert.ok(!errors.some((e) => e.includes("same key")), errors.join("\n"));
  assert.ok(!html.includes(`${GROUP}</strong> (group)`), "groups carry no access-level suffix");
  const source = readFileSync(new URL("../ui-v3/pages/overview.tsx", import.meta.url), "utf8");
  assert.match(source, /key: `b-\$\{g\.projectId\}-\$\{g\.classification/, "budget alert keys stay unique per access level");
});

test("legacy bookmarks show a Groups notice and the navigation and help are group-only", async () => {
  const { NAV } = await import("../ui-v3/lib/nav.ts");
  const { HELP } = await import("../ui-v3/help.ts");
  assert.ok(!NAV.some((n) => n.id === "projects" || n.label === "Legacy projects"));
  assert.ok(!HELP.projects && !HELP.project && !HELP["new-project"]);
  const html = ui.renderPage("Page", replies);
  assert.ok(html.includes("no longer managed in the console"), "old bookmarks explain the removal");
  assert.ok(html.includes('href="#/groups"'), "old bookmarks offer Groups");
  assert.ok(!ui.reads.some((p) => p.startsWith("/api/projects/")), "bookmarks never request legacy records");
});

test("shared group screens show no classification, project tags or removed page imports", async () => {
  const src = (p: string) => readFile(new URL(`../ui-v3/${p}`, import.meta.url), "utf8");
  for (const page of ["pages/chargeback.tsx", "pages/reconciler.tsx", "pages/budgets.tsx", "pages/audit.tsx", "pages/foundry.tsx", "components/cost-breakdown.tsx"]) {
    assert.doesNotMatch(await src(page), /label="Classification"|label="Project"|Project tags|\.\/project-detail\.tsx|\.\/projects\.tsx|chargeback\/classifications/, page);
  }
  const html = ui.renderPage("Budgets", { ...replies, "/api/v3/reconciler/snapshots": cap([budgets[0]]) });
  assert.ok(!/<th[^>]*>[^<]*(classification|Classification)[^<]*<\/th>/.test(html), "snapshot table has no classification column for groups");
  assert.equal((html.match(/<th[^>]*>Group<\/th>/g) ?? []).length, 1, "Group identifies the scope, not a second classification column");
  assert.ok(!html.includes(">group<"), "the internal 'group' scope code is not shown as data");
});

test("scope paths only link GUIDs to Groups, never historical IDs", async () => {
  const { scopePath } = await import("../ui-v3/lib/router.ts");
  assert.equal(scopePath(GROUP), `/groups/${GROUP}`);
  assert.equal(scopePath(GROUP.toUpperCase()), `/groups/${GROUP}`);
  assert.equal(scopePath(LEGACY), null);
  assert.equal(scopePath("x/y"), null);
});

test("Chargeback accepts group deep links and ignores historical classification and tag filters", () => {
  const html = ui.renderPage("Chargeback", replies, `group=${GROUP}&classification=STD&tags=pilot`);
  assert.ok(html.includes('value="' + GROUP + '"'));
  const scoped = ui.reads.filter((p) => p.startsWith("/api/v3/chargeback/"));
  assert.ok(scoped.length > 0);
  for (const path of scoped) {
    const params = new URL(path, "https://example.test").searchParams;
    assert.equal(params.get("group"), GROUP);
    assert.equal(params.get("classification"), null);
    assert.equal(params.get("tags"), null);
  }
});

test("Chargeback historical group scopes render as text, never management links", () => {
  const html = ui.renderPage("Chargeback", { ...replies,
    "/api/v3/chargeback/groups": cap([{ ...costs[1], groupId: LEGACY, groupNameSnapshots: ["Historical scope"] }]),
  });
  assert.ok(html.includes(LEGACY));
  assert.doesNotMatch(html, /href="#\/(?:groups|projects)\/project01/i, "historical scope stays unlinked regardless of casing");
  assert.ok(!html.includes('href="#/projects/'));
});

test("Budgets uses the group registration API and group ID for the burn-down", () => {
  ui.renderPage("Budgets", replies);
  assert.ok(ui.reads.includes(`/api/groups/${GROUP}`), "read the group registration rather than /api/projects");
  assert.ok(!ui.reads.includes(`/api/projects/${GROUP}`));
  const trend = ui.reads.find((p) => p.startsWith("/api/v3/chargeback/trend?"));
  assert.equal(new URL(trend ?? "", "https://example.test").searchParams.get("group"), GROUP);
});

test("Budgets excludes historical records from burn-down selection and legacy API reads", () => {
  const html = ui.renderPage("Budgets", { ...replies, "/api/v2/budgets": { state: "available", data: { groups: [budgets[1]], totals: {} } } });
  assert.ok(html.includes("No group budgets yet."));
  assert.ok(!ui.reads.some((p) => p.startsWith("/api/projects/") || p.startsWith("/api/v3/chargeback/trend?")));
});

test("Budgets explains a missing group ID instead of drawing a zero-cost burn-down", () => {
  const html = ui.renderPage("Budgets", { ...replies, [`/api/groups/${GROUP}`]: {} });
  assert.ok(html.includes("No Entra group ID is recorded for this budget."));
  assert.ok(!ui.reads.some((p) => p.startsWith("/api/v3/chargeback/trend?")));
});

test("Foundry lists linked groups only, not historical projects or another backend", () => {
  const html = ui.renderPage("Foundry", replies);
  assert.ok(html.includes(`href="#/groups/${GROUP}"`));
  assert.ok(!html.includes(LEGACY));
  assert.ok(!html.includes("Other backend"));
  assert.ok(!ui.reads.some((p) => p.startsWith("/api/v2/projects")));
});

test("group-only fixtures render Budgets, Overview, Chargeback and Foundry without legacy queries or controls", () => {
  const onlyGroups = { ...replies,
    "/api/v2/budgets": { state: "available", data: { groups: [budgets[0]], totals: {} } },
    "/api/v3/reconciler/snapshots": cap([budgets[0]]),
    "/api/v3/audit": cap([{ projectId: GROUP, operation: "settings", outcome: "updated" }]),
  };
  for (const name of ["Budgets", "Overview", "Chargeback", "Foundry"]) {
    const html = ui.renderPage(name, onlyGroups);
    assert.ok(html.includes(`href="#/groups/${GROUP}"`), name);
    assert.doesNotMatch(html, /Classification|classification|Legacy projects|Project tags|>Projects<|href="#\/projects\//, name);
    assert.ok(!ui.reads.some((p) => /^\/api\/(?:v2\/)?projects/.test(p) || p.includes("/classifications")), name);
  }
});

test("the local demo seeds valid group registrations and derives group-only budget telemetry", async () => {
  const { createDemoGroups } = await import("../dev/demo-groups.ts");
  const { readGroupRegistration } = await import("../../src/contracts/group-registration.ts");
  const { createDemoTelemetry } = await import("../dev/demo-data.ts");
  const docs = createDemoGroups();
  assert.ok(docs.length > 25, "demo still exercises paging");
  for (const doc of docs) {
    const parsed = readGroupRegistration(doc);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal(doc.projectId, doc.groupId);
    assert.ok(!("classifications" in doc));
  }
  const telemetry = createDemoTelemetry({ version: "test", entries: [] }, docs.map((g) => ({
    groupId: String(g.groupId), groupName: String(g.displayName), backendId: String(g.backendId),
    members: 1, personBudgetUsd: 1, groupBudgetUsd: 10, models: ["claude-haiku-4-5"],
  })));
  const lines = telemetry.groupBudgetLines();
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(docs.some((doc) => doc.groupId === line.projectId));
    assert.equal(line.classification, "group");
  }
});
