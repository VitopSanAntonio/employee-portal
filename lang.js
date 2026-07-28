/* ── Portal Language System ──────────────────────────────────────
   Drop this script at the bottom of every page (before </body>)
   Add data-en="..." data-es="..." to any element you want translated.
   For inputs/selects add data-en-placeholder / data-es-placeholder.
   For option elements, add data-en and data-es directly.
──────────────────────────────────────────────────────────────── */

(function () {
  const STORAGE_KEY = 'portalLang';

  function setLang(lang) {
    localStorage.setItem(STORAGE_KEY, lang);

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

    // Update toggle button
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.innerHTML = lang === 'en' ? '🇪🇸 ES' : '🇬🇧 EN';
  }

  function toggleLang() {
    const current = localStorage.getItem(STORAGE_KEY) || 'en';
    setLang(current === 'en' ? 'es' : 'en');
  }

  // Inject toggle button styles + element
  const style = document.createElement('style');
  style.textContent = `
    #lang-toggle {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 999;
      background: rgba(0,32,91,0.85);
      border: 1px solid rgba(255,255,255,0.15);
      color: #fff;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      font-weight: 600;
      padding: 6px 14px;
      border-radius: 100px;
      cursor: pointer;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      transition: border-color 0.2s, background 0.2s;
      letter-spacing: 0.03em;
    }
    #lang-toggle:hover {
      border-color: rgba(255,255,255,0.4);
      background: rgba(0,32,91,0.95);
    }
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'lang-toggle';
  btn.onclick = toggleLang;
  document.body.appendChild(btn);

  // Apply saved language on load
  const saved = localStorage.getItem(STORAGE_KEY) || 'en';
  setLang(saved);
})();
