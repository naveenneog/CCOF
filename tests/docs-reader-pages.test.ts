// Documentation checks for the reader-facing pages (README, INDEX, GLOSSARY, get-started, operate, evidence):
// links and images resolve, no internal packet IDs, short pages, and the "expected output" lines the deploy page
// quotes are lines the scripts print.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const dir = (d: string) => readdirSync(path.join(root, d)).filter((f) => f.endsWith(".md")).map((f) => `${d}/${f}`);
const pages = ["README.md", "docs/INDEX.md", "docs/GLOSSARY.md", ...dir("docs/get-started"), ...dir("docs/operate"), ...dir("docs/evidence/2026-10-24-demo")];
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

test("deployment day is linked and gives a timed route through every stage", () => {
  const day = read("docs/get-started/deployment-day.md");
  assert.ok(Buffer.byteLength(day.replace(/\r\n/g, "\n")) < 15 * 1024);
  const start = read("README.md").split("## Start here")[1]?.split("\n## ")[0] ?? "";
  assert.match(start, /\]\(docs\/get-started\/deployment-day\.md\)/, "README Start here links deployment day");
  assert.match(read("docs/get-started/02-prerequisites.md"), /\]\(deployment-day\.md\)/);
  for (let stage = 0; stage <= 8; stage++) {
    assert.match(day, new RegExp(`^\\| ${stage} \\| [^|]+ \\| \\d+(?:[–-]\\d+)? min \\|`, "m"),
      `deployment day needs a measured time for Stage ${stage}`);
  }
  for (const text of ["-Stage $stage -ConfigPath $cfg", "-Stage $stage -ConfigPath $cfg -Apply",
    "https://aka.ms/cosmosdbquota", "25,000", '"apimUnits": 4', '"storageSku": "Standard_ZRS"',
    '"zoneRedundant": true', '"isZoneRedundant": false', "foundry-failover.md",
    "x-ccof-project", "/ccof/me/usage", "acceptance.expectedGroup", "three developers", "all registered group IDs",
    "CpuPercent_Gateway", "subscription Owner", "Privileged Role Administrator",
    "persistent", "Cloud Shell", "Stage 0", "Stage 8", "403", "chargeback"]) {
    assert.ok(day.includes(text), `deployment day needs ${text}`);
  }
  assert.match(day, /not.*25,000.*load test|not.*25,000.*capacity guarantee/i);
  assert.match(day, /quota.*per model|per.model.*quota/i);
  assert.match(day, /80[–-]100 minutes/);
  assert.match(day, /storage.*403.*5 minutes/i);
  assert.match(day, /new resources after Stage 1 and before Stage 6/, "verify-mode networking must distinguish pre-day design from connecting newly created resources");
});

test("deployment day quotes only verified script output, not invented success lines", () => {
  const day = read("docs/get-started/deployment-day.md").replace(/\r\n/g, "\n");
  const block = day.split("**Script output:**\n\n```text\n")[1]?.split("```")[0] ?? "";
  assert.ok(block, "deployment day has a script-output checklist");
  const sources = readdirSync(path.join(root, "infra/staged")).filter((f) => f.endsWith(".ps1"))
    .map((f) => read(`infra/staged/${f}`)).join("\n");
  const allowed: Array<[string, RegExp]> = [
    ["preview only: nothing changed", /Write-Host "[^"\n]*preview only: nothing changed/],
    ["completed and verified in", /Write-Host "[^"\n]*completed and verified in/],
    ["HA check:", /Write-Host "HA check:/],
  ];
  const lines = block.trim().split("\n");
  assert.deepEqual(lines, allowed.map(([line]) => line), "deployment-day output checklist must use the real printed fragments");
  for (const [line, printed] of allowed) assert.match(sources, printed, `staged scripts print ${line}`);
});

