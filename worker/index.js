/**
 * Employee Portal — submission proxy
 *
 * Sits between the GitHub Pages portal and Power Automate.
 * The flow URLs (with their sig= tokens) live here as Worker secrets and are
 * NEVER sent to the browser. The browser only ever sees this Worker's URL.
 *
 * Routes:  POST /submit/<formKey>
 * Health:  GET  /health
 *
 * The time-off routes (validate, timeoff, timeoff-lookup, timeoff-cancel)
 * are additions to the same table, not a second dispatcher: they inherit the
 * CORS check, the access-code switch, the size guard and the shape checks
 * that every other submission already goes through.
 */

// ─────────────────────────────────────────────────────────────
// CONFIG — edit these three blocks
// ─────────────────────────────────────────────────────────────

/** Your portal's exact origin(s). No trailing slash. */
const ALLOWED_ORIGINS = [
  'https://vitopsanantonio.github.io',
  // 'http://localhost:8000',  // uncomment while testing locally
];

/**
 * THE access-code switch. Flip to true and redeploy at go-live.
 *
 * This is the only place the access code is turned on or off. The portal does
 * not have a matching flag: it submits without a code, and only prompts for
 * one if this Worker answers 401. So flipping this alone is enough, and the
 * two deployments cannot drift out of sync.
 */
const REQUIRE_ACCESS_CODE = false;

/**
 * formKey -> { secret, requiresCode, refPrefix?, passthrough?, fields }
 * The secret name must match what you set with `wrangler secret put`.
 *
 * `fields` is the authoritative shape of a submission. This Worker is
 * reachable directly by anyone who has its URL, so the forms' own JavaScript
 * validation is advisory only — whatever is enforced here is the *only* thing
 * standing between a stranger with curl and a row in SharePoint. Keys not
 * listed are dropped rather than forwarded, so a direct POST cannot invent
 * columns; `required`/`min`/`max` are enforced server-side.
 *
 * `max` is a character count, except on `photo` where it caps the base64 text.
 */
const TEXT = max => ({ max });

/** Cap on one photo's base64 text. Must match maxEncodedBytes in
 *  photo-upload.js, or the page accepts a photo the Worker then rejects. */
const MAX_PHOTO_B64 = 7 * 1024 * 1024;

const CONTACT_FIELDS = {
  email:     TEXT(254),          // RFC 5321 practical maximum
  photo:     { max: MAX_PHOTO_B64 },
  photoName: TEXT(255),
};

/**
 * Up to three photos as [{ name, base64 }].
 *
 * An array rather than photo1/photo2/photo3: it is the shape Power Automate
 * wants. A Select action maps it straight onto the Attachments collection of
 * "Send an email (V2)", so zero, one, two or three photos all take the same
 * path with no conditional branching in the flow — and raising the limit later
 * is a number here, not three more fields and three more branches there.
 */
const PHOTOS_FIELD = {
  array:    true,
  maxItems: 3,
  item: {
    name:   { max: 255, required: true },
    base64: { max: MAX_PHOTO_B64, required: true, base64: true },
  },
  // Across all items. Kept under LIMITS.maxBodyBytes with room for the rest of
  // the JSON, and matched by maxTotalEncodedBytes in photo-upload.js.
  maxTotalBytes: 12 * 1024 * 1024,
};

/**
 * A time clock number, as it appears on the badge. Digits only, and that is
 * not cosmetic: the validation flow builds its SharePoint OData filter by
 * string interpolation, so an apostrophe in this value does not fail — it
 * silently changes the query. This pattern is the only thing preventing that,
 * and it is enforced here rather than on the page because the page is a
 * courtesy and this route is reachable with curl.
 */
const CLOCK_NUMBER = { max: 10, required: true, re: /^\d{1,10}$/ };

