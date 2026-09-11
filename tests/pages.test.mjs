// Page-level suite: PWA tag parity, service worker activation, language
// toggle (html lang + option translations), aria wiring, placeholders.
import { startServer, launchBrowser, waitFor, report, ROOT } from './helpers.mjs';
import fs from 'fs';
import path from 'path';

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

// The rollback lever.
//
// These assert the mechanism, never which way the lever is currently set. An
// earlier version pinned the committed value, which meant that flipping the
// lever — the one thing it exists for, done under pressure — failed the build.
// A switch you cannot throw without going red is not a switch.
{
  const page = await browser.newPage();
  await page.goto(`${base}/time-off.html`);
  const visible = () => page.evaluate(() =>
    [...document.querySelectorAll('.grid-cards a')]
      .filter(a => a.offsetParent !== null).map(a => a.getAttribute('href')));
  const isPortal = hs => hs.length === 2 && hs.every(h => h.startsWith('time-off-request.html'));
  const isLegacy = hs => hs.length === 2 && hs.every(h => h.includes('forms.cloud.microsoft'));

  // Whichever way it is set, employees see exactly one set of cards. Both at
  // once, or neither, is the failure worth catching.
  const shipped = await visible();
  check('lever-shows-exactly-one-card-set',
    isPortal(shipped) || isLegacy(shipped),
    `${isLegacy(shipped) ? 'legacy' : 'portal'}: ${shipped.join(' ')}`);

  // Both sets ship in the file either way — that is what makes rolling back
  // one line rather than a rewrite.
  const counts = await page.evaluate(() => ({
    portal: document.querySelectorAll('.when-new a[href^="time-off-request.html"]').length,
    legacy: document.querySelectorAll('.when-legacy a[href*="forms.cloud.microsoft"]').length
  }));
  check('lever-keeps-both-card-sets-in-the-file',
    counts.portal === 2 && counts.legacy === 2, JSON.stringify(counts));

  // And it swaps them, in both directions, from whatever state it shipped in.
  await page.evaluate(() => document.documentElement.classList.add('legacy-timeoff'));
  check('lever-on-shows-microsoft-forms', isLegacy(await visible()));
  await page.evaluate(() => document.documentElement.classList.remove('legacy-timeoff'));
  check('lever-off-shows-portal-page', isPortal(await visible()));
  await page.close();
}

// The portal's "My time off" card deep-links past the request tab.
{
  const page = await browser.newPage();
  await page.route('**/submit/validate', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ found: true, displayName: 'Albiar A.' }) }));
  await page.route('**/submit/timeoff-lookup', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ found: true, displayName: 'Albiar A.', balances: [], requests: [] }) }));
  await page.goto(`${base}/time-off-request.html?tab=mine`);
  await page.fill('#clockNumber', '048213');
  await waitFor(() => page.locator('#gate').isVisible());
  check('tab-param-opens-my-time-off',
    (await page.locator('#tab-mine').getAttribute('aria-selected')) === 'true');
  await page.close();
}

// The page is live now — no preview banner, and indexable like the rest.
{
  const page = await browser.newPage();
  await page.goto(`${base}/time-off-request.html`);
  const robots = await page.evaluate(() =>
    (document.querySelector('meta[name="robots"]') || {}).content || '');
  check('timeoff-page-is-live',
    robots === '' && (await page.locator('.preview-banner').count()) === 0, robots);
  await page.close();
}

// Seasonal styling: on inside each window, off outside, one season at a time,
// and confined to the home page — the forms carry injury reports and medical
// leave.
//
// The calendar is read out of seasonal.js rather than written here. The
// windows are configuration and are meant to move — Halloween's was widened
// the day after it shipped — so hardcoding them would turn an ordinary edit
// into a build failure, which is exactly what the lever test used to do.
// Reading them also buys better coverage: these probes land on each window's
// own edges.
const seasonSrc = fs.readFileSync(path.join(ROOT, 'seasonal.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const seasons = [...seasonSrc.matchAll(
  /\{\s*name:\s*'(\w+)',\s*from:\s*\[\s*(\d+),\s*(\d+)\s*\],\s*to:\s*\[\s*(\d+),\s*(\d+)\s*\],\s*flyers:\s*'([^']+)',\s*flight:\s*(\d+)/g
)].map(m => ({
  name: m[1], from: [+m[2], +m[3]], to: [+m[4], +m[5]], flyers: m[6], flight: +m[7]
}));
if (seasons.length < 2) throw new Error('tests/pages: could not read the calendar out of seasonal.js');

