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

## 2. Request flow → `TIMEOFF_FLOW_URL` — **built**

Replaces `https://forms.cloud.microsoft/e/ZuGyfK4j70`.

Built and HTTP-triggered. It validates the shared secret, the leaveType and the
clock number itself — defence in depth behind the Worker's own checks, not a
replacement for them — and responds as soon as the SharePoint row is written,
continuing the approval, item permissions and the two-week reminder after the
connection closes. Its response contract:

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{"referenceId": "TMO-366331"}` | Accepted. Always echoes the `_ref` it was sent. |
| 400 | `{"error": "invalid leaveType"}` | Not one of the five |
| 400 | `{"error": "insufficient_balance", "message": "…"}` | Not enough hours |
| 409 | `{"error": "already_submitted", "message": "…"}` | `_ref` already on file **and the payload differs** |
| 401 | `{"error": "unauthorized"}` | Shared secret missing or wrong |
| 400 | `{"found": false}` | Clock number not on the roster — note **400**, not 404, and no `error` key. The other three flows answer 404 here; the Worker matches on the body as well as the status so both work. |
| 500 | `{"error": "internal_error"}` | Flow failure |

`insufficient_balance` is the only one whose `message` reaches the browser —
see "What a flow is allowed to explain" in `worker/README.md`. **Flows 3 and 4
should use the same shapes**, including the same `error` spellings, so the
Worker keeps one path for all of them.

The section below is the original build note, kept because it describes the
requirements the built flow satisfies.

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
= 1 day), and always a **whole number** — the portal rejects 4.5 rather than
rounding it, on the page and again in the Worker. The flow itself still accepts
decimals; nothing coming from the portal will send one.

`vacationCoversFMLA` is `"Yes"`, `"No"`, or absent. It is optional on the form.

### Return the reference

```json
{ "referenceId": "TMO-004242" }
```

### Edit after a timeout

`Check_Duplicate` finding an existing row is not automatically a retry. The
flow compares the stored StartDate, EndDate, HoursRequested and LeaveType
against the incoming payload:

- **identical** → 200 with the existing reference. A true retry; nothing is
  written twice.
- **different** → 409 `already_submitted`. The submission timed out, the row
  was written anyway, and the employee edited something before trying again.
  Returning 200 here would discard the edit behind a success screen.

The Worker normalises that 409 to its own 400 and the page composes the
message in both languages from the reference it already holds, so the
instruction — cancel it, then submit a new one — is not English-only. The flow
still sends its own `message`; the page does not use it.

> **This instruction points at the cancel tab, which needs Flows 3 and 4.**
> Until both exist, an employee told to "cancel it under My time off" finds a
> tab that cannot load. Worth keeping in mind when sequencing go-live.

**As built, the flow echoes the `_ref` it was sent and does not mint its own.**
So the page's reference is the permanent identifier: it is what lands in
SharePoint, what the lookup flow returns, and what the cancellation flow checks
ownership against. The `TMO-` plus 4–6 digits format is load-bearing — the
Worker's `timeoff-cancel` route rejects anything else.

### Upsert on `_ref`, do not insert

When a flow takes longer than the Worker's 20-second timeout, the Worker gives
up but the flow keeps running and still creates the record. The employee sees
an error and submits again — with the **same** `_ref`, because the page holds
one reference for the whole attempt.

**Key the SharePoint write on `_ref`.** Always inserting produces two rows for
what the employee experienced as one request, and two vacation bookings for one
week off.

---

## 3. Lookup flow → `TIMEOFF_LOOKUP_FLOW_URL` — **built**

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

**All four balance buckets come back every time, zeros included** — an employee
with no Legacy Carryover gets a `0` row rather than a missing one, because the
zero tells them the category exists. The page renders them as sent and does not
filter. `balances` is entitlement − used − pending, so the number shown is what
can actually be requested right now, and the request flow applies the same
arithmetic — the page and the submit check agree by construction.

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

## 4. Cancellation flow → `TIMEOFF_CANCEL_FLOW_URL` — **built**

Responds before starting the supervisor approval, like the request flow.

### The response says which of two things happened

| Case | `status` returned |
| --- | --- |
| FMLA | `Canceled` |
| Request was `Pending` | `Canceled` |
| `Approved`, starts in the future | `Canceled` |
| `Approved`, already started or past | `Cancellation requested` |

```json
{ "status": "Canceled", "referenceId": "TMO-100001" }
```

The page reads this and says the matching thing — `Canceled` means the hours
are already back, `Cancellation requested` means the time off is still in
effect until a supervisor confirms. Most cancellations are for time that has
not happened yet; only cancelling time already taken is a real decision,
because it asserts the employee actually worked those days.

### Error exits

| Status | Body |
| --- | --- |
| 401 | `{"error": "unauthorized"}` |
| 404 | `{"error": "not_found"}` |
| 409 | `{"error": "not_cancellable", "message": "…"}` |

**The 404 is ambiguous on purpose and must stay that way.** It covers both "no
such reference" and "belongs to a different employee", so that walking the
`TMO-` range teaches a stranger nothing. Neither the Worker nor the page
distinguishes them, and the page's copy is written not to hint at which
occurred.

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

## Go-live — done in this commit

Steps 2, 3 and 4 below are **already applied**. What is left is step 1, which is
a check, and step 5, which is a thing to do in Power Automate afterwards.

1. **All four flows built and their secrets set.** `wrangler secret list` should
   show `VALIDATE_FLOW_URL`, `VALIDATE_SECRET`, `TIMEOFF_FLOW_URL`,
   `TIMEOFF_LOOKUP_FLOW_URL`, `TIMEOFF_CANCEL_FLOW_URL` and `TIMEOFF_SECRET`.
   Nothing in this repository can verify that — confirm it before merging.

2. ✅ **`LEGACY_FALLBACK = false` in `time-off.html`.** The switch. The file
   carries both sets of cards — the two portal cards and the two Microsoft
   Forms links — and this lever picks which set is visible. Both sets still
   ship, which is what makes the rollback one line rather than a rewrite.

3. ✅ **`ANNOUNCE = false` in `announce.js`.** The coming-soon popup stops being
   true the moment the cards switch; it would otherwise advertise the page
   directly behind it. Its markup stays in `index.html`, hidden, for the same
   reason the legacy cards do.

4. ✅ **`CACHE_VERSION` bumped to `portal-v9` in `sw.js`.** Without it a
   returning phone can keep serving the pre-go-live `time-off.html` — with
   `LEGACY_FALLBACK` still `true` inside it — for as long as the old cache
   lives.

5. **Turn off the two Microsoft Forms** so nothing arrives by two routes at
   once. Do this *after* confirming the merge is live on the site, not before —
   while the Forms are still on, the rollback in the next section costs nothing.

### Rolling back

Set `LEGACY_FALLBACK = true` in `time-off.html`, bump `CACHE_VERSION` again, and
push. Employees are back on the Microsoft Forms within a cache cycle. Turn
`ANNOUNCE` back on only if the delay is going to be long enough to be worth
explaining.

Requests already filed in the portal stay in SharePoint and stay cancellable —
rolling back hides the portal cards, it does not remove the pages. An employee
with the direct link still reaches a working `time-off-request.html`.

### Every January — the leave year

Requests are confined to one calendar year, currently **2026**. A request with
either date outside it is refused with `outside_leave_year`. This exists because
balances are loaded per year: a request against a year SharePoint has no
balances for has nothing to draw on, and because it stops a mistyped year (a
slip in a date picker) booking time off decades out.

**It has a cliff.** At 00:00 on 1 January 2027 every request starts failing
until the window is moved. That is a hard stop for the whole feature, not a
degradation — so move it together with the new year's balances, before the
year turns rather than after.

The window is written in three places and all three must move together:

| File | What to change |
| --- | --- |
| `worker/index.js` | `const LEAVE_YEAR = { from: …, to: … }` — the one that enforces it |
| `time-off-request.js` | `const LEAVE_YEAR = { from: …, to: … }` — so the field says so before a submission fails |
| `time-off-request.html` | `min` / `max` on both `<input type="date">`, and the "dates in 2026" wording in the two `data-*-year` messages and the `SUBMIT_ERRORS.outside_leave_year` copy |

A test reads the window out of `worker/index.js` and fails if the page script or
either date picker disagrees, so a half-done rollover is caught by the build
rather than by an employee. The wording is not checked — prose is the one part
still worth reading yourself.

#### Leave the old year open for a few weeks

The plant has no sick days, so employees use Floating Holiday for them — often
an hour or two at a time, and usually filed **after** the fact, once they are
back. That is why there is no four-hour floor on anything but Vacation.

It means the rollover is not a clean switch. Somebody out sick on 30 December
who files on 2 January is filing 2026 dates against a 2027 window, and gets
`outside_leave_year` for a request that is perfectly legitimate.

So when you roll over, move `to` and leave `from` where it is for a few weeks:

    from: '2026-01-01',  to: '2027-12-31'

Both years are then bookable, the stragglers get in, and you narrow `from` to
`'2027-01-01'` once they have. The only thing the wide window gives up in the
meantime is some of the protection against a mistyped year, which is worth it
for a fortnight.

If you would rather not, the alternative is fine too — the handful of late
January filings go in by hand. Just decide which before the year turns, rather
than while somebody is standing at the kiosk.

### Known at go-live

- **Requests made on the old Microsoft Form cannot be cancelled in the portal.**
  They carry neither a `ClockNumber` (so they never appear under My time off)
  nor a `ReferenceId` (so the cancel route would refuse them). Those go through
  the old cancellation form or the supervisor until the backlog ages out. The
  portal shows such a row, if one ever appears, as a record with no cancel
  button rather than a button that cannot work.

- **A backfill is possible but needs both columns at once.** `ClockNumber`
  alone makes the rows visible with no way to act on them. References assigned
  by hand should be five digits (`TMO-90001` and up): `makeRef` only ever mints
  six, so the shorter band cannot collide with a real one. The cancellation
  flow's "does this reference belong to this clock number" check is what keeps
  backfilled rows safe — confirm it is really in the built flow first.
