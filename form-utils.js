/* ── Portal Form Utilities ───────────────────────────────────────
   Shared behavior for the submit-style form pages (safety concern,
   suggestion, maintenance request) and the status lookup. Include
   before the page script:
     <script src="form-utils.js"></script>
   Expects the shared form DOM ids: submit-btn, btn-icon, spinner,
   btn-text, submit-error.

   Submissions go through the Cloudflare Worker proxy — no Power
   Automate URLs or tokens live in this repository.
──────────────────────────────────────────────────────────────── */

window.PortalForm = (function () {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ── Submission proxy ────────────────────────────────────────
  const PROXY    = 'https://portal-submit-proxy.thibautleclercq98.workers.dev';
  const CODE_KEY = 'portalAccessCode';

  function el(id) { return document.getElementById(id); }

  function currentLang() { return localStorage.getItem('portalLang') || 'en'; }

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

  // Asked once per device, then remembered. Cleared automatically if
  // the proxy rejects it, so a typo doesn't lock someone out for good.
  function getAccessCode() {
    let code = null;
    try { code = localStorage.getItem(CODE_KEY); } catch (e) {}
    if (!code) {
      code = window.prompt(t('prompt'));
      if (!code) return null;
      try { localStorage.setItem(CODE_KEY, code); } catch (e) {}
    }
    return code;
  }

  function forgetAccessCode() {
    try { localStorage.removeItem(CODE_KEY); } catch (e) {}
  }

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
   */
  async function submitJSON(formKey, payload) {
    let ok = false;
    let referenceId = '';
    let message = '';

    const code = getAccessCode();
    if (!code) return { ok: false, referenceId: '', message: '', cancelled: true };

    try {
      const res = await fetch(PROXY + '/submit/' + formKey, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(Object.assign({}, payload, { accessCode: code }))
      });

      if (res.status === 401) {
        forgetAccessCode();                       // so the next try re-prompts
        return { ok: false, referenceId: '', message: t('badCode'), cancelled: false };
      }
      if (res.status === 429) {
        return { ok: false, referenceId: '', message: t('rate'), cancelled: false };
      }

      ok = res.ok;
      if (ok) {
        const data = await res.json().catch(() => null);
        if (data && data.ok === false) ok = false;
        if (data && data.referenceId) referenceId = data.referenceId;
      }
    } catch (err) {
      console.error('Proxy error:', err);
      message = t('offline');
    }

    return { ok, referenceId, message, cancelled: false };
  }

  /**
   * Read-only lookup (status check). No access code required.
   * Returns the flow's own JSON body, or null on failure.
   */
  async function lookupJSON(formKey, payload) {
    try {
      const res = await fetch(PROXY + '/submit/' + formKey, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch (err) {
      console.error('Lookup error:', err);
      return null;
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
  function fallbackRefId(prefix) {
    return prefix + '-' + (100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  }

  return {
    validateField, isValidEmail, restoreSubmitButton, setSubmitting,
    submitJSON, lookupJSON, showSubmitError, clearInvalidOnInput,
    fallbackRefId, getAccessCode, forgetAccessCode
  };
})();
