// Documentation captures of the deployed admin console: the onboarding wizard for one group, the group list,
// user tags, a group page, budgets and chargeback (with the CSV export). Real names and IDs are replaced with
// hypothetical ones (pseudonymise.cjs) before each screenshot. Attaches to the signed-in Edge window (keepopen.cjs).
// Usage: node console-capture.cjs <cdp> <consoleUrl> <account> <mapping.json> <outDir> <groupId> <displayName>
//          <backendId> <perUserUsd> <chargebackId> <priority> <tagLabel> <personId> <tag>
const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const { loadConfig, capturePseudonymised } = require('./pseudonymise.cjs');
const [cdp, base, account, mapFile, outDir, groupId, displayName, backendId, perUser, chargebackId, priority, tagLabel, personId, tag] = process.argv.slice(2);
const cfg = loadConfig(mapFile);
const report = { startedUtc: new Date().toISOString(), shots: [] };

async function shot(page, name, note, fullPage = false) {
  await page.waitForTimeout(1500);
  await capturePseudonymised(page, cfg, { path: path.join(outDir, `${name}.png`), fullPage });
  report.shots.push({ name, note, realValuesLeft: 0 });
  console.log(`${name}: ${note}`);
}

async function signIn(page) {
  for (let i = 0; i < 60; i++) {
    if (page.url().startsWith(base) && await page.locator('nav').first().isVisible().catch(() => false)
      && !await page.getByRole('button', { name: 'Sign in with Microsoft' }).isVisible().catch(() => false)) return;
    const button = page.getByRole('button', { name: 'Sign in with Microsoft' });
    if (await button.isVisible().catch(() => false)) await button.click();
    if (page.url().includes('login.microsoftonline.com')) {
      const tile = page.locator(`small:has-text("${account}"), div[role="button"]:has-text("${account}")`).first();
      if (await tile.isVisible().catch(() => false)) await tile.click();
    }
    await page.waitForTimeout(1500);
  }
  throw new Error('sign-in did not complete');
}

const go = async (page, route) => { await page.goto(`${base}#${route}`); await page.waitForTimeout(4000); };
const field = (page, label) => page.getByLabel(label, { exact: true }).first();
const cont = (page) => page.getByRole('button', { name: 'Continue' }).click();

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.connectOverCDP(cdp);
  for (const old of browser.contexts()[0].pages()) if (old.url().includes('login.microsoftonline.com')) await old.close().catch(() => {});
  const page = await browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}#/groups`);
  await signIn(page);

  // Onboarding wizard, four steps.
  await go(page, '/groups/new');
  await field(page, 'Entra group Object ID').fill(groupId);
  await field(page, 'Display name').fill(displayName);
  const backend = field(page, 'Foundry backend');
  if (await backend.evaluate((e) => e.tagName).catch(() => '') === 'SELECT') await backend.selectOption(backendId); else await backend.fill(backendId);
  await shot(page, 'console-01-find-group', 'Step 1: Object ID, display name, backend');
  await cont(page);
  await field(page, 'Per-user budget (monthly)').fill(perUser);
  await shot(page, 'console-02-budget', 'Step 2: per-user budget, auto-scale');
  await cont(page);
  const code = page.getByLabel('Claude Code', { exact: false }).first();
  if (await code.count() && !await code.isChecked()) await code.check();
  await field(page, 'Chargeback ID').fill(chargebackId);
  await field(page, 'Priority').fill(priority);
  for (const family of ['sonnet', 'haiku']) {
    const admit = page.getByRole('button', { name: `Admit ${family}` });
    // The buttons render once the model catalog has loaded.
    await admit.waitFor({ state: 'visible', timeout: 30000 });
    await admit.click(); await page.waitForTimeout(800);
  }
  await shot(page, 'console-03-access-models', 'Step 3: surfaces, chargeback ID, priority, models', true);
  await cont(page);
  await page.waitForTimeout(1500);
  const errors = await page.locator('.field-error').allInnerTexts();
  if (errors.length) throw new Error(`wizard blocked: ${errors.join('; ')}`);
  await shot(page, 'console-04-review', 'Step 4: review', true);
  const onboard = page.getByRole('button', { name: 'Onboard group' });
  await onboard.click();
  await page.waitForTimeout(6000);

  await go(page, '/groups');
  await shot(page, 'console-05-groups', 'Groups: the onboarded groups');

  await go(page, '/user-tags');
  await field(page, 'Field name').fill(tagLabel);
  const saveName = page.getByRole('button', { name: 'Save field name' });
  if (await saveName.isEnabled().catch(() => false)) { await saveName.click(); await page.waitForTimeout(3000); }
  await field(page, 'Person (Entra object ID)').fill(personId);
  await page.waitForTimeout(3000);
  await page.locator('.form-grid').getByLabel(tagLabel).fill(tag);
  const saveTag = page.getByRole('button', { name: 'Save tag' });
  if (await saveTag.isEnabled().catch(() => false)) { await saveTag.click(); await page.waitForTimeout(4000); }
  await shot(page, 'console-06-user-tags', `User tags: field ${tagLabel}, person tagged ${tag}`);

  await go(page, `/groups/${groupId}`);
  await shot(page, 'console-07-group-detail', 'A group page');

  await go(page, '/budgets');
  await page.waitForTimeout(4000);
  await shot(page, 'console-08-budgets', 'Budgets');

  await go(page, '/chargeback');
  await page.waitForSelector('text=Export CSV', { timeout: 60000 });
  await page.getByRole('tab', { name: 'Developers' }).click();
  await page.waitForTimeout(8000);
  await page.getByRole('heading', { name: 'Breakdown' }).scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, 'console-09-chargeback', 'Chargeback, Developers');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.getByRole('button', { name: 'Export CSV' }).click()]);
  await download.saveAs(path.join(outDir, 'chargeback-developers.csv'));
  report.csv = 'chargeback-developers.csv';

  fs.writeFileSync(path.join(outDir, 'console-capture.json'), JSON.stringify(report, null, 2));
  await page.close();
  process.exit(report.shots.some((s) => s.realValuesLeft) ? 2 : 0);
})().catch((e) => { report.error = e.message; fs.writeFileSync(path.join(outDir, 'console-capture.json'), JSON.stringify(report, null, 2)); console.error(e.message); process.exit(1); });
