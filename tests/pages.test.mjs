// Page-level suite: PWA tag parity, service worker activation, language
// toggle (html lang + option translations), aria wiring, placeholders.
import { startServer, launchBrowser, report } from './helpers.mjs';

const PORT = 4175;
const server = await startServer(PORT);
const base = `http://localhost:${PORT}`;
const browser = await launchBrowser();
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// PWA tags + favicon on all six pages
for (const p of ['index', 'safety-concern', 'suggestion-form', 'maintenance-request', 'status-check', 'time-off']) {
  const page = await browser.newPage();
  await page.goto(`${base}/${p}.html`);
  const manifest = await page.evaluate(() => !!document.querySelector('link[rel="manifest"]'));
  const appleCapable = await page.evaluate(() => !!document.querySelector('meta[name="apple-mobile-web-app-capable"]'));
  const favicon = await page.evaluate(() => !!document.querySelector('link[rel="icon"]'));
  check(`pwa-tags:${p}`, manifest && appleCapable && favicon);
  await page.close();
}

// Service worker registers and activates
{
  const page = await browser.newPage();
  await page.goto(`${base}/index.html`);
  const swActive = await page.evaluate(() =>
    Promise.race([
      navigator.serviceWorker.ready.then(r => !!r.active),
      new Promise(res => setTimeout(() => res(false), 8000))
    ])
  );
  check('service-worker-active', swActive === true);
  await page.close();
}

// Language toggle: html lang + translated options + toggle back
{
  const page = await browser.newPage();
  await page.goto(`${base}/safety-concern.html`);
  const langBefore = await page.evaluate(() => document.documentElement.lang);
  await page.click('#lang-toggle');
  const langAfter = await page.evaluate(() => document.documentElement.lang);
  const molding = (await page.locator('#location option[value="Injection Molding"]').textContent()).trim();
  const flobin  = (await page.locator('#location option[value="Flobin area"]').textContent()).trim();
  check('html-lang-updates', langBefore === 'en' && langAfter === 'es', `${langBefore}→${langAfter}`);
  check('option-translated-es', molding === 'Moldeo por Inyección' && flobin === 'Área de Flobin', molding);
  await page.click('#lang-toggle');
  const moldingEn = (await page.locator('#location option[value="Injection Molding"]').textContent()).trim();
  check('option-back-to-en', moldingEn === 'Injection Molding', moldingEn);
  await page.close();
}

// Suggestion + maintenance: translations, aria wiring, maxlength, placeholders
{
  const page = await browser.newPage();
  await page.goto(`${base}/suggestion-form.html`);
  await page.evaluate(() => localStorage.setItem('portalLang', 'es'));
  await page.reload();
  const it = (await page.locator('#department option[value="IT"]').textContent()).trim();
  check('suggestion-IT-es', it === 'TI', it);
  const anonGrid = await page.locator('#anon-grid').getAttribute('aria-labelledby');
  const anonRole = await page.locator('#anon-grid').getAttribute('role');
  check('anon-radiogroup-named', anonRole === 'radiogroup' && anonGrid === 'anon-label');
  const photoLabelled = await page.locator('#photo-input').getAttribute('aria-labelledby');
  check('suggestion-photo-labelled', photoLabelled === 'photo-label');
  const maxlen = await page.locator('#suggestion').getAttribute('maxlength');
  check('suggestion-maxlength', maxlen === '4000');
  await page.close();

  const m = await browser.newPage();
  await m.goto(`${base}/maintenance-request.html`);
  const prioLabelled = await m.locator('#priority-grid').getAttribute('aria-labelledby');
  const prioAria = await m.locator('#priority-grid').getAttribute('aria-label');
  check('priority-labelledby', prioLabelled === 'priority-label' && prioAria === null);
  const ph = await m.locator('#email').getAttribute('placeholder');
  check('placeholder-domain', ph.includes('smurfitwestrock.com'), ph);
  const photoFor = await m.locator('label[for="photo-input"]').count();
  check('maintenance-photo-label', photoFor === 1);
  const alerts = await m.locator('.field-error[role="alert"]').count();
  check('field-errors-alert', alerts >= 5, `${alerts} alerts`);
  await m.close();
}

await browser.close();
server.close();
report(results);
