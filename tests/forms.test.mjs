// Form behavior suite. The submit proxy is always mocked — these tests never
// call the real Worker (and therefore never reach Power Automate).
//  - proxy failure → error banner, form stays, submit button re-enabled
//  - proxy success → success screen; server-returned referenceId preferred,
//    client fallback ID when the flow returns an empty body
//  - access code: nothing prompts while the proxy accepts codeless posts; a
//    401 triggers one prompt and one retry; a second 401 shows the bad-code
//    copy and forgets it; a dismissed prompt leaves the form untouched
//  - rate limit (429) shows its own copy and keeps the stored code
//  - photo uploads: non-image or >5MB rejected with a visible error
//  - Spanish mode: failure copy and restored button label are localized
import { startServer, launchBrowser, report, waitFor } from './helpers.mjs';

const PORT = 4173;
const server = await startServer(PORT);
const browser = await launchBrowser();
const results = [];

// Every request the pages make to the submit proxy, whatever the form key.
const isProxy = u => u.href.includes('portal-submit-proxy') || u.href.includes('/submit/');

// Seed via an init script rather than evaluate+reload so each case still
// costs one navigation (page loads dominate this suite's runtime).
function seedStorage(page, entries) {
  return page.addInitScript(items => {
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
  }, entries);
}

const seedAccessCode = page => seedStorage(page, { portalAccessCode: 'TEST-CODE' });

// Records every prompt the page raises. The access code is off by default —
// the proxy decides — so most cases must not raise one at all.
function watchPrompts(page, { answer = null } = {}) {
  const seen = [];
  page.on('dialog', d => {
    seen.push(d.type());
    return answer === null ? d.dismiss() : d.accept(answer);
  });
  return seen;
}

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
  'maintenance-request': /^MNT-\d{6}$/
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
    // No access code seeded and the proxy never 401s here, so a prompt would
    // be a regression: the code is paused until the Worker asks for it.
    const prompts = watchPrompts(page);
    await page.goto(`http://localhost:${PORT}/${name}.html`);
    await fillForm(page, name);
    await page.click('#submit-btn');
    await waitFor(async () =>
      (await page.locator('#success-screen').isVisible()) ||
      (await page.locator('#submit-error.show').isVisible().catch(() => false)));

    const errorShown   = await page.locator('#submit-error.show').isVisible().catch(() => false);
    const successShown = await page.locator('#success-screen').isVisible();
    const btnEnabled   = await page.locator('#submit-btn').isEnabled();
    const refText      = successShown ? (await page.locator('#ref-display').textContent()).trim() : '';

    let pass;
    if (mode === 'success')            pass = successShown && !errorShown && refText === 'SRV-0042';
    else if (mode === 'success-empty') pass = successShown && !errorShown && FALLBACK_REF[name].test(refText);
    else                               pass = errorShown && !successShown && btnEnabled;
    pass = pass && prompts.length === 0;
    results.push({ page: name, mode, pass, errorShown, successShown, btnEnabled, refText, detail: prompts.length ? `prompted x${prompts.length}` : '' });
    await page.close();
  }
}

// Photo validation on all three forms.
//
// Every rejection is asynchronous now: an accepted photo is decoded into a
// canvas and re-encoded before it counts as attached, so these poll rather than
// reading straight after setInputFiles.
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = n => ({ name: n, mimeType: 'image/png', buffer: tinyPng });

