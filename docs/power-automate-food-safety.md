# Safety flow — routing food safety reports

The safety concern form now files two kinds of report through the same flow.
Employees pick one at the top of the page; everything else about the form,
the `SAF-` reference series and the status lookup is unchanged.

## What changed in the payload

Two new fields on `POST /submit/safety`:

```json
{
  "concernType":  "Food safety",
  "foodCategory": "Pest activity",
  "location":    "Break room / Common Area",
  "urgency":     "Low — No immediate danger",
  "description": "Table in the break room was left dirty after break.",
  "solution":    "",
  "email":       "",
  "photo":       "…",
  "photoName":   "…",

  "_ref": "SAF-123456", "_submittedAt": "…", "_form": "safety", "_sourceIp": "…"
}
```

- `concernType` is `"Safety"` or `"Food safety"`.
- `foodCategory` is set only when `concernType` is `"Food safety"`; it is `""`
  for a personal-safety report, even if the employee picked a category and then
  switched the type back.
- `email` is optional and may be empty. It is the only field identifying the
  reporter — see the KPI section below.

**`concernType` can also be absent.** The Worker deliberately does not require
it: a page cached before this change must never have a safety report rejected
for omitting a field that did not exist when it was cached. Treat absent as
`"Safety"` everywhere:

```
coalesce(triggerBody()?['concernType'], 'Safety')
```

## Step 1 — Trigger schema

Add to `properties`:

```json
"concernType":  { "type": "string" },
"foodCategory": { "type": "string" },
```

Do **not** add either of them to `required`.

## Step 2 — Route on the type

Add a **Condition** after the record is created (and after the Response — see
below), testing:

```
@equals(coalesce(triggerBody()?['concernType'], 'Safety'), 'Food safety')
```

- **If yes** → notify the food safety / quality owner. Subject line worth using:
  `Food safety — @{triggerBody()?['foodCategory']} — @{triggerBody()?['location']}`
- **If no** → the existing safety manager notification, unchanged.

A Switch on the same expression works too and is easier to extend if a third
type is ever added.

## Step 3 — Store the type

Add `concernType` and `foodCategory` as columns on the
SharePoint list (or the workbook). Even if both types share one notification
mailbox at first, storing the type is what makes the KPI countable later —
and backfilling it is not possible.

Make `concernType` a Choice column, not free text, so the report can group on
it without cleanup.

## Step 4 — The reporting KPI

Reporting counts toward an employee goal, so the number that matters is
**reports per employee per period**. The form carries no name field: `email` is
the only thing identifying the reporter, and the directory turns it into a name.

`email` is optional, which is deliberate — a required identity suppresses
exactly the safety reports people are most reluctant to file, and losing those
costs more than an uncounted observation. The consequence is that **a report
with no email cannot be attributed to anyone**, so expect the KPI to
under-count rather than to be exact.

Two things worth doing in the flow:

- Where `email` is empty, write `"Not given"` to the reporter column rather
  than leaving it blank. A blank cell is indistinguishable from a column that
  failed to populate.
  ```
  if(empty(triggerBody()?['email']), 'Not given', triggerBody()?['email'])
  ```
- Resolve the name once, at write time, rather than in every report you build
  later. The Office 365 Users connector's **Search for users (V2)** on the
  submitted address gives you a display name; store both.

If the under-count becomes a real problem, making `email` required is a
one-line change on the form — but weigh it against the reports you would stop
receiving.

## Step 5 — Don't let volume become noise

This is the risk specific to a KPI-driven programme: people report to hit a
number, and a queue that was 3 reports a week becomes 60. If every one sends an
immediate email, the food safety owner starts ignoring the inbox, and a real
pest sighting is lost among dirty-table observations.

Recommended from the start, not after it becomes a problem:

- Email immediately **only** for `urgency` = `High — Immediate danger`
  (rendered as "Product may be affected" on the food safety branch).
- Everything else goes to the list, and a second scheduled flow sends the food
  safety owner **one digest** each morning with the previous day's reports.
- The digest is also where the KPI numbers belong: reports per department,
  reports per person, and how many are still open.

That keeps the KPI's incentive to report high while keeping the signal usable.

## Order of operations

Same as the maintenance flow, and for the same reason — the Cloudflare Worker
times out the flow after 20 seconds:

1. Create or update the record (upsert on `_ref`)
2. **Response** with `_ref`
3. Condition on `concernType`
4. Send the notification

## Test plan

| Case | Expect |
| --- | --- |
| Safety, High urgency | Safety manager notified, `concernType` = Safety, `foodCategory` empty |
| Food safety, Pest activity | Food safety owner notified, both fields populated |
| Food safety, then switched back to Safety before submitting | `foodCategory` empty — the form clears it |
| Email left blank | Reporter column written as "Not given", not an empty cell |
| Payload with `concernType` omitted entirely | Treated as Safety, nothing rejected |