test("deployment day configuration teaches each decision and validates its complete HA example", () => {
  const page = read("docs/get-started/deployment-day-config.md");
  assert.match(read("README.md"), /\]\(docs\/get-started\/deployment-day-config\.md\)/);
  assert.match(read("docs/get-started/deployment-day.md"), /\]\(deployment-day-config\.md\)/);
  for (const decision of ["Region", "API Management", "Network", "Cosmos", "HA", "Standby", "Audit", "Groups", "Developer sign-in"]) {
    assert.ok(page.includes(`## ${decision}`), `deployment-day config explains ${decision}`);
  }
  for (const match of page.matchAll(/```json\r?\n([\s\S]*?)```/g)) {
    assert.doesNotThrow(() => JSON.parse(match[1]), "every deployment-day JSON fragment parses");
  }
  const section = page.split("## Complete HA example")[1];
  const sample = section && /```json\r?\n([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(sample, "deployment-day complete HA example is present");
  const config = JSON.parse(sample);
  assert.equal(config.location, "centralindia");
  assert.equal(config.stage1.foundry.location, "eastus2");
  assert.equal(config.stage1.apimUnits, 4);
  assert.equal(config.ha.apim.zoneRedundant, true);
  assert.equal(config.ha.functions.zoneRedundant, true);
  assert.equal(config.stage1.storageSku, "Standard_ZRS");
  assert.deepEqual(config.stage1.cosmosLocations, [
    { locationName: "centralindia", isZoneRedundant: true },
    { locationName: "southindia", isZoneRedundant: false },
  ]);
  assert.equal(config.groups.length, 2);
  const maximumMemberships = 25_000 * config.groups.length;
  assert.ok(config.reconciler.maxStates >= maximumMemberships + config.groups.length,
    "large-rollout example must not retain the 10,000-state guard below 25,000 developers' scopes");
  assert.ok(config.reconciler.ledgerMaxRows > maximumMemberships * Object.keys(config.backends[0].deploymentInferenceGeo).length,
    "large-rollout ledger guard needs headroom for the configured model/member scopes");
  assert.equal(config.sync.mode, "application-permission", "large enrollment must not imply that the small app-settings snapshot transport is a fleet transport");
  assert.equal(config.syncTimerEnabled, true);
  assert.equal(config.acceptance.expectedGroup, config.groups[0].groupId);
  assert.notEqual(config.groups[0].groupId, config.groups[1].groupId);
  assert.ok(config.backends[0].failover, "HA example includes a standby backend");
  assert.notEqual(config.backends[0].subscriptionId, config.backends[0].failover.subscriptionId);
  const scratch = path.join(root, ".env.day-config-test");
  // Keep the sample on the persistent worktree; no OS temporary folder or signed-in Azure profile is needed.
  const file = path.join(scratch, "staged.config.json");
  try {
    mkdirSync(scratch, { recursive: true });
    writeFileSync(file, sample);
    const script = `. '${path.join(root, "infra/staged/Invoke-StagedDeployment.ps1")}' -DotSourceOnly; $null = Read-StgConfig '${file}'; 'HA example accepted'`;
    assert.match(execFileSync("pwsh", ["-NoProfile", "-Command", script], { cwd: root, encoding: "utf8" }), /HA example accepted/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("deployment day illustrates every timed step and inventories every real-run capture", () => {
  const day = read("docs/get-started/deployment-day.md");
  const evidence = "docs/evidence/2026-10-28-deployment-day";
  const index = read(`${evidence}/README.md`);
  for (const step of [...Array.from({ length: 9 }, (_, i) => `Stage ${i}`), "Developer setup", "Two-group onboarding"]) {
    assert.match(day, new RegExp(`^### ${step} [—–-] [^\\n]*(?:seconds|minutes)`, "m"), `${step} has a duration next to its capture`);
  }
  const names = [...Array.from({ length: 9 }, (_, i) => `stage-${i}.png`),
    "developer-setup.png", "two-group-onboarding.png", "usage-and-status.png",
    "console-groups.png", "console-onboard.png", "console-group-detail.png", "console-budgets.png", "console-chargeback.png"];
  for (const name of names) {
    assert.ok(existsSync(path.join(root, evidence, name)), `${name} exists`);
    assert.ok(day.includes(`../evidence/2026-10-28-deployment-day/${name})`), `guide embeds ${name}`);
    assert.ok(index.includes(`(${name})`), `capture index lists ${name}`);
  }
  for (const image of readdirSync(path.join(root, evidence)).filter((name) => name.endsWith(".png"))) {
    assert.ok(index.includes(`(${image})`), `capture index inventories ${image}`);
  }
  assert.match(index, /2026-10-27/);
  assert.match(index, /2026-10-26/);
  assert.match(index, /demo|live/i);
});

