const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_DIR);
const origin = "http://127.0.0.1:7179";
const results = [];
const requests = [];
const errors = [];
const token = /authorization === "([^"]+)"/.exec(readFileSync("admin\\dev\\serve.ts", "utf8"))[1];
const headers = { authorization: token };

async function main() {
  const groups = await fetch(`${origin}/api/groups`, { headers }).then((r) => r.json());
  assert.equal(groups.groups.length, 26, "demo seeds groups, not legacy projects");
  const legacy = await fetch(`${origin}/api/v2/projects`, { headers }).then((r) => r.json());
  assert.deepEqual(legacy.projects, []);
  const group = groups.groups[0];
  const directory = await fetch(`${origin}/api/groups/directory/${group.groupId}`, { headers });
  assert.equal(directory.status, 200, "seeded demo groups must resolve in the synthetic directory");
  const browser = await chromium.launch({
    executablePath: join(process.env["ProgramFiles(x86)"], "Microsoft\\Edge\\Application\\msedge.exe"),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (url.pathname.startsWith("/api/")) requests.push(url.pathname + url.search);
    });
    async function open(path) {
      await page.goto(`${origin}/api/console-v3#/${path}`);
      await page.locator("#page-title").waitFor();
      await page.waitForLoadState("networkidle");
    }
    async function manual(path) {
      await open(path);
      const input = page.getByLabel("Group", { exact: true }).first();
      await input.selectOption(":manual");
      const text = page.getByLabel("Group", { exact: true }).first();
      await text.pressSequentially(group.groupId, { delay: 5 });
      assert.equal(await text.inputValue(), group.groupId, `${path}: manual GUID entry preserves intermediate characters`);
      await page.waitForTimeout(500);
      assert.ok(requests.some((p) => p.startsWith("/api/v3/chargeback/") && new URL(p, origin).searchParams.get("group") === group.groupId));
      results.push(`${path}: manual group GUID accepted and queried`);
    }
    if (process.argv.includes("--manual")) {
      await manual("overview");
      await manual("chargeback");
      return;
    }
    const nav = [...readFileSync("admin\\ui-v3\\lib\\nav.ts", "utf8").matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
    for (const id of nav) {
      await open(id);
      const body = await page.locator("body").innerText();
      assert.doesNotMatch(body, /Classification|Legacy projects|Project tags/);
      assert.equal(await page.locator('a[href^="#/projects"]').count(), 0, id);
      assert.ok(!body.includes("Page not found"), id);
      results.push(`${id}: loads without removed controls or destinations`);
    }
    await open("groups/new");
    assert.doesNotMatch(await page.locator("body").innerText(), /Classification|Legacy projects|Project tags/);
    results.push("group onboarding: loads without legacy controls");
    for (const path of ["groups", "overview", "budgets", "reconciler", "chargeback", "foundry", "audit?source=telemetry"]) {
      await open(path);
      const link = page.locator('a[href^="#/groups/"]:not([href="#/groups/new"])').first();
      await link.waitFor();
      const target = await link.getAttribute("href");
      await link.click();
      await page.waitForLoadState("networkidle");
      await page.locator("#page-title").waitFor();
      assert.equal(new URL(page.url()).hash, target);
      assert.doesNotMatch(await page.locator("body").innerText(), /project_not_found|Page not found|Classification/);
      await page.getByRole("button", { name: "Save changes", exact: true }).waitFor();
      results.push(`${path}: group link opens editable group detail`);
    }
    await manual("overview");
    await manual("chargeback");
    await open("chargeback");
    const labels = await page.getByRole("tab").allTextContents();
    assert.ok(!labels.includes("Projects"));
    assert.equal(await page.getByRole("radiogroup", { name: "Rank" }).count(), 0);
    for (const label of labels) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      await page.waitForLoadState("networkidle");
      assert.doesNotMatch(await page.locator("body").innerText(), /Classification|Legacy projects|Project tags/);
      assert.equal(await page.locator('a[href^="#/projects"]').count(), 0);
    }
    results.push(`Chargeback: all ${labels.length} group-only breakdown tabs load`);
    for (const path of ["projects", "projects/new", "projects/X", "projects/X/budgets", "projects/X/activity"]) {
      await open(path);
      assert.ok((await page.locator("body").innerText()).includes("no longer managed in the console"));
      await page.getByRole("link", { name: "Go to Groups", exact: true }).click();
      await page.locator("#page-title").filter({ hasText: "Groups" }).waitFor();
      results.push(`${path}: explanation and Groups destination`);
    }
    assert.deepEqual(errors, []);
    assert.ok(!requests.some((p) => /^\/api\/(?:v2\/)?projects/.test(p)));
    assert.ok(!requests.some((p) => p.includes("/classifications")));
    writeFileSync("files\\groups-only\\browser-results.json", JSON.stringify({
      navPages: nav.length, results, pageErrors: errors,
      groupReads: requests.filter((p) => /^\/api\/groups\/[0-9a-f-]{36}$/.test(p)).length,
      legacyReads: requests.filter((p) => /^\/api\/(?:v2\/)?projects/.test(p)),
    }, null, 2));
    console.log(JSON.stringify({ navPages: nav.length, checks: results.length, pageErrors: errors }));
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
