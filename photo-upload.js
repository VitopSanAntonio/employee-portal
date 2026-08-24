/* ── Portal Photo Attachment ─────────────────────────────────────
   Shared photo picker for the form pages. Include before the page
   script; call PortalPhoto.init() after the DOM exists.

     const photo = PortalPhoto.init();            // one photo
     const photo = PortalPhoto.init({ max: 3 });  // up to three

   Expects the ids: photo-input, photo-zone, file-name-display,
   photo-error, and either photo-previews (a gallery container, used
   whenever it exists) or preview-img (the single-photo fallback).

   Photos are downscaled in the browser before they are sent — see
   "Why we compress" below. Submit handlers must `await photo.ready()`
   before reading .photos, and should disable the submit button first:
   processing three phone photos is not instant.
──────────────────────────────────────────────────────────────── */

window.PortalPhoto = (function () {

  /* Why we compress
     ───────────────
     A phone camera photo is 3–8 MB. Three of them reach Power Automate
     as base64, which inflates by 4/3, and are then base64-encoded again
     into the MIME body of the notification email — comfortably past the
     25 MB Exchange Online message limit, on top of a multi-megabyte
     upload over plant Wi-Fi.

     Downscaling to 1600 px on the long edge keeps every detail a
     maintenance tech needs (a leak, a cracked guard, a fault code on a
     panel) and lands each photo at roughly 200–600 KB. The caps below
     are guards for the cases where compression can't run — an image
     format the browser can't decode into a canvas, mainly HEIC — not
     the size we expect to send. */
  const DEFAULTS = {
    max: 1,
    // Rejected outright, before any decode is attempted.
    maxSourceBytes: 10 * 1024 * 1024,
    // Cap on one photo *after* processing. Matches the Worker's own
    // per-photo cap, so anything the page accepts the Worker accepts too.
    maxEncodedBytes: 7 * 1024 * 1024,
    // Cap across all attached photos. Must stay under the Worker's
    // LIMITS.maxBodyBytes with room for the rest of the JSON body.
    maxTotalEncodedBytes: 12 * 1024 * 1024,
    maxEdge: 1600,
    quality: 0.82,
  };

  // Ancillary UI strings only. The error messages themselves come from the
  // page's own #photo-error data-en/data-es attributes, so each form can word
  // its limits for itself.
  const UI = {
    en: { remove: 'Remove photo', photo: 'Photo' },
    es: { remove: 'Quitar foto',  photo: 'Foto' },
  };

  function lang() {
    const stored = window.PortalStorage && window.PortalStorage.get('portalLang');
    return stored === 'es' ? 'es' : 'en';
  }

  function ui(key) { return UI[lang()][key] || UI.en[key]; }

  // Browsers that don't know a format report an empty file.type — HEIC is the
  // common case, and it's what iPhones shoot by default. Falling back to the
  // extension keeps the forms' advertised "JPG, PNG, HEIC" honest instead of
  // rejecting the photo with a size error that isn't true.
  const IMAGE_EXT = /\.(jpe?g|png|heic|heif|gif|webp|bmp|tiff?)$/i;

  function looksLikeImage(file) {
    return file.type ? file.type.startsWith('image/') : IMAGE_EXT.test(file.name);
  }

  /**
   * Draws the file into a canvas at no more than `maxEdge` on the long side and
   * re-encodes it as JPEG. Resolves to a data URL, or null when the browser
   * can't decode the format (HEIC on most desktops) — callers fall back to the
   * original bytes rather than dropping the photo.
   */
  function compress(file, opts) {
    return new Promise(resolve => {
      let url;
      try {
        url = URL.createObjectURL(file);
      } catch {
        resolve(null);
        return;
      }

      const img = new Image();
      const done = value => { URL.revokeObjectURL(url); resolve(value); };

      img.onload = () => {
        try {
          // naturalWidth/Height already account for EXIF orientation in every
          // browser we support, so a portrait phone photo stays portrait.
          const w0 = img.naturalWidth;
          const h0 = img.naturalHeight;
          if (!w0 || !h0) { done(null); return; }

          const scale = Math.min(1, opts.maxEdge / Math.max(w0, h0));
          const canvas = document.createElement('canvas');
          canvas.width  = Math.max(1, Math.round(w0 * scale));
          canvas.height = Math.max(1, Math.round(h0 * scale));

          const ctx = canvas.getContext('2d');
          if (!ctx) { done(null); return; }
          // JPEG has no alpha channel: without this, anything transparent
          // (a screenshot, a PNG diagram) re-encodes onto black.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          const dataUrl = canvas.toDataURL('image/jpeg', opts.quality);
          // A canvas that failed to encode returns 'data:,' or falls back to
          // PNG; either means we did not get what we asked for.
          done(dataUrl.startsWith('data:image/jpeg;base64,') ? dataUrl : null);
        } catch {
          done(null);
        }
      };
      img.onerror = () => done(null);
      img.src = url;
    });
  }

  /** Original bytes, unmodified, as a data URL. */
  function readRaw(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload  = e => resolve(String(e.target.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Compressed if we can, original bytes if we can't, and the original when
   * compression made it bigger — which happens on small images that are
   * already well-optimised.
   */
  async function process(file, opts) {
    const [shrunk, raw] = await Promise.all([compress(file, opts), readRaw(file)]);
    if (shrunk && (!raw || shrunk.length < raw.length)) {
      return { dataUrl: shrunk, name: jpegName(file.name) };
    }
    return raw ? { dataUrl: raw, name: file.name } : null;
  }

  // The bytes are JPEG now, so the extension has to say so — Outlook picks the
  // attachment icon and the preview handler from the filename, and a JPEG
  // called .heic opens in nothing.
  function jpegName(name) {
    return name.replace(/\.[^.]+$/, '') + '.jpg';
  }

  function init(options) {
    const opts = Object.assign({}, DEFAULTS, options || {});

    const input    = document.getElementById('photo-input');
    const zone     = document.getElementById('photo-zone');
    const nameEl   = document.getElementById('file-name-display');
    const errorEl  = document.getElementById('photo-error');
    const gallery  = document.getElementById('photo-previews');
    const single   = document.getElementById('preview-img');

    if (opts.max > 1) input.setAttribute('multiple', '');

    // { name, base64, dataUrl }
    let items = [];

    // Resolves when no read is outstanding. FileReader and canvas encoding are
    // both asynchronous, so a fast submit used to send photoName with an empty
    // photo — the flow recorded a filename for an image that never arrived, and
    // the employee had no way to tell. Submitting now waits on this instead.
    let pending = Promise.resolve();

    // Only the newest batch may write results. Picking a second photo while the
    // first is still being read used to let the slower read land last, pairing
    // one photo's bytes with another's filename.
    let batch = 0;

    // Which message #photo-error is currently showing, so a language toggle can
    // redraw it. lang.js resets the element to its data-en/data-es default.
    let errorKey = null;

    /** Reads `data-<lang>-<key>` off #photo-error, falling back to English
     *  and then to the element's default message. */
    function errorText(key) {
      const l = lang();
      return errorEl.getAttribute('data-' + l + '-' + key)
          || errorEl.getAttribute('data-en-' + key)
          || errorEl.getAttribute('data-' + l)
          || errorEl.getAttribute('data-en')
          || '';
    }

    function showError(key) {
      errorKey = key;
      errorEl.textContent = errorText(key);
      errorEl.classList.add('show');
    }

    function hideError() {
      errorKey = null;
      errorEl.classList.remove('show');
    }

    document.addEventListener('portal:langchange', () => {
      if (errorKey) errorEl.textContent = errorText(errorKey);
      render();
    });

    function totalEncoded() {
      return items.reduce((sum, item) => sum + item.base64.length, 0);
    }

    function render() {
      zone.classList.toggle('has-photo', items.length > 0);

      if (!items.length) {
        nameEl.textContent = '';
      } else if (opts.max > 1) {
        nameEl.textContent = '✓ ' + items.length + '/' + opts.max + ' · ' +
          items.map(i => i.name).join(', ');
      } else {
        nameEl.textContent = '✓ ' + items[0].name;
      }

      // Once the last slot is used, stop inviting a photo we would only reject.
      // Only in multi-photo mode: there a thumbnail's × is how you free a slot,
      // whereas with one slot a new pick replaces what is there and the input
      // has to stay live.
      const full = opts.max > 1 && items.length >= opts.max;
      input.disabled = full;
      zone.classList.toggle('is-full', full);

      if (gallery) {
        renderGallery();
      } else if (single) {
        if (items.length) {
          single.src = items[0].dataUrl;
          single.style.display = 'block';
        } else {
          single.style.display = 'none';
          // Not single.src = '': an empty src re-resolves to the page URL in
          // some browsers and fires a pointless second request for the document.
          single.removeAttribute('src');
        }
      }
    }

    function renderGallery() {
      gallery.textContent = '';
      gallery.style.display = items.length ? '' : 'none';

      items.forEach((item, index) => {
        const fig = document.createElement('figure');
        fig.className = 'photo-thumb';

        const img = document.createElement('img');
        img.src = item.dataUrl;
        img.alt = ui('photo') + ' ' + (index + 1) + ': ' + item.name;
        fig.appendChild(img);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'photo-remove';
        remove.setAttribute('aria-label', ui('remove') + ': ' + item.name);
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          items = items.filter(i => i !== item);
          hideError();
          render();
        });
        fig.appendChild(remove);

        const caption = document.createElement('figcaption');
        caption.textContent = item.name;
        fig.appendChild(caption);

        gallery.appendChild(fig);
      });
    }

    /** Adds as many of `files` as the remaining slots and the caps allow. */
    async function accept(files) {
      const list = Array.from(files || []);
      if (!list.length) return;

      const token = ++batch;

      // Single-photo mode has no per-photo remove control, so a new pick has to
      // replace the current photo. Without this it would be refused for lack of
      // a free slot and the employee would have no way to swap the image.
      if (opts.max === 1) items = [];

      const room = opts.max - items.length;
      if (room <= 0) { showError('toomany'); return; }

      // More than there is room for is a mistake worth naming, but we still
      // take the ones that fit rather than dropping the whole selection.
      const taking = list.slice(0, room);
      let problem = list.length > room ? 'toomany' : null;

      const results = [];
      for (const file of taking) {
        if (!looksLikeImage(file)) { problem = problem || 'notimage'; continue; }
        if (file.size > opts.maxSourceBytes) { problem = problem || 'toolarge'; continue; }

        const out = await process(file, opts);
        if (!out) { problem = problem || 'readfailed'; continue; }

        const base64 = out.dataUrl.slice(out.dataUrl.indexOf(',') + 1);
        if (base64.length > opts.maxEncodedBytes) {
          // Under the source cap but still too big once encoded, which only
          // happens when the browser could not decode the format and so could
          // not resize it. Saying "smaller than 10 MB" here would be a lie —
          // the file already is, and shrinking it slightly would not help.
          problem = problem || 'unsupported';
          continue;
        }

        results.push({ name: out.name, base64, dataUrl: out.dataUrl });
      }

      if (token !== batch) return;   // superseded by a newer pick — drop it

      for (const item of results) {
        if (items.length >= opts.max) { problem = problem || 'toomany'; break; }
        if (totalEncoded() + item.base64.length > opts.maxTotalEncodedBytes) {
          problem = problem || 'tooheavy';
          break;
        }
        items.push(item);
      }

      if (problem) showError(problem); else hideError();
      render();
    }

    function clear() {
      batch += 1;                    // orphan any read still in flight
      items = [];
      pending = Promise.resolve();
      input.value = '';
      input.disabled = false;
      hideError();
      render();
    }

    input.addEventListener('change', () => {
      // Snapshot synchronously. input.files is a *live* FileList — the same
      // object every time — so clearing input.value below would empty a
      // reference captured for later, and a queued batch would process nothing.
      const files = Array.from(input.files || []);
      // Clearing the input is what lets the same file be picked again after it
      // is removed; without it the browser fires no change event at all.
      input.value = '';
      // Chained so two quick picks are processed in order and `ready()` covers
      // both.
      pending = pending.then(() => accept(files));
    });

    // dragleave fires when the pointer crosses into a child element too, so a
    // plain remove() makes the highlight flicker as it moves over the icon and
    // caption. Counting enter/leave pairs tracks the zone as a whole.
    let dragDepth = 0;
    zone.addEventListener('dragenter', e => {
      e.preventDefault();
      dragDepth += 1;
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragover', e => e.preventDefault());
    zone.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      dragDepth = 0;
      zone.classList.remove('drag-over');
      // Every dropped file, not just the first — dropping three at once is the
      // obvious gesture once the form says it takes three.
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      pending = pending.then(() => accept(files));
    });

    render();

    return {
      /** [{ name, base64 }] — what the submit handler sends. */
      get photos() { return items.map(i => ({ name: i.name, base64: i.base64 })); },
      get count()  { return items.length; },
      // Single-photo compatibility for the forms that attach one image.
      get base64() { return items.length ? items[0].base64 : ''; },
      get name()   { return items.length ? items[0].name : ''; },
      ready: () => pending,
      clear,
    };
  }

  return { init };
})();
