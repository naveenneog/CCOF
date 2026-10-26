// Reader-page contracts for the long-term audit features (audit archive, ADR-0043; chargeback history, ADR-0044):
// the decision is on the get-started route, an existing deployment has a stage order, the deploy page quotes the
// lines Stage 5 prints, and each feature has a cost with sources and a way to check it works.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const section = (text: string, heading: string) => text.split(heading)[1]?.split(/\n## /)[0] ?? "";

test("both features are decisions on the get-started route, with their cost and the history timer rule", () => {
  const decide = section(read("docs/get-started/02-prerequisites.md"), "## Decide before you start");
  const archive = decide.split("\n").find((l) => l.includes("`audit.archive`")) ?? "";
  const history = decide.split("\n").find((l) => l.includes("`audit.chargebackHistory`")) ?? "";
  assert.match(archive, /USD/, "the archive row states a cost");
  assert.match(archive, /\(\.\.\/operate\/audit-archive\.md\)/);
  assert.match(history, /USD/, "the history row states a cost");
  assert.match(history, /`reconciler\.timerEnabled: true`/);
  assert.match(history, /\(\.\.\/operate\/chargeback-history\.md\)/);
  const deploy = read("docs/get-started/03-deploy.md").split("## Stage 0")[0];
  for (const key of ["`audit.archive.enabled`", "`audit.chargebackHistory.enabled`"]) assert.ok(deploy.includes(key), `03-deploy template table names ${key}`);
});