for (const name of ['safety-concern', 'suggestion-form', 'maintenance-request']) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/${name}.html`);

  // Not an image at all.
  await page.setInputFiles('#photo-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await waitFor(() => page.locator('#photo-error.show').isVisible());
  const errTxt  = await page.locator('#photo-error.show').isVisible();
  const nameTxt = (await page.locator('#file-name-display').textContent()).trim();

  // 6 MB of bytes no decoder accepts: compression can't run, so the original
  // base64 is what would be sent and it clears the per-photo cap.
  await page.setInputFiles('#photo-input', { name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(6 * 1024 * 1024, 1) });
  await waitFor(() => page.locator('#photo-error.show').isVisible());
  const errBig  = await page.locator('#photo-error.show').isVisible();
  const nameBig = (await page.locator('#file-name-display').textContent()).trim();

  // A real image is accepted, and accepting one clears the error.
  await page.setInputFiles('#photo-input', png('ok.png'));
  await waitFor(async () => (await page.locator('#file-name-display').textContent()).includes('ok.png'));
  const errOk  = await page.locator('#photo-error.show').isVisible();
  const nameOk = (await page.locator('#file-name-display').textContent()).trim();

  results.push({
    page: name, mode: 'photo-validation',
    pass: errTxt && nameTxt === '' && errBig && nameBig === '' && !errOk && nameOk.includes('ok.png')
  });
  await page.close();
}

// Maintenance takes three photos. Four at once must attach three and say why,
// removing one must free a slot, and the payload must carry exactly what is on
// screen — the flow builds its email attachments straight off this array.
{
  const page = await browser.newPage();
  let sent = null;
  await page.route(isProxy, route => {
    sent = JSON.parse(route.request().postData() || '{}');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ referenceId: 'MNT-0042' }) });
  });
  await page.goto(`http://localhost:${PORT}/maintenance-request.html`);

  await page.setInputFiles('#photo-input', ['a', 'b', 'c', 'd'].map(n => png(`${n}.png`)));
  await waitFor(async () => (await page.locator('#photo-previews figure').count()) === 3);
  const capped   = await page.locator('#photo-previews figure').count();
  const overErr  = (await page.locator('#photo-error').textContent()).trim();
  // The fourth is refused, not silently swapped in for one of the first three.
  const kept     = (await page.locator('#file-name-display').textContent()).trim();

  // Every thumbnail carries its own remove control, and using one frees a slot.
  await page.locator('#photo-previews .photo-remove').first().click();
  await waitFor(async () => (await page.locator('#photo-previews figure').count()) === 2);
  const afterRemove = await page.locator('#photo-previews figure').count();
  const errCleared  = !(await page.locator('#photo-error.show').isVisible());

  await fillForm(page, 'maintenance-request');
  await page.click('#submit-btn');
  await waitFor(() => page.locator('#success-screen').isVisible());

  const photos = (sent && sent.photos) || [];
  results.push({
    page: 'maintenance-request', mode: 'three-photos',
    pass: capped === 3 && overErr.includes('up to 3') && kept.startsWith('✓ 3/3')
          && afterRemove === 2 && errCleared
          && photos.length === 2
          && photos.every(p => typeof p.name === 'string' && typeof p.base64 === 'string' && p.base64.length > 0),
    detail: `${capped} kept, ${photos.length} sent`
  });
  await page.close();
}

// Resizing three phone photos takes long enough that a second tap used to
// start a second submission of the same request.
{
  const page = await browser.newPage();
  let posts = 0;
  await page.route(isProxy, async route => {
    posts += 1;
    await new Promise(r => setTimeout(r, 400));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ referenceId: 'MNT-0042' }) });
  });
  await page.goto(`http://localhost:${PORT}/maintenance-request.html`);
  await fillForm(page, 'maintenance-request');
  await page.setInputFiles('#photo-input', png('a.png'));
  await waitFor(async () => (await page.locator('#photo-previews figure').count()) === 1);
  // force: the button is expected to be disabled by the first click — that is
  // the whole point — and a normal click would wait for it to come back.
  await page.click('#submit-btn');
  await page.click('#submit-btn', { force: true }).catch(() => {});
  await waitFor(() => page.locator('#success-screen').isVisible());
  results.push({ page: 'maintenance-request', mode: 'no-double-submit', pass: posts === 1, detail: `${posts} posts` });
  await page.close();
}

