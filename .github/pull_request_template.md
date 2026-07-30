## What changed

<!-- Describe the change and why it was needed. -->

## Manual QA checklist

Run through the flows this change touches (CI covers the rest):

- [ ] **Safety concern** — submit with and without a photo; verify the error banner appears when offline
- [ ] **Suggestion** — submit anonymously and with an email
- [ ] **Maintenance request** — submit and confirm the reference number displays
- [ ] **Status check** — look up a known reference number
- [ ] **Time off** — submit a request
- [ ] **Language toggle** — switch to Español on the touched pages; no untranslated text
- [ ] No webhook URLs, keys, or other secrets added to the diff