test("deployment day users distinguishes captured clients from unverified fleet and Office routes", () => {
  const users = read("docs/get-started/deployment-day-users.md");
  assert.match(read("README.md"), /\]\(docs\/get-started\/deployment-day-users\.md\)/);
  assert.match(read("docs/get-started/deployment-day.md"), /\]\(deployment-day-users\.md\)/);
  for (const section of ["Claude Code", "VS Code", "Claude Desktop", "Cowork and Microsoft 365", "Bulk onboarding"]) {
    assert.match(users, new RegExp(`^## \\d\\. ${section} [—–-] (?:[^\\n]*minutes|not timed)`, "m"), `${section} has timing`);
  }
  const setup = read("scripts/client/Set-ClaudeCodeGateway.ps1") + read("scripts/client/ClaudeCodeGateway.ps1");
  for (const key of ["apiKeyHelper", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "claudeCode.disableLoginPrompt"]) {
    assert.ok(users.includes(key), `users guide explains ${key}`);
    assert.ok(setup.includes(key), `setup writes ${key}`);
  }
  for (const script of ["Set-ClaudeCodeGateway.ps1", "Set-ClaudeDesktopGateway.ps1"]) {
    assert.ok(users.includes(script), `users guide quotes ${script}`);
    assert.ok(read(`scripts/client/${script}`).includes("$ConfigPath"), `${script} accepts ConfigPath`);
    assert.ok(read(`scripts/client/${script}`).includes("$Confirmed"), `${script} accepts Confirmed`);
  }
  for (const text of ["ccof-token.cmd", "~/.claude/ccof-token login", "claude -p", "/usage", "/status",
    "not verified", "no Intune tenant", "surfaceClients", "surfaces", "gateway.surfaceClients",
    "C:\\Program Files\\ClaudeCode\\managed-settings.json", "/Library/Application Support/ClaudeCode/managed-settings.json",
    "https://code.claude.com/docs/en/managed-settings", "https://github.com/anthropics/claude-code/tree/main/examples/mdm"]) {
    assert.ok(users.includes(text), `users guide needs ${text}`);
  }
  assert.match(users, /macOS.*not supported|not supported.*macOS/i);
  assert.match(users, /per.user.*sign.in|sign.in.*per.user/i);
  assert.match(users, /7,000 base64/, "bulk onboarding must warn about the small Windows snapshot transport");
  assert.match(users, /Stage 1.*24 hours|24 hours.*Stage 1/, "fresh managed identities need an explicit consent/warm-up plan");
  const windows = users.split("### Windows —")[1]?.split("### macOS/Linux")[0] ?? "";
  const desktop = users.split("## 3. Claude Desktop")[1]?.split("## 4.")[0] ?? "";
  assert.match(windows, /```powershell title="Windows only"/, "Windows helper commands must be labelled, not presented as portable deployer commands");
  assert.match(desktop, /```powershell title="Windows only"/, "Windows-only Desktop commands must be labelled");
  for (const block of users.matchAll(/```json\r?\n([\s\S]*?)```/g)) assert.doesNotThrow(() => JSON.parse(block[1]));
});