/**
 * Matched by a Switch in the Power Automate flow. A value that is not exactly
 * one of these does not error — it falls through the Switch and the request is
 * accepted, logged, and never routed to anyone. Hence an allowlist rather than
 * a length cap.
 *
 * Changing one of these strings means changing it in three places at once, or
 * the mismatch is silent: here, the matching <option value> in
 * time-off-request.html, and the flow's own Switch.
 */
const LEAVE_TYPES = [
  'Vacation',
  'Floating Holiday',
  'LSK CarryOver',
  'Perfect Attendance Reward',
  'FMLA',
];

const FORMS = {
  suggestion: {
    secret: 'FLOW_SUGGESTION', requiresCode: REQUIRE_ACCESS_CODE, refPrefix: 'SUG',
    fields: {
      referenceId: TEXT(20),
      department:  { max: 100,  required: true },
      category:    { max: 100,  required: true },
      suggestion:  { max: 4000, required: true, min: 20 },
      benefit:     TEXT(4000),
      anonymous:   { max: 10,   required: true },
      ...CONTACT_FIELDS,
    },
  },
  safety: {
    secret: 'FLOW_SAFETY', requiresCode: REQUIRE_ACCESS_CODE, refPrefix: 'SAF',
    fields: {
      referenceId: TEXT(20),
      // 'Safety' | 'Food safety'. Deliberately NOT required: the page enforces
      // the choice, and a cached page submitting without it must never have a
      // safety report rejected over a field added after it was cached. The
      // flow treats an absent value as 'Safety'.
      concernType:  TEXT(40),
      foodCategory: TEXT(80),   // only set when concernType is 'Food safety'
      location:    { max: 100,  required: true },
      urgency:     { max: 60,   required: true },
      description: { max: 4000, required: true, min: 10 },
      solution:    TEXT(4000),
      ...CONTACT_FIELDS,
    },
  },
  maintenance: {
    secret: 'FLOW_MAINTENANCE', requiresCode: REQUIRE_ACCESS_CODE, refPrefix: 'MNT',
    fields: {
      referenceId: TEXT(20),
      department:  { max: 100,  required: true },
      location:    { max: 200,  required: true },
      issueType:   { max: 120,  required: true },
      description: { max: 4000, required: true, min: 10 },
      priority:    { max: 20,   required: true },
      ...CONTACT_FIELDS,
      photos:      PHOTOS_FIELD,
    },
  },
  // Status check is a read-only lookup by reference number, so no code needed.
  // passthrough: return the flow's own JSON body unchanged (the page reads
  // data.found and the record fields directly).
  status: {
    secret: 'FLOW_STATUS', requiresCode: false, passthrough: true,
    fields: { referenceId: { max: 20, required: true } },
  },

  // ── Time off ────────────────────────────────────────────────
  //
  // Four routes replacing the two Microsoft Forms. They share a gate: the
  // employee's time clock number, checked against the roster before anything
  // else happens. That check is what the Forms version could not do — Forms
  // cannot validate against a SharePoint list, so a mistyped number was only
  // caught after submission, by which point HR had an orphan request and no
  // way to trace it.

  /**
   * Clock number -> display name. The gate in front of every route below.
   *
   * `limitBucket` puts it on its own counter: validation fires while the
   * employee types, and sharing the submission counter would mean a badge
   * typed slowly used up the allowance for the request that follows it. The
   * ceiling is tighter than a submission's because this endpoint is an
   * enumeration oracle — a loop over numbers returns a real employee name for
   * every valid one.
   *
   * `project` is why this is not a plain passthrough: the flow reads a roster
   * row, and only these two fields are anyone's business in a browser.
   */
  validate: {
    secret: 'VALIDATE_FLOW_URL', secretHeader: 'VALIDATE_SECRET',
    requiresCode: REQUIRE_ACCESS_CODE,
    passthrough: true, project: projectValidate, foundOn404: true,
    limitBucket: 'lookup', maxPerWindow: 10,
    fields: { clockNumber: CLOCK_NUMBER },
  },

  /**
   * A new time-off request.
   *
   * `revalidates` re-runs the clock-number check server-side before
   * forwarding. The page will not let an employee submit an unrecognised
   * number, but that is a UX affordance, not a control: this route answers
   * curl too, and an orphan request is exactly what this work exists to stop.
   */
  timeoff: {
    secret: 'TIMEOFF_FLOW_URL', secretHeader: 'TIMEOFF_SECRET',
    requiresCode: REQUIRE_ACCESS_CODE, refPrefix: 'TMO',
    revalidates: 'clockNumber',
    check: checkTimeOffDates,
    fields: {
      referenceId:        TEXT(20),
      clockNumber:        CLOCK_NUMBER,
      leaveType:          { max: 60, required: true, oneOf: LEAVE_TYPES },
      startDate:          { max: 10, required: true, date: true },
      endDate:            { max: 10, required: true, date: true },
      // Everything is tracked in hours, 8 hours = 1 day, and half days are
      // real — so a number rather than a string, and decimals allowed.
      hours:              { required: true, number: { min: 0.25, max: 2000 } },
      vacationCoversFMLA: { max: 3, oneOf: ['Yes', 'No'] },
      notesToManager:     TEXT(1000),
    },
  },

  /**
   * Balances and existing requests for one clock number.
   *
   * Same oracle problem as /validate and then some — this one returns an
   * employee's leave history — so it shares the tighter lookup ceiling and is
   * projected down to the fields the page actually renders.
   */
  'timeoff-lookup': {
    secret: 'TIMEOFF_LOOKUP_FLOW_URL', secretHeader: 'TIMEOFF_SECRET',
    requiresCode: REQUIRE_ACCESS_CODE,
    passthrough: true, project: projectTimeOffLookup, foundOn404: true,
    limitBucket: 'lookup', maxPerWindow: 10,
    fields: { clockNumber: CLOCK_NUMBER },
  },

  /**
   * Cancel a request the employee already sent.
   *
   * Both the reference and the clock number are required and the clock number
   * is re-validated, so a stranger with the Worker URL cannot cancel someone
   * else's vacation by guessing a TMO number alone. The flow must still check
   * that the reference actually belongs to that clock number — this Worker
   * cannot know that, and it is the last piece of the check.
   */
  'timeoff-cancel': {
    secret: 'TIMEOFF_CANCEL_FLOW_URL', secretHeader: 'TIMEOFF_SECRET',
    requiresCode: REQUIRE_ACCESS_CODE,
    revalidates: 'clockNumber',
    fields: {
      referenceId: { max: 20, required: true, re: /^TMO-\d{4,6}$/ },
      clockNumber: CLOCK_NUMBER,
      reason:      TEXT(1000),
    },
  },
};

