// Operator tool for the live budget-guard test: signs in to the deployed admin console in the dedicated Edge
// profile, takes the Authorization header of the console's own API request, and reads or changes one group.
const { chromium } = require('playwright-core');
const [cdp, base, account, op, groupId, perUser, cap] = process.argv.slice(2);
(async () => {
  const browser = await chromium.connectOverCDP(cdp);
  for (const old of browser.contexts()[0].pages()) if (old.url().includes('login.microsoftonline.com')) await old.close().catch(() => {});
  const page = await browser.contexts()[0].newPage();
  let captured = null;
  page.on('request', (r) => { const a = r.headers().authorization; if (a && r.url().includes('/api/') && !captured) captured = a; });
  await page.goto(`${base}#/groups`);
  for (let i = 0; i < 60 && !captured; i++) {
    const button = page.getByRole('button', { name: 'Sign in with Microsoft' });
    if (await button.isVisible().catch(() => false)) {
      const popup = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
      await button.click();
      const p = await popup;
      if (p) for (let k = 0; k < 20 && !p.isClosed(); k++) { const tile = p.locator(`small:has-text("${account}"), div[role="button"]:has-text("${account}")`).first(); if (await tile.isVisible().catch(() => false)) await tile.click(); await p.waitForTimeout(1500); }
    }
    if (page.url().includes('login.microsoftonline.com')) { const tile = page.locator(`small:has-text("${account}"), div[role="button"]:has-text("${account}")`).first(); if (await tile.isVisible().catch(() => false)) await tile.click(); }
    await page.waitForTimeout(1500);
  }
  if (!captured) { console.log(JSON.stringify({ error: 'no console request carried a token' })); process.exit(1); }
  const result = await page.evaluate(async ({ op, groupId, perUser, cap, auth }) => {
    const got = await fetch(`/api/groups/${groupId}`, { headers: { authorization: auth } });
    const etag = got.headers.get('etag');
    const doc = await got.json();
    const g = doc.group ?? doc;
    if (op === 'get') return { status: got.status, budget: g.budget, etag };
    const body = { budget: { mode: 'cap', perUser: { amount: Number(perUser), currency: 'CCU', period: 'monthly' }, groupCap: { amount: Number(cap), currency: 'CCU', period: 'monthly' } } };
    const put = await fetch(`/api/groups/${groupId}`, { method: 'PUT', headers: { authorization: auth, 'content-type': 'application/json', 'if-match': etag }, body: JSON.stringify(body) });
    return { before: g.budget, status: put.status, answer: (await put.text()).slice(0, 300) };
  }, { op, groupId, perUser, cap, auth: captured });
  console.log(JSON.stringify(result));
  await page.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });