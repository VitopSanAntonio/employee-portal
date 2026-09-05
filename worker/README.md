# Submission proxy (Cloudflare Worker)

`index.js` is the Worker that sits between the portal on GitHub Pages and Power
Automate. The portal never holds a flow URL: it posts to this Worker, and the
Worker forwards to the real flow using URLs kept as Worker secrets.

This directory is source only — GitHub Pages serves it as a static file but
nothing in the portal loads it. It is checked in so changes get reviewed
instead of being typed into the Cloudflare dashboard, where there is no history
and no way to tell what is running.

## Routes

| Route                  | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `POST /submit/safety`      | Safety concern → `FLOW_SAFETY`                             |
| `POST /submit/suggestion`  | Employee suggestion → `FLOW_SUGGESTION`                    |
| `POST /submit/maintenance` | Maintenance request → `FLOW_MAINTENANCE`                   |
| `POST /submit/status`      | Status lookup → `FLOW_STATUS`, returns the flow's own JSON |
| `POST /submit/validate`        | Clock number → `VALIDATE_FLOW_URL`, returns `{ found, displayName }` |
| `POST /submit/timeoff`         | Time-off request → `TIMEOFF_FLOW_URL`                    |
| `POST /submit/timeoff-lookup`  | Balance + requests → `TIMEOFF_LOOKUP_FLOW_URL`           |
| `POST /submit/timeoff-cancel`  | Cancel a request → `TIMEOFF_CANCEL_FLOW_URL`             |
| `GET  /health`             | `{ ok, requiresCode }` — confirms which mode is deployed   |

## Secrets

Set with `wrangler secret put <NAME>` (or the dashboard). None of these belong
in this repository:

- `FLOW_SAFETY`, `FLOW_SUGGESTION`, `FLOW_MAINTENANCE`, `FLOW_STATUS` — the
  Power Automate trigger URLs, including their `sig=` tokens
- `VALIDATE_FLOW_URL`, `TIMEOFF_FLOW_URL`, `TIMEOFF_LOOKUP_FLOW_URL`,
  `TIMEOFF_CANCEL_FLOW_URL` — the four time-off flow trigger URLs
- `VALIDATE_SECRET` — sent to the validation flow as `X-Portal-Secret`
- `TIMEOFF_SECRET` — the same, for the three other time-off flows
- `ACCESS_CODE` — the shared employee access code

A route whose `secretHeader` is declared but unset answers 500 rather than
calling the flow without the header. An HTTP-triggered flow reachable by
unauthenticated callers is a worse failure than a route the Worker refuses to
serve, so this is deliberate: set both halves or neither.

## Time off

These four routes replace the two Microsoft Forms
(`forms.cloud.microsoft/e/ZuGyfK4j70` and `.../gRUsQwKJKM`). The reason for the
change is `/submit/validate`: Forms cannot check a value against a SharePoint
list, so a mistyped time clock number was only caught after submission, by
which point HR had an orphan request and no way to trace it.

The page (`time-off-request.html`) is deliberately **not linked** from
`index.html` or `time-off.html`, and is **not in `sw.js`'s precache list**,
until the switch-over. Both are the go-live change, along with pointing the two
cards on `time-off.html` at it instead of the Forms URLs.

### The clock number is the identity

Many employees at this site have no Microsoft 365 account, so there is no SSO
to lean on. The clock number is checked against the roster and that check is
the only thing standing between a request and the wrong person's name on it.
It is enforced in three places, and all three are load-bearing:

1. **Digits only** (`CLOCK_NUMBER`). The validation flow builds its SharePoint
   OData filter by string interpolation, so an apostrophe does not fail the
   query — it silently changes it. Rejected with a 400 *before* the flow is
   called.
2. **A tighter rate limit** — 10 per IP per minute, on its own `limitBucket`.
   The endpoint is an enumeration oracle: a loop over numbers returns a real
   employee name for every valid one. The separate bucket matters as much as
   the ceiling, because validation fires while the employee is still typing and
   would otherwise spend the allowance for the submission that follows.
3. **Re-validation server-side** (`revalidates`) on `/submit/timeoff` and
   `/submit/timeoff-cancel`. The page will not let an employee submit an
   unrecognised number, but the page is a courtesy — these routes answer curl.

A flow that answers **404** means "no such record", and that is passed through
as `{ found: false }` with a 404 rather than being collapsed into an error. The
page needs the distinction: "check your badge" and "we couldn't reach the
system" send an employee to very different places.

