// Documentation checks for the reader-facing pages (README, INDEX, GLOSSARY, get-started, operate, evidence):
// links and images resolve, no internal packet IDs, short pages, and the "expected output" lines the deploy page
// quotes are lines the scripts print.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const dir = (d: string) => readdirSync(path.join(root, d)).filter((f) => f.endsWith(".md")).map((f) => `${d}/${f}`);
const pages = ["README.md", "docs/INDEX.md", "docs/GLOSSARY.md", ...dir("docs/get-started"), ...dir("docs/operate"), ...dir("docs/evidence/2026-10-24-demo")];
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

test("every relative link and image on the reader-facing pages resolves", () => {
  const missing: string[] = [];
  for (const page of pages) {
    for (const m of read(page).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const file = path.resolve(path.dirname(path.join(root, page)), decodeURIComponent(target.split("#")[0]));
      if (!existsSync(file)) missing.push(`${page} -> ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("reader-facing pages carry no internal packet or unknown IDs", () => {
  const found = pages.flatMap((p) => [...read(p).matchAll(/\b(G-[A-Z]{2,}|E2E-\d\d|U-\d+|WP-[A-Z]+)\b/g)].map((m) => `${p}: ${m[0]}`));
  assert.deepEqual(found, []);
});

test("get-started and operate pages stay short (15 KB)", () => {
  const big = [...dir("docs/get-started"), ...dir("docs/operate")].filter((p) => statSync(path.join(root, p)).size > 15 * 1024);
  assert.deepEqual(big, []);
});

test("the expected lines quoted on the deploy page are printed by the staged scripts", () => {
  const deploy = read("docs/get-started/03-deploy.md");
  const scripts = readdirSync(path.join(root, "infra/staged")).filter((f) => f.endsWith(".ps1")).map((f) => read(`infra/staged/${f}`)).join("\n")
    + read("infra/quickstart/Deploy-Quickstart.ps1") + read("src/sync/telemetry.ts");
  const quoted: Array<[string, RegExp]> = [
    ["completed and verified in", /completed and verified in/],
    ["deployed stage1-services", /Write-Host "deployed \$Name/],
    ["integrated with snet-functions", /integrated with/],
    ["STAGED OK", /STAGED OK/],
    ["ccof.sync.run.v1", /ccof\.sync\.run\.v1/],
    ["Set-ClaudeCodeGateway.ps1", /Set-ClaudeCodeGateway\.ps1/],
  ];
  for (const [text, source] of quoted) {
    assert.ok(deploy.includes(text), `the deploy page quotes "${text}"`);
    assert.match(scripts, source, `a script prints "${text}"`);
  }
});

test("developer login and snapshot onboarding include the configuration handoff", () => {
  assert.match(read("docs/get-started/05-developer-setup.md"), /\$env:CCOF_CONFIG_FILE\s*=\s*\(Resolve-Path/);
  const members = read("docs/operate/users-and-groups.md");
  assert.match(members, /--groups \$groupsFile/);
  assert.match(members, /Invoke-SnapshotApplyThroughFunction\.ps1/);
  assert.match(members, /all registered group IDs/i);
  assert.match(read("docs/get-started/04-onboard-a-group.md"), /successful sync or snapshot/i);
});

test("deployment setup shows key configuration values and a lab path", () => {
  const deploy = read("docs/get-started/03-deploy.md");
  for (const key of ['"tenantId"', '"subscriptionId"', '"resourceGroup"', '"location"', '"prefix"', '"accountName"']) {
    assert.ok(deploy.includes(key), `deployment guide shows ${key}`);
  }
  assert.match(deploy, /not a complete configuration/i);
  const prerequisites = read("docs/get-started/02-prerequisites.md");
  assert.match(prerequisites, /single-subscription lab/i);
  assert.match(prerequisites, /network\.mode: create/);
  assert.match(prerequisites, /charges?/i);
});

test("README live acceptance summary is understandable without gateway jargon", () => {
  const readme = read("README.md");
  const section = readme.split("## Live acceptance")[1]?.split("\n## ")[0] ?? "";
  assert.ok(section, "README has a Live acceptance section");
  assert.match(section, /group-specific model access/i);
  assert.match(section, /budget exhaustion/i);
  assert.match(section, /chargeback report/i);
  assert.match(section, /detailed report/i);
  assert.doesNotMatch(section, /bypass|CCU|list-rate|streamed cache/i);
});

test("budget-exhausted evidence describes the current status-line output", () => {
  const evidence = read("docs/evidence/2026-10-24-demo/README.md");
  assert.match(evidence, /refreshed by rendering the saved `\/usage` response.*current client formatter/i);
  assert.doesNotMatch(evidence, /predates the status-line fix/i);
  const source = read("docs/evidence/2026-10-24-demo/usage-03-refused.txt");
  assert.match(source, /status line:\s+CCOF \$2\.14\/\$2\.00 \(106%\) - budget used up, requests refused/);
  const onboarding = read("docs/get-started/04-onboard-a-group.md");
  assert.match(onboarding, /console-04-review\.png/);
  assert.doesNotMatch(onboarding, /console-03-access-models\.png/);
});

test("developer setup starts by getting the code and names the folder to run from", () => {
  const setup = read("docs/get-started/05-developer-setup.md");
  assert.match(setup, /git clone https:\/\/github\.com\/naveenneog\/CCOF\.git ccof/);
  assert.match(setup, /from the `ccof` folder/i);
  assert.ok(setup.indexOf("git clone") < setup.indexOf("npm ci --prefix"), "clone comes before the install");
  assert.doesNotMatch(setup, /predates the status-line correction/i);
});

test("every applying stage shows its preview command first", () => {
  const deploy = read("docs/get-started/03-deploy.md").replace(/\r\n/g, "\n");
  for (let stage = 1; stage <= 8; stage++) {
    const section = deploy.split(`## Stage ${stage} `)[1]?.split("\n## ")[0] ?? "";
    const apply = section.search(new RegExp(`^pwsh -File \\$run -Stage ${stage} -ConfigPath \\$cfg -Apply[ \\t]*$`, "m"));
    const preview = section.search(new RegExp(`^pwsh -File \\$run -Stage ${stage} -ConfigPath \\$cfg[ \\t]*(#[^\\n]*)?$`, "m"));
    assert.ok(apply >= 0, `stage ${stage} section has its apply command`);
    assert.ok(preview >= 0 && preview < apply, `stage ${stage} section has its preview command before apply`);
  }
  assert.match(deploy, /preview only: nothing changed/);
  assert.match(read("infra/staged/Invoke-StagedDeployment.ps1"), /preview only: nothing changed/);
});

test("the Stage 7 capture has a plain checklist of what success looks like", () => {
  const stage7 = read("docs/get-started/03-deploy.md").split("## Stage 7")[1].split("## Stage 8")[0];
  for (const line of ["(OneDeploy)", "admin.zip", ": created", '"outcome":"succeeded"', '"writeFailures":0', "Configure this machine", "stage 7 completed and verified"]) {
    assert.ok(stage7.includes(line), `Stage 7 checklist names ${line}`);
  }
});

test("the lab route gives a rough daily cost with sources and a way to check actual spend", () => {
  const lab = read("docs/get-started/02-prerequisites.md");
  assert.match(lab, /USD 0\.96 per hour/);
  assert.match(lab, /about USD 25 per day/i);
  assert.match(lab, /prices\.azure\.com/);
  assert.match(lab, /Cost analysis/);
  assert.match(lab, /8.24 hours/);
});

const archived = ["DEPLOYMENT-GUIDE", "QUICKSTART", "QUICKSTART-PREREQUISITES", "MANUAL-DEPLOYMENT", "MANUAL-PORTAL-FIXES", "ONBOARDING",
  "ADMIN-V2", "ADMIN-QUICK-STAGES", "ADMIN-V3-BUG-BASH", "RELEASE-v0.2.0", "STAGE1-LIVE-VERIFICATION", "STAGED-LIVE-RUN-2026-10-20", "STAGED-STDV2-RUNS-2026-10-20"];

test("earlier-path guides live in docs/archive, listed by its README, with working links", () => {
  const index = read("docs/archive/README.md");
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const trackedNames = new Set(tracked.map((f) => path.posix.basename(f)));
  const broken: string[] = [];
  for (const name of archived) {
    assert.ok(!existsSync(path.join(root, `docs/${name}.md`)), `docs/${name}.md moved`);
    assert.ok(existsSync(path.join(root, `docs/archive/${name}.md`)), `docs/archive/${name}.md exists`);
    assert.ok(index.includes(`(${name}.md)`), `archive README lists ${name}`);
    const page = `docs/archive/${name}.md`;
    // Every relative link must resolve from docs/archive/. The only exception is a target whose file name is in no
    // tracked path: those links were already broken before the move (images and ADR 0012 never committed).
    for (const m of read(page).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(m[1])) continue;
      const target = decodeURIComponent(m[1].split("#")[0]);
      if (existsSync(path.resolve(root, "docs/archive", target))) continue;
      if (trackedNames.has(path.posix.basename(target))) broken.push(`${page} -> ${m[1]}`);
    }
  }
  assert.deepEqual(broken, []);
  const inbound = new RegExp(`(^|[^\\w/-])docs[\\\\/](${archived.join("|")})\\.md`);
  const stale = tracked.filter((f) => /\.(md|ts|tsx|mjs|cjs|js|ps1|psm1|py|json|ya?ml|bicep|xml)$/.test(f) && existsSync(path.join(root, f))
    && inbound.test(readFileSync(path.join(root, f), "utf8")));
  assert.deepEqual(stale, [], "no file refers to an archived guide by its former docs/ path");
  assert.match(read("docs/INDEX.md"), /\(archive\/README\.md\)/);
});
