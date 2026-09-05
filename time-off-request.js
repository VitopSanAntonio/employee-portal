/* ── Time Off Request (preview) ──────────────────────────────────
   The in-portal replacement for the two Microsoft Forms. Loaded by
   time-off-request.html between form-utils.js and lang.js.

   Kept in its own file rather than inline like the other pages so
   that eslint actually sees it — inline page scripts are invisible
   to `npm run lint:js`.

   The shape of this page follows from one constraint: Microsoft
   Forms could not check a time clock number against the roster, so
   a mistyped number was only caught after submission, leaving HR an
   orphan request with no way to trace it. Here the number is checked
   first and nothing else is reachable until it passes.
──────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── DOM ─────────────────────────────────────────────────────
  const clockInput  = document.getElementById('clockNumber');
  const clockField  = document.getElementById('f-clockNumber');
  const gate        = document.getElementById('gate');
  const welcomeName = document.getElementById('welcome-name');
  const helpToggle  = document.getElementById('help-toggle');
  const helpBox     = document.getElementById('clock-help');

  const tabRequest  = document.getElementById('tab-request');
  const tabMine     = document.getElementById('tab-mine');
  const panelRequest = document.getElementById('panel-request');
  const panelMine    = document.getElementById('panel-mine');

  const form        = document.getElementById('timeoff-form');
  const formCard    = document.getElementById('form-card');
  const successScr  = document.getElementById('success-screen');
  const refDisplay  = document.getElementById('ref-display');
  const anotherBtn  = document.getElementById('another-btn');

  const mineLoading = document.getElementById('mine-loading');
  const mineFailed  = document.getElementById('mine-failed');
  const mineEmpty   = document.getElementById('mine-empty');
  const mineContent = document.getElementById('mine-content');
  const mineRetry   = document.getElementById('mine-retry');
  const mineFailedText = document.getElementById('mine-failed-text');
  const balanceGrid = document.getElementById('balance-grid');
  const reqList     = document.getElementById('req-list');

  const ID_STATES = ['id-checking', 'id-ok', 'id-bad', 'id-error'];

  // ── State ───────────────────────────────────────────────────
  //
  // Deliberately in memory only. The kiosk on the plant floor is shared, so a
  // clock number in localStorage would mean the next person to walk up files a
  // request — and now sees a balance — under the previous person's name.
  let identity = null;          // { clockNumber, displayName }
  let mine = null;              // { balances, requests } as last loaded
  let cancelOpenFor = null;     // referenceId whose cancel panel is expanded
  let cancelSentFor = null;     // referenceId that just had a cancellation sent

  // Guarded rather than assumed: lang.js defines PortalStorage but loads after
  // this file.
  function currentLang() {
    return (window.PortalStorage && window.PortalStorage.get('portalLang')) || 'en';
  }

  function txt(el, key) {
    if (!el) return '';
    return el.getAttribute('data-' + currentLang() + '-' + key) ||
           el.getAttribute('data-en-' + key) || '';
  }

  // ── Clock number validation ─────────────────────────────────

  function setIdState(which) {
    ID_STATES.forEach(id => {
      document.getElementById(id).classList.toggle('show', id === which);
    });
  }

  function closeGate() {
    identity = null;
    mine = null;
    cancelOpenFor = null;
    cancelSentFor = null;
    gate.classList.remove('show');
  }

  function openGate(displayName, clockNumber) {
    identity = { clockNumber: clockNumber, displayName: displayName };
    renderWelcome();
    setIdState('id-ok');
    gate.classList.add('show');
  }

  function renderWelcome() {
    if (!identity) return;
    // textContent, not markup: displayName comes back from a SharePoint roster
    // row and has no business being parsed as HTML.
    welcomeName.textContent = (currentLang() === 'es' ? 'Bienvenido, ' : 'Welcome, ') +
      (identity.displayName || identity.clockNumber);
  }

  // Only the newest check may paint. Validation fires on a debounce and on
  // blur, so two are easily in flight at once — without this, a slow answer for
  // an old number can overwrite the answer for the one now in the box, and the
  // employee files a request as somebody else.
  let checkToken = 0;
  let debounceTimer = null;

  // Digits only, and at least this many before an automatic check fires.
  // Checking after one keystroke would burn the endpoint's 10-per-minute
  // allowance on prefixes nobody asked about.
  const MIN_AUTO_LENGTH = 3;

  async function checkClockNumber(value) {
    const clockNumber = value.trim();
    if (!/^\d{1,10}$/.test(clockNumber)) {
      setIdState(null);
      closeGate();
      return;
    }

    const token = ++checkToken;
    closeGate();
    setIdState('id-checking');

    const { ok, data, message, cancelled } = await PortalForm.lookupGatedJSON('validate', {
      clockNumber: clockNumber
    });

    if (token !== checkToken) return;          // superseded — drop it

    if (cancelled) { setIdState(null); return; }

    if (!ok) {
      // Reached nothing. Never say "not recognized" here: telling somebody
      // their real badge number is wrong during an outage sends them to their
      // supervisor over a number that was right all along.
      const el = document.getElementById('id-error-text');
      if (message) el.textContent = message;
      else el.textContent = el.getAttribute('data-' + currentLang()) || el.getAttribute('data-en');
      setIdState('id-error');
      return;
    }

    if (data && data.found) {
      openGate(data.displayName, clockNumber);
    } else {
      setIdState('id-bad');
    }
  }

  clockInput.addEventListener('input', () => {
    // Strip anything that isn't a digit as it is typed. The flow interpolates
    // this value straight into a SharePoint OData filter, so an apostrophe
    // does not fail — it silently changes the query. The Worker rejects
    // non-digits too; this just stops the employee producing one by accident.
    const cleaned = clockInput.value.replace(/\D/g, '');
    if (cleaned !== clockInput.value) clockInput.value = cleaned;

    clockField.classList.remove('invalid');
    closeGate();
    setIdState(null);

    clearTimeout(debounceTimer);
    if (cleaned.length >= MIN_AUTO_LENGTH) {
      debounceTimer = setTimeout(() => checkClockNumber(cleaned), 500);
    }
  });

  clockInput.addEventListener('blur', () => {
    clearTimeout(debounceTimer);
    // Blur checks any non-empty value, including one shorter than the
    // auto-check floor: at that point the employee has finished typing and is
    // owed an answer either way.
    if (clockInput.value.trim() && !identity) checkClockNumber(clockInput.value);
  });

  clockInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounceTimer);
      checkClockNumber(clockInput.value);
    }
  });

  helpToggle.addEventListener('click', () => {
    const open = helpBox.classList.toggle('show');
    helpToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  /**
   * Shared kiosk: drop the identity after a spell of no interaction, rather
   * than leaving a name and a leave balance on screen for whoever walks up
   * next. Five minutes is long enough to fill the form out slowly.
   */
  const IDLE_MS = 5 * 60 * 1000;
  let idleTimer = null;

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!identity) return;
    idleTimer = setTimeout(() => {
      closeGate();
      setIdState(null);
      clockInput.value = '';
      resetRequestForm();
    }, IDLE_MS);
  }

  ['click', 'keydown', 'touchstart'].forEach(evt =>
    document.addEventListener(evt, resetIdleTimer, { passive: true })
  );

  // ── Tabs ────────────────────────────────────────────────────

  function selectTab(which) {
    const isRequest = which === 'request';
    tabRequest.setAttribute('aria-selected', isRequest ? 'true' : 'false');
    tabMine.setAttribute('aria-selected', isRequest ? 'false' : 'true');
    panelRequest.hidden = !isRequest;
    panelMine.hidden = isRequest;
    if (!isRequest && !mine) loadMine();
  }

  tabRequest.addEventListener('click', () => selectTab('request'));
  tabMine.addEventListener('click', () => selectTab('mine'));

  // ── Tab 1: the request form ─────────────────────────────────

  function showFieldError(id, variant) {
    const el = document.getElementById(id);
    if (!el) return;
    const custom = variant ? txt(el, variant) : '';
    el.textContent = custom || el.getAttribute('data-' + currentLang()) || el.getAttribute('data-en');
  }

  // Vacation's four-hour floor is enforced here and not in the Worker: it is a
  // local HR rule from the design copy, not part of the flow's contract, and a
  // Worker that rejected a legitimate two-hour request the flow would have
  // accepted is the worse failure.
  const VACATION_MIN_HOURS = 4;

  function parseHours(raw) {
    // A comma decimal separator is what a Spanish-language keypad offers.
    const n = parseFloat(String(raw).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }

  function validateForm() {
    let valid = true;

    const leaveType = document.getElementById('leaveType').value;
    valid = PortalForm.validateField('leaveType', !!leaveType) && valid;

    const startDate = document.getElementById('startDate').value;
    const endDate   = document.getElementById('endDate').value;
    valid = PortalForm.validateField('startDate', !!startDate) && valid;

    if (!endDate) {
      showFieldError('endDate-error', null);
      valid = PortalForm.validateField('endDate', false) && valid;
    } else if (startDate && endDate < startDate) {
      // ISO dates sort lexicographically, so this is a correct comparison and
      // not a shortcut around parsing.
      showFieldError('endDate-error', 'order');
      valid = PortalForm.validateField('endDate', false) && valid;
    } else {
      PortalForm.validateField('endDate', true);
    }

    const hours = parseHours(document.getElementById('hours').value);
    if (!(hours > 0)) {
      showFieldError('hours-error', null);
      valid = PortalForm.validateField('hours', false) && valid;
    } else if (leaveType === 'Vacation' && hours < VACATION_MIN_HOURS) {
      showFieldError('hours-error', 'min');
      valid = PortalForm.validateField('hours', false) && valid;
    } else {
      PortalForm.validateField('hours', true);
    }

    return valid;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();

    // Belt and braces — the gate is hidden without an identity, but a stale
    // page whose identity was cleared by the idle timer must not submit as
    // nobody.
    if (!identity) {
      clockField.classList.add('invalid');
      clockInput.focus();
      return;
    }

    if (!validateForm()) return;

    // Fallback only; the flow should return the real one. Stable across
    // retries, so a resubmit after a timeout is not counted as a second
    // request — same reasoning as the maintenance form.
    const refId = PortalForm.fallbackRefId('TMO');

    // Disabled before the await, not after: on a weak plant-floor signal the
    // gap is long enough to tap twice.
    PortalForm.setSubmitting();

    const fmla = document.querySelector('input[name="vacationCoversFMLA"]:checked');

    const payload = {
      referenceId:        refId,
      clockNumber:        identity.clockNumber,
      leaveType:          document.getElementById('leaveType').value,
      startDate:          document.getElementById('startDate').value,
      endDate:            document.getElementById('endDate').value,
      hours:              parseHours(document.getElementById('hours').value),
      vacationCoversFMLA: fmla ? fmla.value : '',
      notesToManager:     document.getElementById('notesToManager').value.trim()
    };

    const { ok, referenceId, message, cancelled } = await PortalForm.submitJSON('timeoff', payload);

    if (!ok) {
      if (cancelled) { PortalForm.restoreSubmitButton(); return; }
      PortalForm.showSubmitError(message);
      return;
    }

    PortalForm.clearRefId('TMO');
    refDisplay.textContent   = referenceId || refId;
    formCard.style.display   = 'none';
    successScr.style.display = 'block';
    // The list on the other tab is now out of date.
    mine = null;
    window.scrollTo(0, 0);
  });

  function resetRequestForm() {
    form.reset();
    document.querySelectorAll('#panel-request .field').forEach(f => f.classList.remove('invalid'));
    document.getElementById('submit-error').classList.remove('show');
    PortalForm.restoreSubmitButton();
    formCard.style.display   = 'block';
    successScr.style.display = 'none';
  }

  anotherBtn.addEventListener('click', () => {
    resetRequestForm();
    window.scrollTo(0, 0);
  });

  PortalForm.clearInvalidOnInput();

  // ── Tab 2: balance and existing requests ────────────────────

  function showMineState(which) {
    [mineLoading, mineFailed, mineEmpty].forEach(el =>
      el.classList.toggle('show', el.id === which)
    );
    mineContent.style.display = which === null ? 'block' : 'none';
  }

  let mineToken = 0;

  async function loadMine() {
    if (!identity) return;

    const token = ++mineToken;
    showMineState('mine-loading');

    const { ok, data, message, cancelled } = await PortalForm.lookupGatedJSON('timeoff-lookup', {
      clockNumber: identity.clockNumber
    });

    if (token !== mineToken) return;
    if (cancelled) { showMineState('mine-failed'); return; }

    if (!ok || !data) {
      if (message) mineFailedText.textContent = message;
      else mineFailedText.textContent =
        mineFailedText.getAttribute('data-' + currentLang()) || mineFailedText.getAttribute('data-en');
      showMineState('mine-failed');
      return;
    }

    mine = {
      balances: Array.isArray(data.balances) ? data.balances : [],
      requests: Array.isArray(data.requests) ? data.requests : []
    };

    if (!mine.balances.length && !mine.requests.length) {
      showMineState('mine-empty');
      return;
    }

    showMineState(null);
    renderMine();
  }

  mineRetry.addEventListener('click', loadMine);

  // Keyed on the lowercased status the flow returns. `denied` and `cancelled`
  // are kept alongside the current spellings: a row written before the rename,
  // or a flow edited only halfway, still renders as itself rather than
  // dropping to the neutral fallback pill.
  const STATUS_META = {
    pending:                  { cls: 'status-pending',   en: 'Pending',                 es: 'Pendiente' },
    approved:                 { cls: 'status-done',      en: 'Approved',                es: 'Aprobada' },
    rejected:                 { cls: 'status-rejected',  en: 'Rejected',                es: 'Rechazada' },
    denied:                   { cls: 'status-rejected',  en: 'Rejected',                es: 'Rechazada' },
    canceled:                 { cls: 'status-canceled',  en: 'Canceled',                es: 'Cancelada' },
    cancelled:                { cls: 'status-canceled',  en: 'Canceled',                es: 'Cancelada' },
    'cancellation requested': { cls: 'status-requested', en: 'Cancellation requested',  es: 'Cancelación solicitada' }
  };

  function statusMeta(status) {
    return STATUS_META[String(status || '').trim().toLowerCase()] ||
      { cls: 'status-default', en: status || '—', es: status || '—' };
  }

  const LEAVE_TYPE_ES = {
    'Vacation': 'Vacaciones',
    'Floating Holiday': 'Día flotante',
    'LSK CarryOver': 'LSK acumulado',
    'Perfect Attendance Reward': 'Premio por asistencia perfecta',
    'FMLA': 'FMLA'
  };

  function leaveTypeLabel(value) {
    if (currentLang() !== 'es') return value || '—';
    return LEAVE_TYPE_ES[value] || value || '—';
  }

  function formatDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return iso || '—';
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(currentLang() === 'es' ? 'es-MX' : 'en-US', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
    });
  }

  function dateRange(r) {
    if (!r.endDate || r.endDate === r.startDate) return formatDate(r.startDate);
    return formatDate(r.startDate) + ' – ' + formatDate(r.endDate);
  }

  /**
   * Builds one labelled cell. Everything on this tab is built with
   * createElement and textContent rather than innerHTML: the values come back
   * from an HR list, and free text typed by a manager has no reason to be
   * parsed as HTML.
   */
  function cell(className, labelEn, labelEs, value) {
    const wrap = document.createElement('div');
    wrap.className = 'req-cell ' + className;
    const label = document.createElement('div');
    label.className = 'r-label';
    label.textContent = currentLang() === 'es' ? labelEs : labelEn;
    const val = document.createElement('div');
    val.className = 'r-value';
    val.textContent = value;
    wrap.appendChild(label);
    wrap.appendChild(val);
    return wrap;
  }

  function button(className, labelEn, labelEs, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = currentLang() === 'es' ? labelEs : labelEn;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderBalances() {
    balanceGrid.textContent = '';
    if (!mine.balances.length) {
      const empty = document.createElement('p');
      empty.className = 'field-hint';
      empty.textContent = currentLang() === 'es'
        ? 'Tu saldo aún no está disponible.'
        : 'Your balance is not available yet.';
      balanceGrid.appendChild(empty);
      return;
    }
    mine.balances.forEach(b => {
      const card = document.createElement('div');
      card.className = 'balance-card';
      const label = document.createElement('div');
      label.className = 'b-label';
      label.textContent = leaveTypeLabel(b.leaveType);
      const hours = document.createElement('div');
      hours.className = 'b-hours';
      hours.textContent = b.hours === null || b.hours === undefined ? '—' : String(b.hours);
      const unit = document.createElement('span');
      unit.className = 'b-unit';
      unit.textContent = currentLang() === 'es' ? ' h' : ' hrs';
      hours.appendChild(unit);
      card.appendChild(label);
      card.appendChild(hours);
      balanceGrid.appendChild(card);
    });
  }

  function renderRequests() {
    reqList.textContent = '';

    mine.requests.forEach(r => {
      const meta = statusMeta(r.status);
      const isOpen = cancelOpenFor === r.referenceId;
      const cancellable = (meta.cls === 'status-pending' || meta.cls === 'status-done') && !isOpen;

      const row = document.createElement('div');
      row.className = 'req-row' + (isOpen ? ' selected' : '');

      const main = document.createElement('div');
      main.className = 'req-main';
      main.appendChild(cell('req-dates', 'Dates', 'Fechas', dateRange(r)));
      main.appendChild(cell('req-type', 'Type', 'Tipo', leaveTypeLabel(r.leaveType)));
      main.appendChild(cell('req-hours', 'Hours', 'Horas',
        r.hours === null || r.hours === undefined ? '—' : String(r.hours)));

      const pillWrap = document.createElement('div');
      pillWrap.className = 'req-pill';
      const pill = document.createElement('span');
      pill.className = 'status-pill ' + meta.cls;
      const dot = document.createElement('span');
      dot.className = 'dot';
      pill.appendChild(dot);
      const pillText = document.createElement('span');
      pillText.textContent = currentLang() === 'es' ? meta.es : meta.en;
      pill.appendChild(pillText);
      pillWrap.appendChild(pill);
      main.appendChild(pillWrap);

      const action = document.createElement('div');
      action.className = 'req-action';
      if (cancellable) {
        action.appendChild(button('btn btn-outline', 'Cancel request', 'Cancelar solicitud', () => {
          cancelOpenFor = r.referenceId;
          cancelSentFor = null;
          renderRequests();
        }));
      } else {
        const dash = document.createElement('span');
        dash.style.color = 'var(--gray-04)';
        dash.textContent = '—';
        action.appendChild(dash);
      }
      main.appendChild(action);
      row.appendChild(main);

      if (isOpen) row.appendChild(cancelPanel(r));
      if (cancelSentFor === r.referenceId) row.appendChild(cancelSentLine());

      reqList.appendChild(row);
    });
  }

  function cancelSentLine() {
    const sent = document.createElement('div');
    sent.className = 'cancel-sent';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '20 6 9 17 4 12');
    svg.appendChild(poly);
    const text = document.createElement('span');
    text.textContent = currentLang() === 'es'
      ? 'Solicitud de cancelación enviada — tu supervisor la confirmará en breve.'
      : 'Cancellation request sent — your supervisor will confirm shortly.';
    sent.appendChild(svg);
    sent.appendChild(text);
    return sent;
  }

  function cancelPanel(r) {
    const es = currentLang() === 'es';

    const panel = document.createElement('div');
    panel.className = 'cancel-panel';

    const heading = document.createElement('h3');
    heading.textContent = es ? '¿Cancelar esta solicitud?' : 'Cancel this request?';
    panel.appendChild(heading);

    const body = document.createElement('p');
    body.textContent = es
      ? 'Tu supervisor será notificado y tus horas volverán a tu saldo una vez confirmada la cancelación.'
      : 'Your supervisor will be notified and your hours will be returned to your balance once the cancellation is confirmed.';
    panel.appendChild(body);

    const areaId = 'cancel-reason-' + r.referenceId;
    const label = document.createElement('label');
    label.setAttribute('for', areaId);
    label.textContent = es ? 'Motivo de la cancelación (opcional)' : 'Reason for cancelling (optional)';
    panel.appendChild(label);

    const area = document.createElement('textarea');
    area.id = areaId;
    area.rows = 2;
    area.maxLength = 1000;
    area.placeholder = es
      ? 'Opcional — cuéntale a tu gerente qué cambió…'
      : 'Optional — let your manager know what changed…';
    panel.appendChild(area);

    const failed = document.createElement('div');
    failed.className = 'cancel-failed';
    failed.style.display = 'none';
    failed.setAttribute('role', 'alert');

    const actions = document.createElement('div');
    actions.className = 'cancel-actions';

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    const confirmSpinner = document.createElement('span');
    confirmSpinner.className = 'spinner';
    const confirmText = document.createElement('span');
    confirmText.textContent = es ? 'Confirmar cancelación' : 'Confirm cancellation';
    confirm.appendChild(confirmSpinner);
    confirm.appendChild(confirmText);

    confirm.addEventListener('click', async () => {
      // Disabled before the await, like every other submit on the portal: a
      // second tap here would file a second cancellation.
      confirm.disabled = true;
      confirmSpinner.style.display = 'block';
      confirmText.textContent = es ? 'Enviando…' : 'Submitting…';
      failed.style.display = 'none';

      const { ok, message, cancelled } = await PortalForm.submitJSON('timeoff-cancel', {
        referenceId: r.referenceId,
        clockNumber: identity.clockNumber,
        reason:      area.value.trim()
      });

      if (!ok) {
        confirm.disabled = false;
        confirmSpinner.style.display = 'none';
        confirmText.textContent = es ? 'Confirmar cancelación' : 'Confirm cancellation';
        if (cancelled) return;
        failed.textContent = message || (es
          ? 'No se pudo enviar la cancelación — verifica tu conexión e inténtalo de nuevo.'
          : 'Your cancellation could not be sent — check your connection and try again.');
        failed.style.display = 'block';
        return;
      }

      // Reflect it locally rather than refetching: the flow needs the
      // supervisor to confirm before the stored status changes, so a reload
      // here would show the old status and read as though nothing happened.
      r.status = 'Cancellation requested';
      cancelOpenFor = null;
      cancelSentFor = r.referenceId;
      renderRequests();
    });

    actions.appendChild(confirm);
    actions.appendChild(button('btn btn-outline', 'Never mind', 'No importa', () => {
      cancelOpenFor = null;
      renderRequests();
    }));

    panel.appendChild(actions);
    panel.appendChild(failed);
    return panel;
  }

  function renderMine() {
    if (!mine) return;
    renderBalances();
    renderRequests();
  }

  // lang.js only swaps static markup; everything on the second tab and the
  // welcome line is rendered from data and has to be redrawn by hand.
  document.addEventListener('portal:langchange', () => {
    renderWelcome();
    if (mine) renderMine();
  });
})();
