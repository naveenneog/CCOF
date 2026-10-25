// Reader-page contracts for the long-term audit features (audit archive, ADR-0043; chargeback history, ADR-0044):
// the decision is on the get-started route, an existing deployment has a stage order, the deploy page quotes the
// lines Stage 5 prints, and each feature has a cost with sources and a way to check it works.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const reading = section(page, "## Read the archive");
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
