# Prompt for building the Power Automate flows

Copy everything below the line into a **new Claude conversation** (claude.ai).
It is self-contained — Claude will not have this repo, so the prompt carries
every contract it needs.

Attach `docs/power-automate-time-off.md` to that conversation if you can; it
saves repeating yourself. The prompt works without it.

**Flow 2 (the request flow) is built.** Two remain: the lookup and the
cancellation. Work one at a time — ask for Flow 3, build it, test it, then come
back for Flow 4. A single conversation that tries to produce both at once will
give you two half-specified flows.

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

Two flows already exist and work: the validation flow and the request flow. I
need the lookup flow and the cancellation flow.

## What already exists

**Validation flow** — HTTP trigger. Receives `{ "clockNumber": "048213" }`,
looks the number up in a SharePoint roster list, and returns either
200 `{ "found": true, "displayName": "Albiar A." }` or 404 `{ "found": false }`.
It builds its OData filter by string interpolation; the Worker guarantees the
value is digits-only before calling it.

**Request flow** — HTTP trigger. Writes a time-off request to SharePoint. It
responds as soon as the row is written and continues the approval, item
permissions and a reminder branch after the connection closes, which keeps the
caller's round trip to one lookup and one write. It looks up the incoming
`_ref` before creating anything and returns the existing reference if a row is
already there, so a retry is idempotent.

Its response contract is the pattern I want the two new flows to follow
exactly — same status codes, same body shapes, same `error` spellings:

| Status | Body |
| --- | --- |
| 200 | `{"referenceId": "TMO-366331"}` |
| 400 | `{"error": "invalid leaveType"}` |
| 400 | `{"error": "insufficient_balance", "message": "…"}` |
| 409 | `{"error": "already_submitted", "message": "…"}` |
| 401 | `{"error": "unauthorized"}` |
| 404 | `{"found": false}` |
| 500 | `{"error": "internal_error"}` |

Only `insufficient_balance` has its `message` shown to the employee; the caller
collapses everything else into a generic failure, so don't put anything
diagnostic in the other bodies.

I'll tell you the roster and request lists' actual columns when you ask.

## Shared requirements for both flows

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

## Flow 2 — Submit a time off request — **already built**

Described above as the pattern to match. Nothing to do here.

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
`Cancellation requested` — the page colours each one. These match the
SharePoint columns exactly, including the inconsistency: `Canceled` has one L,
`Cancellation requested` has a lowercase r. Don't normalise them. Sort
`requests` newest first.

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

- **One flow at a time.** Start with Flow 3. Don't write both at once.
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