const LIMITS = {
  // Default ceiling. A form may set its own `maxPerWindow` (the time-off
  // lookups do — see FORMS above) and its own `limitBucket` to count on a
  // separate tally rather than eating into this one.
  maxPerWindow: 6,             // submissions per IP per window
  windowMs:     60_000,        // 1 minute
  // Photos ride along as base64 in the JSON body, and the maintenance form
  // sends up to three. PHOTOS_FIELD caps their combined base64 at 12 MB, so
  // the ceiling has to clear that plus the rest of the JSON — anything lower
  // rejects the submission with a 413 before it is even parsed.
  maxBodyBytes: 14 * 1024 * 1024,
  flowTimeoutMs: 20_000,       // give up on a hanging flow
};

// ─────────────────────────────────────────────────────────────
// Rate limiting (in-isolate — a speed bump, not a wall; see README)
// ─────────────────────────────────────────────────────────────

const hits = new Map();

/**
 * `bucket` separates tallies that should not compete. Submissions all share
 * one, but the time-off lookups get their own: validation fires while the
 * employee is still typing their badge number, and counting those against the
 * submission allowance meant a slow typist ran out of submissions before
 * reaching the submit button.
 */
function rateLimited(bucket, ip, ceiling) {
  const now = Date.now();
  const key = bucket + ':' + ip;
  const rec = hits.get(key);

  if (!rec || now > rec.resetAt) {
    hits.set(key, { count: 1, resetAt: now + LIMITS.windowMs });
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    }
    return false;
  }

  rec.count += 1;
  return rec.count > ceiling;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

