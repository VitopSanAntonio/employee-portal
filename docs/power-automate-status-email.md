# Status by email — the "Email me my requests" flow

What the new flow behind `POST /submit/status-email` has to do. The portal
side (the card on `status-check.html` and the Worker route) is already built;
until this flow exists and its URL is set as a Worker secret, the route answers
`500 flow_not_configured` and the page shows "We couldn't send the summary
right now".

## Why it emails instead of answering

Employees asked to check their requests by email address instead of reference
number. Work addresses are easy to guess, so a page that *listed* the requests
for a typed address would show anyone a colleague's safety concerns, and even
"no requests found" would reveal who has filed something. The flow therefore
mails the summary **to the address that was typed**, and the browser always gets
the same answer. Only the mailbox owner ever sees the list.

Everything below follows from that. Three rules matter most:

1. **Respond before looking anything up.** The response must not depend on
   what was found, how long the search took, or whether the search failed.
2. **Send nothing when nothing matches.** That way the company mailbox only
   ever writes to addresses that were already given to it on a form, so the
   route cannot be used to send mail to arbitrary addresses.
3. **Never return any data in the Response.** The Worker throws the body away
   (`blind: true` in `worker/index.js`), but a flow that keeps its Response
   empty does not depend on that.

## What the flow receives

```json
{
  "email": "ana.lopez@smurfitwestrock.com",
  "lang":  "es"
}
```

- `email` is already trimmed, lowercased and checked by the Worker against
  `LOOKUP_EMAIL`. The check allows only letters, digits and `. _ % + -` before
  the `@`, so no apostrophe can reach an OData filter.
- `lang` is `en` or `es`, or absent (treat absent as `en`).

Nothing else is forwarded: no source IP, no reference, no access code.

## Step 1 — Trigger

**When an HTTP request is received**, with this request body schema:

```json
{
  "type": "object",
  "properties": {
    "email": { "type": "string" },
    "lang":  { "type": "string" }
  },
  "required": ["email"]
}
```

## Step 2 — Respond immediately

Add the **Response** action directly after the trigger:

- Status code: `202`
- Body: `{ "ok": true }`

The Worker gives the flow 30 seconds and treats any 2xx (and a 404) as
success. Because this response comes before any lookup, a slow or failing
SharePoint search can neither time the employee out nor reveal anything about
the address.

## Step 3 — Per-address limit

The Worker already limits each address to 3 requests an hour, but that counter
lives in the memory of each Cloudflare isolate (see `worker/README.md`), so it
slows a loop down without stopping it. The real limit belongs here, because
only the flow can count across every request.

Create a small SharePoint list, **Status email log**, with one text column,
`Email`. Then:

- **Get items** on it with Filter Query:
  `Email eq '@{outputs('Safe_email')}' and Created ge '@{addHours(utcNow(), -1)}'`
  (define `Safe_email` in Step 4 first, or put this step after it)
- **Condition**: `length(body('Get_items_log')?['value'])` is greater than or
  equal to `3`
  - Yes → **Terminate**, status *Succeeded*
  - No → **Create item** in the log with `Email` set to the address

Add a retention policy or a monthly cleanup to the list. It only needs to hold
the last hour.

## Step 4 — Escape the address once

**Compose** named `Safe_email`:

```
replace(triggerBody()?['email'], '''', '''''')
```

The Worker already rejects apostrophes, so this changes nothing today. It is
here so that loosening the pattern later cannot quietly turn into a filter
injection. Use `outputs('Safe_email')` in every filter below and never the
raw trigger value.

## Step 5 — Find the requests

One **Get items** per list. `Email` below means the column each form's
`email` field is written to; use that list's real internal column name.

| List        | Filter Query                                                                      |
| ----------- | --------------------------------------------------------------------------------- |
| Maintenance | `Email eq '@{outputs('Safe_email')}'`                                             |
| Safety      | `Email eq '@{outputs('Safe_email')}'`                                             |
| Suggestions | `Email eq '@{outputs('Safe_email')}' and Anonymous ne 'Yes'`                      |

On each one, set **Order By** to `Created desc` and **Top Count** to `25`.

