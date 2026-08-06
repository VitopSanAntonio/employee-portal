/* ── Portal Service Worker ───────────────────────────────────────
   Network-first for same-origin GET requests, falling back to the
   cache when offline, so employees never see a stale form while
   connected but can still open the portal shell without signal.
   Bump CACHE_VERSION when shell assets change to evict old caches.
──────────────────────────────────────────────────────────────── */

const CACHE_VERSION = 'portal-v3';

// How long to wait for the network before serving the cached copy. Without a
// bound, a weak signal is worse than no signal: fetch() does not reject on a
// stalled connection, so the page hangs for the browser's own timeout instead
// of falling back. Plant-floor dead zones are exactly this case.
const NETWORK_TIMEOUT_MS = 3000;

const SHELL = [
  './',                  // the URL employees actually open, and the manifest's
                         // start_url — without it, offline navigation to the
                         // directory root misses the cache entirely
  'index.html',
  'safety-concern.html',
  'suggestion-form.html',
  'maintenance-request.html',
  'status-check.html',
  'time-off.html',
  'theme.css',
  'lang.js',
  'form-utils.js',
  'photo-upload.js',
  'manifest.json',
  'portal-icon-192.png',
  'portal-icon-512.png',
  'smurfit-logo.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // Individually, so one unreachable asset cannot fail the whole install
      // and leave the portal with no offline support at all.
      .then(cache => Promise.all(
        SHELL.map(url => cache.add(url).catch(err => console.warn('SW precache miss:', url, err)))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Network, but give up waiting after NETWORK_TIMEOUT_MS. */
function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), NETWORK_TIMEOUT_MS);
    fetch(request).then(
      response => { clearTimeout(timer); resolve(response); },
      err      => { clearTimeout(timer); reject(err); }
    );
  });
}

/** Cached copy, falling back to the shell for navigations. */
async function fromCache(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;

  // A navigation to any page we did not cache (or to a path variant of one)
  // still gets the portal rather than the browser's offline error.
  if (request.mode === 'navigate') {
    return (await caches.match('index.html')) || (await caches.match('./'));
  }
  return undefined;
}

self.addEventListener('fetch', event => {
  // Never intercept form submissions or cross-origin requests (fonts, webhooks).
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetchWithTimeout(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          // waitUntil so the write survives the SW being shut down as soon as
          // the response is handed back.
          event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(async () => (await fromCache(event.request)) || Response.error())
  );
});