/** Constant-time-ish compare so the code can't be guessed byte by byte. */
function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Employees mistype case and add spaces — normalise before comparing. */
function normaliseCode(v) {
  return String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Excel/SharePoint formula injection guard. Submissions land in a workbook
 * or list (status-check.html's date parsing confirms the backend reads
 * Excel serial numbers), and a cell that starts with =, +, -, or @ is
 * live-evaluated when someone opens it there — e.g. a "description" of
 * =HYPERLINK("http://evil","click") becomes a clickable formula for the
 * safety manager, not inert text. A leading tab or CR reaches the same
 * cell-start position after Excel trims whitespace, so both are guarded
 * too. Prefixing with a single quote forces it back to text; Excel/Sheets
 * both strip a leading quote from what they display, so this doesn't
 * change what the reader sees.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function sanitizeForSpreadsheet(value) {
  return FORMULA_LEAD.test(value) ? "'" + value : value;
}

/**
 * Keys whose string value is base64 image bytes rather than spreadsheet text.
 * Prefixing one with a quote would corrupt the image: `photo` is the legacy
 * single-photo field, `base64` the per-item key inside `photos`. Filenames are
 * NOT on this list — a photo called `=cmd|…` lands in a cell like any other
 * text and is guarded like any other text.
 */
const RAW_BYTE_KEYS = new Set(['photo', 'base64']);

/**
 * Applies the guard to every string in a submission payload except the raw
 * image bytes above. Client-side validation (the forms' own JS) can't be
 * trusted here: this Worker is reachable directly by anyone who has its URL,
 * bypassing whatever the page would have checked.
 *
 * Recurses into nested objects and arrays, so the `name` inside each entry of
 * `photos` is guarded exactly as a top-level string would be.
 */
function sanitizePayload(value, key) {
  if (typeof value === 'string') {
    return RAW_BYTE_KEYS.has(key) ? value : sanitizeForSpreadsheet(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizePayload(item, key));
  }
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(value)) clean[k] = sanitizePayload(v, k);
    return clean;
  }
  return value;
}

/**
 * Enforces a form's declared `fields` shape, returning either the accepted
 * subset or the first problem found.
 *
 * Unknown keys are dropped rather than rejected: the portal and the flows are
 * deployed independently, and a page that starts sending a new field should
 * degrade to "that column is missing" rather than break every submission until
 * the Worker catches up. Anything declared, though, is enforced strictly.
 */
function validatePayload(payload, fields) {
  const clean = {};

  for (const [key, rule] of Object.entries(fields)) {
    const raw = payload[key];

    if (raw === undefined || raw === null || raw === '' ||
        (rule.array && Array.isArray(raw) && raw.length === 0)) {
      if (rule.required) return { error: `missing_${key}` };
      continue;
    }

    if (rule.array) {
      const { list, error } = validateArrayField(key, raw, rule);
      if (error) return { error };
      clean[key] = list;
      continue;
    }

    // Numbers arrive as a number from the page and as whatever a direct POST
    // felt like sending, so both are accepted and one number is forwarded.
    // Kept ahead of the string check because a JSON number is not a string.
    if (rule.number) {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { error: `invalid_${key}` };
      if (n < rule.number.min || n > rule.number.max) return { error: `out_of_range_${key}` };
      clean[key] = n;
      continue;
    }

    if (typeof raw !== 'string') return { error: `invalid_${key}` };
    if (raw.length > rule.max) return { error: `too_long_${key}` };

    // `min` is a floor on meaningful content, so it ignores surrounding space —
    // otherwise "          " passes a 10-character minimum.
    if (rule.min && raw.trim().length < rule.min) return { error: `too_short_${key}` };

    if (rule.re && !rule.re.test(raw)) return { error: `invalid_${key}` };
    if (rule.date && !isCalendarDate(raw)) return { error: `invalid_${key}` };

    // An allowlist, not a length cap: see LEAVE_TYPES on why a near-miss is
    // worse here than a rejection.
    if (rule.oneOf && !rule.oneOf.includes(raw)) return { error: `invalid_${key}` };

    clean[key] = raw;
  }

  return { clean };
}