test("high availability guide shows opt-in settings, cost, checks and create-only migration", () => {
  const ha = read("docs/get-started/high-availability.md");
  for (const text of ['"ha"', '"zoneRedundant": true', '"storageSku": "Standard_ZRS"', '"apimUnits": 2',
    '"isZoneRedundant": true', "HA check:", "suggestion:", "Stage 0", "Stage 1", "always-ready",
    "new prefix", "single-region", "foundry-failover.md"]) assert.ok(ha.includes(text), `HA guide needs ${text}`);
  assert.match(ha, /re-creat|recreat/i);
  assert.match(ha, /https:\/\/aka\.ms\/cosmosdbquota/, "HA guide needs a recovery path when zonal Cosmos capacity is refused");
  assert.match(ha, /Standard v2 Secondary Unit/, "HA cost example must distinguish the additional-unit meter from the first unit");
  assert.match(ha, /az cosmosdb delete/, "HA guide needs a failed-empty-account recovery command, not a fictional Stage 1 completion");
  assert.match(ha, /never succeeded.*Stage 1|Stage 1.*never succeeded/i);
  assert.match(ha, /documentEndpoint/, "Failed-account recovery must explain how to corroborate no initialized data endpoint when database listing is refused");
  assert.match(ha, /list-flexconsumption-locations --zone-redundant=true/);
  assert.match(ha, /learn\.microsoft\.com\/azure\/reliability\/reliability-api-management/);
  for (const page of ["02-prerequisites.md", "region-and-failover.md", "configuration-resources.md", "configuration.md", "configuration-reference.md"]) {
    assert.ok(read(`docs/get-started/${page}`).includes("(high-availability.md)"), `${page} links the HA guide`);
  }
  for (const key of ["ha.apim.zoneRedundant", "ha.functions.zoneRedundant"]) {
    assert.ok(read("docs/get-started/configuration-reference.md").includes(key), `configuration reference needs ${key}`);
  }
});

test("regional outage guidance includes a reversible Cosmos drill and single-region service recovery", () => {
  const regions = read("docs/get-started/region-and-failover.md");
  assert.match(regions, /az cosmosdb failover-priority-change.*southindia=0 centralindia=1/, "AO-8: document a planned Cosmos write-region switch");
  assert.match(regions, /az cosmosdb failover-priority-change.*centralindia=0 southindia=1/, "AO-8: document switching back");
  assert.match(regions, /learn\.microsoft\.com\/.*cosmosdb.*#az-cosmosdb-failover-priority-change/);
  assert.match(regions, /gateway.*unavailable/i);
  assert.match(regions, /writeLocations/);
  assert.match(regions, /Stage 8/);
  assert.match(regions, /does not prove.*South India/i);
  assert.match(regions, /COSMOS_PREFERRED_REGIONS.*southindia,centralindia/);
  assert.match(regions, /restore.*saved value/i);
  assert.match(regions, /new Cosmos.*account/i);
});

test("novice operations guidance gives realistic grant timing and a real backend availability link", () => {
  const stage3 = read("docs/get-started/03-deploy.md").split("## Stage 3")[1]?.split("\n## ")[0] ?? "";
  assert.match(stage3, /Time:\*\* 6[–-]15 minutes/, "N4: Stage 3 time estimate must cover the observed 6–15 minute range");
  const backends = read("docs/BACKENDS.md");
  assert.doesNotMatch(backends, /AVAILABILITY\.md/, "novice Low: BACKENDS must not name the missing AVAILABILITY page");
  assert.match(backends, /\[[^\]]+\]\(get-started\/region-and-failover\.md\)/);
});

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
  const big = [...dir("docs/get-started"), ...dir("docs/operate")].filter((p) => Buffer.byteLength(read(p).replace(/\r\n/g, "\n")) > 15 * 1024); // LF size: the same on a Windows (CRLF) and a Linux checkout
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

