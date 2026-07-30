/* ── Portal Service Worker ───────────────────────────────────────
   Network-first for same-origin GET requests, falling back to the
   cache when offline, so employees never see a stale form while
   connected but can still open the portal shell without signal.
   Bump CACHE_VERSION when shell assets change to evict old caches.
──────────────────────────────────────────────────────────────── */

const CACHE_VERSION = 'portal-v1';
const SHELL = [
  'index.html',
  'safety-concern.html',
  'suggestion-form.html',
  'maintenance-request.html',
  'status-check.html',
  'time-off.html',
  'theme.css',
  'lang.js',
  'manifest.json',
  'portal-icon-192.png',
  'portal-icon-512.png',
  'smurfit-logo.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL))
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

self.addEventListener('fetch', event => {
  // Never intercept form submissions or cross-origin requests (fonts, webhooks).
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
