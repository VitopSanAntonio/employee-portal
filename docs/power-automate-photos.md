# Maintenance flow — moving from 1 photo to 3

What the maintenance flow has to change now that the form sends up to three
photos. Everything on the portal side is already deployed; the flow is the
remaining half.

The Worker keeps sending the old single-photo fields as well, so **the flow
does not break while it is being edited** — an unmigrated flow still receives
photo #1 exactly as before. Take the steps in order and nothing is ever in a
half-working state.

## What the flow receives now

```json
{
  "referenceId": "MNT-123456",
  "department":  "Facility",
  "location":    "Press 4, north side",
  "issueType":   "Air compressor 1 (AC-01)",
  "description": "Hydraulic leak under the main ram.",
  "priority":    "High",
  "email":       "someone@smurfitwestrock.com",

  "photos": [
    { "name": "leak-wide.jpg",  "base64": "/9j/4AAQSkZJRg…" },
    { "name": "leak-close.jpg", "base64": "/9j/4AAQSkZJRg…" }
  ],
  "photoCount": 2,

  "photo":     "/9j/4AAQSkZJRg…",   // = photos[0].base64  — legacy, remove later
  "photoName": "leak-wide.jpg",     // = photos[0].name    — legacy, remove later

  "_ref":         "MNT-123456",
  "_submittedAt": "2026-08-24T14:02:11.418Z",
  "_form":        "maintenance",
  "_sourceIp":    "203.0.113.7"
}
```

`photos` is **absent entirely** when no photo was attached — not `[]`. Always
wrap it in `coalesce(…, createArray())` and never mark it `required` in the
trigger schema.

## Step 1 — Trigger schema

*When an HTTP request is received* → **Use sample payload to generate schema**,
paste the JSON above, or paste this directly:

```json
{
  "type": "object",
  "properties": {
    "referenceId": { "type": "string" },
    "department":  { "type": "string" },
    "location":    { "type": "string" },
    "issueType":   { "type": "string" },
    "description": { "type": "string" },
    "priority":    { "type": "string" },
    "email":       { "type": "string" },
    "photos": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name":   { "type": "string" },
          "base64": { "type": "string" }
        },
        "required": [ "name", "base64" ]
      }
    },
    "photoCount":   { "type": "integer" },
    "photo":        { "type": "string" },
    "photoName":    { "type": "string" },
    "_ref":         { "type": "string" },
    "_submittedAt": { "type": "string" },
    "_form":        { "type": "string" },
    "_sourceIp":    { "type": "string" }
  },
  "required": [ "referenceId", "department", "location", "issueType", "description", "priority" ]
}
```

Keep `required` to the fields the Worker itself marks required. A schema that
requires something optional makes the trigger reject a perfectly good
submission — and the employee sees a generic "could not be sent".

## Step 2 — Build the attachment array (one Select, no branching)

Add **Data Operations → Select** before the email. Name it `Select_attachments`.

**From**

```
coalesce(triggerBody()?['photos'], createArray())
```

**Map** — click the ⇄ icon on the right of the Map box to switch to text mode,
then paste:

```json
{
  "Name": "@item()?['name']",
  "ContentBytes": "@base64ToBinary(item()?['base64'])"
}
```

Use `@…`, **not** `@{…}`. The braces force the value through string
interpolation, which turns the binary content back into text and produces an
attachment that downloads but will not open.

This one action covers zero, one, two and three photos. No Condition, no
`if(empty(…))`, no three parallel branches — and raising the limit to five
later is a change in the Worker only.

## Step 3 — Send an email (V2)

In the **Attachments** section, use the icon on the right to
**Switch to input entire array**, then set it to:

```
@body('Select_attachments')
```

An empty array is valid — the email simply sends with no attachments — so the
zero-photo case needs no special handling.

Useful in the body:

```
Photos attached: @{length(coalesce(triggerBody()?['photos'], createArray()))}
```

> If an attachment ever arrives corrupt, the first thing to try is dropping
> `base64ToBinary()` and mapping `"ContentBytes": "@item()?['base64']"`. Both
> forms are accepted by the Outlook connector; which one a given connector
> version prefers is the usual cause of an attachment that will not open.

## Step 4 — SharePoint attachments (only if you store them there)

The list item has to exist first, so this goes after *Create item*:

- **Apply to each** → From: `@body('Select_attachments')`
- Inside: **SharePoint → Add attachment**
  - Id: the *Create item* → `ID`
  - File Name: `@{item()?['Name']}`
  - File Content: `@item()?['ContentBytes']`

