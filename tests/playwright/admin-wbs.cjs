// Live admin console check (deployed lab): an admin names the user-tag field "WBS ID", tags a person, sees the
// saved tag suggested, and the downloaded chargeback CSV carries the "WBS ID" column. Attaches to the signed-in
// Edge window (keepopen.cjs); selects only the operator's own account tile if MSAL shows the account picker.
const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const [cdp, base, outDir, personId, account, label, tag] = process.argv.slice(2);
const report = { startedUtc: new Date().toISOString(), base, label, tag, steps: [] };
const step = (id, data) => { report.steps.push({ id, ...data }); console.log(JSON.stringify({ id, ...data })); };
const MASK = (process.env.MASK_LIST || '').split(',').map((x) => x.trim()).filter(Boolean);
async function mask(page) {
  // The same masking as portal-walk.cjs: GUIDs keep 8 + 4 characters; listed names become <masked>.
  await page.evaluate((list) => {
    const re = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}([0-9a-f]{4})\b/gi;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { let v = n.nodeValue.replace(re, '$1-····-····-····-········$2'); for (const m of list) v = v.split(m).join('<masked>'); if (v !== n.nodeValue) n.nodeValue = v; }
    for (const i of document.querySelectorAll('input')) i.value = i.value.replace(re, '$1-····-····-····-········$2');
  }, MASK).catch(() => {});
}
const shot = async (page, name) => { await mask(page); const f = path.join(outDir, `${name}.png`); await page.screenshot({ path: f, fullPage: false }); return f; };

async function pickAccount(p) {
  if (!p.url().includes('login.microsoftonline.com')) return;
  const tile = p.locator(`[data-test-id="${account}"], div[role="button"]:has-text("${account}"), small:has-text("${account}")`).first();
  if (await tile.isVisible().catch(() => false)) { await tile.click(); step('account-picker', { selected: account }); }
}

async function signedIn(page) {
  for (let i = 0; i < 60; i++) {
    const url = page.url();
    if (url.startsWith(base) && await page.locator('text=Tag field name').first().isVisible().catch(() => false)) return true;
    const button = page.getByRole('button', { name: 'Sign in with Microsoft' });
    if (url.startsWith(base) && await button.isVisible().catch(() => false)) {
      const popup = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
      await button.click();
      step('sign-in-button', { clicked: true });
      const p = await popup;
      if (p) { for (let k = 0; k < 20 && !p.isClosed(); k++) { await pickAccount(p); await p.waitForTimeout(1500); } }
    }
    await pickAccount(page);
    await page.waitForTimeout(1500);
  }
  return false;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}#/user-tags`);
  if (!await signedIn(page)) { step('sign-in', { status: 'blocked_sign_in', url: page.url().slice(0, 80) }); await shot(page, 'admin-00-sign-in'); throw new Error('not signed in'); }
  await page.waitForSelector('text=Tag field name', { timeout: 60000 });
  step('user-tags-page', { status: 'pass' });

  const fieldName = page.getByLabel('Field name');
  await fieldName.fill(label);
  const saveName = page.getByRole('button', { name: 'Save field name' });
  if (await saveName.isEnabled()) { await saveName.click(); await page.waitForSelector('text=Field name saved', { timeout: 30000 }).catch(() => {}); }
  await page.waitForSelector(`h1:has-text("${label}"), h2:has-text("${label}")`, { timeout: 30000 });
  step('field-name-saved', { status: 'pass', heading: label });
  await shot(page, 'admin-01-field-name');

  await page.getByLabel('Person (Entra object ID)').fill(personId);
  await page.waitForSelector(`text=Current ${label}`, { timeout: 30000 });
  const tagInput = page.locator('.form-grid').getByLabel(label);
  await tagInput.fill(tag);
  const saveTag = page.getByRole('button', { name: 'Save tag' });
  if (await saveTag.isEnabled()) { await saveTag.click(); await page.waitForSelector(`text=Tagged ${tag}`, { timeout: 30000 }).catch(() => {}); }
  await page.waitForSelector(`table tr:has-text("${personId.slice(0, 8)}"):has-text("${tag}")`, { timeout: 30000 });
  step('person-tagged', { status: 'pass', personId, tag, shownIn: 'Tagged people table' });
  await shot(page, 'admin-02-person-tagged');

  // A new tag is saved and suggested next time: type its prefix in the filter.
  const filter = page.locator('.filter-bar').getByLabel(label);
  await filter.fill(tag.slice(0, 5));
  const suggestion = page.locator(`[role="option"]:has-text("${tag}"), datalist option[value="${tag}"], li:has-text("${tag}")`).first();
  const suggested = await suggestion.count().then((n) => n > 0).catch(() => false);
  step('tag-suggested', { status: suggested ? 'pass' : 'mismatch', typed: tag.slice(0, 5) });
  await shot(page, 'admin-03-tag-suggested');

  await page.goto(`${base}#/chargeback`);
  await page.waitForSelector('text=Export CSV', { timeout: 60000 });
  await page.getByRole('tab', { name: 'Developers' }).click();
  await page.waitForTimeout(8000);
  await shot(page, 'admin-04-chargeback-developers');
  const tabLabels = await page.getByRole('tab').allInnerTexts();
  step('chargeback-tabs', { status: tabLabels.includes(label) ? 'pass' : 'mismatch', tabs: tabLabels });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('button', { name: 'Export CSV' }).click()]);
  const csvPath = path.join(outDir, download.suggestedFilename());
  await download.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  const header = csv.split(/\r?\n/).find((l) => l && !l.startsWith('#')) ?? '';
  const rowWithTag = csv.split(/\r?\n/).find((l) => l.includes(tag)) ?? null;
  step('csv-export', { status: header.split(',').includes(label) && rowWithTag ? 'pass' : 'mismatch', file: path.basename(csvPath), header, rowWithTag: rowWithTag ? rowWithTag.slice(0, 200) : null });
  fs.writeFileSync(path.join(outDir, 'admin-wbs-report.json'), JSON.stringify(report, null, 2));
  await page.close();
  process.exit(0);
})().catch(async (e) => { report.error = e.message; fs.writeFileSync(path.join(outDir, 'admin-wbs-report.json'), JSON.stringify(report, null, 2)); console.error(e.message); process.exit(1); });
