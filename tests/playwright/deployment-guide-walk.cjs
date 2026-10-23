// Usage: node tests\playwright\deployment-guide-walk.cjs <private-output-dir> <rendered-guide.html> [automation-CDP-endpoint]
// Uses a visible dedicated automation profile; never imports cookies or clicks sign-in/consent.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

async function redactSignIn(page) {
  const safe = new Set([
    'Sign in', 'Pick an account', 'Use another account', 'Next', 'Back', 'Cancel',
    'Email, phone, or Skype', 'No account?', 'Create one!', "Can't access your account?",
    'Sign-in options', 'Terms of use', 'Privacy & cookies', 'Microsoft', 'Learn more',
  ]);
  for (const frame of page.frames()) {
    await frame.evaluate(words => {
      const allow = new Set(words);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement?.closest('script,style')) continue;
        if (node.textContent.trim() && !allow.has(node.textContent.trim())) node.textContent = '[redacted]';
      }
      for (const input of document.querySelectorAll('input')) {
        input.value = '';
        if (!allow.has(input.placeholder)) input.placeholder = '';
      }
      for (const element of document.querySelectorAll('[title],[aria-label]')) {
        element.removeAttribute('title');
        element.removeAttribute('aria-label');
      }
      for (const image of document.querySelectorAll('img,svg,canvas,video')) image.style.visibility = 'hidden';
    }, [...safe]);
  }
}

async function main() {
  const [output, html, endpoint] = process.argv.slice(2);
  if (!output || !html) throw new Error('Supply a private output directory and rendered guide HTML.');
  const out = path.resolve(output);
  fs.mkdirSync(out, { recursive: true });
  const report = { startedUtc: new Date().toISOString(), visibleBrowser: true, steps: [] };
  const browser = endpoint ? await chromium.connectOverCDP(endpoint, { timeout: 15000 }) : null;
  let ctx;
  let page;
  try {
    ctx = browser ? browser.contexts()[0] : await chromium.launchPersistentContext(path.join(out, 'browser-profile'), {
      channel: 'msedge', headless: false, viewport: { width: 1440, height: 1000 }, timeout: 30000,
    });
    // Never navigate an operator's existing tab or close their browser.
    page = await ctx.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const pageErrors = [];
    const onPageError = error => pageErrors.push(error.message);
    page.on('pageerror', onPageError);
    await page.goto(pathToFileURL(path.resolve(html)).href, { timeout: 30000 });
    const checks = await page.evaluate(() => ({
      headings: [...document.querySelectorAll('h2,h3,h4')].map(e => e.textContent),
      brokenImages: [...document.images].filter(e => !e.complete || !e.naturalWidth).map(e => e.getAttribute('src')),
      brokenAnchors: [...document.querySelectorAll('a[href^="#"]')]
        .filter(e => !document.getElementById(decodeURIComponent(e.hash.slice(1)))).map(e => e.hash),
      localLinks: [...document.querySelectorAll('a[href]')].map(e => e.href).filter(href => href.startsWith('file:')),
    }));
    const brokenLinks = checks.localLinks.filter(href => !fs.existsSync(fileURLToPath(href)));
    delete checks.localLinks;
    report.steps.push({ id: 'guide', status: 'read_in_browser', ...checks, brokenLinks, pageErrors });
    page.removeListener('pageerror', onPageError);
    const checklist = page.getByRole('heading', { name: '2. Prerequisites', exact: true });
    await checklist.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'guide-prerequisites-raw.png') });
    const apps = page.getByRole('heading', { name: 'Entra administrator: short Portal checklist', exact: true });
    await apps.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'guide-entra-raw.png') });
    // Follow the guide's first identity prerequisite. No app/resource creation or account selection.
    await page.goto('https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', {
      waitUntil: 'domcontentloaded', timeout: 90000,
    });
    await page.waitForTimeout(20000);
    const host = new URL(page.url()).hostname;
    const signIn = host === 'login.microsoftonline.com' ||
      await page.getByRole('heading', { name: /^(Sign in|Pick an account)$/ }).count() > 0;
    await page.screenshot({ path: path.join(out, 'portal-prerequisite-raw.png') });
    const step = {
      id: 'entra-app-registrations', status: signIn ? 'blocked_sign_in' : 'unverified',
      host, attempted: 'Microsoft Entra ID > App registrations',
      note: signIn ? 'Interactive authentication required; no authenticated Portal blade verified.' :
        'Not a sign-in page, but authenticated blade access has not been asserted.',
    };
    report.steps.push(step);
    // Only publish a neutralized blocker, never an unreviewed authenticated Portal page.
    if (signIn) {
      await redactSignIn(page);
      const images = path.resolve('docs', 'images', 'deployment-walk');
      fs.mkdirSync(images, { recursive: true });
      await page.screenshot({ path: path.join(images, 'portal-sign-in-blocker.png') });
      step.sanitizedScreenshot = 'docs/images/deployment-walk/portal-sign-in-blocker.png';
    }
  } finally {
    fs.writeFileSync(path.join(out, 'browser-walk.json'), JSON.stringify(report, null, 2));
    if (browser) await page?.close();
    else await ctx?.close();
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.steps.some(s => s.brokenImages?.length || s.brokenAnchors?.length ||
    s.brokenLinks?.length || s.pageErrors?.length)) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