/**
 * Base64 as the browser's FileReader produces it: standard alphabet, no line
 * breaks, padded to a multiple of four.
 *
 * Worth checking rather than passing through, because the failure is silent and
 * downstream: Power Automate's base64ToBinary() does not reject malformed input,
 * it produces a corrupt attachment. The maintenance tech opens an email with a
 * photo that won't render and has no way to tell whether the photo was bad or
 * the employee never took one.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isBase64(value) {
  return value.length % 4 === 0 && BASE64_RE.test(value);
}

/**
 * Enforces an `array: true` rule: item count, per-item shape, and the combined
 * size across items. Unknown item keys are dropped, matching how unknown
 * top-level keys are treated.
 */
function validateArrayField(key, raw, rule) {
  if (!Array.isArray(raw)) return { error: `invalid_${key}` };
  if (raw.length > rule.maxItems) return { error: `too_many_${key}` };

  const list = [];
  let total = 0;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `invalid_${key}` };
    }

    const item = {};
    for (const [itemKey, itemRule] of Object.entries(rule.item)) {
      const value = entry[itemKey];

      if (value === undefined || value === null || value === '') {
        if (itemRule.required) return { error: `missing_${key}_${itemKey}` };
        continue;
      }
      if (typeof value !== 'string') return { error: `invalid_${key}_${itemKey}` };
      if (value.length > itemRule.max) return { error: `too_long_${key}_${itemKey}` };
      if (itemRule.base64 && !isBase64(value)) return { error: `invalid_${key}_${itemKey}` };

      total += value.length;
      item[itemKey] = value;
    }
    list.push(item);
  }

  if (rule.maxTotalBytes && total > rule.maxTotalBytes) return { error: `too_large_${key}` };

  return { list };
}

/**
 * A real calendar date in YYYY-MM-DD, not merely a string shaped like one.
 *
 * The round-trip through Date is what rejects 2026-02-30: the shape test alone
 * passes it, and Date rolls it forward to March 2nd, so the flow would book
 * time off on a day the employee never asked for.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Cross-field rule for a time-off request. `fields` can only see one key at a
 * time, and "ends before it starts" needs two.
 *
 * A plain string compare is correct here and a date compare would not be
 * clearer: both values already passed isCalendarDate, and ISO-8601 dates sort
 * lexicographically.
 */
function checkTimeOffDates(clean) {
  if (clean.endDate < clean.startDate) return 'end_before_start';
  return null;
}

/**
 * What a lookup flow is allowed to tell the browser.
 *
 * Both flows read rows out of an HR list — a roster row for /validate, a leave
 * history for /timeoff-lookup — and a passthrough would hand the browser every
 * column those rows happen to carry, including ones added later by whoever
 * next edits the SharePoint list. Projecting keeps that decision here, and
 * doubles as the contract the flows are built against (worker/README.md).
 */
const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const num = value => (Number.isFinite(Number(value)) ? Number(value) : null);

function projectValidate(data) {
  return {
    found: data.found === true,
    displayName: str(data.displayName, 80),
  };
}

