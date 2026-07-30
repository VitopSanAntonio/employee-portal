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

const PAGES = ['index', 'safety-concern', 'suggestion-form', 'maintenance-request', 'status-check', 'time-off'];

for (const lang of ['en', 'es']) {
  for (const p of PAGES) {
    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/${p}.html`);
    if (lang === 'es') {
      await page.evaluate(() => localStorage.setItem('portalLang', 'es'));
      await page.reload();
    }
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
