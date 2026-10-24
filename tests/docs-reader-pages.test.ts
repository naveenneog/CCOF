// Documentation checks for the reader-facing pages (README, INDEX, GLOSSARY, get-started, operate, evidence):
// links and images resolve, no internal packet IDs, short pages, and the "expected output" lines the deploy page
// quotes are lines the scripts print.
import assert from "node:assert/strict";
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
