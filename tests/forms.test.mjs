// Form behavior suite. The Power Automate webhook is always mocked — these
// tests never call the real endpoints.
//  - webhook failure → error banner, form stays, submit button re-enabled
//  - webhook success → success screen; server-returned referenceId preferred,
//    client fallback ID when the flow returns an empty body
//  - photo uploads: non-image or >5MB rejected with a visible error
//  - Spanish mode: failure copy and restored button label are localized
import { startServer, launchBrowser, report } from './helpers.mjs';

const PORT = 4173;
const server = await startServer(PORT);
const browser = await launchBrowser();
const results = [];

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
    await page.route(u => u.href.includes('powerplatform'), route => {
      if (mode === 'fail-network') return route.abort('failed');
      if (mode === 'fail-500') return route.fulfill({ status: 500, body: 'boom' });
      if (mode === 'success-empty') return route.fulfill({ status: 202, body: '' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ referenceId: 'SRV-0042' }) });
    });
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

// Spanish-mode failure: banner text and restored button label must be Spanish
{
  const page = await browser.newPage();
  await page.route(u => u.href.includes('powerplatform'), route => route.abort('failed'));
  await page.goto(`http://localhost:${PORT}/safety-concern.html`);
  await page.evaluate(() => localStorage.setItem('portalLang', 'es'));
  await page.reload();
  await fillForm(page, 'safety-concern');
  await page.click('#submit-btn');
  await page.waitForTimeout(700);
  const esBanner = (await page.locator('#submit-error span[data-en]').textContent()).trim();
  const esBtn    = (await page.locator('#btn-text').textContent()).trim();
  results.push({ page: 'safety-concern', mode: 'fail-es', pass: esBanner.startsWith('No se pudo') && esBtn === 'Enviar reporte de seguridad' });
  await page.close();
}

await browser.close();
server.close();
report(results);
