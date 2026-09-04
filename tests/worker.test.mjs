// Submission proxy suite. Runs worker/index.js directly against Node's own
// Request/Response — no Cloudflare runtime and no network: the upstream
// fetch to Power Automate is stubbed, so this never reaches a real flow.
//
// The Worker is the only server-side code in the repo and the only thing
// standing between a stranger with curl and a row in SharePoint, so the
// rules it enforces are worth pinning down.
import worker from '../worker/index.js';
import { report } from './helpers.mjs';

const ORIGIN = 'https://vitopsanantonio.github.io';
const ENV = {
  FLOW_SAFETY: 'https://flow.example/safety',
  FLOW_SUGGESTION: 'https://flow.example/suggestion',
  FLOW_MAINTENANCE: 'https://flow.example/maintenance',
  FLOW_STATUS: 'https://flow.example/status',
  VALIDATE_FLOW_URL: 'https://flow.example/validate',
  VALIDATE_SECRET: 'validate-shared-secret',
  TIMEOFF_FLOW_URL: 'https://flow.example/timeoff',
  TIMEOFF_LOOKUP_FLOW_URL: 'https://flow.example/timeoff-lookup',
  TIMEOFF_CANCEL_FLOW_URL: 'https://flow.example/timeoff-cancel',
  TIMEOFF_SECRET: 'timeoff-shared-secret',
  ACCESS_CODE: 'TEST-CODE',
};

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// Captures what would have gone to Power Automate.
let forwarded = null;
let calls = [];
let upstreamReply = () => new Response('{}', { status: 200 });
globalThis.fetch = async (url, init) => {
  const call = { url, headers: init.headers || {}, body: JSON.parse(init.body) };
  calls.push(call);
  forwarded = call;
  return upstreamReply(url, init);
};

// Each call gets its own IP unless one is pinned, so the rate limiter (6 per
// IP per minute) doesn't start rejecting unrelated cases partway through.
let ipCounter = 0;

