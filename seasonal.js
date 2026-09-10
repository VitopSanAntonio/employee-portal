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

  /**
   * The bats make one pass and are then taken out of the document.
   *
   * This is the whole reason the decoration is affordable: the portal runs on
   * a shared floor kiosk that stays open all shift, and an animation left
   * looping there burns CPU for hours to no purpose. A finite entrance costs
   * nine seconds and then nothing at all.
   *
   * Must outlast the last bat: it launches at 3.4s and flies for 8s, so it is
   * clear of the screen at 11.4s. Anything shorter deletes a bat mid-crossing.
   * Keep this in step with .bat / .bat-3 in index.html. Under
   * prefers-reduced-motion the bats never display, so this only ever removes
   * something that was already invisible.
   */
  const BAT_FLIGHT_MS = 12000;

  function retireTheBats() {
    const bats = document.querySelector('.bats');
    if (bats) setTimeout(() => bats.remove(), BAT_FLIGHT_MS);
  }

  const now = new Date();
  const month = now.getMonth();
  const day = now.getDate();

  for (const s of SEASONS) {
    const afterStart = month > s.from[0] || (month === s.from[0] && day >= s.from[1]);
    const beforeEnd  = month < s.to[0]   || (month === s.to[0]   && day <= s.to[1]);
    if (afterStart && beforeEnd) {
      document.documentElement.classList.add('season-' + s.name);
      retireTheBats();
      break;
    }
  }
})();