test("each feature says how to turn it on in an existing deployment, in stage order, with the forced reruns", () => {
  const pages: Array<[string, number[]]> = [["docs/operate/audit-archive.md", [5, 7, 8]], ["docs/operate/chargeback-history.md", [2, 3, 5, 7, 8]]];
  for (const [page, stages] of pages) {
    const text = section(read(page), "## Turn on in an existing deployment");
    assert.ok(text, `${page} has a "Turn on in an existing deployment" section`);
    assert.match(text, /git pull/);
    assert.match(text, /stage_dependency_changed/);
    const at = stages.map((n) => text.indexOf(`Stage ${n}`));
    assert.ok(at.every((i) => i >= 0), `${page} names stages ${stages.join(", ")}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, `${page} lists stages ${stages.join(", ")} in order`);
  }
  assert.match(section(read("docs/operate/chargeback-history.md"), "## Turn on in an existing deployment"), /access administrator/i);
  const guide = read("docs/STAGED-DEPLOYMENT-GUIDE.md");
  assert.match(guide, /chargebackHistory/, "the staged guide mentions chargeback history");
});

test("the deploy page quotes the Stage 5 audit line and the Stage 2 history container, as the scripts print them", () => {
  const deploy = read("docs/get-started/03-deploy.md");
  assert.match(section(deploy, "## Stage 5 "), /`audit archive: /);
  assert.match(section(deploy, "## Stage 5 "), /`audit archive: off/);
  assert.match(read("infra/staged/Staged.Audit.ps1"), /"audit archive: off; \$ws"/);
  assert.match(read("infra/staged/Staged.Audit.ps1"), /return "audit archive: \$\(\$Deployment\.accountName\) in /);
  assert.match(section(deploy, "## Stage 2 "), /`chargebackDaily`/);
});

test("the archive page quotes the Stage 5 lines as printed and gives Windows-safe checks, including the delivery metrics", () => {
  const page = read("docs/operate/audit-archive.md");
  // ARM returns the API Management region as its display name, which Stage 5 prints as is (live 2026-10-26).
  const example = page.split("\n").find((l) => l.startsWith("audit archive: ccoflab") && l.includes(" blobs ")) ?? "";
  assert.match(example, /^audit archive: \S+ in East US 2, blobs deleted after 2555 days, no immutability, Standard_LRS; diagnostic setting ccof-gateway-archive \(GatewayLogs, GatewayLlmLogs\); workspace retention unchanged$/);
  assert.ok(!/ in eastus2\b|"location": "eastus2"/.test(page), "no region in the short form where Stage 5 prints the display name");
  assert.ok(page.includes("audit archive: ccoflab4f2kq7xz3m6bwaud network public-enabled (firewall Deny, no rules), trusted services allowed"), "network line, deployed mode");
  assert.ok(page.includes("audit archive: ccoflab4f2kq7xz3m6bwaud network public-disabled (policy or private), trusted services allowed"), "network line, policy mode");
  assert.match(read("infra/staged/Staged.Audit.ps1"), /return "audit archive: \$AccountName network \$Mode \(\$how\), trusted services allowed"/);
  const check = section(page, "## Check it works");
  for (const text of ["az monitor metrics list", "Transactions", "Authentication eq 'OAuth'", "AppendBlock", "PutBlob", "90 minutes"]) assert.ok(check.includes(text), `check section names ${text}`);
  // Through az.cmd, cmd.exe splits an argument without spaces at ( ) | & < > ^ (seen live with length(@)).
  const queries = [...(page + read("docs/operate/audit-archive-reading.md")).matchAll(/--query (["'])(.*?)\1/g)].map((m) => m[2]);
  assert.deepEqual(queries.filter((q) => /[()|&<>^]/.test(q) && !q.includes(" ")), [], "no --query that cmd.exe splits");
  const policy = section(read("docs/operate/audit-archive-reading.md"), "## When a policy turns public network access off");
  for (const text of ["publicNetworkAccess", "Disabled", "private endpoint", "IP rule", "SecurityControl", "Network Security Perimeter", "public-disabled"]) {
    assert.ok(policy.includes(text), `policy section names ${text}`);
  }
  assert.ok(!/not yet proven|Whether Azure Monitor writes with Shared Key disabled/.test(page), "Shared Key delivery is no longer an assumption");
});

test("the history page says which exports carry sources, as admin/src/export.ts does", () => {
  const code = read("admin/src/export.ts");
  assert.match(code, /if \(!split\.history\) return \{ \.\.\.\(logs as NonNullable<typeof logs>\), rateCardVersion: prepared\.version \}/, "a Log-Analytics-only export has no sources");
  const which = section(read("docs/operate/chargeback-history.md"), "## Which export uses it");
  assert.match(which.replace(/\n/g, " "), /no `sources` key/);
});

test("the history page shows how to download an old month and how to check that history is written", () => {
  const page = read("docs/operate/chargeback-history.md");
  const download = section(page, "## Download an old month");
  for (const text of ["/api/v3/export/usage", "period=custom", "format=csv", "Projects.Manage", "CCOF.Projects.Read", "admin.extraAllowedClientIds", "04b07795-8ddb-461a-bbee-02f9e1bf7b46"]) {
    assert.ok(download.includes(text), `download section names ${text}`);
  }
  assert.match(download, /not .*Export CSV/i, "says the console button does not read history");
  const check = section(page, "## Check it works");
  for (const text of ["ccof.reconciler.run.v1", "historyOutcome", "FunctionAppLogs", "stage2.verify.json"]) assert.ok(check.includes(text), `check section names ${text}`);
});

test("cost sections give prices with sources and retrieval dates", () => {
  const history = section(read("docs/operate/chargeback-history.md"), "## Cost");
  assert.match(history, /USD 0\.25 per million RU/);
  assert.match(history, /learn\.microsoft\.com\/en-us\/azure\/cosmos-db\/request-units/);
  assert.match(history, /prices\.azure\.com/);
  const archive = section(read("docs/operate/audit-archive.md"), "## Cost");
  assert.match(archive, /prices\.azure\.com/);
  assert.match(archive, /Write Operations/);
  assert.match(archive, /Standard_RAGZRS/);
  assert.match(archive, /31 days/);
});

test("the archive page has reading steps, checks and the not-yet-verified note", () => {
  const page = read("docs/operate/audit-archive.md");
  assert.match(section(page, "## Read the archive"), /\(audit-archive-reading\.md\)/);
  const reading = section(read("docs/operate/audit-archive-reading.md"), "## Read the archive");
  for (const text of ["az role assignment create", "Storage Blob Data Reader", "Storage Account Contributor", "az apim list", "storage-private-endpoints", "m=00"]) {
    assert.ok(reading.includes(text), `reading steps name ${text}`);
  }
  const check = section(page, "## Check it works");
  assert.ok(check.includes(".staged-state/evidence/stage5.verify.json"), "full path of stage5.verify.json");
  assert.match(check, /Diagnostic settings/);
  assert.match(check, /90 minutes/);
  assert.match(page, /\(\.\.\/UNKNOWNS\.md\)/, "links the open assumptions");
  assert.match(page, /delete-batch/);
  assert.match(page, /Storage Blob Data Contributor/);
});

test("README and INDEX name chargeback history, and the configuration sample says which audit features it turns on", () => {
  assert.match(read("README.md"), /chargeback history/i);
  assert.match(read("docs/INDEX.md"), /\(operate\/chargeback-history\.md\)/);
  const sample = read("docs/get-started/configuration.md").split("## Complete sample")[1];
  assert.match(sample.split("```").slice(2).join("```"), /audit\.archive/, "a note after the sample names audit.archive");
});

test("the configuration reference keeps both audit features under one Audit heading", () => {
  const ref = read("docs/get-started/configuration-reference-3.md");
  const audit = section(ref, "## Audit\n");
  assert.ok(audit.includes("### Audit archive") && audit.includes("### Chargeback history"), "both under ## Audit");
  assert.match(audit, /24855/);
  assert.match(audit, /`audit\.workspaceRetentionDays` if set, else `stage1\.retentionInDays`|`audit\.workspaceRetentionDays`, or `stage1\.retentionInDays` when it is absent/);
  assert.match(audit, /Other keys inside `audit\.archive` are refused/);
  assert.match(audit, /Other keys inside\s+`audit\.chargebackHistory` are refused/);
});

test("no CODE-NOTE placeholder is left in the documentation", () => {
  const files = (dir: string): string[] => readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".md") ? [path.join(dir, e.name)] : []));
  const found = ["README.md", ...files("docs")].filter((p) => read(p).includes("CODE-NOTE"));
  assert.deepEqual(found, []);
});

test("template statements match staged.config.example.json (history off with the timer, archive on)", () => {
  const example = JSON.parse(read("infra/staged/staged.config.example.json"));
  const archive = example.audit.archive.enabled;
  const history = example.audit.chargebackHistory.enabled;
  assert.equal(history, false, "history needs the timer, which the example keeps off");
  assert.equal(example.reconciler.timerEnabled, false);
  const row = (text: string, key: string) => text.split("\n").find((l) => l.startsWith(`| \`${key}\` |`)) ?? "";
  for (const page of ["docs/get-started/configuration-reference-3.md", "docs/get-started/03-deploy.md"]) {
    const text = read(page);
    assert.ok(row(text, "audit.archive.enabled").includes(`| \`${archive}\` |`), `${page}: audit.archive.enabled template value`);
    assert.ok(row(text, "audit.chargebackHistory.enabled").includes(`| \`${history}\` |`), `${page}: audit.chargebackHistory.enabled template value`);
  }
  const decide = section(read("docs/get-started/02-prerequisites.md"), "## Decide before you start").split("\n");
  assert.match(decide.find((l) => l.includes("`audit.archive`")) ?? "", /On \(template\)/);
  assert.match(decide.find((l) => l.includes("`audit.chargebackHistory`")) ?? "", /Off \(template\)/);
  const pages = ["README.md", "docs/INDEX.md", "docs/get-started/02-prerequisites.md", "docs/get-started/03-deploy.md", "docs/get-started/configuration.md",
    "docs/get-started/configuration-reference-3.md", "docs/operate/chargeback-history.md", "docs/operate/audit-archive.md", "docs/STAGED-DEPLOYMENT-GUIDE.md"];
  const claims = pages.filter((p) => /both on|turns on both|template turns both|both long-term audit features/i.test(read(p)));
  assert.deepEqual(claims, [], "no page says the template turns both features on");
});