Set the Apply to each's **Concurrency Control** to off (sequential). SharePoint
returns a 409 when two attachments are added to the same item at once.

## Step 5 — Respond before you send the email

This is the change worth making even if you were not adding photos.

The Worker gives the flow **20 seconds** (`LIMITS.flowTimeoutMs`) and then
answers 504. The flow keeps running and still files the request, but the
employee sees an error and submits again. Sending an email with three
attachments is exactly the step that pushes a flow past 20 seconds.

Order the actions:

1. *Create item* (or *Add a row*) — the record exists
2. **Response** — `{ "referenceId": "@{triggerBody()?['_ref']}" }`, status 200
3. *Select_attachments*
4. *Send an email (V2)*
5. SharePoint attachments

The employee gets their reference number in about a second, and the email takes
as long as it takes. Use `_ref` rather than a SharePoint ID: the Worker has
already made it unique and stable across retries, and it is the format
`status-check.html` can look up.

## Step 6 — Upsert on `_ref`, don't insert

Unchanged from before, but it matters more now that payloads are larger and
timeouts more likely. Before creating the record:

- **Get items** with Filter Query: `Reference eq '@{triggerBody()?['_ref']}'`
- **Condition**: `@empty(body('Get_items')?['value'])`
  - Yes → *Create item*
  - No → *Update item* on the existing `ID`

Without this, one timeout equals two work orders for one broken machine.

## Step 7 — Error handling

**Scope + run-after.** Wrap steps 3–5 in a *Scope* named `Notify`. Add a second
scope `Handle_failure`, and in its **Configure run after** tick *has failed*,
*is skipped* and *has timed out* on `Notify`. Inside it, send yourself an email
with:

```
Flow: @{workflow()?['name']}
Run:  @{workflow()?['run']?['name']}
Ref:  @{triggerBody()?['_ref']}
Result: @{result('Notify')}
```

`result('Notify')` returns the status and error of every action in the scope —
it is the difference between "a request went missing last Tuesday" and knowing
which action failed and why.

The record is already created and the Response already sent by then, so a failed
email never costs the employee their request.

**Retry policy.** On *Send an email (V2)* → Settings, set Retry Policy to
Exponential, 4 retries. The default fixed retry is fine for a 500 but poor for
throttling, which is what a burst of photo-heavy emails actually hits.

**Don't validate what the Worker already validated.** Count, size and base64
shape are enforced before the flow ever sees the request (`PHOTOS_FIELD` in
`worker/index.js`), and enforcing them twice means two places to change. One
guard is worth adding, because it is about *this* flow's mailbox rather than the
contract:

```
if(greater(length(coalesce(triggerBody()?['photos'], createArray())), 3), true, false)
```

→ Terminate with status `Failed` and a message naming `_ref`.

## Step 8 — Remove the legacy fields

Once the flow reads `photos` and you have watched a few real submissions land:

1. Delete `photo` / `photoName` from the trigger schema and from any action
   that still references them.
2. Delete `withLegacyPhotoFields()` from `worker/index.js` and its tests.

Until then it duplicates photo #1 in the body sent upstream. Harmless, but it is
not free and it is easy to forget.

## Size limits

| Where | Limit | Set in |
| --- | --- | --- |
| Source file the employee picks | 10 MB each | `maxSourceBytes`, `photo-upload.js` |
| After resizing (what actually travels) | ~200–600 KB each | `maxEdge` 1600 px, `quality` 0.82 |
| One photo, base64 | 7 MB | `MAX_PHOTO_B64`, `worker/index.js` |
| All photos combined, base64 | 12 MB | `PHOTOS_FIELD.maxTotalBytes` |
| Whole request body | 14 MB | `LIMITS.maxBodyBytes` |
| Exchange Online message | 25 MB incl. base64 inflation → ~18 MB of attachments | tenant setting |

The Worker's caps and the page's caps are duplicated on purpose — the page fails
fast and in the employee's language, the Worker is what actually holds, because
anyone with the Worker URL can skip the page. **They have to be changed
together**: if the page is the looser of the two, an employee attaches three
photos, waits through the upload, and only then gets a 400 with nothing on
screen to say which photo was the problem.

The reason the real numbers land so far under every ceiling is Step 0, which
happens in the browser before any of this: each photo is drawn into a canvas at
no more than 1600 px on the long edge and re-encoded as JPEG at quality 0.82.
A 4 MB phone photo becomes roughly 350 KB with no visible loss of the detail a
tech needs — a leak, a cracked guard, a fault code on a panel. Three compressed
photos are a smaller upload than the one uncompressed photo the form used to
send, which matters on a plant handset on the far side of the warehouse.