function post(formKey, payload, { origin = ORIGIN, ip = `10.0.${++ipCounter >> 8}.${ipCounter & 255}` } = {}) {
  forwarded = null;
  calls = [];
  return worker.fetch(new Request(`https://proxy.example/submit/${formKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip },
    body: JSON.stringify(payload),
  }), ENV, {});
}

const VALID_SAFETY = {
  location: 'Quality',
  urgency: 'Low — No immediate danger',
  description: 'Loose guard rail on the mezzanine near press 4.',
};

// ── CORS / origin ────────────────────────────────────────────
{
  const res = await post('safety', VALID_SAFETY);
  check('allowed-origin-accepted', res.status === 200 &&
    res.headers.get('Access-Control-Allow-Origin') === ORIGIN, `${res.status}`);

  const bad = await post('safety', VALID_SAFETY, { origin: 'https://evil.example' });
  check('foreign-origin-rejected', bad.status === 403, `${bad.status}`);

  // The live portal's own origin must be in the allowlist, or every browser
  // submission fails preflight while curl (which sends no Origin) still works.
  const preflight = await worker.fetch(new Request('https://proxy.example/submit/safety', {
    method: 'OPTIONS', headers: { Origin: ORIGIN },
  }), ENV, {});
  check('preflight-allows-portal-origin',
    preflight.status === 204 && preflight.headers.get('Access-Control-Allow-Origin') === ORIGIN,
    preflight.headers.get('Access-Control-Allow-Origin'));
}

// ── Validation ───────────────────────────────────────────────
{
  const missing = await post('safety', { location: 'Quality', urgency: 'Low' });
  check('missing-required-rejected', missing.status === 400 &&
    (await missing.clone().json()).error === 'missing_description');

  const short = await post('safety', { ...VALID_SAFETY, description: 'too short' });
  check('below-min-length-rejected', short.status === 400 &&
    (await short.clone().json()).error === 'too_short_description');

  // Whitespace is not content: a field of spaces must not satisfy a minimum.
  const blank = await post('safety', { ...VALID_SAFETY, description: ' '.repeat(50) });
  check('whitespace-only-rejected', blank.status === 400 &&
    (await blank.clone().json()).error === 'too_short_description');

  const long = await post('safety', { ...VALID_SAFETY, description: 'x'.repeat(5000) });
  check('over-max-length-rejected', long.status === 400 &&
    (await long.clone().json()).error === 'too_long_description');

  const wrongType = await post('safety', { ...VALID_SAFETY, location: { $ne: null } });
  check('non-string-rejected', wrongType.status === 400 &&
    (await wrongType.clone().json()).error === 'invalid_location');

  // Undeclared keys are dropped, so a direct POST cannot invent columns.
  await post('safety', { ...VALID_SAFETY, isApproved: 'yes', salary: '999999' });
  check('unknown-keys-dropped',
    forwarded && !('isApproved' in forwarded.body) && !('salary' in forwarded.body),
    Object.keys(forwarded?.body || {}).join(','));
}

// ── Spreadsheet formula injection ────────────────────────────
{
  await post('safety', { ...VALID_SAFETY, description: '=HYPERLINK("http://evil","click me now")' });
  check('formula-prefixed', forwarded.body.description.startsWith("'="), forwarded.body.description.slice(0, 12));

  await post('safety', { ...VALID_SAFETY, description: '\tSUM(A1:A9) and more text here' });
  check('tab-lead-prefixed', forwarded.body.description.startsWith("'\t"));

  // Base64 image bytes must not be prefixed — that would corrupt the photo.
  await post('safety', { ...VALID_SAFETY, photo: '+abc123', photoName: 'x.jpg' });
  check('photo-not-prefixed', forwarded.body.photo === '+abc123', forwarded.body.photo);
}

// ── Photos ───────────────────────────────────────────────────
{
  const VALID_MAINT = {
    department: 'Facility', location: 'Press 4', issueType: 'Air compressor 1 (AC-01)',
    description: 'Hydraulic leak under the main ram.', priority: 'Low',
  };
  const photo = (name, b64 = 'aGVsbG8=') => ({ name, base64: b64 });

  await post('maintenance', { ...VALID_MAINT, photos: [photo('a.jpg'), photo('b.jpg'), photo('c.jpg')] });
  check('three-photos-forwarded', forwarded.body.photos.length === 3 &&
    forwarded.body.photos[2].name === 'c.jpg', `${forwarded.body.photos.length}`);
  check('photo-count-forwarded', forwarded.body.photoCount === 3, `${forwarded.body.photoCount}`);

  // The migration shim: a flow still reading the old single-photo fields keeps
  // receiving photo #1 unchanged.
  check('legacy-photo-fields-derived',
    forwarded.body.photo === 'aGVsbG8=' && forwarded.body.photoName === 'a.jpg',
    forwarded.body.photoName);

  const four = await post('maintenance', { ...VALID_MAINT, photos: [photo('a.jpg'), photo('b.jpg'), photo('c.jpg'), photo('d.jpg')] });
  check('fourth-photo-rejected', four.status === 400 &&
    (await four.clone().json()).error === 'too_many_photos', `${four.status}`);

  // Power Automate's base64ToBinary() does not reject malformed input — it
  // produces an attachment that will not open. Catch it here instead.
  const junk = await post('maintenance', { ...VALID_MAINT, photos: [photo('a.jpg', 'not valid base64!!')] });
  check('non-base64-rejected', junk.status === 400 &&
    (await junk.clone().json()).error === 'invalid_photos_base64', `${junk.status}`);

  const nameless = await post('maintenance', { ...VALID_MAINT, photos: [{ base64: 'aGVsbG8=' }] });
  check('photo-without-name-rejected', nameless.status === 400 &&
    (await nameless.clone().json()).error === 'missing_photos_name', `${nameless.status}`);

  const notArray = await post('maintenance', { ...VALID_MAINT, photos: 'aGVsbG8=' });
  check('photos-must-be-an-array', notArray.status === 400 &&
    (await notArray.clone().json()).error === 'invalid_photos', `${notArray.status}`);

  // Three photos that each clear the per-photo cap can still be too much
  // together for the notification email.
  // Each is under the 7 MB per-photo cap but the three together clear the
  // 12 MB combined cap — while the whole body stays under maxBodyBytes, so this
  // is a validation failure and not a 413.
  const heavy = 'A'.repeat(4_200_000);
  const tooBig = await post('maintenance', { ...VALID_MAINT, photos: [photo('a.jpg', heavy), photo('b.jpg', heavy), photo('c.jpg', heavy)] });
  check('combined-photo-size-capped', tooBig.status === 400 &&
    (await tooBig.clone().json()).error === 'too_large_photos', `${tooBig.status}`);

  // Filenames land in a cell like any other text, so they get the formula
  // guard; the image bytes beside them must not be touched.
  await post('maintenance', { ...VALID_MAINT, photos: [photo('=cmd|calc.jpg', '+bm90ZQ=')] });
  check('photo-name-sanitized-bytes-not',
    forwarded.body.photos[0].name.startsWith("'=") && forwarded.body.photos[0].base64 === '+bm90ZQ=',
    forwarded.body.photos[0].name);

  // No photos at all is the common case and must stay valid.
  const none = await post('maintenance', VALID_MAINT);
  check('photos-optional', none.status === 200 && !('photos' in forwarded.body), `${none.status}`);
}

// ── Concern type (safety vs food safety) ─────────────────────
{
  await post('safety', { ...VALID_SAFETY, concernType: 'Food safety',
    foodCategory: 'Pest activity' });
  check('food-safety-fields-forwarded',
    forwarded.body.concernType === 'Food safety' &&
    forwarded.body.foodCategory === 'Pest activity',
    forwarded.body.foodCategory);

  // A page cached before this field existed must never have a safety report
  // rejected for omitting it.
  const legacy = await post('safety', VALID_SAFETY);
  check('concern-type-optional', legacy.status === 200 && !('concernType' in forwarded.body),
    `${legacy.status}`);

  const longType = await post('safety', { ...VALID_SAFETY, concernType: 'x'.repeat(41) });
  check('concern-type-length-capped', longType.status === 400 &&
    (await longType.clone().json()).error === 'too_long_concernType', `${longType.status}`);

  // Every new field lands in a cell like any other text.
  await post('safety', { ...VALID_SAFETY, concernType: 'Food safety', foodCategory: '=cmd|calc' });
  check('food-category-sanitized', forwarded.body.foodCategory.startsWith("'="),
    forwarded.body.foodCategory);

  // Dropped rather than forwarded, so a stale page still submits successfully.
  const stale = await post('safety', { ...VALID_SAFETY, reporterName: 'A. Operator' });
  check('removed-field-dropped-not-rejected',
    stale.status === 200 && !('reporterName' in forwarded.body), `${stale.status}`);
}

// ── Anonymity ────────────────────────────────────────────────
{
  const base = { department: 'Quality', category: 'Safety', suggestion: 'x'.repeat(30) };
  await post('suggestion', { ...base, anonymous: 'Yes' });
  check('anonymous-carries-no-ip', !('_sourceIp' in forwarded.body));

  await post('suggestion', { ...base, anonymous: 'No', email: 'a@b.com' }, { ip: '203.0.113.7' });
  check('identified-carries-ip', forwarded.body._sourceIp === '203.0.113.7', forwarded.body._sourceIp);
}

// ── Reference stability (retry after a timeout must not duplicate) ──
{
  upstreamReply = () => new Response('', { status: 202 });
  const first = await post('safety', { ...VALID_SAFETY, referenceId: 'SAF-123456' });
  const firstRef = forwarded.body._ref;
  await post('safety', { ...VALID_SAFETY, referenceId: 'SAF-123456' });
  check('client-ref-is-stable-across-retries',
    firstRef === 'SAF-123456' && forwarded.body._ref === 'SAF-123456', firstRef);
  check('ref-echoed-to-page', (await first.clone().json()).referenceId === 'SAF-123456');

  // Without one, the Worker mints a reference status-check.html accepts.
  await post('safety', VALID_SAFETY);
  check('generated-ref-is-lookupable', /^SAF-\d{4,6}$/.test(forwarded.body._ref), forwarded.body._ref);
  upstreamReply = () => new Response('{}', { status: 200 });
}

// ── Rate limiting ────────────────────────────────────────────
{
  const ip = '198.51.100.4';
  let limited = 0;
  for (let i = 0; i < 9; i++) {
    const res = await post('safety', VALID_SAFETY, { ip });
    if (res.status === 429) limited++;
  }
  check('rate-limit-engages', limited > 0, `${limited} of 9 limited`);

  const other = await post('safety', VALID_SAFETY, { ip: '198.51.100.5' });
  check('rate-limit-is-per-ip', other.status === 200, `${other.status}`);
}

// ── Passthrough lookup ───────────────────────────────────────
{
  upstreamReply = () => new Response(JSON.stringify({ found: true, status: 'Open' }), { status: 200 });
  const res = await post('status', { referenceId: 'MNT-0001' });
  check('status-passthrough-body', (await res.clone().json()).found === true);
  check('status-forwards-only-ref',
    Object.keys(forwarded.body).join(',') === 'referenceId', Object.keys(forwarded.body).join(','));
  upstreamReply = () => new Response('{}', { status: 200 });
}

// ── Upstream failures ────────────────────────────────────────
{
  upstreamReply = () => new Response('nope', { status: 500 });
  const res = await post('safety', VALID_SAFETY);
  check('flow-error-is-502', res.status === 502 && (await res.clone().json()).ok === false, `${res.status}`);
  upstreamReply = () => new Response('{}', { status: 200 });

  const unknown = await post('nosuchform', VALID_SAFETY);
  check('unknown-form-404', unknown.status === 404, `${unknown.status}`);

  const health = await worker.fetch(new Request('https://proxy.example/health', {
    method: 'GET', headers: { Origin: ORIGIN },
  }), ENV, {});
  check('health-reports-mode', health.status === 200 && 'requiresCode' in (await health.clone().json()));
}

// ── Time off: clock-number validation ────────────────────────
//
// This route is the whole point of replacing the Microsoft Form: Forms could
// not check a number against the roster, so a typo became an orphan request
// nobody could trace.
{
  const found = () => new Response(
    // Extra columns on purpose: the flow reads a roster row, and rows grow
    // whenever someone edits the SharePoint list.
    JSON.stringify({ found: true, displayName: 'Albiar A.', ssn: '000-00-0000', payRate: 31.5 }),
    { status: 200 }
  );

  // An apostrophe is not a cosmetic problem: the flow interpolates this value
  // into an OData filter, so it silently changes the query rather than failing.
  upstreamReply = found;
  const quoted = await post('validate', { clockNumber: "1234' or '1'='1" });
  check('validate-rejects-non-digits',
    quoted.status === 400 && calls.length === 0,
    `${quoted.status}, ${calls.length} upstream calls`);

  const empty = await post('validate', { clockNumber: '' });
  check('validate-requires-clock-number', empty.status === 400 && calls.length === 0);

  const ok = await post('validate', { clockNumber: '048213' });
  const okBody = await ok.clone().json();
  check('validate-returns-display-name',
    ok.status === 200 && okBody.found === true && okBody.displayName === 'Albiar A.',
    JSON.stringify(okBody));

  // The projection is the reason this is not a passthrough.
  check('validate-projects-away-roster-columns',
    Object.keys(okBody).sort().join(',') === 'displayName,found',
    Object.keys(okBody).join(','));

  check('validate-sends-shared-secret',
    forwarded.headers['X-Portal-Secret'] === 'validate-shared-secret',
    JSON.stringify(forwarded.headers));

  // 404 is an answer, not a failure — the page has to tell "check your badge"
  // apart from "we couldn't reach the system".
  upstreamReply = () => new Response(JSON.stringify({ found: false }), { status: 404 });
  const missing = await post('validate', { clockNumber: '999999' });
  check('validate-404-is-found-false',
    missing.status === 404 && (await missing.clone().json()).found === false, `${missing.status}`);

  // A 401 means the shared secret is misconfigured. That must not be legible
  // from a browser on the plant floor.
  upstreamReply = () => new Response('Unauthorized: signature did not match', { status: 401 });
  const denied = await post('validate', { clockNumber: '048213' });
  const deniedText = await denied.clone().text();
  check('validate-upstream-401-is-generic-502',
    denied.status === 502 && !deniedText.includes('signature'), `${denied.status}: ${deniedText}`);

  upstreamReply = found;
  const noSecret = await worker.fetch(new Request('https://proxy.example/submit/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ clockNumber: '048213' }),
  }), { ...ENV, VALIDATE_SECRET: '' }, {});
  check('validate-refuses-without-configured-secret', noSecret.status === 500, `${noSecret.status}`);

  upstreamReply = () => new Response('{}', { status: 200 });
}

// ── Time off: the lookup limiter is its own tally ─────────────
{
  const ip = '198.51.100.20';
  upstreamReply = () => new Response(JSON.stringify({ found: true, displayName: 'A. B.' }), { status: 200 });

  let limited = 0;
  for (let i = 0; i < 14; i++) {
    const res = await post('validate', { clockNumber: String(1000 + i) }, { ip });
    if (res.status === 429) limited++;
  }
  check('validate-rate-limit-engages', limited > 0, `${limited} of 14 limited`);

  // Validation fires while the employee is still typing. If those calls ate
  // the submission allowance, a slow typist would be rate-limited out of the
  // request they came to file.
  const submission = await post('safety', VALID_SAFETY, { ip });
  check('lookup-limit-does-not-block-submissions', submission.status === 200, `${submission.status}`);

  upstreamReply = () => new Response('{}', { status: 200 });
}

// ── Time off: submitting a request ───────────────────────────
{
  const VALID_TIMEOFF = {
    clockNumber: '048213',
    leaveType: 'Vacation',
    startDate: '2026-09-15',
    endDate: '2026-09-17',
    hours: 24,
    vacationCoversFMLA: 'No',
    notesToManager: 'Family trip.',
  };

  // Roster check first, then the flow — both go through the one stub.
  const routed = url => url.includes('/validate')
    ? new Response(JSON.stringify({ found: true, displayName: 'Albiar A.' }), { status: 200 })
    : new Response('{}', { status: 200 });

  upstreamReply = routed;

  const ok = await post('timeoff', VALID_TIMEOFF);
  check('timeoff-accepts-valid-request', ok.status === 200, `${ok.status}`);
  check('timeoff-revalidates-before-forwarding',
    calls.length === 2 && calls[0].url.includes('/validate') && calls[1].url.includes('/timeoff'),
    calls.map(c => c.url).join(' -> '));

  // The payload schema is a contract with the Power Automate flow — a Switch
  // matches leaveType exactly, and a renamed key is a silent drop.
  const sent = calls[1].body;
  check('timeoff-forwards-contract-fields',
    sent.clockNumber === '048213' && sent.leaveType === 'Vacation' &&
    sent.startDate === '2026-09-15' && sent.endDate === '2026-09-17' &&
    sent.hours === 24 && sent.vacationCoversFMLA === 'No' &&
    sent.notesToManager === 'Family trip.',
    JSON.stringify(sent));

  check('timeoff-hours-forwarded-as-number', typeof sent.hours === 'number', typeof sent.hours);
  check('timeoff-returns-tmo-reference',
    /^TMO-\d{6}$/.test((await ok.clone().json()).referenceId),
    (await ok.clone().json()).referenceId);

  // Half days are real; everything is tracked in hours.
  const half = await post('timeoff', { ...VALID_TIMEOFF, hours: 4.5 });
  check('timeoff-accepts-fractional-hours', half.status === 200, `${half.status}`);

  const strHours = await post('timeoff', { ...VALID_TIMEOFF, hours: '8' });
  check('timeoff-coerces-string-hours',
    strHours.status === 200 && calls[1].body.hours === 8, `${calls[1] && calls[1].body.hours}`);

  const zero = await post('timeoff', { ...VALID_TIMEOFF, hours: 0 });
  check('timeoff-rejects-zero-hours', zero.status === 400, `${zero.status}`);

  const wordHours = await post('timeoff', { ...VALID_TIMEOFF, hours: 'lots' });
  check('timeoff-rejects-non-numeric-hours', wordHours.status === 400, `${wordHours.status}`);

  // A near-miss falls through the flow's Switch: accepted, logged, routed to
  // nobody. Worse than a rejection, hence the allowlist.
  const drifted = await post('timeoff', { ...VALID_TIMEOFF, leaveType: 'vacation' });
  check('timeoff-rejects-leave-type-drift',
    drifted.status === 400 && (await drifted.clone().json()).error === 'invalid_leaveType');

  const fmlaType = await post('timeoff', { ...VALID_TIMEOFF, leaveType: 'FMLA Without Vacation' });
  check('timeoff-accepts-fmla-without-vacation', fmlaType.status === 200, `${fmlaType.status}`);

  const backwards = await post('timeoff', { ...VALID_TIMEOFF, endDate: '2026-09-14' });
  check('timeoff-rejects-end-before-start',
    backwards.status === 400 && (await backwards.clone().json()).error === 'end_before_start');

  const sameDay = await post('timeoff', { ...VALID_TIMEOFF, endDate: '2026-09-15' });
  check('timeoff-accepts-single-day', sameDay.status === 200, `${sameDay.status}`);

  // Shaped like a date but not one: Date rolls this to March 2nd, which would
  // book time off on a day nobody asked for.
  const impossible = await post('timeoff', { ...VALID_TIMEOFF, startDate: '2026-02-30' });
  check('timeoff-rejects-impossible-date', impossible.status === 400, `${impossible.status}`);

  const notADate = await post('timeoff', { ...VALID_TIMEOFF, startDate: 'tomorrow' });
  check('timeoff-rejects-freetext-date', notADate.status === 400, `${notADate.status}`);

  const badFmla = await post('timeoff', { ...VALID_TIMEOFF, vacationCoversFMLA: 'maybe' });
  check('timeoff-rejects-unknown-fmla-answer', badFmla.status === 400, `${badFmla.status}`);

  const noFmla = await post('timeoff', { ...VALID_TIMEOFF, vacationCoversFMLA: '' });
  check('timeoff-fmla-answer-is-optional', noFmla.status === 200, `${noFmla.status}`);

  // The page will not let this happen; curl will.
  upstreamReply = url => url.includes('/validate')
    ? new Response(JSON.stringify({ found: false }), { status: 404 })
    : new Response('{}', { status: 200 });
  const orphan = await post('timeoff', { ...VALID_TIMEOFF, clockNumber: '999999' });
  check('timeoff-rejects-unknown-clock-number',
    orphan.status === 400 && (await orphan.clone().json()).error === 'unknown_clock_number' &&
    calls.length === 1,
    `${orphan.status}, ${calls.length} upstream calls`);

  // "The roster service is down" and "you do not work here" are very different
  // things to tell an employee, so a failed check must not read as a bad badge.
  upstreamReply = url => url.includes('/validate')
    ? new Response('boom', { status: 500 })
    : new Response('{}', { status: 200 });
  const rosterDown = await post('timeoff', VALID_TIMEOFF);
  check('timeoff-roster-outage-is-502-not-400',
    rosterDown.status === 502 && calls.length === 1, `${rosterDown.status}`);

  upstreamReply = () => new Response('{}', { status: 200 });
}

// ── Time off: lookup and cancellation ────────────────────────
{
  upstreamReply = () => new Response(JSON.stringify({
    found: true,
    displayName: 'Albiar A.',
    balances: [{ leaveType: 'Vacation', hours: 64, accrualCode: 'internal' }],
    requests: [{ referenceId: 'TMO-100001', leaveType: 'Vacation', startDate: '2026-09-15',
                 endDate: '2026-09-17', hours: 24, status: 'Pending', approverEmail: 'boss@example.com' }],
    hrNotes: 'internal only',
  }), { status: 200 });

  const res = await post('timeoff-lookup', { clockNumber: '048213' });
  const body = await res.clone().json();
  check('timeoff-lookup-returns-balance-and-requests',
    res.status === 200 && body.balances[0].hours === 64 && body.requests[0].referenceId === 'TMO-100001',
    JSON.stringify(body));

  check('timeoff-lookup-projects-away-internal-fields',
    !('hrNotes' in body) && !('accrualCode' in body.balances[0]) &&
    !('approverEmail' in body.requests[0]),
    Object.keys(body).join(','));

  upstreamReply = url => url.includes('/validate')
    ? new Response(JSON.stringify({ found: true, displayName: 'Albiar A.' }), { status: 200 })
    : new Response('{}', { status: 200 });

  const cancelled = await post('timeoff-cancel', {
    referenceId: 'TMO-100001', clockNumber: '048213', reason: 'Plans changed.',
  });
  check('timeoff-cancel-accepts-valid', cancelled.status === 200, `${cancelled.status}`);

  // A stranger with the Worker URL must not be able to cancel somebody's
  // vacation by guessing a TMO number alone.
  const noClock = await post('timeoff-cancel', { referenceId: 'TMO-100001' });
  check('timeoff-cancel-requires-clock-number',
    noClock.status === 400 && (await noClock.clone().json()).error === 'missing_clockNumber');

  const badRef = await post('timeoff-cancel', { referenceId: 'nope', clockNumber: '048213' });
  check('timeoff-cancel-rejects-malformed-reference', badRef.status === 400, `${badRef.status}`);

  upstreamReply = () => new Response('{}', { status: 200 });
}

report(results);
