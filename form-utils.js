/* ── Portal Form Utilities ───────────────────────────────────────
   Shared behavior for the submit-style form pages (safety concern,
   suggestion, maintenance request). Include before the page script:
     <script src="form-utils.js"></script>
   Expects the shared form DOM ids: submit-btn, btn-icon, spinner,
   btn-text, submit-error.
──────────────────────────────────────────────────────────────── */

window.PortalForm = (function () {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function el(id) { return document.getElementById(id); }

  function currentLang() { return localStorage.getItem('portalLang') || 'en'; }

  // Marks the wrapper .field#f-<id> invalid when test is falsy.
  function validateField(id, test) {
    const field = el('f-' + id);
    if (!field) return test;
    if (!test) { field.classList.add('invalid'); return false; }
    field.classList.remove('invalid');
    return true;
  }

  function isValidEmail(value) { return EMAIL_RE.test(value); }

  function restoreSubmitButton() {
    const btnText = el('btn-text');
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

  // POSTs the payload; ok is false on network error or non-2xx status.
  // referenceId is filled when the flow's Response action returns one.
  async function submitJSON(url, payload) {
    let ok = false;
    let referenceId = '';
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
      ok = res.ok;
      if (ok) {
        const data = await res.json().catch(() => null);
        if (data && data.referenceId) referenceId = data.referenceId;
      }
    } catch (err) {
      console.error('Webhook error:', err);
    }
    return { ok, referenceId };
  }

  function showSubmitError() {
    restoreSubmitButton();
    const banner = el('submit-error');
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

  return { validateField, isValidEmail, restoreSubmitButton, setSubmitting, submitJSON, showSubmitError, clearInvalidOnInput, fallbackRefId };
})();
