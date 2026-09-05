# Time off — building the four flows

What Power Automate has to provide for `time-off-request.html`. The portal half
and the Worker half are done; these flows are the remaining piece.

The page is **not linked** from the portal yet, so nothing here is urgent and
nothing here can break the live site. Build the flows in the order below —
each one lights up a bit more of the page, and the page degrades to a plain
"we couldn't reach the time off system" message for whatever is not built yet.

## Why this exists

Time off went through a Microsoft Form where the employee picked their name
from a dropdown, which let anyone submit on anyone's behalf. Replacing the name
with a time clock number fixed that, but **Forms cannot validate a value
against a SharePoint list** — a mistyped number was only caught after
submission, by which point HR had an orphan request and no way to trace it.

The portal page checks the number against the roster *before* the employee can
submit anything. That check is the whole reason for the change.

## Constraint: no Microsoft account

Many employees at this site have no Microsoft 365 account. Every flow here is
an **HTTP-triggered** flow called by the Worker, never a Forms trigger and
never anything that assumes a signed-in Microsoft identity. The employee's
browser never talks to Power Automate directly.

## Authentication

Each flow is called with a shared secret in the `X-Portal-Secret` header:

- validation flow → `VALIDATE_SECRET`
- the other three → `TIMEOFF_SECRET`

**Check it as the first action** and return 401 if it does not match. An
HTTP-triggered flow URL is a bearer token on its own, but the header means a
leaked URL alone is not enough. The Worker never forwards a 401's body to the
browser, so a mismatch shows as a generic "could not be delivered" rather than
telling an attacker what went wrong.

Set both halves of each pair, or neither — the Worker answers 500 rather than
calling a flow whose declared secret is unset.

---

## 1. Validation flow → `VALIDATE_FLOW_URL`

**Built and tested already.** Documented here because the other three depend
on it, and because the Worker calls it a second time on its own to
re-validate before writing anything.

Receives:

```json
{ "clockNumber": "048213" }
```

Returns **200** when the number is on the roster:

```json
{ "found": true, "displayName": "Albiar A." }
```

…and **404** when it is not:

```json
{ "found": false }
```

> The 404 matters. The page shows "Number not recognized — check your badge"
> for a 404 and "we couldn't check right now — this doesn't mean it's wrong"
> for anything else. Returning 200 `{"found": false}` for an outage would send
> an employee to their supervisor over a badge number that was right all along.

`displayName` is shown on screen as "Welcome, Albiar A." — an initial rather
than a full surname is deliberate, so a shared floor kiosk does not put a full
name in front of whoever walks up next.

> **Do not add fields to this response.** The Worker projects it down to
> `found` and `displayName` before it reaches the browser, so extra roster
> columns are dropped rather than leaked — but the flow shouldn't be sending
> them in the first place.

### The OData filter

The flow builds its SharePoint filter by string interpolation. The Worker
guarantees `clockNumber` is `/^\d{1,10}$/` and rejects anything else with a 400
*before* calling this flow, which is the only thing preventing an apostrophe
from silently changing the query. **If that check is ever loosened, escape the
filter here first.**

---

## 2. Request flow → `TIMEOFF_FLOW_URL`

Replaces `https://forms.cloud.microsoft/e/ZuGyfK4j70`. This is the one to build
first — the request form is the page's main tab.

Receives:

```json
{
  "clockNumber": "048213",
  "leaveType": "Vacation",
  "startDate": "2026-09-15",
  "endDate": "2026-09-17",
  "hours": 24,
  "vacationCoversFMLA": "No",
  "notesToManager": "Family trip.",
  "_ref": "TMO-366331",
  "_submittedAt": "2026-09-04T02:28:13.337Z",
  "_form": "timeoff",
  "_sourceIp": "10.0.0.37"
}
```

`leaveType` is one of exactly these five strings, matched by a Switch:

- `Vacation`
- `Floating Holiday`
- `LSK CarryOver`
- `Perfect Attendance Reward`
- `FMLA`

> **Type these into the Switch exactly as written.** A near-miss does not error
> here — it falls through the Switch and the request is accepted, logged, and
> routed to nobody. That is why the Worker rejects anything not on the list
> rather than just capping its length.
>
> The same five strings live in `LEAVE_TYPES` in `worker/index.js` and in the
> `<option value>` list in `time-off-request.html`. All three have to agree.

`hours` is a **number**, not a string — everything is tracked in hours (8 hours
= 1 day) and half days are real, so expect decimals like `4.5`.

`vacationCoversFMLA` is `"Yes"`, `"No"`, or absent. It is optional on the form.