// Spanish-mode failure: banner is visible, offline copy and restored button
// label are both localized.
{
  const page = await browser.newPage();
  await page.route(isProxy, route => route.abort('failed'));
  await seedStorage(page, { portalLang: 'es' });
  await page.goto(`http://localhost:${PORT}/safety-concern.html`);
  await fillForm(page, 'safety-concern');
  await page.click('#submit-btn');
  await waitFor(() => page.locator('#submit-error.show').isVisible());
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

// A rate limit is not the code's fault, so a stored code survives it.
{
  const page = await browser.newPage();
  await page.route(isProxy, route => route.fulfill({ status: 429, body: '' }));
  await seedAccessCode(page);
  await page.goto(`http://localhost:${PORT}/safety-concern.html`);
  await fillForm(page, 'safety-concern');
  await page.click('#submit-btn');
  await waitFor(() => page.locator('#submit-error.show').isVisible());
  const shown  = await page.locator('#submit-error.show').isVisible();
  const banner = (await page.locator('#submit-error span[data-en]').textContent()).trim();
  const stored = await page.evaluate(() => localStorage.getItem('portalAccessCode'));
  results.push({
    page: 'safety-concern', mode: 'rate-limited',
    pass: shown && banner.startsWith('Too many submissions') && stored === 'TEST-CODE',
    detail: banner.slice(0, 30)
  });
  await page.close();
}

// Turning the code on is a Worker-side change: the page finds out because the
// proxy starts answering 401. First attempt carries no code, the prompt
// follows, and the retry carries it. Nothing reaches the flow until it passes.
{
  const page = await browser.newPage();
  const sent = [];
  await page.route(isProxy, route => {
    const code = JSON.parse(route.request().postData() || '{}').accessCode ?? null;
    sent.push(code);
    return code === 'GIVEN-CODE'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ referenceId: 'SRV-0042' }) })
      : route.fulfill({ status: 401, body: '' });
  });
  const prompts = watchPrompts(page, { answer: 'GIVEN-CODE' });
  await page.goto(`http://localhost:${PORT}/safety-concern.html`);
  await fillForm(page, 'safety-concern');
  await page.click('#submit-btn');
  await waitFor(() => page.locator('#success-screen').isVisible());
  const success = await page.locator('#success-screen').isVisible();
  const refText = success ? (await page.locator('#ref-display').textContent()).trim() : '';
  const stored  = await page.evaluate(() => localStorage.getItem('portalAccessCode'));
  results.push({
    page: 'safety-concern', mode: 'code-required-then-given',
    pass: success && refText === 'SRV-0042' && prompts.length === 1
          && sent.length === 2 && sent[0] === null && sent[1] === 'GIVEN-CODE'
          && stored === 'GIVEN-CODE',
    detail: JSON.stringify(sent)
  });
  await page.close();
}

// A code that is wrong twice stops at one retry, shows the bad-code copy, and
// is forgotten so the next attempt starts clean.
{
  const page = await browser.newPage();
  let requests = 0;
  await page.route(isProxy, route => { requests += 1; return route.fulfill({ status: 401, body: '' }); });
  const prompts = watchPrompts(page, { answer: 'WRONG-CODE' });
  await page.goto(`http://localhost:${PORT}/safety-concern.html`);
  await fillForm(page, 'safety-concern');
  await page.click('#submit-btn');
  await waitFor(() => page.locator('#submit-error.show').isVisible());
  const shown  = await page.locator('#submit-error.show').isVisible();
  const banner = (await page.locator('#submit-error span[data-en]').textContent()).trim();
  const stored = await page.evaluate(() => localStorage.getItem('portalAccessCode'));
  results.push({
    page: 'safety-concern', mode: 'code-wrong-twice',
    pass: shown && banner.startsWith('That access code') && stored === null
          && requests === 2 && prompts.length === 1,
    detail: `${requests} posts, ${prompts.length} prompts`
  });
  await page.close();
}

// Dismissing the prompt is the one failure that stays silent: no banner, no
// success screen, form still usable, and nothing sent after the 401.
{
  const page = await browser.newPage();
  let requests = 0;
  await page.route(isProxy, route => { requests += 1; return route.fulfill({ status: 401, body: '' }); });
  const prompts = watchPrompts(page);
  await page.goto(`http://localhost:${PORT}/safety-concern.html`);
  await fillForm(page, 'safety-concern');
  await page.click('#submit-btn');
  await waitFor(() => requests >= 1);
  await waitFor(() => page.locator('#submit-btn').isEnabled());
  const shown      = await page.locator('#submit-error.show').isVisible().catch(() => false);
  const success    = await page.locator('#success-screen').isVisible();
  const btnEnabled = await page.locator('#submit-btn').isEnabled();
  results.push({
    page: 'safety-concern', mode: 'prompt-cancelled',
    pass: !shown && !success && btnEnabled && requests === 1 && prompts.length === 1
  });
  await page.close();
}

