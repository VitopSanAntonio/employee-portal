/* ── Seasonal styling ────────────────────────────────────────────
   Loaded by index.html only. The portal's other pages carry safety
   concerns, food safety reports and FMLA leave requests; a screen
   someone uses to report an injury is not a screen to decorate.

   Everything seasonal hangs off a class this file adds, so each
   season arrives and leaves on its own — no deploy to put it up,
   none to take it down, and nobody has to remember. Deleting this
   file, the seasonal CSS block and the decoration markup removes
   the feature entirely.

   theme.css already disables every animation under
   prefers-reduced-motion, so anything seasonal inherits that.
──────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /**
   * The calendar. getMonth() is zero-based, so 2 is March and 11 is December.
   *
   * Windows must not overlap: the first match wins and the rest are skipped,
   * so an overlap would silently hide a season rather than fail. A test walks
   * this list and rejects one.
   *
   *   flyers  the decoration that makes one pass and is then removed
   *   flight  how long to leave it there, in milliseconds
   *
   * `flight` must outlast the last flyer: take its animation-delay, add its
   * duration, and leave a second of slack. Set it short and the last one is
   * deleted mid-crossing — which is a visible bug, not a subtle one. Each
   * season's figures are next to its CSS in index.html.
   */
  const SEASONS = [
    { name: 'stpatrick',    from: [2, 1],   to: [2, 17],  flyers: '.flock-stpatrick',    flight: 13000 },
    { name: 'fiesta',       from: [3, 15],  to: [3, 30],  flyers: '.flock-fiesta',       flight: 15000 },
    { name: 'pride',        from: [5, 1],   to: [5, 30],  flyers: '.flock-pride',        flight: 14000 },
    { name: 'halloween',    from: [8, 8],   to: [9, 31],  flyers: '.bats',               flight: 12000 },
    { name: 'thanksgiving', from: [10, 1],  to: [10, 30], flyers: '.flock-thanksgiving', flight: 14000 },
    { name: 'christmas',    from: [11, 1],  to: [11, 31], flyers: '.flock-christmas',    flight: 16000 }
  ];

  /**
   * The flyers make one pass and are then taken out of the document.
   *
   * This is the whole reason the decoration is affordable: the portal runs on
   * a shared floor kiosk that stays open all shift, and an animation left
   * looping there burns CPU for hours to no purpose. A finite entrance costs
   * a few seconds and then nothing at all.
   *
   * Under prefers-reduced-motion the flyers never display, so this only ever
   * removes something that was already invisible. What stays behind in that
   * case — and after the flight in every case — is the season's still
   * decoration, which is why every season has one.
   */
  function launch(season) {
    const flock = document.querySelector(season.flyers);
    if (!flock) return;
    flock.classList.add('fly');
    setTimeout(() => flock.remove(), season.flight);
  }

  /**
   * Waits for nothing to be covering the page.
   *
   * The home page can open a coming-soon dialog on load. Flyers launched at
   * the same moment cross the hero behind it and are removed before it is
   * dismissed, so the one animation an employee was meant to see is over
   * before they can see it.
   *
   * Waits for DOMContentLoaded rather than a timer. This file runs before
   * announce.js, so asking now would always find the dialog hidden — and a
   * setTimeout(0) is no better: announce.js is fetched over the network, and
   * while the parser blocks on that fetch the event loop is free to run
   * timers, so the callback can land before the dialog has opened. That is
   * exactly what it did. DOMContentLoaded cannot fire until every
   * parser-inserted script has run, which is the guarantee needed here.
   */
  function whenTheViewIsClear(run) {
    const check = () => {
      const modal = document.getElementById('announce');
      if (!modal || modal.hidden) { run(); return; }
      const watch = new MutationObserver(() => {
        if (modal.hidden) { watch.disconnect(); run(); }
      });
      watch.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', check, { once: true });
    } else {
      check();
    }
  }

  const now = new Date();
  const month = now.getMonth();
  const day = now.getDate();

  for (const s of SEASONS) {
    const afterStart = month > s.from[0] || (month === s.from[0] && day >= s.from[1]);
    const beforeEnd  = month < s.to[0]   || (month === s.to[0]   && day <= s.to[1]);
    if (afterStart && beforeEnd) {
      document.documentElement.classList.add('season-' + s.name);
      whenTheViewIsClear(() => launch(s));
      break;
    }
  }
})();
