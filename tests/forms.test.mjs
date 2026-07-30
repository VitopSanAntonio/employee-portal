// Form behavior suite. The submit proxy is always mocked — these tests never
// call the real Worker (and therefore never reach Power Automate).
//  - proxy failure → error banner, form stays, submit button re-enabled
//  - proxy success → success screen; server-returned referenceId preferred,
//    client fallback ID when the flow returns an empty body
//  - access code: 401 clears the stored code, 429 shows the rate-limit copy,
//    a dismissed prompt leaves the form untouched with no banner
//  - photo uploads: non-image or >5MB rejected with a visible error
//  - Spanish mode: failure copy and restored button label are localized
import { startServer, launchBrowser, report } from './helpers.mjs';

const PORT = 4173;
const server = await startServer(PORT);
const browser = await launchBrowser();
const results = [];

// Every request the pages make to the submit proxy, whatever the form key.
const isProxy = u => u.href.includes('portal-submit-proxy') || u.href.includes('/submit/');

// The pages prompt for an employee access code on first submit and remember it.
// Seeding it keeps the submit-path tests focused on the response handling; the
// prompt itself is covered by the dedicated cases below. Seed via an init
// script rather than evaluate+reload so each case still costs one navigation.
function seedStorage(page, entries) {
  return page.addInitScript(items => {
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
  }, entries);
}

const seedAccessCode = page => seedStorage(page, { portalAccessCode: 'TEST-CODE' });

async function fillForm(page, name) {
  if (name === 'safety-concern') {
    await page.selectOption('#location', 'Quality');
    await page.click('label[for="urgLow"]');
    await page.fill('#description', 'Loose guard rail on mezzanine near press 4.');
  } else if (name === 'suggestion-form') {
    await page.selectOption('#department', { index: 1 });
    await page.selectOption('#category', { index: 1 });
    await page.fill('#suggestion', 'Add floor markings near the loading dock for pedestrian safety.');
    await page.click('label[for="anon-yes"]');
  } else if (name === 'maintenance-request') {
    await page.selectOption('#department', { index: 1 });
    await page.fill('#location', 'Press 4, north side');
    await page.selectOption('#issueType', { index: 1 });
    await page.fill('#description', 'Hydraulic leak under the main ram, dripping steadily.');
    await page.click('label[for="p-low"]');
  }
}

const FALLBACK_REF = {
  'safety-concern': /^SAF-\d{6}$/,
  'suggestion-form': /^SUG-\d{6}$/,
  'maintenance-request': /^MNT-\?\?\?\?$/
};

for (const name of ['safety-concern', 'suggestion-form', 'maintenance-request']) {
  for (const mode of ['fail-network', 'fail-500', 'success', 'success-empty']) {
    const page = await browser.newPage();
    await page.route(isProxy, route => {
      if (mode === 'fail-network') return route.abort('failed');
      if (mode === 'fail-500') return route.fulfill({ status: 500, body: 'boom' });
      if (mode === 'success-empty') return route.fulfill({ status: 202, body: '' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ referenceId: 'SRV-0042' }) });
    });
    await seedAccessCode(page);
    await page.goto(`http://localhost:${PORT}/${name}.html`);
    await fillForm(page, name);
    await page.click('#submit-btn');
    await page.waitForTimeout(700);

    const errorShown   = await page.locator('#submit-error.show').isVisible().catch(() => false);
    const successShown = await page.locator('#success-screen').isVisible();
    const btnEnabled   = await page.locator('#submit-btn').isEnabled();
    const refText      = successShown ? (await page.locator('#ref-display').textContent()).trim() : '';

    let pass;
    if (mode === 'success')            pass = successShown && !errorShown && refText === 'SRV-0042';
    else if (mode === 'success-empty') pass = successShown && !errorShown && FALLBACK_REF[name].test(refText);
    else                               pass = errorShown && !successShown && btnEnabled;
    results.push({ page: name, mode, pass, errorShown, successShown, btnEnabled, refText });
    await page.close();
  }
}