// A lookup that never completes must NOT be reported as "reference not found":
// telling someone with a valid number that it doesn't exist sends them off to
// re-check a number that was right all along.
for (const [mode, fail] of [['lookup-offline', r => r.abort('failed')], ['lookup-5xx', r => r.fulfill({ status: 502, body: 'boom' })]]) {
  const page = await browser.newPage();
  await page.route(isProxy, fail);
  await page.goto(`http://localhost:${PORT}/status-check.html`);
  await page.fill('#ref-input', 'MNT-0001');
  await page.click('#lookup-btn');
  await waitFor(() => page.locator('#lookup-failed').isVisible());
  const failShown = await page.locator('#lookup-failed').isVisible();
  const nfShown   = await page.locator('#not-found').isVisible();
  const btnBack   = await page.locator('#lookup-btn').isEnabled();
  results.push({ page: 'status-check', mode, pass: failShown && !nfShown && btnBack });
  await page.close();
}

// Holding Enter used to fire one lookup per keypress, so results could paint
// out of order and show one reference's number beside another's status.
{
  const page = await browser.newPage();
  let inflight = 0, peak = 0;
  await page.route(isProxy, async route => {
    inflight++; peak = Math.max(peak, inflight);
    await new Promise(r => setTimeout(r, 300));
    inflight--;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ found: true, status: 'Open' }) });
  });
  await page.goto(`http://localhost:${PORT}/status-check.html`);
  await page.fill('#ref-input', 'MNT-0001');
  for (let i = 0; i < 4; i++) await page.press('#ref-input', 'Enter');
  await waitFor(() => page.locator('#result-area').isVisible());
  results.push({ page: 'status-check', mode: 'no-concurrent-lookups', pass: peak === 1, detail: `peak ${peak}` });
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
  await waitFor(async () =>
    (await page.locator('#result-area').isVisible()) ||
    (await page.locator('#not-found').isVisible()) ||
    (await page.locator('#lookup-failed').isVisible()));
  const resultShown = await page.locator('#result-area').isVisible();
  const nfShown     = await page.locator('#not-found').isVisible();
  const statusText  = resultShown ? (await page.locator('#result-status-text').textContent()).trim() : '';
  const pass = mode === 'status-found'
    ? resultShown && !nfShown && statusText === 'In Progress' && sentCode === null
    : nfShown && !resultShown;
  results.push({ page: 'status-check', mode, pass, detail: statusText });
  await page.close();
}

// An anonymous suggestion must not leave a focusable "Your email" box behind:
// height alone hid it visually while keyboard and screen-reader users still
// tabbed straight into it.
{
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/suggestion-form.html`);
  await page.click('label[for="anon-yes"]');
  await page.waitForTimeout(450);   // the collapse transition owns visibility
  const focusable = await page.evaluate(() => {
    const input = document.getElementById('email');
    input.focus();
    return document.activeElement === input;
  });
  results.push({ page: 'suggestion-form', mode: 'anon-hides-email-from-tab-order', pass: !focusable });
  await page.close();
}

// Blocked site data must not take out translation *and* the service worker.
{
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('denied', 'SecurityError'); }
    });
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/time-off.html`);
  // Raced against a timer: if registration is broken again, this must fail the
  // assertion rather than hang the whole suite on a promise that never settles.
  const swOk = await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(() => true).catch(() => false),
    new Promise(res => setTimeout(() => res(false), 8000))
  ]));
  const translated = await page.locator('h1[data-en="Time off"]').isVisible();
  results.push({
    page: 'time-off', mode: 'storage-denied-still-works',
    pass: swOk && translated && errors.length === 0,
    detail: errors.slice(0, 1).join('') || 'no page errors'
  });
  await page.close();
}

// The URL employees actually open is the directory, not index.html — it has to
// be in the cache or the installed PWA cannot start offline.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cached = await waitFor(async () => page.evaluate(async () => {
    const c = await caches.open('portal-v4');
    const paths = (await c.keys()).map(r => new URL(r.url).pathname);
    return paths.includes('/') && paths.includes('/index.html');
  }));
  results.push({ page: 'sw', mode: 'caches-directory-root', pass: cached === true });
  await ctx.close();
}

await browser.close();
server.close();
report(results);