function projectTimeOffLookup(data) {
  return {
    found: data.found === true,
    displayName: str(data.displayName, 80),
    balances: Array.isArray(data.balances)
      ? data.balances.slice(0, 20).map(b => ({
          leaveType: str(b && b.leaveType, 60),
          hours:     num(b && b.hours),
        }))
      : [],
    requests: Array.isArray(data.requests)
      ? data.requests.slice(0, 50).map(r => ({
          referenceId: str(r && r.referenceId, 20),
          leaveType:   str(r && r.leaveType, 60),
          startDate:   str(r && r.startDate, 10),
          endDate:     str(r && r.endDate, 10),
          hours:       num(r && r.hours),
          status:      str(r && r.status, 40),
        }))
      : [],
  };
}

/**
 * Asks the validation flow whether a clock number is on the roster.
 *
 * Used by the routes that write something (a request, a cancellation) before
 * they forward. The page already checked — but the page is a courtesy, and
 * this route answers curl. Returns `{ found }` on a real answer or `{ error }`
 * when the flow could not be reached; the caller must not conflate the two,
 * because "the roster service is down" and "you do not work here" are very
 * different things to tell someone.
 */
async function clockNumberExists(clockNumber, env, signal) {
  const url = env.VALIDATE_FLOW_URL;
  if (!url) return { error: 'flow_not_configured' };
  const secret = env.VALIDATE_SECRET;
  if (!secret) return { error: 'flow_secret_not_configured' };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Portal-Secret': secret },
      body: JSON.stringify({ clockNumber }),
      signal,
    });
  } catch (err) {
    return { error: err && err.name === 'AbortError' ? 'flow_timeout' : 'proxy_error' };
  }

  if (res.status === 404) return { found: false };
  if (!res.ok) return { error: 'flow_error' };

  // A flow that answers 200 with no body means "found" — the 404 above is how
  // it says otherwise.
  try {
    const body = await res.json();
    return { found: body && body.found !== false };
  } catch {
    return { found: true };
  }
}

/**
 * Fallback reference, used only when the flow doesn't return one of its own.
 * The format has to match what status-check.html accepts — /^(MNT|SAF|SUG)-\d{4,6}$/
 * with a 10-character input cap — or the number we hand the employee is one
 * they can never look up.
 */
function makeRef(prefix) {
  if (!prefix) return null;
  const n = 100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
  return `${prefix}-${n}`;
}

/**
 * Fills in `photo` / `photoName` from the first entry of `photos`, and always
 * sets `photoCount`.
 *
 * The portal and the flows deploy independently — the portal is a git push, the
 * flow is a hand edit in Power Automate — so for the window between them a
 * maintenance flow that still reads `photo` keeps receiving photo #1 exactly as
 * before, while a migrated flow reads `photos` and gets all three. The
 * duplication costs nothing on the employee's connection: it is added here,
 * after the upload, on the datacentre-to-datacentre hop.
 *
 * Delete this once every flow reads `photos` (see worker/README.md).
 */
function withLegacyPhotoFields(body) {
  if (!Array.isArray(body.photos)) return body;

  const first = body.photos[0];
  return {
    ...body,
    photoCount: body.photos.length,
    // An explicitly sent `photo` wins — the other forms still send one.
    photo:     body.photo     || (first ? first.base64 : ''),
    photoName: body.photoName || (first ? first.name   : ''),
  };
}

/**
 * The suggestion form promises, on screen, that an anonymous submission
 * "cannot be traced". Attaching the source IP to it would quietly break that
 * promise in SharePoint, so anonymous suggestions travel without one.
 */
function tracksSourceIp(formKey, payload) {
  if (formKey !== 'suggestion') return true;
  return String(payload.anonymous ?? '').trim().toLowerCase() !== 'yes';
}