### Return the reference

```json
{ "referenceId": "TMO-004242" }
```

The Worker prefers the flow's reference over the page's fallback. Either way
the employee is shown one, so the format has to be `TMO-` plus 4–6 digits — the
"My time off" tab matches on it.

### Upsert on `_ref`, do not insert

When a flow takes longer than the Worker's 20-second timeout, the Worker gives
up but the flow keeps running and still creates the record. The employee sees
an error and submits again — with the **same** `_ref`, because the page holds
one reference for the whole attempt.

**Key the SharePoint write on `_ref`.** Always inserting produces two rows for
what the employee experienced as one request, and two vacation bookings for one
week off.

---

## 3. Lookup flow → `TIMEOFF_LOOKUP_FLOW_URL`

Powers the "My time off" tab: the balance the employees have been asking for,
and the list of their existing requests.

Receives `{ "clockNumber": "048213" }` and returns:

```json
{
  "found": true,
  "displayName": "Albiar A.",
  "balances": [
    { "leaveType": "Vacation", "hours": 64 },
    { "leaveType": "Floating Holiday", "hours": 8 }
  ],
  "requests": [
    {
      "referenceId": "TMO-100001",
      "leaveType": "Vacation",
      "startDate": "2026-09-15",
      "endDate": "2026-09-17",
      "hours": 24,
      "status": "Pending"
    }
  ]
}
```

Return **404** for a clock number with no record, same as the validation flow.

`status` values the page gives their own colour:

| Status                    | Pill    | Cancellable |
| ------------------------- | ------- | ----------- |
| `Pending`                 | yellow  | yes         |
| `Approved`                | green   | yes         |
| `Rejected`                | fuchsia | no          |
| `Canceled`                | grey    | no          |
| `Cancellation requested`  | indigo  | no          |

Anything else renders in a neutral pill showing the raw text, so a status you
add later is untidy rather than broken. `Rejected` and `Canceled` were
previously spelled `Denied` and `Cancelled`; the page still recognises both older
spellings and shows them under the current labels, so historical rows do not
drop to the neutral pill. New rows should use the spellings in the table.

Sort newest first — the page renders the array in the order it arrives.

> The Worker projects this response too, and drops every key not listed above.
> Approver emails, accrual codes and HR notes will not reach the browser even
> if the flow sends them, but don't send them.

---

## 4. Cancellation flow → `TIMEOFF_CANCEL_FLOW_URL`

Replaces `https://forms.cloud.microsoft/e/gRUsQwKJKM`. Receives:

```json
{
  "referenceId": "TMO-100001",
  "clockNumber": "048213",
  "reason": "Plans changed.",
  "_ref": "TMO-100001",
  "_submittedAt": "2026-09-04T02:28:13.337Z",
  "_form": "timeoff-cancel"
}
```

**The flow must check that `referenceId` actually belongs to `clockNumber`.**
The Worker verifies the reference is shaped `TMO-nnnnnn` and re-validates the
clock number against the roster, but it has no way to know whose request that
reference is. Without this check, a stranger who guesses a TMO number can
cancel somebody's vacation.

Keep the existing behaviour otherwise: notify the supervisor, and return the
hours to the balance once the cancellation is confirmed. The page shows
"Cancellation requested" immediately and says the supervisor will confirm — it
does not assume the cancellation is already final.

Return 200 on success. `reason` is optional and may be an empty string.

---

## Testing without touching the live site

The page is unlinked, so open it directly:

```
https://vitopsanantonio.github.io/employee-portal/time-off-request.html
```

Set the secrets one flow at a time (`wrangler secret put …`, see
`worker/wrangler.toml`). Until a flow's secret is set, its route answers 500
and the page shows a plain "couldn't reach the time off system" message — which
is exactly what an employee would see during a real outage, so it is worth
looking at once on purpose.

`npm run test:worker` exercises every route against a stubbed upstream, so the
Worker's half can be verified with no flow at all.

## Go-live

1. All four flows built and their secrets set.
2. Point both cards on `time-off.html` at `time-off-request.html` instead of
   the two `forms.cloud.microsoft` URLs.
3. Remove the preview banner and the `noindex` meta from
   `time-off-request.html`.
4. Add `time-off-request.html`, `time-off-request.js` and
   `timeclock-card-example.png` to `SHELL` in `sw.js` and bump
   `CACHE_VERSION`, so the page works offline like the rest. The photo matters
   here: "where do I find my number" is exactly the question an employee has
   when they are standing somewhere with no signal.
5. Turn off the Microsoft Forms so nothing arrives by two routes at once.
