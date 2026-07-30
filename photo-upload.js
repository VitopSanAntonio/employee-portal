/* ── Portal Photo Attachment ─────────────────────────────────────
   Shared photo picker for the form pages. Include before the page
   script; call PortalPhoto.init() after the DOM exists. Expects the
   ids: photo-input, photo-zone, preview-img, file-name-display,
   photo-error. Rejects non-images and files over 5 MB.
──────────────────────────────────────────────────────────────── */

window.PortalPhoto = (function () {
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  function init() {
    const input   = document.getElementById('photo-input');
    const zone    = document.getElementById('photo-zone');
    const preview = document.getElementById('preview-img');
    const nameEl  = document.getElementById('file-name-display');
    const errorEl = document.getElementById('photo-error');

    let base64 = '';
    let name   = '';

    function clear() {
      input.value = '';
      base64 = ''; name = '';
      nameEl.textContent = '';
      preview.style.display = 'none';
      preview.src = '';
      zone.classList.remove('has-photo');
      errorEl.classList.remove('show');
    }

    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/') || file.size > MAX_PHOTO_BYTES) {
        clear();
        errorEl.classList.add('show');
        return;
      }
      errorEl.classList.remove('show');
      name = file.name;
      nameEl.textContent = '✓ ' + file.name;
      zone.classList.add('has-photo');
      const reader = new FileReader();
      reader.onload = e => {
        base64 = e.target.result.split(',')[1]; // strip the data: prefix
        preview.src = e.target.result;
        preview.style.display = 'block';
      };
      reader.readAsDataURL(file);
    });

    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
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
      clear
    };
  }

  return { init };
})();
