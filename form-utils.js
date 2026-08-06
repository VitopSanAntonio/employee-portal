/* ── Portal Form Utilities ───────────────────────────────────────
   Shared behavior for the submit-style form pages (safety concern,
   suggestion, maintenance request) and the status lookup. Include
   before the page script:
     <script src="form-utils.js"></script>
   Expects the shared form DOM ids: submit-btn, btn-icon, spinner,
   btn-text, submit-error.

   Loads before lang.js on every page, so anything from lang.js
   (window.PortalStorage) must be resolved when called, not at load.

   Submissions go through the Cloudflare Worker proxy — no Power
   Automate URLs or tokens live in this repository.
──────────────────────────────────────────────────────────────── */

window.PortalForm = (function () {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ── Submission proxy ────────────────────────────────────────
  const PROXY    = 'https://portal-submit-proxy.thibautleclercq98.workers.dev';
  const CODE_KEY = 'portalAccessCode';

  function el(id) { return document.getElementById(id); }

  // PortalStorage (lang.js) swallows the exceptions that private-browsing and
  // locked-down browsers raise on storage access.
  //
  // Resolved per call, never captured: every page loads form-utils.js *before*
  // lang.js, so at this point window.PortalStorage does not exist yet. Binding
  // it once here would permanently freeze in the no-op fallback and silently
  // lose both the saved language and the access code.
  const NO_STORE = { get() { return null; }, set() { return false; }, remove() {} };
  function store() { return window.PortalStorage || NO_STORE; }

  function currentLang() { return store().get('portalLang') || 'en'; }

  const MSG = {
    en: {
      prompt:  'Enter your employee access code:',
      badCode: 'That access code is not correct. Check with your supervisor.',
      rate:    'Too many submissions. Please wait a minute and try again.',
      offline: 'No connection. Check your signal and try again.'
    },
    es: {
      prompt:  'Ingresa tu código de acceso de empleado:',
      badCode: 'Ese código de acceso no es correcto. Consulta con tu supervisor.',
      rate:    'Demasiados envíos. Espera un minuto e inténtalo de nuevo.',
      offline: 'Sin conexión. Revisa tu señal e inténtalo de nuevo.'
    }
  };

  function t(key) {
    const lang = currentLang();
    return (MSG[lang] && MSG[lang][key]) || MSG.en[key];
  }

  // The access code is remembered per device once entered. Whether one is
  // needed at all is decided by the proxy, not here — see submitJSON.
  function storedAccessCode() { return store().get(CODE_KEY); }
  function rememberAccessCode(code) { store().set(CODE_KEY, code); }
  function forgetAccessCode() { store().remove(CODE_KEY); }

  // ── Validation helpers ──────────────────────────────────────

  // Marks the wrapper .field#f-<id> invalid when test is falsy.
  function validateField(id, test) {
    const field = el('f-' + id);
    if (!field) return test;
    if (!test) { field.classList.add('invalid'); return false; }
    field.classList.remove('invalid');
    return true;
  }

  function isValidEmail(value) { return EMAIL_RE.test(value); }

  // ── Submit button state ─────────────────────────────────────

  function restoreSubmitButton() {
    const btnText = el('btn-text');
    if (!btnText) return;
    el('submit-btn').disabled = false;
    el('btn-icon').style.display = 'block';
    el('spinner').style.display = 'none';
    btnText.textContent = btnText.getAttribute('data-' + currentLang()) || btnText.getAttribute('data-en');
  }

  function setSubmitting() {
    el('submit-btn').disabled = true;
    el('btn-icon').style.display = 'none';
    el('spinner').style.display = 'block';
    el('btn-text').textContent = currentLang() === 'es' ? 'Enviando…' : 'Submitting…';
    el('submit-error').classList.remove('show');
  }

  // ── Submission ──────────────────────────────────────────────

  /**
   * POSTs the payload through the proxy.
   *   formKey: 'suggestion' | 'safety' | 'maintenance'
   * Returns { ok, referenceId, message, cancelled }.
   *   cancelled          -> user dismissed the code prompt; leave the form as-is
   *   ok=false + message -> show that message to the user
   *   ok=false, no message-> show the page's own default error wording
   * Anything that is not a cancellation must surface an error: a silent
   * reset would read as "sent" to someone filing a safety report.
   *
   * Whether an access code is required is the proxy's call, not this file's.
   * We send whatever code the device already has (none, while the code is
   * paused) and only prompt if the proxy answers 401. That keeps the switch in
   * one place — REQUIRE_ACCESS_CODE in the Worker — so turning it on at
   * go-live needs no matching change here and can't leave the two out of sync.
   * The proxy checks the code before forwarding anything to Power Automate, so
   * a 401 never creates a record and the retry can't duplicate a submission.
   */
  async function submitJSON(formKey, payload) {
    let code = storedAccessCode();

    for (let attempt = 0; ; attempt++) {
      const body = Object.assign({}, payload);
      if (code) body.accessCode = code;

      let res;
      try {
        res = await fetch(PROXY + '/submit/' + formKey, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body)
        });
      } catch (err) {
        console.error('Proxy error:', err);
        return { ok: false, referenceId: '', message: t('offline'), cancelled: false };
      }

      if (res.status === 401) {
        forgetAccessCode();                       // so the next try re-prompts
        // One retry: the first 401 asks for a code, a second means the code
        // typed in response to it was wrong too.
        if (attempt > 0) {
          return { ok: false, referenceId: '', message: t('badCode'), cancelled: false };
        }
        code = window.prompt(t('prompt'));
        if (!code) return { ok: false, referenceId: '', message: '', cancelled: true };
        rememberAccessCode(code);
        continue;
      }

      if (res.status === 429) {
        return { ok: false, referenceId: '', message: t('rate'), cancelled: false };
      }

      let ok = res.ok;
      let referenceId = '';
      if (ok) {
        const data = await res.json().catch(() => null);
        if (data && data.ok === false) ok = false;
        if (data && data.referenceId) referenceId = data.referenceId;
      }
      return { ok, referenceId, message: '', cancelled: false };
    }
  }

  /**
   * Read-only lookup (status check). No access code required.
   * Returns { ok, data }:
   *   ok=true          -> the lookup completed; `data` is the flow's own body,
   *                       and data.found says whether a record exists
   *   ok=false         -> the lookup never completed (offline, proxy down,
   *                       flow error, unparseable body)
   *
   * The distinction matters: collapsing both into null told an employee whose
   * reference is perfectly valid that it "could not be found" during an
   * outage, and sent them off to re-check a number that was already correct.
   */
  async function lookupJSON(formKey, payload) {
    try {
      const res = await fetch(PROXY + '/submit/' + formKey, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
      if (!res.ok) return { ok: false, data: null };
      const data = await res.json().catch(() => null);
      return data === null ? { ok: false, data: null } : { ok: true, data };
    } catch (err) {
      console.error('Lookup error:', err);
      return { ok: false, data: null };
    }
  }

  // ── Error banner ────────────────────────────────────────────

  // Pass a message to override the banner text (e.g. wrong access code);
  // call with no argument to restore the page's default wording.
  function showSubmitError(message) {
    restoreSubmitButton();
    const banner = el('submit-error');
    if (!banner) return;
    const span = banner.querySelector('span');
    if (span) {
      if (message) {
        span.textContent = message;
      } else {
        span.textContent = span.getAttribute('data-' + currentLang()) || span.getAttribute('data-en') || span.textContent;
      }
    }
    banner.classList.add('show');
    banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function clearInvalidOnInput() {
    document.querySelectorAll('input, select, textarea').forEach(elm => {
      const clear = () => { const f = elm.closest('.field'); if (f) f.classList.remove('invalid'); };
      elm.addEventListener('input', clear);
      elm.addEventListener('change', clear);
    });
  }

  // Client-side fallback reference ID; the flow should return the real one.
  // Format must satisfy status-check.html's /^(MNT|SAF|SUG)-\d{4,6}$/.
  function newRefId(prefix) {
    return prefix + '-' + (100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  }

  /**
   * The reference for the attempt *in progress*, stable across retries.
   *
   * A flow that takes longer than the proxy's timeout still creates the
   * record; the employee sees an error and submits again. Minting a fresh ID
   * on that second attempt made the two indistinguishable and left two rows
   * for one report. Reusing the ID gives the flow a key to upsert on.
   * Cleared by clearRefId() once a submission actually succeeds.
   */
  const pendingRefs = {};

  function fallbackRefId(prefix) {
    if (!pendingRefs[prefix]) pendingRefs[prefix] = newRefId(prefix);
    return pendingRefs[prefix];
  }

  function clearRefId(prefix) { delete pendingRefs[prefix]; }

  return {
    validateField, isValidEmail, restoreSubmitButton, setSubmitting,
    submitJSON, lookupJSON, showSubmitError, clearInvalidOnInput,
    fallbackRefId, clearRefId, forgetAccessCode
  };
})();
