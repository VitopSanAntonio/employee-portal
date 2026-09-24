# Employee Portal — production readiness review (September 2026)

Scope: every file in the repository at `32a3907` — the seven static pages, the
shared scripts (`form-utils.js`, `lang.js`, `photo-upload.js`,
`time-off-request.js`, `sw.js`, `seasonal.js`, `announce.js`), `theme.css`,
the Cloudflare Worker (`worker/index.js`), the four test suites, CI, and the
Power Automate flow docs under `docs/`.

**What the stack actually is.** The brief mentions Java and SQL. Neither is in
this repository. The portal is static HTML/CSS/JS on GitHub Pages, with one
server-side component: a Cloudflare Worker that validates submissions and
forwards them to Power Automate flows, which write to SharePoint lists and send
email. The review is written against that architecture. "SQL injection"
becomes **OData filter injection** in the flows, and "the backend" becomes the
Worker plus the flows, which are **not in source control**.

Findings marked **✅ Fixed in this PR** have code, tests and a passing CI run
behind them. Everything else is a recommendation with replacement code.

---

## Contents

1. [Critical issues](#critical-issues)
2. [High priority](#high-priority)
3. [Medium priority](#medium-priority)
4. [Low priority](#low-priority)
5. [Architecture review](#architecture-review)
6. [UI / UX and accessibility](#ui--ux-and-accessibility)
7. [Performance](#performance)
8. [Code quality](#code-quality)
9. [Testing](#testing)
10. [Production readiness scores](#production-readiness-scores)
11. [Executive summary](#executive-summary)

---

## Critical issues

Must be fixed before this serves thousands of employees.

### C1. A badge number alone opens anyone's leave history, FMLA included, and lets you cancel it

**Severity:** Critical
**Location:** `worker/index.js` — `REQUIRE_ACCESS_CODE = false` (line 35); the `validate`, `timeoff-lookup` and `timeoff-cancel` routes
**Root cause:** Time off went live (`5d7cc0b`) with the access-code switch still off. The only identity check is the time clock number. Clock numbers are short, sequential-ish digits printed on badges and time cards.
**Impact:**
- `POST /submit/timeoff-lookup {"clockNumber":"048213"}` returns that employee's name, every balance and every request, **including FMLA leave**. That is medical-adjacent information protected by federal law. An employer that leaks it has a compliance problem, not just a bug.
- The lookup returns the employee's `TMO-` references, and `timeoff-cancel` needs only a reference plus the clock number. Anyone who knows a coworker's badge number can **cancel their approved vacation**. A request that has not started is cancelled immediately, with no supervisor step.
- `validate` is a name-enumeration oracle. The limit is 10/min per IP **per isolate** (see H2), so a loop over a 6-digit space from a few IPs recovers the roster in hours.
- The Worker URL is public: it sits in `form-utils.js` on a public GitHub Pages site.

**Recommended fix:** Add a second factor that only the employee has. The access code is one secret shared by the whole plant, so it stops outsiders but not a coworker. Flip it on now anyway, because it closes the internet-facing half today. Then add a per-employee PIN: HR issues it, the roster stores it hashed, and the validate flow checks it.

**Fixed code example.** Step 1 is a one-line change: set the secret first, then flip the switch and deploy.

```sh
wrangler secret put ACCESS_CODE        # must exist first, or every route answers 500
```
```js
const REQUIRE_ACCESS_CODE = true;
```

Step 2: a per-employee PIN on every clock-number route (Worker half; the validate flow compares it against a hashed roster column and answers 404 on mismatch, keeping the "unknown vs wrong PIN" ambiguity):

```js
const PIN = { max: 6, required: true, re: /^\d{4,6}$/ };

validate:          { /* … */ fields: { clockNumber: CLOCK_NUMBER, pin: PIN } },
'timeoff-lookup':  { /* … */ fields: { clockNumber: CLOCK_NUMBER, pin: PIN } },
'timeoff-cancel':  { /* … */ fields: { referenceId: …, clockNumber: CLOCK_NUMBER, pin: PIN, reason: TEXT(1000) } },
timeoff:           { /* … */ fields: { …, pin: PIN } },

// clockNumberExists(): forward the PIN too
body: JSON.stringify({ clockNumber, pin }),
```

Until a PIN exists, at minimum **drop FMLA rows from `projectTimeOffLookup`**,
or show them as "Protected leave" with no dates.

---

### C2. The browser chooses the record key, and the flows upsert on it: any report can be overwritten or silently lost

**Severity:** Critical
**Location:** `form-utils.js` `newRefId()`; `worker/index.js` `REF()` and `const ref = sent || makeRef(…)`; `docs/power-automate-photos.md` step 6 and `docs/power-automate-food-safety.md` ("upsert on `_ref`"); `docs/power-automate-time-off.md` ("the flow echoes the `_ref` it was sent and does not mint its own")
**Root cause:** The same value does two jobs. It is the retry idempotency key (good), and it is the permanent public identifier printed on success screens and in emails. It is 6 random digits, and it is **chosen by the client**.
**Impact:**
- **Deliberate overwrite.** A reference shows up on success screens, confirmation emails and status checks. POSTing a new maintenance or safety report with an existing `referenceId` makes the flow *Update item* on that row. An insider can rewrite someone else's safety report, and the Worker cannot tell this apart from a retry.
- **Accidental collision.** 900,000 possible values per prefix. By the birthday bound, the chance of a collision passes 50% at about 1,100 submissions and becomes near-certain within the first few thousand. A colliding maintenance request overwrites an unrelated work order. A colliding time-off request gets `already_submitted` (409), which tells the employee to cancel a request that belongs to someone else. If the dates happen to match, it gets a 200 and **nothing is written**.

**Recommended fix:** Separate the two jobs. The page sends a 122-bit random `submissionId` that is stable across retries, and the flows upsert on that. The flow mints the human-readable reference from the SharePoint item ID, which is unique by construction. The Worker already prefers a reference returned by the flow (`flowRef || ref`), so the page needs no other change.

**Fixed code example:**

```js
// form-utils.js — per-attempt idempotency key, replacing fallbackRefId's role
const pendingIds = {};
function submissionId(form) {
  return pendingIds[form] || (pendingIds[form] = crypto.randomUUID());
}
function clearSubmissionId(form) { delete pendingIds[form]; }

// worker/index.js — accepted on every write route, forwarded as _idem
const SUBMISSION_ID = { max: 36, re: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/ };
// fields: { submissionId: SUBMISSION_ID, … }
// body:   { …, _idem: clean.submissionId, _ref: undefined }   // flow mints the ref
```

```text
Flow: Get items  Filter: Idem eq '@{triggerBody()?['_idem']}'   (index the Idem column)
      empty  → Create item → Update item: Reference = concat('MNT-', formatNumber(ID,'000000'))
      exists → return its Reference unchanged (never Update from a retry)
```

Until the flows change, stop **updating** on a `_ref` match. Return the
existing reference and write nothing. That turns overwrite into "duplicate
ignored", which is recoverable.

---

### C3. On the shared kiosk, the next employee saw the previous employee's balances and requests

**✅ Fixed in this PR**
**Severity:** Critical
**Location:** `time-off-request.js` `closeGate()` / `openGate()` / `loadMine()`
**Root cause:** `closeGate()` cleared the `identity` and `mine` variables but left the rendered balance grid and request list in the DOM, and it left the "My time off" tab selected. Separately, a lookup still in flight when the badge changed was not invalidated.
**Impact:** Reproduced in Chromium. Employee A opens *My time off* and clears the badge field, or walks away and the idle timer fires. Employee B enters their badge, and the page shows **"Welcome, Bob B."** above **Alice's 111-hour balance and request list**, with *Cancel request* buttons on Alice's rows. The same happens if A's slow lookup lands after B's badge clears.
**Fixed code:**

```js
function closeGate() {
  identity = null;
  mine = null;
  cancelOpenFor = null;
  cancelSentFor = null;
  cancelSentOutcome = null;
  mineToken++;                          // orphan any lookup still in flight
  balanceGrid.textContent = '';
  reqList.textContent = '';
  gate.classList.remove('show');
}

function openGate(displayName, clockNumber) {
  // …
  if (pendingTab === 'mine') { pendingTab = 'request'; selectTab('mine'); }
  else if (!panelMine.hidden) loadMine();   // this employee's own list
}
```

The cancellation handler also drops its result if the screen changed hands
mid-request. Regression tests: `next-badge-never-sees-previous-balance` and
`late-lookup-for-previous-badge-dropped` in `tests/forms.test.mjs`. Both fail
on the old code.

---

### C4. Time off stops working for everyone at midnight on 1 January 2027

**Severity:** Critical (scheduled outage, 98 days away)
**Location:** `LEAVE_YEAR` in `worker/index.js`, again in `time-off-request.js`, the `min`/`max` of both date inputs and four bilingual error strings in `time-off-request.html`, and the `outside_leave_year` copy in `time-off-request.js`
**Root cause:** The window is hardcoded on purpose, because balances are loaded per year. Moving it takes coordinated edits in 3 files and 8 places, plus a SharePoint balance load.
**Impact:** From 00:00 on 1 Jan, every request fails with `outside_leave_year`, including requests *for* January. Employees cannot request time off over the holiday period, when demand peaks. The code comment says as much ("a hard stop for the whole feature").
**Recommended fix:** Make the Worker the single source of truth and let the page read it. Allow an overlap window so December requests for January work once the new balances are loaded.

**Fixed code example:**

```js
// worker/index.js — env-driven, no redeploy of the page needed
function leaveYear(env) {
  return { from: env.LEAVE_YEAR_FROM || '2026-01-01', to: env.LEAVE_YEAR_TO || '2026-12-31' };
}
// GET /config  → { leaveYear: { from, to } }   (cacheable for 5 min)
// checkTimeOffDates(clean, env) uses leaveYear(env)
```
```js
// time-off-request.js — on load
PortalForm.lookupJSON('config', {}).then(({ ok, data }) => {
  if (!ok || !data.leaveYear) return;
  LEAVE_YEAR = data.leaveYear;
  ['startDate', 'endDate'].forEach(id => {
    const el = document.getElementById(id);
    el.min = LEAVE_YEAR.from; el.max = LEAVE_YEAR.to;
  });
});
```
Build the error copy from `LEAVE_YEAR` rather than the literal "2026".
Put a calendar reminder for **1 December 2026** on the go-live checklist.

---

## High priority

### H1. Production employee data runs through a personal Cloudflare account

**Severity:** High
**Location:** `form-utils.js:20` — `PROXY = 'https://portal-submit-proxy.thibautleclercq98.workers.dev'`
**Root cause:** The Worker was deployed from an individual's account.
**Impact:** Flow URLs with `sig=` tokens, the access code and employee leave data all sit in an account the company does not control. If that person leaves, loses the account or gets compromised, the company loses the portal and possibly the data. It also bypasses corporate audit, SSO and billing, and most IT security policies prohibit it.
**Recommended fix:** Move the Worker to a company-owned Cloudflare account. Serve it on a company domain route such as `portal-api.<company-domain>/*`, so the URL does not change the next time ownership changes. Deploy it from CI (see H5).

```toml
# wrangler.toml
account_id = "<company account id>"
routes = [{ pattern = "portal-api.example.com/*", zone_name = "example.com" }]
workers_dev = false
```

---

### H2. The rate limit is per IP per isolate, so the whole plant shares one allowance and an attacker gets many

**Severity:** High
**Location:** `worker/index.js` `rateLimited()` and `LIMITS`
**Root cause:** The rate limiter is an in-memory `Map`. Plant Wi-Fi and kiosks almost always NAT to **one public IP**.
**Impact:**
- **Legitimate users get blocked.** At shift change, dozens of employees on the same network share 6 submissions and 10 badge checks per minute. The 11th badge typed in a minute gets "Too many checks right now". This gets worse as more employees use the portal.
- **Attackers are barely slowed.** Each Cloudflare isolate has its own counter, so the real ceiling is 10 × isolates × IPs.

**Recommended fix:** Use Cloudflare's Rate Limiting binding, which is consistent across isolates. Key lookups on IP **and** clock number, so one badge can't be hammered and one NAT doesn't starve the plant.

```toml
[[ratelimits]]
name = "LOOKUP_LIMITER"
namespace_id = "1001"
simple = { limit = 5, period = 60 }      # per key
```
```js
const key = form.limitBucket === 'lookup'
  ? `lookup:${ip}:${payload.clockNumber}`   // per badge, per network
  : `submit:${ip}`;
const { success } = await env.LOOKUP_LIMITER.limit({ key });
if (!success) return json({ ok: false, error: 'rate_limited', … }, 429, origin);
```
Raise the per-IP submit ceiling to match the size of the site, and add a
per-clock-number daily cap on `validate` to stop enumeration.

---

### H3. `/submit/status` returned the flow's entire row to anyone

**✅ Fixed in this PR**
**Severity:** High
**Location:** `worker/index.js` `FORMS.status` (`passthrough: true`)
**Root cause:** The time-off lookups were projected, but the status route, which needs **no access code**, passed the flow's JSON straight through.
**Impact:** Walking the `SAF-`/`MNT-`/`SUG-` range returns whatever columns the status flow's row has, or gains later: reporter email, description, `_sourceIp`. Anonymous suggestions are part of that range.
**Fixed code:**

```js
function projectStatus(data) {
  const ts = data.timestamp;
  return {
    found: data.found === true,
    status: str(data.status, 40),
    timestamp: typeof ts === 'number' && Number.isFinite(ts) ? ts : str(ts, 40),
    maintenanceComments:   str(data.maintenanceComments, 4000),
    safetyManagerComments: str(data.safetyManagerComments, 4000),
    managerComments:       str(data.managerComments, 4000),
  };
}
// FORMS.status: { …, passthrough: true, project: projectStatus, … }
```
This also fixes a runtime error: `status-check.html` called `comment.trim()`
and threw on a non-string comment. Tests: `status-projected`,
`status-non-string-comment-is-empty`.

---

### H4. Business logic lives in Power Automate flows that are not in source control

**Severity:** High
**Location:** `docs/power-automate-*.md` describe the flows. The flows themselves are edited by hand in the Power Automate designer.
**Root cause:** Power Automate is the actual backend, but there is no export in the repo.
**Impact:** The most security-critical checks live in unreviewed and unversioned flows: reference ownership on cancel, OData filter construction, upsert semantics (C2), balance arithmetic. A bad edit can't be diffed or rolled back. The docs themselves record the contracts drifting ("the four flows do not agree").
**Recommended fix:** Put the flows in a Power Platform **solution**. Export it on every change with `pac solution export` and unpack it into `flows/` with `pac solution unpack`. Review flow changes in PRs like any other code. Longer term, move balance and ownership logic into the Worker or an Azure Function, where it can be tested.

---

### H5. Deploys are manual, and there is no staging, monitoring or alerting

**Severity:** High
**Location:** `worker/README.md` "Deploying" (`wrangler deploy` from a laptop); `.github/workflows/ci.yml` has no deploy job
**Impact:** Nobody learns that a flow is failing until employees complain. What runs can drift from what is committed, and the README says the dashboard has already drifted once. A bad Worker deploy has no rollback path except someone's laptop.
**Recommended fix:**

```yaml
# .github/workflows/deploy-worker.yml
on: { push: { branches: [main], paths: ['worker/**'] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production          # requires approval
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run test:worker
      - uses: cloudflare/wrangler-action@v3
        with: { apiToken: '${{ secrets.CF_API_TOKEN }}', workingDirectory: worker }
```
Turn on Workers Logs or Logpush. Add a Cloudflare notification on the error
rate, and a synthetic check that runs `GET /health` and one `status` lookup
every 5 minutes. Add one structured log line per request:
`console.log(JSON.stringify({ form: formKey, status, ms, error }))`. It must
contain no payload fields.

---

### H6. SharePoint list thresholds and Power Automate quotas will limit scale

**Severity:** High (at thousands of employees)
**Location:** the flows' `Get items` filters: `Reference eq '…'`, `ClockNumber eq '…'`
**Impact:** A filter on an **unindexed** column fails once the list passes 5,000 items, and a years-old request list will get there. HTTP-triggered flows are also subject to per-flow and per-licence request limits, and a flow that is throttled at 09:00 on a Monday returns 429 or times out.
**Recommended fix:** Index `Reference`, `ClockNumber` and (after C2) `Idem` in every list. Archive request rows yearly. Check the licence's action limits against peak volume, which is roughly employees × 2 lookups per request.

---

## Medium priority

### M1. The access-code comparison leaked the code's length through timing — ✅ Fixed

**Location:** `worker/index.js` `safeEqual()`. It returned early when the lengths differed.
**Fix:** Both sides are hashed with SHA-256 before a constant-time XOR over 32 bytes. Tests: `safe-equal-*`.

### M2. `email` was not validated server-side — ✅ Fixed

**Impact:** The flows email this address. A direct POST could set it to any string, including a list of external addresses, which turns the company mailbox into a relay.
**Fix:** `email: { max: 254, email: true }`, with the same regex as `form-utils.js`. Test: `invalid-email-rejected`.
**Still recommended:** The flows should only send confirmations to the company domain, or not send them at all to addresses that haven't been verified.

### M3. The single-photo `photo` field skipped the base64 check — ✅ Fixed

**Impact:** `base64ToBinary()` in the flow produces a corrupt attachment and raises no error. The `photos` array already checked this; `photo` did not.
**Fix:** Scalar fields now accept `base64: true`. Test: `single-photo-must-be-base64`.

### M4. No sanity check on hours against dates — ✅ Fixed

**Impact:** "80" typed for an 8-hour single day was accepted and booked, or rejected by the flow for insufficient balance with a misleading message.
**Fix:** The Worker rejects `too_many_hours` when hours > days × 24, a ceiling no genuine request can reach. The page shows the problem at the field in both languages. Tests: `timeoff-hours-vs-days: *`, `hours-beyond-the-dates-refused`.

### M5. API responses were cacheable and sniffable — ✅ Fixed

**Fix:** Every Worker response now carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Lookups carry names and leave history, and a shared kiosk's HTTP cache is not a place for either. Test: `responses-not-cached`.

### M6. No Content Security Policy

**Location:** every page. GitHub Pages can't set headers, but a `<meta>` CSP works.
**Impact:** No XSS sink takes dynamic data today. `lang.js` restricts `innerHTML` to static attributes, and every data-driven render uses `textContent`. That is good work. CSP is the backstop if that ever regresses.
**Recommended fix:** Move the inline `onclick=` handlers (four of them) and inline `<script>` blocks into files first, then:

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com;
  img-src 'self' data: blob:;
  connect-src 'self' https://portal-api.example.com;
  manifest-src 'self'; worker-src 'self';
  object-src 'none'; base-uri 'self'; form-action 'none'">
```

### M7. Anonymous suggestions can carry EXIF metadata

**Location:** `photo-upload.js` `process()`. When the canvas can't decode a format (HEIC on most desktops), the **original bytes** are sent.
**Impact:** Original photos carry the device model, the capture time and often GPS. That breaks the on-screen promise that anonymous suggestions "cannot be traced".
**Recommended fix:** On the suggestion form, when `anonymous === 'Yes'`, refuse photos that could not be re-encoded:

```js
// PortalPhoto.init({ requireReencode: () => anonChecked() })
if (!shrunk && opts.requireReencode && opts.requireReencode()) return null;  // → 'unsupported'
```

### M8. Half-filled safety and maintenance forms persist on the shared kiosk

**Location:** `safety-concern.html`, `maintenance-request.html`, `suggestion-form.html`
**Impact:** The time-off page has a 5-minute idle reset. The other forms keep the description, the email and the photos for the next person at the kiosk. On the suggestion form, that can expose someone who chose not to be anonymous.
**Recommended fix:** Move the idle timer from `time-off-request.js` into `form-utils.js` as `PortalForm.resetWhenIdle(resetForm)` and call it from each form page.

### M9. The access code is entered through `window.prompt()`

**Impact:** The dialog can't be styled or translated beyond its text, and it isn't announced consistently by screen readers. Some kiosk browsers and embedded webviews suppress it, and in that case the employee sees nothing and the submission silently "cancels". It also shows the code in clear text on a shared screen.
**Recommended fix:** Use an in-page `<dialog>` with an `<input type="password" autocomplete="off">` and a labelled submit button, and return a promise from `askForCode()` so `submitJSON` keeps its shape.

---

## Low priority

| # | Issue | Location | Fix |
|---|---|---|---|
| L1 | `/health` reveals whether the access code is on | `worker/index.js` | Fine for ops; remove `requiresCode` once monitoring exists |
| L2 | Stale comment: Halloween says "24 and 31 October", but the calendar runs from 8 Sep | `index.html` seasonal CSS header | Correct the comment |
| L3 | Figtree is loaded in 8 weights, render-blocking, on every page | `<link href="…fonts.googleapis.com…">` | Load only the 4 weights used, and self-host (also removes a third party from CSP) |
| L4 | `currentLang()` is re-implemented 5 times | pages + scripts | Export once from `lang.js` (`PortalLang.current()`) |
| L5 | Inline page scripts are not linted | `*.html` `<script>` blocks | Move each to `<page>.js`, as `time-off-request.js` already is |
| L6 | `photo-upload.js` clears `items` before a superseded batch is dropped | `accept()`, single-photo mode | Move `items = []` after the `token !== batch` check |
| L7 | The migration shim duplicates photo #1 upstream | `withLegacyPhotoFields()` | Delete once the maintenance flow reads `photos` |
| L8 | `sw.js` caches every same-origin GET indefinitely | `fetch` handler | Cache only `SHELL` paths; the others are fine network-only |

---

## Architecture review

**Structure.** Static multi-page site, one edge proxy, a low-code backend.
That is a sound choice for a small team: nothing to patch, cheap hosting,
secrets kept off the client. The Worker is the best-engineered part of the
system. It has a declarative field schema, drops unknown fields, guards
against spreadsheet formula injection, lets through only an allowlist of
upstream errors, and projects every response.

**Anti-patterns and technical debt**

1. **Constants duplicated across the tiers without a shared source.**
   `LEAVE_YEAR` (3 places), `LEAVE_TYPES` (3: Worker, `<option>`s, the flow
   Switch), the photo caps (2), the reference regex (4), `EMAIL_RE` (2). Tests
   catch some of the drift but not all. **Fix:** a `shared/contract.js`
   module imported by the Worker, loaded by the pages, and asserted by one
   test. Or serve `/config` from the Worker (see C4).
2. **One field doing two jobs**: the reference is both the idempotency key and
   the public ID (C2).
3. **The real backend is unversioned** (H4).
4. **The rendering layer is imperative DOM building by hand.** It is safe
   because it uses `textContent` everywhere, but `renderRequests()` and
   `cancelPanel()` are 200 lines of `createElement`. A `<template>` element
   per row would halve that and keep the markup in HTML, where
   `html-validate` and axe can see it.
5. **Page globals.** `resetForm()`/`lookupStatus()` are global functions for
   `onclick=`, which blocks CSP (M6). Wrap each page in a module and wire
   handlers with `addEventListener`.
6. **Very long comments.** Many comments are thorough design rationale, which
   helps with audits. But about 40% of `worker/index.js` is comment lines, and some
   functions are harder to scan than the code needs. Move the rationale into
   `worker/README.md` and keep the one-line *why* inline.

**Separation of concerns.** This is good between the page, the Worker and the
flows. Each tier revalidates, and the page is treated as advisory. The one
gap is **authorization**. "Does this reference belong to this employee?" is
enforced only in a flow nobody can review (H4).

---

## UI / UX and accessibility

**Strengths**, and worth keeping:
- Bilingual throughout, including `alt` and `aria-label`, and the language
  can be switched without losing form state.
- Offline is distinguished from not-found everywhere: "couldn't check" never
  reads as "your number is wrong".
- `role="alert"` on field errors, labelled radio groups, and focus trap and
  focus return in the announcement dialog. `prefers-reduced-motion` is
  respected.
- Buttons are disabled *before* the await, so double submits can't happen.
- The axe suite runs on every page in CI.

**Issues and fixes**

| Issue | WCAG | Status |
|---|---|---|
| `role="tab"` buttons had no arrow-key navigation and no roving tabindex | 2.1.1, ARIA tabs pattern | ✅ Fixed. ←/→/Home/End; only the active tab is in the Tab order. Test: `tabs-follow-arrow-keys` |
| The access code uses `window.prompt` | 4.1.2, 3.3.2 | M9 |
| No idle reset on three of the four forms (shared kiosk) | — (privacy) | M8 |
| axe runs only on pages at rest, not with the time-off gate open, the error banner showing or the success screen | — | Add axe passes for those states |
| The status-check result isn't announced | 4.1.3 | Add `aria-live="polite"` to `#result-area`/`#not-found`/`#lookup-failed`, or move focus to the result heading |
| The "My time off" list is a stack of `div`s | 1.3.1 | Use `<ul role="list">` with one `<li>` per request so screen readers announce "list, 4 items" |
| The success screen doesn't move focus | 2.4.3 | `successScr.querySelector('h2').focus()` with `tabindex="-1"` after submit |

**Modern UI suggestions**
- Show the remaining balance **inline in the request form**, under the Hours
  field ("You have 64 h of Vacation"). The data is already loaded for the
  other tab. It prevents most `insufficient_balance` rejections before they
  happen.
- Suggest hours from the dates: once both are picked, pre-fill
  `business days × 8` as a placeholder the employee can overwrite.
- Show a "Signed in as Albiar A. — Not you?" bar at the top of the gate,
  with a one-tap clear. On a kiosk that works better than relying on the idle
  timer.

---

## Performance

The portal is small and mostly fast. Nothing here blocks deployment.

| Area | Finding | Recommendation |
|---|---|---|
| Fonts | 8 Figtree weights, render-blocking stylesheet | Self-host 4 WOFF2 files with `font-display: swap` and `<link rel="preload">` |
| `index.html` | 969 lines; about 380 are seasonal CSS shipped all year | Move seasonal CSS to `seasonal.css`, loaded by `seasonal.js` only when a season is active |
| Images | All PNGs are under 41 KB | Fine. WebP would save about 30% but isn't worth the complexity |
| Photos | Downscaled to 1600px JPEG in the browser | Good. This is the biggest performance win in the codebase |
| Service worker | Network-first with a 3s timeout; precaches the shell | Good. Restrict runtime caching to the shell (L8) |
| Worker | Two sequential flow calls on `timeoff`/`timeoff-cancel` (revalidate, then forward) | Fine at current volume. At scale, fold the roster check into the request flow and drop the extra round-trip |
| Lookups | Validate fires after 500ms of typing | Good, with a minimum length of 3. Consider 700ms on kiosks |
| Rendering | Full `renderRequests()` re-render on every cancel click | Fine at 50 rows or fewer (the projection caps it) |

No database queries run in this repository. Query performance is the
SharePoint indexing issue in H6.

---

## Code quality

**Readability and naming.** Names are good and consistent: `clockNumberExists`,
`upstreamFailure`, `projectTimeOffLookup`. Error codes are machine-readable
and mapped to bilingual copy on the page. **Duplication** is the main
weakness: the four form pages repeat the same submit, reset and success
scaffolding.

**Refactor suggestion.** A shared submit controller reduces each page to its
own validation and payload:

```js
// form-utils.js
function wireForm({ form, prefix, formKey, validate, payload, onSuccess }) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!validate()) return;
    const refId = fallbackRefId(prefix);
    setSubmitting();
    const body = await payload(refId);
    const res = await submitJSON(formKey, body);
    if (!res.ok) {
      if (res.cancelled) { restoreSubmitButton(); return; }
      showSubmitError(res.message);
      return;
    }
    clearRefId(prefix);
    onSuccess(res.referenceId || refId, res);
  });
}
```

**Exception handling.** Good. Every `fetch` path has a timeout, every JSON
parse is guarded, and AbortError is kept separate from other failures. One gap
is that `upstreamFailure` swallows the upstream body with no log line, so a
misconfigured flow is invisible. Log `formKey` and `upstream.status` only
(H5).

**Logging.** The client logs `console.error` only, which is fine. The Worker
**logs nothing at all**, which is not fine in production (H5).

---

## Testing

**Coverage today** is well above average for a project this size: 100+ Worker
checks run against the real module with `fetch` stubbed, about 60 browser
workflow checks, page checks, axe on every page, gitleaks over the full
history, and html-validate. This PR adds 18 more.

**Gaps and recommended cases**

| Area | Test case |
|---|---|
| Access code on | Run the Worker suite a second time with `REQUIRE_ACCESS_CODE` forced true (export a factory `createWorker({ requireCode })`): 401 without a code, 401 with a wrong one, 200 with a correct one in a different case or with extra spaces, 500 when the secret is unset |
| Kiosk | Idle timer fires → gate closed, form blank, **no DOM text from the previous employee** (search `document.body.innerText` for the name) |
| Cancel | Cancel with the network cut mid-request → button re-enabled, error shown, no status change |
| Cancel | Double-click Confirm → exactly one POST |
| Ref collision (after C2) | Two submissions with different `submissionId` and the same `_ref` → two rows |
| Leave year | Freeze time at 2026-12-31T23:59 and 2027-01-01T00:01 with Playwright `page.clock`; assert the page and the Worker agree |
| Status | Flow returns 404 → page shows "not found", not "couldn't check" (today the Worker turns a status 404 into a 502) |
| Offline | `context.setOffline(true)`, submit → "No connection" banner, form contents kept |
| Service worker | Offline navigation to `/time-off-request.html?tab=mine` serves the cached page |
| Photos | HEIC that can't be decoded plus anonymous → refused (M7) |
| Load | A k6 script at 200 requests/min against a staging Worker with flows stubbed. Confirm the rate limiting in H2 doesn't block one NAT'd site |
| Contract | A JSON Schema per flow response, checked in CI against a recorded fixture from each real flow |

---

## Production readiness scores

| Dimension | Score | Justification |
|---|---|---|
| **Security** | **5 / 10** | Input validation, secret handling, output encoding, formula-injection defence and secret scanning are all excellent. Identity, though, is a badge number with the access code off (C1), clients choose the record keys (C2), the Worker runs on a personal account (H1) and there is no CSP. A careful codebase with an authorization gap. |
| **Performance** | **8 / 10** | Small static pages, compression in the browser, a service worker, bounded timeouts. Fonts and the seasonal CSS are the only real waste. |
| **Maintainability** | **6 / 10** | The tests and documentation are excellent. Constants are duplicated across tiers, inline scripts go unlinted, form scaffolding is repeated, and the flows that hold the core logic are unversioned (H4). |
| **Scalability** | **5 / 10** | The static site and edge Worker scale without limit. The bottlenecks sit behind them: SharePoint's 5,000-item threshold, Power Automate quotas, the reference collision space (C2) and a per-IP limit that starves NAT'd sites (H2). |
| **Reliability** | **6 / 10** | Offline and timeout handling and idempotent retries are carefully designed. Against that: a scheduled outage on 1 Jan (C4), manual deploys, and no monitoring or alerting (H5). |
| **User experience** | **7 / 10** | Bilingual, accessible, and honest error states. The kiosk data leak (C3) is fixed here. `window.prompt` for the code, forms that don't reset when idle, and the balance not showing in the request form are what remain. |

**Overall project score: 6.2 / 10**

---

## Executive summary

The portal is a small, carefully built static site. Its Cloudflare Worker is
more defensive than most production APIs: it declares the shape of every
field, drops unknown input, guards against formula injection, projects its
responses and relays only allowlisted errors, and the test suite pins most of
that down. The front end is bilingual, accessible and honest about outages.

The weaknesses are not code quality. They are **identity, key ownership and
operations**. Time off went live with the access code off, so a coworker's
badge number is enough to read their FMLA history and cancel their vacation.
The browser chooses the key that the flows upsert on, so records can be
overwritten on purpose or by collision. The Worker runs on a personal
account, deploys by hand and logs nothing. On 1 January the leave-year
window closes and time off stops for everyone.

This PR fixes what can be fixed safely in code without changing the flows:
the kiosk data leak, status-route over-exposure, the timing leak in the
code comparison, server-side email and photo validation, the hours sanity
check, cache headers and tab keyboard access. Each has a regression test.

### Top 10 risks

1. Badge number → FMLA history and cancellation of someone else's leave (C1)
2. A client-chosen `_ref` lets anyone overwrite a safety or maintenance record (C2)
3. Random 6-digit references collide within the first ~1,100 submissions (C2)
4. Time off stops for everyone at midnight on 1 Jan 2027 (C4)
5. The Worker and its secrets run on a personal Cloudflare account (H1)
6. A NAT'd plant network shares one rate-limit allowance and blocks employees at shift change (H2)
7. Authorization logic lives in unversioned Power Automate flows (H4)
8. No monitoring or alerting; failures surface as employee complaints (H5)
9. SharePoint queries on unindexed columns start failing past 5,000 rows (H6)
10. The flows can be used as an email relay through the `email` field. The format is now checked (M2); the flows should restrict recipients

### Top 10 quick wins

1. `wrangler secret put ACCESS_CODE`, then set `REQUIRE_ACCESS_CODE = true` (C1, 5 min)
2. Hide FMLA rows in `projectTimeOffLookup` until a PIN exists (C1, 10 min)
3. Change the flows' "Update item" on a `_ref` match to "return the existing ref" (C2, 15 min per flow)
4. Index `Reference` and `ClockNumber` in every SharePoint list (H6, 10 min)
5. Put a 1 Dec calendar reminder on the leave-year checklist, and pre-load the 2027 balances (C4)
6. Turn on Workers Logs and an error-rate notification (H5, 10 min)
7. Add a synthetic `/health` check (H5, 10 min)
8. Add `aria-live` to the status-check results (5 min)
9. Load only the 4 font weights actually used (L3, 5 min)
10. Merge this PR: 7 fixes, 18 new regression checks

### Production readiness verdict

**Not ready for a rollout to thousands of employees. Ready for a limited
pilot once C1 and C2 are mitigated.**

Turning on the access code, hiding FMLA rows and stopping the flows from
overwriting on a reference match can all be done in an afternoon. After that,
the remaining risk is operational (H1, H2, H5) and the scheduled leave-year
cliff (C4). All four should be closed before the site-wide announcement, and
C4 before 1 December 2026.