Anything else non-2xx becomes a generic 502 and **the upstream body stops at
the Worker**. A 401 from Power Automate means `VALIDATE_SECRET` is wrong, and
that must not be legible from a browser on the plant floor.

### The flow contract

`/submit/timeoff` forwards exactly this, plus the usual `_ref`,
`_submittedAt`, `_form` and `_sourceIp`:

```json
{
  "clockNumber": "048213",
  "leaveType": "Vacation",
  "startDate": "2026-09-15",
  "endDate": "2026-09-17",
  "hours": 24,
  "vacationCoversFMLA": "No",
  "notesToManager": ""
}
```

`leaveType` is matched by a Switch in the flow, so it is an allowlist
(`LEAVE_TYPES`) rather than a length cap — a near-miss like `"vacation"` would
not error, it would fall through the Switch and be accepted, logged and routed
to nobody.

> The five values live in three places that must agree exactly: `LEAVE_TYPES`
> in `worker/index.js`, the `<option value>` list in `time-off-request.html`,
> and the flow's own Switch. Change one and requests silently stop matching.

`hours` is forwarded as a **number**, not a string. Everything is tracked in
hours (8 hours = 1 day) and half days are real, so decimals are accepted.

The two lookup flows are **projected**, not passed through — `projectValidate`
and `projectTimeOffLookup` name every field that reaches the browser. Both read
rows out of an HR list, and a passthrough would hand over whatever columns
those rows happen to carry, including ones added later by whoever next edits
the SharePoint list. The projections double as the shape the flows must return:

```jsonc
// /submit/validate            → 200, or 404 with { "found": false }
{ "found": true, "displayName": "Albiar A." }

// /submit/timeoff-lookup
{
  "found": true,
  "displayName": "Albiar A.",
  "balances": [ { "leaveType": "Vacation", "hours": 64 } ],
  "requests": [ {
    "referenceId": "TMO-100001", "leaveType": "Vacation",
    "startDate": "2026-09-15", "endDate": "2026-09-17",
    "hours": 24, "status": "Pending"
  } ]
}
```

`status` values the page renders with their own colour: `Pending`, `Approved`,
`Rejected`, `Canceled`, `Cancellation requested`. Anything else renders in a
neutral pill with the raw text, so a new status is untidy rather than broken.
The page also still recognises the retired spellings `Denied` and `Cancelled`,
displaying them under the current labels, so a historical row does not drop to
the neutral pill.

`/submit/timeoff-cancel` sends `{ referenceId, clockNumber, reason }`. The
Worker checks the reference is shaped `TMO-nnnnnn` and re-validates the clock
number, but it **cannot** check that the reference actually belongs to that
employee — the flow must do that, or a stranger who guesses a TMO number can
cancel somebody's vacation.

### Still to build

`VALIDATE_FLOW_URL` exists and is tested. The other three flows do not exist
yet: those routes answer `500 flow_not_configured` until the secrets are set,
and the page turns that into "we couldn't reach the time off system", which is
the correct thing for an employee to see in the meantime.

`TMO-` references are **not** lookupable on `status-check.html`, which accepts
only `/^(MNT|SAF|SUG)-\d{4,6}$/`. The "My time off" tab is where a time-off
reference is looked up. Adding `TMO` there is a separate change.

## The access-code switch

```js
const REQUIRE_ACCESS_CODE = false;   // → true at go-live
```

This is the only place the access code is turned on or off. The portal has no
matching flag on purpose: `form-utils.js` submits without a code and prompts
for one only if this Worker answers 401. Flipping this line and redeploying is
the whole change — the two deployments cannot drift into the state where the
proxy demands a code the portal never asks for, which would show every employee
"That access code is not correct" with no way to enter one.

While it is `false`, anyone who learns the Worker URL can post to the flows.
That is acceptable for a pre-launch window and not much longer.

The time-off routes honour the same switch, including the two lookups —
unlike `/submit/status`, they hand back a real employee's name and leave
history, so they are gated with everything else rather than left open.
`PortalForm.lookupGatedJSON` is the client half: same prompt-on-401 retry as a
submission, but it keeps the response body and treats a 404 as an answer.

## Request validation

`FORMS[key].fields` is the authoritative shape of a submission: which fields
exist, which are required, and how long each may be. Unknown keys are dropped
rather than forwarded, so a direct POST cannot invent columns in SharePoint.

