/* ── Portal Photo Attachment ─────────────────────────────────────
   Shared photo picker for the form pages. Include before the page
   script; call PortalPhoto.init() after the DOM exists. Expects the
   ids: photo-input, photo-zone, preview-img, file-name-display,
   photo-error. Rejects non-images and files over 5 MB.

   Submit handlers must `await photo.ready()` before reading .base64 —
   see the note on the read race below.
──────────────────────────────────────────────────────────────── */

window.PortalPhoto = (function () {
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  // Browsers that don't know a format report an empty file.type — HEIC is the
  // common case, and it's what iPhones shoot by default. Falling back to the
  // extension keeps the forms' advertised "JPG, PNG, HEIC" honest instead of
  // rejecting the photo with a size error that isn't true.
  const IMAGE_EXT = /\.(jpe?g|png|heic|heif|gif|webp|bmp|tiff?)$/i;

  function looksLikeImage(file) {
    return file.type ? file.type.startsWith('image/') : IMAGE_EXT.test(file.name);
  }

  function init() {
    const input   = document.getElementById('photo-input');
    const zone    = document.getElementById('photo-zone');
    const preview = document.getElementById('preview-img');
    const nameEl  = document.getElementById('file-name-display');
    const errorEl = document.getElementById('photo-error');

    let base64 = '';
    let name   = '';

    // Resolves when no read is outstanding. FileReader is asynchronous, so a
    // fast submit used to send photoName with an empty photo — the flow
    // recorded a filename for an image that never arrived, and the employee
    // had no way to tell. Submitting now waits on this instead.
    let pending = Promise.resolve();

    function clear() {
      input.value = '';
      base64 = ''; name = '';
      pending = Promise.resolve();
      nameEl.textContent = '';
      preview.style.display = 'none';
      // Not preview.src = '': an empty src re-resolves to the page URL in some
      // browsers and fires a pointless second request for the document.
      preview.removeAttribute('src');
      zone.classList.remove('has-photo');
      errorEl.classList.remove('show');
    }

    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      if (!looksLikeImage(file) || file.size > MAX_PHOTO_BYTES) {
        clear();
        errorEl.classList.add('show');
        return;
      }
      errorEl.classList.remove('show');
      name = file.name;
      nameEl.textContent = '✓ ' + file.name;
      zone.classList.add('has-photo');

      pending = new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => {
          base64 = e.target.result.split(',')[1]; // strip the data: prefix
          preview.src = e.target.result;
          preview.style.display = 'block';
          resolve();
        };
        reader.onerror = () => {
          // Surface it rather than submitting a filename with no image.
          clear();
          errorEl.classList.add('show');
          resolve();
        };
        reader.readAsDataURL(file);
      });
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
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    });

    return {
      get base64() { return base64; },
      get name()   { return name; },
      ready: () => pending,
      clear
    };
  }

  return { init };
})();
