/**
 * Employee Portal — submission proxy
 *
 * Sits between the GitHub Pages portal and Power Automate.
 * The flow URLs (with their sig= tokens) live here as Worker secrets and are
 * NEVER sent to the browser. The browser only ever sees this Worker's URL.
 *
 * Routes:  POST /submit/<formKey>
 * Health:  GET  /health
 */

// ─────────────────────────────────────────────────────────────
// CONFIG — edit these three blocks
// ─────────────────────────────────────────────────────────────

/** Your portal's exact origin(s). No trailing slash. */
const ALLOWED_ORIGINS = [
  'https://thibautleclercq98-stack.github.io',
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
 * formKey -> { secret: <Worker secret name>, requiresCode: bool }
 * The secret name must match what you set with `wrangler secret put`.
 */
const FORMS = {
  suggestion:  { secret: 'FLOW_SUGGESTION',  requiresCode: REQUIRE_ACCESS_CODE, refPrefix: 'SUG' },
  safety:      { secret: 'FLOW_SAFETY',      requiresCode: REQUIRE_ACCESS_CODE, refPrefix: 'SAF' },
  maintenance: { secret: 'FLOW_MAINTENANCE', requiresCode: REQUIRE_ACCESS_CODE, refPrefix: 'MNT' },
  // Status check is a read-only lookup by reference number, so no code needed.
  // passthrough: return the flow's own JSON body unchanged (the page reads
  // data.found and the record fields directly).
  status:      { secret: 'FLOW_STATUS',      requiresCode: false, passthrough: true },
};

const LIMITS = {
  maxPerWindow: 6,             // submissions per IP per window
  windowMs:     60_000,        // 1 minute
  // Photos ride along as base64 in the JSON body. The portal accepts images up
  // to 5 MB, and base64 inflates by ~4/3, so the ceiling has to clear ~7 MB or
  // every submission with a real phone photo is rejected before it is parsed.
  maxBodyBytes: 8 * 1024 * 1024,
  flowTimeoutMs: 20_000,       // give up on a hanging flow
};

// ─────────────────────────────────────────────────────────────
// Rate limiting (in-isolate — a speed bump, not a wall; see README)
// ─────────────────────────────────────────────────────────────

const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);

  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + LIMITS.windowMs });
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    }
    return false;
  }

  rec.count += 1;
  return rec.count > LIMITS.maxPerWindow;
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
    const match = url.pathname.match(/^\/submit\/([a-z]+)\/?$/);
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
    if (rateLimited(ip)) {
      return json(
        { ok: false, error: 'rate_limited', message: 'Too many submissions. Please wait a minute and try again.' },
        429,
        origin
      );
    }

    // Size guard
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > LIMITS.maxBodyBytes) {
      return json({ ok: false, error: 'payload_too_large' }, 413, origin);
    }

    // Parse body
    let payload;
    try {
      const raw = await request.text();
      if (raw.length > LIMITS.maxBodyBytes) {
        return json({ ok: false, error: 'payload_too_large' }, 413, origin);
      }
      payload = JSON.parse(raw || '{}');
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
    delete payload.accessCode;

    // Resolve the real flow URL from secrets
    const flowUrl = env[form.secret];
    if (!flowUrl) {
      return json({ ok: false, error: 'flow_not_configured' }, 500, origin);
    }

    // Add server-side context the browser can't be trusted to supply. A lookup
    // is a read, so it forwards the reference number and nothing else.
    const ref = makeRef(form.refPrefix);
    const body = form.passthrough
      ? { ...payload }
      : {
          ...payload,
          _ref: ref,
          _submittedAt: new Date().toISOString(),
          _form: formKey,
          ...(tracksSourceIp(formKey, payload) ? { _sourceIp: ip } : {}),
        };

    // Forward to Power Automate
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.flowTimeoutMs);

    try {
      const upstream = await fetch(flowUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Flows without a Response action return 202 — any 2xx means accepted.
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

      // Lookup-style forms need the flow's own JSON, not our wrapper.
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

      // Flow's own ID wins; then the one the page already generated and may
      // have shown the employee; ours is the last resort.
      const finalRef = flowRef || payload.referenceId || ref;
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