This is not belt-and-braces on top of the forms' own JavaScript — it is the
only validation that actually runs. The Worker is reachable by anyone who has
its URL, so whatever the page checked can simply be skipped.

Adding a field to a form means adding it here too, or it is silently dropped.

## Photos

The maintenance form sends up to three:

```json
"photos": [ { "name": "pump-leak.jpg", "base64": "…" } ]
```

`PHOTOS_FIELD` enforces the count (3), the per-photo base64 cap (7 MB), the
combined cap (12 MB), and that each `base64` value really is base64 — Power
Automate's `base64ToBinary()` does not reject malformed input, it just produces
an attachment that won't open.

Before forwarding, `withLegacyPhotoFields()` also sets `photoCount` and copies
the first photo into the old `photo` / `photoName` fields. That is a migration
shim: the portal deploys with a git push and the flow is edited by hand, so
until a flow reads `photos` it keeps receiving photo #1 exactly as before.
**Delete the shim once every flow reads `photos`** — it doubles photo #1 in the
body sent upstream.

## Duplicate submissions

When a flow takes longer than `flowTimeoutMs`, the Worker gives up and answers
504 — but the flow keeps running and still creates the record. The employee
sees an error and submits again.

The pages therefore keep one reference number for the whole attempt
(`PortalForm.fallbackRefId`, cleared only on success) and the Worker forwards
it as `_ref` when present. **The flows must upsert on `_ref` rather than always
inserting**, or that retry still produces a second row for what the employee
experienced as one report.

## Things that have bitten us

- **`ALLOWED_ORIGINS` must list the real portal origin.** A wrong value fails
  *only* in a browser: `curl` sends no `Origin` header and skips the check
  entirely, so a curl smoke test passes while every employee sees an error —
  and because the rejection carries a mismatched `Access-Control-Allow-Origin`,
  the browser blocks the response and the page reports "No connection" rather
  than anything diagnosable. The portal is served from
  `https://vitopsanantonio.github.io`; verify this against Settings → Pages
  after any repository move.
- **`maxBodyBytes` has to clear the photo size.** Photos travel as base64 in
  the JSON body, and the maintenance form sends up to three. `PHOTOS_FIELD`
  caps their combined base64 at 12 MB, so `maxBodyBytes` has to clear that plus
  the rest of the JSON. Too low a ceiling rejects the submission with a 413
  before it is even parsed.
- **The photo caps are duplicated in `photo-upload.js`.** `MAX_PHOTO_B64` and
  `PHOTOS_FIELD.maxTotalBytes` here must match `maxEncodedBytes` and
  `maxTotalEncodedBytes` there. If the page's caps are the looser pair, an
  employee attaches three photos, watches them upload, and only then gets a
  400 with no way to tell which one was the problem.
- **Fallback reference IDs have to match `status-check.html`.** It accepts
  `/^(MNT|SAF|SUG)-\d{4,6}$/` in a 10-character input; anything else is a
  number the employee can be given but can never look up.
- **Anonymous suggestions must not carry `_sourceIp`.** The form promises on
  screen that they cannot be traced.
- **The clock-number digit check is not cosmetic.** It is the only thing
  stopping an apostrophe from reaching a flow that interpolates it into an
  OData filter. If `CLOCK_NUMBER.re` is ever loosened, that filter needs
  escaping first.
- **Rate limiting is per-isolate.** `hits` is an in-memory Map, and Cloudflare
  runs many isolates, so the real ceiling is `maxPerWindow × isolates` per
  minute. It is a speed bump against a stuck retry loop, not a defence against
  a determined flood — that needs a Durable Object or KV.

## Tests

`npm run test:worker` runs `tests/worker.test.mjs`, which imports this Worker
directly and exercises it against Node's own `Request`/`Response` with the
upstream `fetch` stubbed. It never touches a real flow, so it is safe to run
anywhere.

## Deploying

```sh
cd worker
wrangler deploy
```

`wrangler.toml` pins the Worker name (`portal-submit-proxy`) and the entry
point. The name determines the `*.workers.dev` URL the portal posts to, so
changing it means changing `PROXY` in `form-utils.js` to match.

Deploying from source overwrites what is live, including any edit made in the
Cloudflare dashboard. If the two have drifted, reconcile before the first
`wrangler deploy` — the intent is for this directory to be the authoritative
copy.