// Photo validation on all three forms
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
for (const name of ['safety-concern', 'suggestion-form', 'maintenance-request']) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/${name}.html`);

  await page.setInputFiles('#photo-input', { name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(6 * 1024 * 1024, 1) });
  const errBig  = await page.locator('#photo-error.show').isVisible();
  const nameBig = (await page.locator('#file-name-display').textContent()).trim();

  await page.setInputFiles('#photo-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  const errTxt = await page.locator('#photo-error.show').isVisible();

  await page.setInputFiles('#photo-input', { name: 'ok.png', mimeType: 'image/png', buffer: tinyPng });
  await page.waitForTimeout(300);
  const errOk  = await page.locator('#photo-error.show').isVisible();
  const nameOk = (await page.locator('#file-name-display').textContent()).trim();

  results.push({ page: name, mode: 'photo-validation', pass: errBig && nameBig === '' && errTxt && !errOk && nameOk.includes('ok.png') });
  await page.close();
}

// Spanish-mode failure: banner is visible, offline copy and restored button
// label are both localized.
{
  const page = await browser.newPage();
  await page.route(isProxy, route => route.abort('failed'));
  await seedStorage(page, { portalLang: 'es', portalAccessCode: 'TEST-CODE' });
  await page.goto(`http://localhost:${PORT}/safety-concern.html`);
  await fillForm(page, 'safety-concern');
  await page.click('#submit-btn');
  await page.waitForTimeout(700);
  const shown    = await page.locator('#submit-error.show').isVisible();
  const esBanner = (await page.locator('#submit-error span[data-en]').textContent()).trim();
  const esBtn    = (await page.locator('#btn-text').textContent()).trim();
  results.push({
    page: 'safety-concern', mode: 'fail-es',
    pass: shown && esBanner.startsWith('Sin conexión') && esBtn === 'Enviar reporte de seguridad',
    detail: esBanner.slice(0, 30)
  });
  await page.close();
}

// Access-code handling on the submit path.
for (const [mode, status] of [['bad-code', 401], ['rate-limited', 429]]) {
  const page = await browser.newPage();
  await page.route(isProxy, route => route.fulfill({ status, body: '' }));
  await seedAccessCode(page);
  await page.goto(`http://localhost:${PORT}/safety-concern.html`);
  await fillForm(page, 'safety-concern');
  await page.click('#submit-btn');
  await page.waitForTimeout(700);
  const shown  = await page.locator('#submit-error.show').isVisible();
  const banner = (await page.locator('#submit-error span[data-en]').textContent()).trim();
  const stored = await page.evaluate(() => localStorage.getItem('portalAccessCode'));
  // A rejected code is forgotten so the next attempt re-prompts; a rate limit
  // is not the code's fault, so the stored code survives.
  const pass = mode === 'bad-code'
    ? shown && banner.startsWith('That access code') && stored === null
    : shown && banner.startsWith('Too many submissions') && stored === 'TEST-CODE';
  results.push({ page: 'safety-concern', mode, pass, detail: banner.slice(0, 30) });
  await page.close();
}

// Dismissing the access-code prompt is the one failure that stays silent:
// no banner, no success screen, form still usable, nothing sent.
{
  const page = await browser.newPage();
  let requested = false;
  await page.route(isProxy, route => { requested = true; return route.fulfill({ status: 200, body: '{}' }); });
  page.on('dialog', d => d.dismiss());
  await page.goto(`http://localhost:${PORT}/safety-concern.html`);
  await fillForm(page, 'safety-concern');
  await page.click('#submit-btn');
  await page.waitForTimeout(700);
  const shown      = await page.locator('#submit-error.show').isVisible().catch(() => false);
  const success    = await page.locator('#success-screen').isVisible();
  const btnEnabled = await page.locator('#submit-btn').isEnabled();
  results.push({
    page: 'safety-concern', mode: 'prompt-cancelled',
    pass: !shown && !success && btnEnabled && !requested
  });
  await page.close();
}

// Status lookup goes through the proxy and needs no access code.
for (const [mode, body] of [['status-found', { found: true, status: 'In Progress', timestamp: '2026-03-04' }], ['status-missing', { found: false }]]) {
  const page = await browser.newPage();
  let sentCode = null;
  await page.route(isProxy, route => {
    sentCode = JSON.parse(route.request().postData() || '{}').accessCode ?? null;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  page.on('dialog', d => d.dismiss());
  await page.goto(`http://localhost:${PORT}/status-check.html`);
  await page.fill('#ref-input', 'MNT-0001');
  await page.click('#lookup-btn');
  await page.waitForTimeout(700);
  const resultShown = await page.locator('#result-area').isVisible();
  const nfShown     = await page.locator('#not-found').isVisible();
  const statusText  = resultShown ? (await page.locator('#result-status-text').textContent()).trim() : '';
  const pass = mode === 'status-found'
    ? resultShown && !nfShown && statusText === 'In Progress' && sentCode === null
    : nfShown && !resultShown;
  results.push({ page: 'status-check', mode, pass, detail: statusText });
  await page.close();
}

await browser.close();
server.close();
report(results);
