/* ── Portal Language System ──────────────────────────────────────
   Drop this script at the bottom of every page (before </body>)
   Add data-en="..." data-es="..." to any element you want translated.
   For inputs/selects add data-en-placeholder / data-es-placeholder.
   For option elements, add data-en and data-es directly.

   Language toggle: pages provide their own
   <button id="lang-toggle" class="btn-lang" type="button"></button>
   in the header; this script wires it up and sets its label. If a page
   doesn't include one, a floating fallback button is created instead.
──────────────────────────────────────────────────────────────── */

/* Storage can throw, not just return null: Safari private windows, blocked
   site data, and locked-down managed browsers all raise on access. An
   unguarded read here used to take down translation, the toggle, and — since
   it shares this IIFE — service worker registration, leaving the portal
   untranslated *and* with no offline support. Every touch goes through these
   two helpers, which degrade to "language not remembered" instead. */
window.PortalStorage = window.PortalStorage || {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } }
};

(function () {
  const STORAGE_KEY = 'portalLang';

  function setLang(lang) {
    window.PortalStorage.set(STORAGE_KEY, lang);
    document.documentElement.lang = lang;

    // Translate all tagged elements
    document.querySelectorAll('[data-en]').forEach(el => {
      if (el.tagName === 'OPTION') {
        el.textContent = el.getAttribute('data-' + lang) || el.getAttribute('data-en');
      } else if (el.tagName === 'OPTGROUP') {
        el.label = el.getAttribute('data-' + lang) || el.getAttribute('data-en');
      } else if (el.children.length === 0 || el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SPAN' || el.tagName === 'LABEL' || el.tagName === 'P' || el.tagName === 'H1' || el.tagName === 'H2' || el.tagName === 'DIV') {
        // Only swap if it has no complex child elements (icons etc)
        const hasOnlyTextOrInline = [...el.childNodes].every(n =>
          n.nodeType === 3 || ['EM','STRONG','SMALL','BR','SPAN'].includes(n.nodeName)
        );
        if (hasOnlyTextOrInline) {
          const value = el.getAttribute('data-' + lang) || el.getAttribute('data-en');
          // innerHTML only for the handful of strings that genuinely carry
          // inline markup (<br>, <strong>, <span>); everything else goes
          // through textContent. Both are fed from static attributes in this
          // repo, so neither is exploitable today — but keeping the HTML sink
          // to the few places that need it means a future dynamic data-* can
          // only ever set text.
          if (/[<&]/.test(value)) el.innerHTML = value;
          else el.textContent = value;
        }
      }
    });

    // Translate placeholders
    document.querySelectorAll('[data-en-placeholder]').forEach(el => {
      el.placeholder = el.getAttribute('data-' + lang + '-placeholder') || el.getAttribute('data-en-placeholder');
    });

    // Translate alt text. An image that carries meaning needs its description
    // in the reader's language too — the rest of the page being bilingual does
    // not help someone who only ever hears the alt.
    document.querySelectorAll('[data-en-alt]').forEach(el => {
      el.alt = el.getAttribute('data-' + lang + '-alt') || el.getAttribute('data-en-alt');
    });

    // Update toggle button — label shows the language you'd switch TO
    const btn = document.getElementById('lang-toggle');
    if (btn) {
      btn.textContent = lang === 'en' ? 'Español' : 'English';
      btn.setAttribute('aria-label', lang === 'en' ? 'Switch to Spanish' : 'Cambiar a inglés');
    }
  }

  function toggleLang() {
    const current = window.PortalStorage.get(STORAGE_KEY) || 'en';
    setLang(current === 'en' ? 'es' : 'en');
    // Pages that render content from data (status-check) need to redraw it in
    // the new language; static markup is already handled by setLang.
    document.dispatchEvent(new CustomEvent('portal:langchange', { detail: { lang: document.documentElement.lang } }));
  }

  let btn = document.getElementById('lang-toggle');
  if (btn) {
    btn.addEventListener('click', toggleLang);
  } else {
    // Fallback: no in-header toggle slot on this page — float one in the corner.
    const style = document.createElement('style');
    style.textContent = `
      #lang-toggle {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 999;
        background: rgba(0,32,91,0.9);
        border: 1px solid rgba(255,255,255,0.25);
        color: #fff;
        font-family: 'Figtree', system-ui, sans-serif;
        font-size: 13px;
        font-weight: 600;
        padding: 7px 14px;
        border-radius: 999px;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,32,91,0.2);
        transition: background 0.2s;
      }
      #lang-toggle:hover { background: rgba(0,32,91,1); }
    `;
    document.head.appendChild(style);

    btn = document.createElement('button');
    btn.id = 'lang-toggle';
    btn.type = 'button';
    btn.onclick = toggleLang;
    document.body.appendChild(btn);
  }

  // Apply saved language on load. Wrapped because a failure to translate must
  // not stop the service worker below from registering — offline access does
  // not depend on the language system working.
  try {
    setLang(window.PortalStorage.get(STORAGE_KEY) || 'en');
  } catch (err) {
    console.warn('Translation failed:', err);
  }
})();

// Register the service worker (lang.js is loaded by every page).
// Relative path keeps the scope correct under a sub-path deployment.
// Deliberately outside the IIFE above: this is the portal's offline support
// and it must not share a failure path with translation.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed:', err));
}