// ─────────────────────────────────────────────────────────────
// Worker
// ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      // requiresCode is reported so you can confirm which mode is deployed
      // without submitting a form.
      return json({ ok: true, requiresCode: REQUIRE_ACCESS_CODE }, 200, origin);
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    }

    // Route: /submit/<formKey>
    const match = url.pathname.match(/^\/submit\/([a-z-]+)\/?$/);
    if (!match) {
      return json({ ok: false, error: 'not_found' }, 404, origin);
    }
    const formKey = match[1];
    const form = FORMS[formKey];
    if (!form) {
      return json({ ok: false, error: 'unknown_form' }, 404, origin);
    }

    // Origin check. NOT a security boundary (curl can forge it) — it stops
    // other websites from posting to this endpoint. The access code is what
    // actually keeps strangers out.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ ok: false, error: 'origin_not_allowed' }, 403, origin);
    }

    // Rate limit
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(form.limitBucket || 'submit', ip, form.maxPerWindow || LIMITS.maxPerWindow)) {
      return json(
        { ok: false, error: 'rate_limited', message: 'Too many submissions. Please wait a minute and try again.' },
        429,
        origin
      );
    }

    // Size guard. Content-Length is a hint, not a promise — it is absent on a
    // chunked request — so it only lets us bail early. The real check is the
    // buffered body's true byte length (String#length counts UTF-16 units, so
    // it would under-count any multi-byte text by up to 3x).
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > LIMITS.maxBodyBytes) {
      return json({ ok: false, error: 'payload_too_large' }, 413, origin);
    }

    // Parse body
    let payload;
    try {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > LIMITS.maxBodyBytes) {
        return json({ ok: false, error: 'payload_too_large' }, 413, origin);
      }
      payload = JSON.parse(new TextDecoder().decode(buf) || '{}');
    } catch {
      return json({ ok: false, error: 'invalid_json' }, 400, origin);
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return json({ ok: false, error: 'invalid_payload' }, 400, origin);
    }

    // Access code
    if (form.requiresCode) {
      const expected = normaliseCode(env.ACCESS_CODE);
      if (!expected) {
        return json({ ok: false, error: 'server_misconfigured' }, 500, origin);
      }
      if (!safeEqual(normaliseCode(payload.accessCode), expected)) {
        return json(
          { ok: false, error: 'bad_code', message: 'That access code is not correct. Check with your supervisor.' },
          401,
          origin
        );
      }
    }

    // Never forward the code onward — it must not end up stored in SharePoint.
    // Removed before validation so it can't be mistaken for a payload field.
    delete payload.accessCode;

    // Shape check. Whether the browser bothered to validate is not knowable
    // here, so this is where required/length rules are actually enforced.
    const { clean, error } = validatePayload(payload, form.fields);
    if (error) {
      return json({ ok: false, error }, 400, origin);
    }

    // Rules that need more than one field at a time.
    const crossFieldError = form.check ? form.check(clean) : null;
    if (crossFieldError) {
      return json({ ok: false, error: crossFieldError }, 400, origin);
    }

    // Resolve the real flow URL from secrets
    const flowUrl = env[form.secret];
    if (!flowUrl) {
      return json({ ok: false, error: 'flow_not_configured' }, 500, origin);
    }

    // Flows that authenticate their caller do it with a shared secret header.
    // Declared but unset is a misconfiguration, not a licence to call the flow
    // without one: an HTTP-triggered flow left open to unauthenticated callers
    // is a worse failure than a route this Worker refuses to serve.
    let flowSecret = null;
    if (form.secretHeader) {
      flowSecret = env[form.secretHeader];
      if (!flowSecret) {
        return json({ ok: false, error: 'flow_secret_not_configured' }, 500, origin);
      }
    }

    // Add server-side context the browser can't be trusted to supply. A lookup
    // is a read, so it forwards the reference number and nothing else — and
    // isn't sanitized for spreadsheet formulas, since a read doesn't write
    // anything back into the workbook.
    //
    // The page's own reference wins when it sends one, so a submission retried
    // after a timeout carries the same _ref as the attempt that timed out. That
    // gives the flow a stable key to upsert on instead of writing a second row
    // for what the employee experienced as one report. (The flow has to
    // actually upsert on it — see worker/README.md.)
    const ref = clean.referenceId || makeRef(form.refPrefix);
    const body = form.passthrough
      ? { ...clean }
      : {
          ...withLegacyPhotoFields(sanitizePayload(clean)),
          _ref: ref,
          _submittedAt: new Date().toISOString(),
          _form: formKey,
          ...(tracksSourceIp(formKey, clean) ? { _sourceIp: ip } : {}),
        };

    // Forward to Power Automate
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.flowTimeoutMs);

    try {
      // Server-side re-validation of the clock number, before anything is
      // written. Shares the one timeout budget with the forward below, so a
      // hanging roster lookup cannot double this route's worst case.
      if (form.revalidates) {
        const gate = await clockNumberExists(clean[form.revalidates], env, controller.signal);
        if (gate.error) {
          clearTimeout(timer);
          return json(
            { ok: false, error: 'flow_error', message: 'Submission could not be delivered. Please try again or tell your supervisor.' },
            502,
            origin
          );
        }
        if (!gate.found) {
          clearTimeout(timer);
          return json(
            { ok: false, error: 'unknown_clock_number', message: 'That time clock number was not recognized. Check your badge or see your supervisor.' },
            400,
            origin
          );
        }
      }

      const upstream = await fetch(flowUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(flowSecret ? { 'X-Portal-Secret': flowSecret } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // A lookup flow answers 404 for "no such record". That is an answer, not
      // a failure, and the page needs to tell the two apart: "check your badge
      // number" and "we couldn't reach the system" send an employee to very
      // different places.
      if (form.foundOn404 && upstream.status === 404) {
        return json({ found: false }, 404, origin);
      }

      // Flows without a Response action return 202 — any 2xx means accepted.
      // The upstream body stops here: a 401 means the shared secret is
      // misconfigured, and that must not be legible from a browser.
      if (!upstream.ok) {
        return json(
          { ok: false, error: 'flow_error', status: upstream.status, message: 'Submission could not be delivered. Please try again or tell your supervisor.' },
          502,
          origin
        );
      }

      // If the flow returns its own reference, prefer that one.
      let flowRef = null;
      let text = '';
      try { text = await upstream.text(); } catch { /* no body */ }

      // Lookup-style forms need the flow's own JSON, not our wrapper. Forms
      // that declare a `project` get only the fields it names — see
      // projectValidate / projectTimeOffLookup on why.
      if (form.project) {
        let data;
        try {
          data = JSON.parse(text || '{}');
        } catch {
          data = null;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return json(
            { ok: false, error: 'flow_error', message: 'Could not look that up right now. Please try again in a moment.' },
            502,
            origin
          );
        }
        return json(form.project(data), 200, origin);
      }

      if (form.passthrough) {
        return new Response(text || '{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors(origin) },
        });
      }

      try {
        if (text) {
          const parsed = JSON.parse(text);
          flowRef = parsed?.referenceId || parsed?.ref || parsed?.reference || null;
        }
      } catch { /* flow returned no body or non-JSON — fine */ }

      // Flow's own ID wins; otherwise `ref`, which is already the page's own
      // reference when it sent one and our generated fallback when it didn't.
      const finalRef = flowRef || ref;
      // Return both key names so existing page code keeps working.
      return json({ ok: true, ref: finalRef, referenceId: finalRef }, 200, origin);

    } catch (err) {
      clearTimeout(timer);
      const aborted = err?.name === 'AbortError';
      return json(
        {
          ok: false,
          error: aborted ? 'flow_timeout' : 'proxy_error',
          message: 'Submission could not be delivered. Please try again or tell your supervisor.',
        },
        504,
        origin
      );
    }
  },
};
