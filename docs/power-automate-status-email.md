# Status by email — the "Email me my requests" flow

What the new flow behind `POST /submit/status-email` has to do. The portal
side (the card on `status-check.html` and the Worker route) is already built;
until this flow exists and its URL is set as a Worker secret, the route answers
`500 flow_not_configured` and the page shows "We couldn't send the summary
right now".

The requests live in **Excel tables** (Excel Online (Business)), one per form:
the same tables the maintenance, safety and suggestion flows write to with
*Add a row into a table*, and that the existing status flow reads.

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

## The tables and columns

These are the same workbooks the existing **A4. Status Check - HTML Request**
flow reads. Every one is on OneDrive for Business (Location: *OneDrive for
Business*, the `me` source in that flow):

| Table       | File                                                |
| ----------- | --------------------------------------------------- |
| Maintenance | `/1. PowerAutomate Workflows/Maintenance_Tracker.xlsx` |
| Safety      | `/1. PowerAutomate Workflows/Safety_Tracker.xlsx`      |
| Suggestions | `/SuggestionTracker.xlsx`                              |

Pick the same table in each file that A4 uses. Column headers, taken from A4:

| Holds          | Maintenance           | Safety                  | Suggestions       |
| -------------- | --------------------- | ----------------------- | ----------------- |
| Reference      | `ID`                  | `ID`                    | `ID`              |
| Status         | `Status`              | `Status`                | `Status`          |
| Submitted      | `Time`                | `Time`                  | `Date`            |
| Team comments  | `MaintenanceComments` | `SafetyManagerComments` | `ManagerComments` |
| Email          | `Employee Email`      | `Employee Email`        | `EmployeeEmail`   |
| Anonymous      | —                     | —                       | `Anonymous` ⚠️    |

Note the space: `Employee Email` in maintenance and safety, `EmployeeEmail`
in suggestions. A wrong header does not cause an error. Every row just reads
as blank, nothing matches, and the flow quietly stops at Step 5.

⚠️ `Anonymous` is **not confirmed**. If the header is spelled differently,
the check silently lets everything through, so verify it against the
suggestions workbook. Excel headers are matched exactly, including capitals
and spaces.

## What the flow receives

```json
{
  "email": "ana.lopez@smurfitwestrock.com",
  "lang":  "es"
}
```

- `email` is already trimmed, lowercased and checked by the Worker against
  `LOOKUP_EMAIL`, which allows only letters, digits and `. _ % + -` before
  the `@`.
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
Excel read can neither time the employee out nor reveal anything about the
address.

## Step 3 — Read the three tables

