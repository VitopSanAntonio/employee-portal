# Prompt for building the Power Automate flows

Copy everything below the line into a **new Claude conversation** (claude.ai).
It is self-contained — Claude will not have this repo, so the prompt carries
every contract it needs.

Attach `docs/power-automate-time-off.md` to that conversation if you can; it
saves repeating yourself. The prompt works without it.

**Work one flow at a time.** Ask for Flow 2, build it, test it, then come back
for Flow 3. A single conversation that tries to produce all three at once will
give you three half-specified flows.

---

I'm building Power Automate flows for a manufacturing plant's employee portal
and I need step-by-step build instructions I can follow in the Power Automate
designer. Please act as an experienced Power Automate developer walking me
through it.

## Context

Smurfit Westrock's San Antonio Bag-in-Box facility has a static employee portal
(GitHub Pages). It posts to a Cloudflare Worker, which holds the Power Automate
flow URLs as secrets and forwards to the flows. **The employee's browser never
calls Power Automate directly** — only the Worker does.

Time off used to go through a Microsoft Form where the employee picked their
name from a dropdown, which let anyone submit on anyone's behalf. We replaced
the name with their time clock number. Forms can't validate a value against a
SharePoint list, so a typo was only caught after submission and HR ended up
with orphan requests. The new portal page checks the clock number against the
roster before the employee can submit anything.

**Critical constraint: many of these employees have no Microsoft 365 account.**
Every flow must be an HTTP-triggered flow ("When an HTTP request is received").
Nothing may assume a signed-in Microsoft identity, SSO, or Azure AD. Do not
suggest a Forms trigger, a "for a selected item" trigger, or anything requiring
the employee to authenticate.

The validation flow already exists and works. I need the other three.

## What already exists

**Validation flow** — HTTP trigger. Receives `{ "clockNumber": "048213" }`,
looks the number up in a SharePoint roster list, and returns either
200 `{ "found": true, "displayName": "Albiar A." }` or 404 `{ "found": false }`.
It builds its OData filter by string interpolation; the Worker guarantees the
value is digits-only before calling it.

I'll tell you the roster list's actual columns when you ask.

## Shared requirements for all three flows

**Authentication.** Each flow is called with a shared secret in an
`X-Portal-Secret` header. Make checking it the **first action**, and return 401
if it doesn't match. Show me exactly how to read a custom header from the HTTP
trigger and compare it — this is the part I always get wrong.

**Response shapes are a contract.** The Worker validates and projects
responses, and the portal page reads specific keys. If a key name drifts, the
page silently shows nothing rather than erroring. Don't rename anything.

**404 means "no such record"** and is a real answer, not an error. The page
shows different messages for a 404 and for a failure, so returning 200 with an
empty result instead of 404 would tell an employee their correct badge number
is wrong.

Everything is tracked in **hours**, not days. 8 hours = 1 day, and half days
are real, so expect decimals like 4.5.

---

## Flow 2 — Submit a time off request

Receives this JSON:

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

`leaveType` is exactly one of five strings, matched by a Switch:
`Vacation`, `Floating Holiday`, `LSK CarryOver`, `Perfect Attendance Reward`,
`FMLA`.

`vacationCoversFMLA` is `"Yes"`, `"No"`, or absent. `hours` arrives as a JSON
number, not a string.

It must:
1. Check the shared secret.
2. Write the request to SharePoint, notify the employee's supervisor, and
   branch on `leaveType` — I'll describe the existing routing when you ask.
3. Return `{ "referenceId": "TMO-004242" }` — `TMO-` plus 4 to 6 digits.

**The upsert requirement.** When a flow takes longer than the Worker's
20-second timeout, the Worker gives up but the flow keeps running and still
creates the record. The employee sees an error and resubmits — with the *same*
`_ref`, because the page holds one reference for the whole attempt. So the
SharePoint write must **look up `_ref` first and update the existing row if it
finds one**, rather than always creating. Show me how to do that without a race
between two near-simultaneous retries. Otherwise one week off gets booked
twice.

Please also tell me what happens in your design if the Switch gets a value that
isn't one of the five — I want it to fail loudly, not fall through silently.

## Flow 3 — Look up balance and existing requests

Receives `{ "clockNumber": "048213" }`. Returns:

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

404 if the clock number has no record.

`status` must be one of: `Pending`, `Approved`, `Rejected`, `Canceled`,
`Cancellation requested` — the page colours each one. Sort `requests` newest
first.

Return **only** these keys. No approver emails, accrual codes or HR notes —
this response goes to a browser.

I need help with the balance calculation specifically: show me how to compute
remaining hours per leave type from an entitlement column minus approved and
pending requests, and tell me whether that's better done in the flow or as a
calculated column in SharePoint.

## Flow 4 — Cancel a request

Receives:

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

`reason` is optional and may be an empty string. Return 200 on success.

**The security check that only this flow can do:** it must verify that
`referenceId` actually belongs to `clockNumber`. The Worker checks the
reference is shaped `TMO-nnnnnn` and re-validates the clock number against the
roster, but it has no way to know whose request a reference is. Without this
check, anyone who guesses a TMO number can cancel someone else's vacation.
Please make this explicit in the steps and tell me what to return when it
fails.

Behaviour otherwise: notify the supervisor, mark the request
`Cancellation requested`, and only return the hours to the balance once the
supervisor confirms — the cancellation is a request, not an immediate undo.

---

## How I'd like the answer

- **One flow at a time.** Start with Flow 2. Don't write all three at once.
- Numbered steps naming the **exact action** to add ("Add a *Condition*
  control", "Add *Send an HTTP request to SharePoint*"), since I'm clicking
  through the designer.
- Give me the actual **expressions** to paste, in full, not descriptions of
  them. Flag any that are version-sensitive.
- Show the **Response** action's status code, headers and body for every exit
  path, including the error paths.
- Tell me what to put in the trigger's **Request Body JSON Schema**.
- Call out anywhere Power Automate will do something surprising — silent type
  coercion, a null that becomes an empty string, `int()` vs `float()` on the
  hours field, timezone handling on the dates.
- If any of this is a bad idea or there's a simpler shape, say so before
  writing the steps.

Ask me about the SharePoint list names and columns before you start — I have
them in front of me.
