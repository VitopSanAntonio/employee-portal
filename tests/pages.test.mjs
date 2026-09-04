// Page-level suite: PWA tag parity, service worker activation, language
// toggle (html lang + option translations), aria wiring, placeholders.
import { startServer, launchBrowser, waitFor, report } from './helpers.mjs';

const PORT = 4175;
const server = await startServer(PORT);
const base = `http://localhost:${PORT}`;
const browser = await launchBrowser();
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// PWA tags + favicon on all six pages
for (const p of ['index', 'safety-concern', 'suggestion-form', 'maintenance-request', 'status-check', 'time-off', 'time-off-request']) {
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

// Time off (preview): the clock-number gate.
//
// The whole point of this page is that nothing is submittable until the number
// is checked against the roster, so that is what is worth pinning down. The
// proxy is stubbed — these tests must never reach the real Worker.
{
  const page = await browser.newPage();

  let validateCalls = 0;
  await page.route('**/submit/validate', async route => {
    validateCalls++;
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.clockNumber === '048213') {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ found: true, displayName: 'Albiar A.' }) });
    } else {
      await route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ found: false }) });
    }
  });
  await page.route('**/submit/timeoff-lookup', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      found: true, displayName: 'Albiar A.',
      balances: [{ leaveType: 'Vacation', hours: 64 }],
      requests: [{ referenceId: 'TMO-100001', leaveType: 'Vacation', startDate: '2026-09-15',
                   endDate: '2026-09-17', hours: 24, status: 'Pending' }]
    })
  }));

  await page.goto(`${base}/time-off-request.html`);

  // Unlinked from the portal until go-live, and marked noindex on top of that.
  const noindex = await page.evaluate(() =>
    (document.querySelector('meta[name="robots"]') || {}).content || '');
  check('timeoff-preview-noindex', noindex.includes('noindex'), noindex);

  const gateHiddenAtRest = await page.locator('#gate').isVisible();
  check('timeoff-form-hidden-before-validation', gateHiddenAtRest === false);

  // Non-digits never reach the input: the flow interpolates this value into an
  // OData filter, where an apostrophe changes the query rather than failing.
  await page.fill('#clockNumber', "04'82;13");
  check('timeoff-clock-input-digits-only',
    (await page.inputValue('#clockNumber')) === '048213',
    await page.inputValue('#clockNumber'));

  await waitFor(() => page.locator('#gate').isVisible());
  check('timeoff-valid-number-reveals-form', await page.locator('#gate').isVisible());
  check('timeoff-welcomes-by-name',
    (await page.locator('#welcome-name').textContent()).includes('Albiar A.'),
    await page.locator('#welcome-name').textContent());

  // Changing the number has to re-close the gate — otherwise a request could
  // be filed under a name that is no longer the one in the box.
  await page.fill('#clockNumber', '111111');
  await waitFor(async () => await page.locator('#id-bad').isVisible());
  check('timeoff-unknown-number-hides-form',
    (await page.locator('#gate').isVisible()) === false &&
    (await page.locator('#id-bad').isVisible()) === true);

  // Plain English, never a status code or an error object.
  const badText = (await page.locator('#id-bad').textContent()).trim();
  check('timeoff-unknown-number-message-is-plain',
    badText.includes('Number not recognized') && !/\d{3}/.test(badText), badText);

  await page.fill('#clockNumber', '048213');
  await waitFor(() => page.locator('#gate').isVisible());

  // The second tab loads balance and requests off the same number.
  await page.click('#tab-mine');
  await waitFor(() => page.locator('#req-list .req-row').count().then(n => n > 0));
  check('timeoff-mine-tab-lists-requests',
    (await page.locator('#req-list .req-row').count()) === 1 &&
    (await page.locator('#balance-grid .balance-card').count()) === 1);
  check('timeoff-request-row-shows-status',
    (await page.locator('#req-list .status-pill').textContent()).includes('Pending'));

  check('timeoff-validate-was-stubbed', validateCalls > 0, `${validateCalls} calls`);

  // Nothing about the employee may outlive the tab: the floor kiosk is shared.
  const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  check('timeoff-clock-number-not-persisted', !stored.includes('048213'), stored);

  // "Where do I find this?" shows a photo of a real card with the number
  // boxed. It has to actually load — a broken image here answers nothing.
  await page.click('#help-toggle');
  const photo = page.locator('.help-photo');
  // Polled, not asserted immediately: the photo is loading="lazy", so the
  // fetch only starts when the box is opened. Checking `complete` on the same
  // tick as the click tests the click, not the image.
  const photoLoaded = await waitFor(() =>
    photo.evaluate(img => img.complete && img.naturalWidth > 0));
  check('timeoff-card-photo-loads', (await photo.isVisible()) && photoLoaded === true);
  check('timeoff-help-toggle-is-expanded',
    (await page.locator('#help-toggle').getAttribute('aria-expanded')) === 'true');

  // The photo carries meaning, so its alt has to switch languages with
  // everything else — lang.js only learned about alt for this.
  const altEn = await photo.getAttribute('alt');
  await page.click('#lang-toggle');
  const altEs = await photo.getAttribute('alt');
  check('timeoff-card-photo-alt-is-bilingual',
    altEn.includes('bottom-right') && altEs.includes('esquina inferior derecha'),
    `${altEn} / ${altEs}`);

  await page.close();
}

await browser.close();
server.close();
report(results);
