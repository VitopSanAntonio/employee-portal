// axe-core accessibility scan of all six pages, in both languages.
// Fails the build on serious or critical violations.
import { AxeBuilder } from '@axe-core/playwright';
import { startServer, launchBrowser, report } from './helpers.mjs';
import fs from 'fs';

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

// Seasonal styling is date-gated, so a run in any given week would see at most
// one season — and contrast is exactly what a seasonal palette gets wrong.
// Force each one on in turn and scan the home page in both languages. The list
// comes out of seasonal.js so a new season cannot ship unscanned.
const seasonNames = [...fs.readFileSync(new URL('../seasonal.js', import.meta.url), 'utf8')
  .matchAll(/\{\s*name:\s*'(\w+)'/g)].map(m => m[1]);
if (!seasonNames.length) throw new Error('tests/axe: could not read the calendar out of seasonal.js');

for (const season of seasonNames) {
  for (const lang of ['en', 'es']) {
    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/index.html`);
    if (lang === 'es') {
      await page.evaluate(() => localStorage.setItem('portalLang', 'es'));
      await page.reload();
    }
    // Whatever today's season is has already been applied; clear it so the
    // scan sees exactly one.
    await page.evaluate(n => {
      const root = document.documentElement;
      root.className = root.className.replace(/season-\S+/g, '');
      root.classList.add('season-' + n);
    }, season);
    const scan = await new AxeBuilder({ page }).analyze();
    const blocking = scan.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    for (const v of blocking) {
      console.log(`  index [${lang}] season-${season} ${v.id} (${v.impact}): ${v.help}`);
      for (const node of v.nodes.slice(0, 3)) console.log(`    → ${node.target.join(' ')}`);
    }
    results.push({ page: `index (${season})`, lang, pass: blocking.length === 0,
      blocking: blocking.map(v => v.id).join(', ') || '—' });
    await page.close();
  }
}

// The announcement is the first thing on the page and traps focus, so it is
// worth scanning in its own right rather than only behind the backdrop.
for (const lang of ['en', 'es']) {
  const page = await context.newPage();
  if (lang === 'es') await page.addInitScript(() => localStorage.setItem('portalLang', 'es'));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForSelector('#announce:not([hidden])');
  const scan = await new AxeBuilder({ page }).analyze();
  const blocking = scan.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  for (const v of blocking) {
    console.log(`  index [${lang}] announce ${v.id} (${v.impact}): ${v.help}`);
    for (const node of v.nodes.slice(0, 3)) console.log(`    → ${node.target.join(' ')}`);
  }
  results.push({ page: 'index (announce)', lang, pass: blocking.length === 0,
    blocking: blocking.map(v => v.id).join(', ') || '—' });
  await page.close();
}

await browser.close();
server.close();
report(results);