test("the history page quotes the timer and coverage refusals, and it or troubleshooting names every new code as the code spells it", () => {
  const page = read("docs/operate/chargeback-history.md");
  const refusal = /'(audit\.chargebackHistory\.enabled is true but reconciler\.timerEnabled is not: [^']+)'/.exec(read("infra/staged/Staged.Cosmos.ps1"))?.[1];
  assert.ok(refusal && page.replace(/\n\s*/g, " ").includes(refusal), "timer refusal quoted word for word");
  const troubleshooting = section(read("docs/operate/troubleshooting.md"), "## Chargeback history");
  const code = ["admin/src/export.ts", "admin/src/history.ts", "src/reconciler/history-run.ts", "src/reconciler/run.ts"].map(read).join("\n");
  const names = ["history_not_covered", "uncoveredDays", "openDays", "history_range_not_whole_days", "backend_filter_not_in_history",
    "chargeback_history_not_configured", "chargeback_history_settings_invalid", "historyClosedRefused", "historyBudgetDeferred",
    "historyCoverageWritten", "historyShrinkRefused", "history_lease_held", "history_time_budget", "history_lease_unavailable",
    "history_conflict", "history_write_failed", "history_read_failed", "history_ledger_read_failed", "history_store_missing", "history_expired", "expiredDays"];
  for (const name of names) {
    assert.ok(code.includes(name), `${name} is in the code`);
    assert.ok(new RegExp(`\\b${name}\\b`).test(page + troubleshooting), `chargeback-history.md or troubleshooting.md names ${name}`);
  }
  for (const name of ["history_not_covered", "uncoveredDays", "openDays", "historyClosedRefused", "history_expired", "X-CCOF-History-Open-Days"]) assert.ok(page.includes(name), `chargeback-history.md names ${name}`);
  assert.match(page, /409/);
  assert.match(page, /ccof-chargeback-history/, "names the history lease");
  assert.match(page, /\(troubleshooting\.md#chargeback-history\)/);
});

test("the admin API and architecture pages describe the history part of the usage export and the run order", () => {
  const api = section(read("docs/ADMIN-API.md"), "### Export for Power BI");
  for (const text of ["409", "history_not_covered", "uncoveredDays", "openDays", "backend_filter_not_in_history", "history_range_not_whole_days"]) {
    assert.ok(api.includes(text), `ADMIN-API export section names ${text}`);
  }
  const arch = read("docs/ARCHITECTURE.md");
  assert.match(arch, /budget lease[^.]*released/);
  assert.match(arch, /ccof-chargeback-history/);
});

test("the audit reader pages use plain terms, not unknown-register IDs", () => {
  const pages = ["docs/operate/audit-archive.md", "docs/operate/chargeback-history.md", "docs/operate/chargeback-and-tags.md", "docs/get-started/configuration-reference-3.md"];
  const found = pages.flatMap((p) => [...read(p).matchAll(/\bAUD-[AC]\d+\b|configuration hash/g)].map((m) => `${p}: ${m[0]}`));
  assert.deepEqual(found, []);
});
