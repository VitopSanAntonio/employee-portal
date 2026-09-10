/* ── Coming-soon announcement ────────────────────────────────────
   Loaded by index.html only, after lang.js so PortalStorage and the
   translations are already in place.

   Announces the in-portal time off pages while employees are still
   being sent to the Microsoft Forms. It is only truthful while that
   is the case — see ANNOUNCE below.
──────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /* ── THE ANNOUNCEMENT SWITCH ──────────────────────────────────
     Must be turned off when LEGACY_FALLBACK in time-off.html goes
     false: at that moment the pages below stop being "coming soon"
     and this becomes an advert for something already on the screen
     behind it. The two live in different files because the pages
     are different; keeping them in step is a go-live checklist
     item (docs/power-automate-time-off.md).

     ENDS is a backstop, not the plan. An announcement nobody
     remembers to take down is worse than one that never ran, so
     this one stops on its own whatever anybody forgets.
  ────────────────────────────────────────────────────────────── */
  const ANNOUNCE = true;
  const ENDS = new Date('2026-12-31T23:59:59');

  // Re-offered rather than dismissed forever. The floor kiosk is shared, so a
  // single "Got it" from the first person through would otherwise hide this
  // from everybody behind them; a week means a phone user is not nagged every
  // visit while the kiosk still re-announces it during the run-up.
  const SEEN_KEY = 'timeoff_announce_seen';
  const QUIET_DAYS = 7;

  const store = window.PortalStorage;
  const modal = document.getElementById('announce');
  if (!ANNOUNCE || !modal || !store || new Date() > ENDS) return;

  const seenAt = Number(store.get(SEEN_KEY) || 0);
  if (seenAt && (Date.now() - seenAt) < QUIET_DAYS * 864e5) return;

  const dialog  = modal.querySelector('.announce');
  const shots   = [].slice.call(modal.querySelectorAll('.announce-shot'));
  const dots    = [].slice.call(modal.querySelectorAll('.announce-dot'));
  const focusable = () => [].slice.call(
    dialog.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));

  let slide = 0;
  let timer = null;
  let returnFocusTo = null;

  function show(i) {
    slide = (i + shots.length) % shots.length;
    shots.forEach((s, n) => s.classList.toggle('on', n === slide));
    dots.forEach((d, n) => {
      d.classList.toggle('on', n === slide);
      d.setAttribute('aria-selected', n === slide ? 'true' : 'false');
    });
  }

  function close() {
    // Stamped on the way out, so an employee who never dismisses it keeps
    // being told — the announcement has not done its job until it is read.
    store.set(SEEN_KEY, String(Date.now()));
    clearInterval(timer);
    modal.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (returnFocusTo && returnFocusTo.focus) returnFocusTo.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the dialog: a modal you can tab out of is a modal that
    // hands focus to a page the reader cannot see.
    const items = focusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  modal.querySelector('#announce-close').addEventListener('click', close);
  modal.querySelector('#announce-ok').addEventListener('click', close);
  modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', onKey);
  dots.forEach((d, n) => d.addEventListener('click', () => { clearInterval(timer); show(n); }));

  returnFocusTo = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  show(0);
  // The dialog itself, not the close button: a screen reader then reads the
  // title and body on open, and the first Tab lands on the close control.
  dialog.focus();

  // Advance on its own only where motion is welcome. Under reduced motion the
  // first frame simply stays put and the dots still work, so nothing is
  // unreachable — it just does not move.
  const stillness = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!stillness.matches) timer = setInterval(() => show(slide + 1), 4200);
})();