Add one **List rows present in a table** (Excel Online (Business)) per table.
Name them `List_maintenance`, `List_safety` and `List_suggestions`. Point each
at the file and table listed in [The tables and columns](#the-tables-and-columns).

Set these on **each** of the three:

- **Show advanced options → DateTime Format: `ISO 8601`.** Without it, dates
  come back as Excel serial numbers like `46000.5`, and the email shows
  numbers instead of dates.
- **Settings (⋯ → Settings) → Pagination: On, Threshold `5000`** (or more
  than the table will ever hold). **This setting is required.** Without
  pagination the action returns only the **first 256 rows**. Excel adds new
  rows at the bottom, so once a table passes 256 rows the newest requests are
  silently left out, and those are the ones employees ask about.
- **Leave Filter Query empty.** Excel's Filter Query takes only one condition,
  and the suggestions table needs two (address *and* not anonymous). The
  matching is done in Step 4 instead, which also ignores differences in
  upper/lower case and spaces around the address.

## Step 4 — Keep only this address's rows

One **Filter array** per table. Name them `Filter_maintenance`,
`Filter_safety` and `Filter_suggestions`.

- From: `body('List_maintenance')?['value']` (and so on for each table)
- Click **Edit in advanced mode** and paste:

Maintenance and safety:

```
@equals(toLower(trim(coalesce(item()?['Employee Email'], ''))), triggerBody()?['email'])
```

Suggestions:

```
@and(
  equals(toLower(trim(coalesce(item()?['EmployeeEmail'], ''))), triggerBody()?['email']),
  not(equals(toLower(trim(coalesce(item()?['Anonymous'], ''))), 'yes'))
)
```

- `toLower(trim(...))` is why `Ana.Lopez@…` typed on a form years ago still
  matches. The Worker lowercases the address it forwards, so both sides are
  compared the same way.
- `coalesce(..., '')` stops rows with an empty email cell from failing the
  action.
- The suggestion form clears the email when "anonymous" is chosen, so
  anonymous rows should have no address at all. The `Anonymous` check is a
  second safeguard: an anonymous suggestion must never be linked to a person,
  even by mistake.
- Safety rows written with `"Not given"` (see
  `power-automate-food-safety.md`) cannot match a real address, so they need
  no special handling.
- Filter array compares values in memory, so the typed address never becomes
  part of a query and there is nothing to escape.

## Step 5 — Nothing found → stop

**Condition**, in advanced mode:

```
@and(
  empty(body('Filter_maintenance')),
  empty(body('Filter_safety')),
  empty(body('Filter_suggestions'))
)
```

- **True** → **Terminate**, status *Succeeded*. Send no email (rule 2 above).
- **False** → continue with the steps below.

The page already says "*If* any requests were sent with this address…" and
suggests checking the junk folder, so an employee who used a different address
is not misled.

## Step 6 — Per-address limit (recommended)

The Worker already limits each address to 3 requests an hour, but that counter
lives in the memory of each Cloudflare isolate (see `worker/README.md`), so it
slows a loop down without stopping it. Only the flow can count across every
request.

This step sits **after** Step 5, so it only counts addresses that are
actually about to be emailed, and the log table stays small.

In any workbook (a new `Portal logs.xlsx` is fine), create a table named
`StatusEmailLog` with two columns, `Email` and `SentAt`. Then, in the
**False** branch:

1. **List rows present in a table** on `StatusEmailLog` (`List_log`),
   DateTime Format `ISO 8601`.
2. **Filter array** (`Filter_log`), from `body('List_log')?['value']`, in
   advanced mode:
   ```
   @and(
     equals(item()?['Email'], triggerBody()?['email']),
     greaterOrEquals(ticks(item()?['SentAt']), ticks(addHours(utcNow(), -1)))
   )
   ```
3. **Condition**: `length(body('Filter_log'))` is greater than or equal to `3`
   - True → **Terminate**, status *Succeeded*
   - False → **Add a row into a table** on `StatusEmailLog` with
     `Email` = `triggerBody()?['email']` and `SentAt` = `utcNow()`, then
     continue to Step 7.

Clear out old rows once a month. The table only needs the last hour.

## Step 7 — Build the summary

Each Select below starts from the **25 most recent** matches. Excel adds new
rows at the bottom, so the list is reversed first.

One **Select** per table:

- From: `take(reverse(body('Filter_maintenance')), 25)` (and so on for each table)
- Map (switch the map to text mode and paste one JSON object per table):

Maintenance:

```json
{
  "Reference":     "@{item()?['ID']}",
  "Type":          "@{if(equals(triggerBody()?['lang'], 'es'), 'Mantenimiento', 'Maintenance')}",
  "Request":       "@{if(greater(length(coalesce(item()?['description'], '')), 10), concat(substring(item()?['description'], 0, 10), '…'), coalesce(item()?['description'], ''))}",
  "Status":        "@{item()?['Status']}",
  "Submitted":     "@{if(empty(item()?['Time']), '', formatDateTime(item()?['Time'], 'dd MMM yyyy'))}",
  "Team comments": "@{item()?['MaintenanceComments']}"
}
```

Safety:

```json
{
  "Reference":     "@{item()?['ID']}",
  "Type":          "@{if(equals(triggerBody()?['lang'], 'es'), 'Seguridad', 'Safety')}",
  "Request":       "@{if(greater(length(coalesce(item()?['description'], '')), 10), concat(substring(item()?['description'], 0, 10), '…'), coalesce(item()?['description'], ''))}",
  "Status":        "@{item()?['Status']}",
  "Submitted":     "@{if(empty(item()?['Time']), '', formatDateTime(item()?['Time'], 'dd MMM yyyy'))}",
  "Team comments": "@{item()?['SafetyManagerComments']}"
}
```

Suggestions (the date column is `Date` here, not `Time`):

```json
{
  "Reference":     "@{item()?['ID']}",
  "Type":          "@{if(equals(triggerBody()?['lang'], 'es'), 'Sugerencia', 'Suggestion')}",
  "Request":       "@{if(greater(length(coalesce(item()?['suggestion'], '')), 10), concat(substring(item()?['suggestion'], 0, 10), '…'), coalesce(item()?['suggestion'], ''))}",
  "Status":        "@{item()?['Status']}",
  "Submitted":     "@{if(empty(item()?['Date']), '', formatDateTime(item()?['Date'], 'dd MMM yyyy'))}",
  "Team comments": "@{item()?['ManagerComments']}"
}
```

`Request` is the first 10 characters of the employee's own text (`description`
for maintenance and safety, `suggestion` for suggestions), followed by `…`
when there is more. That is enough to tell requests apart while keeping the
full text out of an email that can be forwarded. Add nothing beyond these six
fields.

Then:

- **Compose** `All_rows`:
  `union(body('Select_maintenance'), body('Select_safety'), body('Select_suggestions'))`
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

The failure most likely in practice is Excel answering *"The file is locked"*
or a 429 while someone has the workbook open in the desktop app. On each
**List rows** and **Add a row** action, set Retry Policy to Exponential,
4 retries.

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
| Address with requests in all three tables | One email listing them; page shows the confirmation |
| Address with no requests | No email; page shows the **same** confirmation |
| A request in row 300+ of a table | Listed (proves pagination is on) |
| Same address 4 times within an hour | Three emails at most |
| Address stored in mixed case (`Ana.Lopez@…`) | Matches |
| Anonymous suggestion | Never listed |
| `lang: es` | Spanish subject, intro and type labels |
| Submitted dates | Shown as dates (`04 Mar 2026`), not numbers like `46085` |
| Workbook open on someone's desktop | Page still shows the confirmation; email arrives after retries, or owner gets the `Handle_failure` alert |
| Flow turned off | Page shows "We couldn't send the summary right now" |