test("developer /usage page separates the interactive skill, claude -p and a refused budget (DEV-1, DEV-2, DEV-4)", () => {
  const setup = read("docs/get-started/05-developer-setup.md");
  const step = setup.split("## 4. Check your own budget")[1]?.split("\n## ")[0] ?? "";
  assert.match(step, /interactive Claude Code session/i);
  assert.match(step, /`claude -p "\/usage"`[^.]*built-in/);
  assert.match(step, /Once requests are refused, `\/usage` cannot show it/);
  assert.match(step, /status line/);
  assert.match(step, /& "\$HOME\/\.claude\/ccof-usage\.ps1"/);
  assert.doesNotMatch(step, /usage-03-refused\.png/, "a refused budget is not shown by /usage");
  const usage = read("docs/USAGE.md");
  assert.match(usage, /Shell command permission check failed/);
  assert.match(usage, /allowed-tools/);
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

test("developer setup has one sign-in step for both sign-in methods, and the method is a deployment decision", () => {
  const setup = read("docs/get-started/05-developer-setup.md");
  const step2 = setup.split("## 2.")[1].split("\n## ")[0];
  assert.match(step2, /& "\$env:USERPROFILE\\\.claude\\ccof-token\.cmd" login/);
  assert.match(step2, /"signIn"/, "step 2 points at the command setup printed");
  assert.doesNotMatch(setup, /Open `client-config\.json`/, "the developer does not choose a route by reading the configuration");
  assert.doesNotMatch(setup, /\.\\client\\bin\\ccof-token\.cmd login/, "no second, repository-path sign-in command");
  for (const method of ["msal", "azure-cli"]) assert.ok(step2.includes(`\`${method}\``), `step 2 says what ${method} shows`);
  const decide = read("docs/get-started/02-prerequisites.md").split("## Decide before you start")[1];
  assert.match(decide, /\| Developer sign-in \|[^\n]*`client\.signInMethod`[^\n]*`entra\.allowAzureCliClient(: true)?`/);
});

const configPages = ["configuration", "configuration-identity", "configuration-resources", "configuration-reference", "configuration-reference-2", "configuration-reference-3"].map((n) => `docs/get-started/${n}.md`);
const configText = () => configPages.map((p) => read(p)).join("\n");

// Leaf key paths of the template, arrays collapsed to []; map keys that are model or family names are generic.
const templateLeafPaths = (): string[] => {
  const template = JSON.parse(read("infra/staged/staged.config.example.json"));
  const out = new Set<string>();
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) { if (!value.length) out.add(at); else value.forEach((v) => walk(v, `${at}[]`)); return; }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (!entries.length) out.add(at);
      for (const [k, v] of entries) walk(v, at ? `${at}.${k}` : k);
      return;
    }
    out.add(at);
  };
  walk(template, "");
  return [...out].map((p) => p.replace(/deploymentInferenceGeo\.[^.]+$/, "deploymentInferenceGeo.<deployment>").replace(/families\.(haiku|sonnet)\b/, "families.<family>"));
};

test("the configuration pages name every leaf key of the template and the decision keys", () => {
  const decisions = ["stage1.cosmosLocations", "stage1.foundry.deployments", "stage1.foundry.modelProviderData", "network.existing", "network.create",
    "network.existing.privateDnsZoneIds.cosmos", "network.existing.privateDnsZoneIds.blob", "network.existing.privateDnsZoneIds.foundry.cognitiveServices",
    "network.existing.privateDnsZoneIds.foundry.openAi", "network.existing.privateDnsZoneIds.foundry.aiServices", "apim.existing.name", "apim.existing.subscriptionId",
    "apim.existing.resourceGroup", "entra.existing.gatewayAppId", "entra.existing.resolverAppId", "entra.existing.adminAppId", "groups[].groupId",
    "backends[].deploymentInferenceGeo", "groups[].budget", "groups[].familyPolicy", "acceptance", "acceptance.expectedGroup"];
  for (const p of configPages) assert.ok(existsSync(path.join(root, p)), `${p} exists`);
  const text = configText();
  const missing = [...new Set([...templateLeafPaths(), ...decisions])].filter((k) => !text.includes(`\`${k}\``));
  assert.deepEqual(missing, [], "keys the configuration pages do not name");
  for (const p of configPages) assert.ok(read(p).split("\n").length < 400, `${p} stays under 400 lines`);
});