// Day arithmetic via Date, so stepping off either end crosses months correctly.
const probe = (m, d, shift = 0) => {
  const dt = new Date(2026, m, d + shift, 9);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T09:00:00`;
};
const freeze = t => page => page.addInitScript(iso => {
  const Real = Date;
  window.Date = class extends Real {
    constructor(...a) { super(...(a.length ? a : [iso])); }
    static now() { return new Real(iso).getTime(); }
  };
}, t);

// The loop in seasonal.js breaks on the first match, so an overlap would
// silently swallow a season rather than fail. Cheaper to catch here.
{
  const dayOf = ([m, d]) => m * 31 + d;
  const sorted = [...seasons].sort((a, b) => dayOf(a.from) - dayOf(b.from));
  const clash = sorted.find((s, i) => i > 0 && dayOf(s.from) <= dayOf(sorted[i - 1].to));
  check('seasonal-windows-never-overlap', !clash, clash ? clash.name : '');
}

// Every flyer has to clear the screen before seasonal.js deletes the flock.
// Halloween shipped with a flight 3.8s too short and the last bat vanished
// mid-crossing; this reads the real numbers back out of the CSS and the markup
// so the next season cannot repeat it.
for (const s of seasons) {
  let budget;
  if (s.name === 'halloween') {
    const dur = Number((indexSrc.match(/animation:\s*bat-cross\s+([\d.]+)s/) || [])[1]);
    const delays = [...indexSrc.matchAll(/\.season-halloween \.bat-\d \{[^}]*animation-delay:\s*([\d.]+)s/g)]
      .map(m => Number(m[1]));
    budget = dur + Math.max(...delays);
  } else {
    const dur = Number((indexSrc.match(
      new RegExp(`\\.flock-${s.name} \\.flyer \\{ animation: flyer-\\w+ ([\\d.]+)s`)) || [])[1]);
    const from = indexSrc.indexOf(`class="flock flock-${s.name}"`);
    const markup = indexSrc.slice(from, indexSrc.indexOf('</span>\n\n', from));
    const delays = [...markup.matchAll(/--d:([\d.]+)s/g)].map(m => Number(m[1]));
    budget = dur + Math.max(...delays);
  }
  check(`seasonal-flight-outlasts-the-last-flyer-${s.name}`,
    Number.isFinite(budget) && s.flight / 1000 > budget,
    `${s.flight / 1000}s for ${budget}s of flying`);
}

for (const s of seasons) {
  for (const [when, iso, expect] of [
    ['first-day', probe(s.from[0], s.from[1]), true],
    ['last-day', probe(s.to[0], s.to[1]), true],
    ['day-before', probe(s.from[0], s.from[1], -1), false],
    ['day-after', probe(s.to[0], s.to[1], 1), false],
  ]) {
    const page = await browser.newPage();
    await freeze(iso)(page);
    await page.goto(`${base}/index.html`);
    const on = await page.evaluate(n => document.documentElement.classList.contains(n), `season-${s.name}`);
    check(`seasonal-gate-${s.name}-${when}`, on === expect, `${on}`);

    // Two at once would mean two notices and two sets of decoration. Note this
    // is "at most one", not "none but this one": the windows are contiguous, so
    // the day after Halloween ends is the day Thanksgiving correctly begins.
    const applied = await page.evaluate(() =>
      [...document.documentElement.classList].filter(c => c.startsWith('season-')));
    check(`seasonal-only-one-season-${s.name}-${when}`, applied.length <= 1, applied.join(' '));
    await page.close();
  }

  // Details, on the season's own first day.
  const iso = probe(s.from[0], s.from[1]);
  const page = await browser.newPage();
  await freeze(iso)(page);
  await page.goto(`${base}/index.html`);

  check(`seasonal-notice-visible-${s.name}`,
    (await page.locator(`.notice-${s.name}`).isVisible()) === true);

  // Decoration must never sit between a finger and a card, and must never
  // reach a screen reader.
  const inert = await page.evaluate(() =>
    [...document.querySelectorAll('.web, .spider, .bats, .hanger, .flock')].every(el =>
      getComputedStyle(el).pointerEvents === 'none' &&
      (el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"]'))));
  check(`seasonal-decoration-is-inert-and-silent-${s.name}`, inert === true);

  // Every season needs something still. The flyers are removed after one pass
  // and never render at all under prefers-reduced-motion, so a season without
  // a still ornament is blank most of the time — which is what a phone showed
  // us in October. It has to survive a phone, too: hiding the spider below
  // 900px was the other half of that bug.
  const still = s.name === 'halloween' ? '.hero .spider' : `.hero .hanger-${s.name}`;
  check(`seasonal-still-ornament-${s.name}`, (await page.locator(still).isVisible()) === true);
  await page.setViewportSize({ width: 360, height: 780 });
  check(`seasonal-still-ornament-survives-a-phone-${s.name}`,
    (await page.locator(still).isVisible()) === true);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Regression: the flyers used to launch on load, cross the page behind the
  // coming-soon dialog, and be removed before anybody had dismissed it — so
  // the one animation an employee was meant to see was over before they could
  // see it.
  //
  // Asserted through the class rather than by waiting out the flight: the
  // question is whether they are being held, and that is answerable
  // immediately.
  if (await page.locator('#announce').isVisible()) {
    check(`seasonal-flyers-wait-for-a-clear-view-${s.name}`,
      ((await page.locator(s.flyers).getAttribute('class')) || '').indexOf('fly') === -1);
    await page.click('#announce-ok');
  }
  const launched = await waitFor(() => page.locator(`${s.flyers}.fly`).count().then(n => n === 1));
  check(`seasonal-flyers-launch-once-the-view-is-clear-${s.name}`, launched === true);
  await page.close();

}

// Never anywhere but the home page. Asserted against the markup rather than by
// loading each page in each season: seasonal.js is what carries the class, so
// "no other page loads it" covers every page and every season at once, where
// the browser check only ever covered the pages someone remembered to list.
{
  const others = fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.html') && f !== 'index.html')
    .filter(f => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('seasonal.js'));
  check('seasonal-never-on-any-form-page', others.length === 0, others.join(' '));
  check('seasonal-is-on-the-home-page',
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('seasonal.js'));

  // And once for real, so the pair above cannot both pass on a typo.
  const s = seasons[0];
  const form = await browser.newPage();
  await freeze(probe(s.from[0], s.from[1]))(form);
  await form.goto(`${base}/safety-concern.html`);
  const onForm = await form.evaluate(n => document.documentElement.classList.contains(n), `season-${s.name}`);
  check(`seasonal-never-on-safety-form-${s.name}`, onForm === false);
  await form.close();
}

// And then they stop existing: the kiosk stays open all shift, so this is the
// difference between a short entrance and hours of compositing on a machine
// nobody is looking at. Waiting out a flight is expensive, so this runs on the
// shortest one and the rest are covered by the budget check above.
{
  const s = seasons.reduce((a, b) => (b.flight < a.flight ? b : a));
  const page = await browser.newPage();
  await freeze(probe(s.from[0], s.from[1]))(page);
  await page.goto(`${base}/index.html`);
  if (await page.locator('#announce').isVisible()) await page.click('#announce-ok');
  const retired = await waitFor(
    () => page.locator(s.flyers).count().then(n => n === 0),
    { timeout: s.flight + 8000, interval: 500 });
  check(`seasonal-flyers-are-removed-after-one-pass-${s.name}`, retired === true);
  await page.close();
}

// The coming-soon announcement. It is only truthful while employees are still
// being sent to the Microsoft Forms, so it carries its own switch and its own
// expiry — and it has to be dismissible, escapable and readable in both
// languages, because it is the first thing anyone meets.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('#announce:not([hidden])');

  const dialog = page.locator('#announce .announce');
  check('announce-is-a-real-dialog',
    (await dialog.getAttribute('role')) === 'dialog' &&
    (await dialog.getAttribute('aria-modal')) === 'true' &&
    (await dialog.getAttribute('aria-labelledby')) === 'announce-title');

  // Focus must land inside, or a keyboard reader is left on the page behind.
  check('announce-takes-focus',
    await page.evaluate(() => document.querySelector('#announce').contains(document.activeElement)));

  // Both previews ship, and the second one is real rather than a placeholder.
  const shots = await page.evaluate(() =>
    [...document.querySelectorAll('.announce-shot')].map(i => i.complete && i.naturalWidth > 0));
  check('announce-previews-load', shots.length === 2 && shots[0] === true, JSON.stringify(shots));

  await page.locator('.announce-dot').nth(1).click();
  check('announce-dots-switch-the-preview',
    (await page.locator('.announce-shot').nth(1).getAttribute('class')).includes('on'));

  await page.keyboard.press('Escape');
  check('announce-escape-closes', (await page.locator('#announce').isVisible()) === false);

  // Dismissal is remembered, so it does not greet the same person every visit.
  await page.reload();
  await page.waitForTimeout(400);
  check('announce-stays-closed-once-seen',
    (await page.locator('#announce').isVisible()) === false);
  await ctx.close();
}

// It belongs on the landing page and nowhere else — the forms are where people
// go to report an injury, not to read an advert.
{
  const page = await browser.newPage();
  await page.goto(`${base}/safety-concern.html`);
  check('announce-only-on-the-home-page',
    (await page.locator('#announce').count()) === 0);
  await page.close();
}

// The dialog's controls are named only by aria-label, so those labels are the
// whole name for the one reader who depends on them — lang.js learned to
// translate them for this.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('portalLang', 'es'));
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('#announce:not([hidden])');
  check('announce-aria-labels-translate',
    (await page.locator('#announce-close').getAttribute('aria-label')) === 'Cerrar',
    await page.locator('#announce-close').getAttribute('aria-label'));
  check('announce-body-translates',
    (await page.locator('#announce-title').textContent()).includes('se muda al portal'));
  await ctx.close();
}

await browser.close();
server.close();
report(results);