- SharePoint's `eq` on a text column ignores case, so `Ana.Lopez@…` stored on
  the row still matches the lowercased address.
- The suggestion form clears the email when "anonymous" is chosen, so
  anonymous rows should have no address at all. The `Anonymous ne 'Yes'`
  clause is a second safeguard: an anonymous suggestion must never be linked
  to a person, even by mistake.
- Safety rows written with `"Not given"` (see
  `power-automate-food-safety.md`) cannot match a real address, so they need no
  special handling.

## Step 6 — Nothing found → stop

**Condition**: all three `value` arrays are empty:

```
and(
  empty(body('Get_items_maintenance')?['value']),
  empty(body('Get_items_safety')?['value']),
  empty(body('Get_items_suggestions')?['value'])
)
```

- Yes → **Terminate**, status *Succeeded*. Send no email (rule 2 above).

The page already says "*If* any requests were sent with this address…" and
suggests checking the junk folder, so an employee who used a different address
is not misled.

## Step 7 — Build the summary

One **Select** per list, mapping each row to the same five fields the status
page shows. Include nothing else: an email can be forwarded, and the summary
does not need the description or location to be useful.

| Key            | Maintenance                 | Safety                         | Suggestions               |
| -------------- | --------------------------- | ------------------------------ | ------------------------- |
| Reference      | `item()?['Reference']`      | `item()?['Reference']`         | `item()?['Reference']`    |
| Type           | `Maintenance` / `Mantenimiento` | `Safety` / `Seguridad`     | `Suggestion` / `Sugerencia` |
| Status         | `item()?['Status']`         | `item()?['Status']`            | `item()?['Status']`       |
| Submitted      | `formatDateTime(item()?['Created'], 'dd MMM yyyy')` | same       | same                      |
| Team comments  | `item()?['MaintenanceComments']` | `item()?['SafetyManagerComments']` | `item()?['ManagerComments']` |

Pick the Type label with `if(equals(triggerBody()?['lang'], 'es'), 'Seguridad', 'Safety')`
and so on. The comment columns are the ones the existing status flow already
reads; reuse its column names.

Then:

- **Compose** `All_rows`: `union(body('Select_maintenance'), body('Select_safety'), body('Select_suggestions'))`
- **Create HTML table** from `outputs('All_rows')`, columns *Automatic*

## Step 8 — Send it

**Send an email (V2)**:

- To: `triggerBody()?['email']`. Always the address that was typed, never a
  value read from a row.
- Subject: `if(equals(triggerBody()?['lang'], 'es'), 'Tus solicitudes — portal del empleado', 'Your requests — employee portal')`
- Body: a short intro in the chosen language, then the HTML table, then:
  *"You received this because someone asked for a summary of requests sent
  with this address on the employee portal. If it wasn't you, you can ignore
  this email; nothing has changed."* (and the Spanish equivalent).

Set Retry Policy to Exponential, 4 retries, as in `power-automate-photos.md`.

## Step 9 — Error handling

Wrap steps 3–8 in a **Scope** named `Summarise`, and add a `Handle_failure`
scope that runs after it *has failed / is skipped / has timed out*. Have it
email the portal owner the run name and `result('Summarise')`, **without the
employee's address**. The employee already got their 202, so a failure here is
silent to them, and this alert is the only way anyone finds out.

## Step 10 — Connect it to the Worker

```sh
cd worker
wrangler secret put FLOW_STATUS_EMAIL   # paste the trigger URL, sig= and all
```

No deploy is needed for the secret itself, but the route only exists from the
Worker version that includes it, so deploy the Worker first if it is older.

## Test checklist

| Case | Expected |
| ---- | -------- |
| Address with requests in all three lists | One email listing them; page shows the confirmation |
| Address with no requests | No email; page shows the **same** confirmation |
| Same address 4 times within an hour | Three emails at most |
| Address in mixed case (`Ana.Lopez@…`) | Matches rows stored in any case |
| Anonymous suggestion | Never listed |
| `lang: es` | Spanish subject, intro and type labels |
| SharePoint unavailable | Page still shows the confirmation; owner gets the `Handle_failure` alert |
| Flow turned off | Page shows "We couldn't send the summary right now" |
