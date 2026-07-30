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

(function () {
  const STORAGE_KEY = 'portalLang';

  function setLang(lang) {
    localStorage.setItem(STORAGE_KEY, lang);
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
          el.innerHTML = el.getAttribute('data-' + lang) || el.getAttribute('data-en');
        }
      }
    });

    // Translate placeholders
    document.querySelectorAll('[data-en-placeholder]').forEach(el => {
      el.placeholder = el.getAttribute('data-' + lang + '-placeholder') || el.getAttribute('data-en-placeholder');
    });

    // Update toggle button — label shows the language you'd switch TO
    const btn = document.getElementById('lang-toggle');
    if (btn) {
      btn.textContent = lang === 'en' ? 'Español' : 'English';
      btn.setAttribute('aria-label', lang === 'en' ? 'Switch to Spanish' : 'Cambiar a inglés');
    }
  }

  function toggleLang() {
    const current = localStorage.getItem(STORAGE_KEY) || 'en';
    setLang(current === 'en' ? 'es' : 'en');
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

  // Apply saved language on load
  const saved = localStorage.getItem(STORAGE_KEY) || 'en';
  setLang(saved);

  // Register the service worker (lang.js is loaded by every page).
  // Relative path keeps the scope correct under a sub-path deployment.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed:', err));
  }
})();
