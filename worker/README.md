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
| `GET  /health`             | `{ ok, requiresCode }` — confirms which mode is deployed   |

## Secrets

Set with `wrangler secret put <NAME>` (or the dashboard). None of these belong
in this repository:

- `FLOW_SAFETY`, `FLOW_SUGGESTION`, `FLOW_MAINTENANCE`, `FLOW_STATUS` — the
  Power Automate trigger URLs, including their `sig=` tokens
- `ACCESS_CODE` — the shared employee access code

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

## Things that have bitten us

- **`ALLOWED_ORIGINS` must list the real portal origin.** A wrong value fails
  *only* in a browser: `curl` sends no `Origin` header and skips the check
  entirely, so a curl smoke test passes while every employee sees an error.
- **`maxBodyBytes` has to clear the photo size.** Photos travel as base64 in
  the JSON body, and base64 inflates by ~4/3, so the portal's 5 MB image cap
  needs roughly 7 MB of headroom. Too low a ceiling rejects the submission with
  a 413 before it is even parsed.
- **Fallback reference IDs have to match `status-check.html`.** It accepts
  `/^(MNT|SAF|SUG)-\d{4,6}$/` in a 10-character input; anything else is a
  number the employee can be given but can never look up.
- **Anonymous suggestions must not carry `_sourceIp`.** The form promises on
  screen that they cannot be traced.

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