test("the configuration pages are linked and show create and reuse JSON for every reuse-or-create choice", () => {
  assert.match(read("docs/get-started/03-deploy.md").split("## Stage 0")[0], /\]\(configuration\.md\)/, "linked from Before Stage 0");
  assert.match(read("docs/INDEX.md"), /\]\(get-started\/configuration\.md\)/, "linked from the documentation map");
  const overview = read(configPages[0]);
  for (const p of configPages.slice(1)) assert.ok(overview.includes(`](${path.basename(p)})`), `configuration.md links ${path.basename(p)}`);
  const identity = read("docs/get-started/configuration-identity.md");
  for (const key of ["gatewayAppId", "resolverAppId", "adminAppId"]) assert.ok(identity.includes(`"${key}"`), `an Entra snippet shows ${key}`);
  for (const line of ["reuse existing gateway application", "reuse application '", "created application '", "created group "]) assert.ok(identity.includes(line), `identity page quotes "${line}"`);
  const stages = readdirSync(path.join(root, "infra/staged")).filter((f) => f.startsWith("Staged.")).map((f) => read(`infra/staged/${f}`)).join("\n");
  for (const fragment of ["reuse existing $Kind application", "reuse application '$DisplayName'", "created application '$DisplayName'", "created group $($g.groupDisplayName)", "lacks deployments"]) {
    assert.ok(stages.includes(fragment), `a staged script prints "${fragment}"`);
  }
  const resources = read("docs/get-started/configuration-resources.md");
  for (const heading of ["## Foundry and backends", "## Network", "## API Management"]) {
    assert.ok(resources.includes(heading), `resources page has ${heading}`);
    const section = resources.split(heading)[1].split("\n## ")[0];
    assert.ok(/Create new/.test(section) && /Reuse existing|Existing/.test(section), `${heading} shows both choices`);
    assert.ok((section.match(/```json/g) ?? []).length >= 2, `${heading} has at least two JSON snippets`);
  }
  const cosmos = resources.split("## Cosmos DB")[1];
  assert.ok(/One region, serverless/.test(cosmos) && /Two regions, provisioned/.test(cosmos), "Cosmos DB shows one and two regions");
  assert.ok((cosmos.match(/```json/g) ?? []).length >= 2, "Cosmos DB has two JSON snippets");
  assert.ok(resources.includes("infra/prereqs/network.bicep"), "the network section points at the network module");
});

