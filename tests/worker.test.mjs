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
  ACCESS_CODE: 'TEST-CODE',
};

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// Captures what would have gone to Power Automate.
let forwarded = null;
let upstreamReply = () => new Response('{}', { status: 200 });
globalThis.fetch = async (url, init) => {
  forwarded = { url, body: JSON.parse(init.body) };
  return upstreamReply();
};

// Each call gets its own IP unless one is pinned, so the rate limiter (6 per
// IP per minute) doesn't start rejecting unrelated cases partway through.
let ipCounter = 0;

function post(formKey, payload, { origin = ORIGIN, ip = `10.0.${++ipCounter >> 8}.${ipCounter & 255}` } = {}) {
  forwarded = null;
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

report(results);
