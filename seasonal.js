/* ── Seasonal styling ────────────────────────────────────────────
   Loaded by index.html only. The portal's other pages carry safety
   concerns, food safety reports and FMLA leave requests; a screen
   someone uses to report an injury is not a screen to decorate.

   Everything seasonal hangs off a class this file adds, so the
   season arrives and leaves on its own — no deploy to put it up,
   none to take it down, and nobody has to remember. Deleting this
   file and its CSS block removes the feature entirely.

   theme.css already disables every animation under
   prefers-reduced-motion, so anything seasonal inherits that.
──────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // getMonth() is zero-based: 9 is October. The window opens the week
  // before and closes when November starts, so November 1st is a
  // normal portal again without anyone touching it.
  const SEASONS = [
    { name: 'halloween', from: [8, 8], to: [9, 31] }
  ];

  const now = new Date();
  const month = now.getMonth();
  const day = now.getDate();

  for (const s of SEASONS) {
    const afterStart = month > s.from[0] || (month === s.from[0] && day >= s.from[1]);
    const beforeEnd  = month < s.to[0]   || (month === s.to[0]   && day <= s.to[1]);
    if (afterStart && beforeEnd) {
      document.documentElement.classList.add('season-' + s.name);
      break;
    }
  }
})();