test("every JSON block on the configuration pages parses, and the complete sample passes Read-StgConfig", () => {
  for (const p of configPages) {
    for (const m of read(p).matchAll(/```json\r?\n([\s\S]*?)```/g)) {
      const body = m[1].trim();
      assert.doesNotThrow(() => JSON.parse(body.startsWith("{") ? body : `{${body}}`), `${p}: a JSON block parses`);
    }
  }
  const overview = read(configPages[0]);
  const section = overview.split("## Complete sample")[1];
  assert.ok(section, "configuration.md has a Complete sample section");
  const sample = /```json\r?\n([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(sample, "the Complete sample section holds a JSON block");
  assert.doesNotMatch(sample, /REPLACE-/, "the sample holds no placeholder");
  const dirPath = mkdtempSync(path.join(tmpdir(), "ccof-config-sample-"));
  try {
    const file = path.join(dirPath, "staged.config.json");
    writeFileSync(file, sample);
    const script = `. '${path.join(root, "infra/staged/Invoke-StagedDeployment.ps1")}' -DotSourceOnly; $null = Read-StgConfig '${file}'; 'sample accepted'`;
    const output = execFileSync("pwsh", ["-NoProfile", "-Command", script], { cwd: root, encoding: "utf8" });
    assert.match(output, /sample accepted/);
  } finally {
    rmSync(dirPath, { recursive: true, force: true });
  }
});
test("the existing API Management page is on the reader's route and quotes lines the scripts print", () => {
  for (const page of ["docs/get-started/02-prerequisites.md", "docs/get-started/03-deploy.md"]) {
    assert.match(read(page), /\(existing-api-management\.md[#)]/, `${page} links the existing API Management page`);
  }
  const existing = read("docs/get-started/existing-api-management.md");
  const scripts = readdirSync(path.join(root, "infra/staged")).filter((f) => f.endsWith(".ps1")).map((f) => read(`infra/staged/${f}`)).join("\n");
  const quoted = ["apim_existing_unreadable", "apim_identity_missing", "apim_existing_sku", "apim_existing_api_conflict", "apim_existing_path_taken",
    "apim_existing_backend_conflict", "apim_existing_diagnostic_settings_full", "apim_existing_no_private_route", "apim_gateway_logs_conflict",
    "you cannot run Stage 5 on", "also runs for the CCOF API", "system-assigned identity on,", "gateway logs: diagnostic setting", "gateway logs: reusing diagnostic setting",
    "verified:", "is not changed: CCOF does not change the networking of an existing API Management.", "both a new API Management"];
  for (const text of quoted) {
    assert.ok(existing.includes(text), `the page quotes "${text}"`);
    assert.ok(scripts.includes(text), `a staged script prints "${text}"`);
  }
});

test("a region without Claude, provisioned Cosmos DB cost and the failover region are on the reader's route (novice run 5)", () => {
  const page = read("docs/get-started/region-and-failover.md");
  assert.match(read("docs/get-started/02-prerequisites.md").split("## Decide before you start")[1], /\]\(region-and-failover\.md\)/, "linked from Decide before you start");
  assert.match(read("README.md"), /\]\(docs\/get-started\/region-and-failover\.md\)/, "linked from the README");
  assert.match(page, /stage1\.foundry\.location/, "names the key that places the Foundry account");
  assert.match(page, /Data Zone/, "explains where inference data is processed");
  assert.match(page, /privateEndpoint/, "explains private endpoint or public Foundry across regions");
  assert.match(page, /regions-paired/, "cites the Azure region pairs");
  assert.match(page, /South India/, "gives the Central India example");
  assert.match(page, /isZoneRedundant: false/, "a region without availability zones");
  assert.match(page, /prices\.azure\.com[^)]*Cosmos/, "provisioned Cosmos DB cost with its source");
  const outage = page.split("## 4.")[1] ?? "";
  assert.match(outage, /one hour or more/, "service-managed failover can take an hour (Learn, region outage table)");
  assert.match(outage, /region offline operation/, "names the region offline operation as the faster recovery");
  assert.match(outage, /single availability zone|one availability zone/, "says what isZoneRedundant: false risks");
  assert.match(outage, /any Azure region/, "Global Standard processing is not account failover");
  const guide = read("docs/STAGED-DEPLOYMENT-GUIDE.md").split("### 2.6")[1].split("\n## ")[0];
  assert.match(guide, /paired region|region pair/i, "guide 2.6 names the paired region");
  assert.match(guide, /residency/i, "guide 2.6 names data residency");
});
test("Foundry failover has an upgrade path and a verifiable drill on the reader's route", () => {
  const page = read("docs/get-started/foundry-failover.md");
  assert.match(page, /backends\[\]\.failover/);
  assert.match(page, /Stage 1 is create-only/);
  assert.match(page, /BackendUrl/);
  assert.match(page, /429/);
  assert.match(page, /Retry-After/);
  assert.match(page, /same subscription/);
  assert.match(page, /approximate per gateway instance/);
  assert.match(read("docs/get-started/region-and-failover.md"), /\]\(foundry-failover\.md\)/);
  assert.match(read("docs/BACKENDS.md"), /\]\(get-started\/foundry-failover\.md\)/);
});
