// axe-core accessibility scan of all six pages, in both languages.
// Fails the build on serious or critical violations.
import { AxeBuilder } from '@axe-core/playwright';
import { startServer, launchBrowser, report } from './helpers.mjs';

const PORT = 4177;
const server = await startServer(PORT);
const browser = await launchBrowser();
// @axe-core/playwright requires pages created from an explicit context.
const context = await browser.newContext();
const results = [];

const PAGES = ['index', 'safety-concern', 'suggestion-form', 'maintenance-request', 'status-check', 'time-off', 'time-off-request'];

// Most of the time-off page is behind the clock-number gate, so scanning it at
// rest would only cover the badge field. Stub the proxy and open the gate so
// the form and the requests list are actually in the tree when axe runs.
async function prepare(page, name) {
  if (name !== 'time-off-request') return;
  await page.route('**/submit/validate', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ found: true, displayName: 'Albiar A.' })
  }));
  await page.route('**/submit/timeoff-lookup', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      found: true, displayName: 'Albiar A.',
      balances: [{ leaveType: 'Vacation', hours: 64 }],
      requests: [{ referenceId: 'TMO-100001', leaveType: 'Vacation', startDate: '2026-09-15',
                   endDate: '2026-09-17', hours: 24, status: 'Pending' }]
    })
  }));
}

async function reveal(page, name) {
  if (name !== 'time-off-request') return;
  await page.fill('#clockNumber', '048213');
  await page.waitForSelector('#gate.show', { timeout: 5000 });
  await page.click('#tab-mine');
  await page.waitForSelector('#req-list .req-row', { timeout: 5000 });
  await page.click('#tab-request');
}

for (const lang of ['en', 'es']) {
  for (const p of PAGES) {
    const page = await context.newPage();
    await prepare(page, p);
    await page.goto(`http://localhost:${PORT}/${p}.html`);
    if (lang === 'es') {
      await page.evaluate(() => localStorage.setItem('portalLang', 'es'));
      await page.reload();
    }
    await reveal(page, p);
    const scan = await new AxeBuilder({ page }).analyze();
    const blocking = scan.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    for (const v of blocking) {
      console.log(`  ${p} [${lang}] ${v.id} (${v.impact}): ${v.help}`);
      for (const node of v.nodes.slice(0, 3)) console.log(`    → ${node.target.join(' ')}`);
    }
    results.push({ page: p, lang, pass: blocking.length === 0, blocking: blocking.map(v => v.id).join(', ') || '—' });
    await page.close();
  }
}

await browser.close();
server.close();
report(results);
