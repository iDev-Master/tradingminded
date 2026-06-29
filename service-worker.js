/* ============================================================
   Salmon — Service Worker (offline shell for the PWA)
   ------------------------------------------------------------
   All paths are RELATIVE so the worker works under a GitHub Pages
   project subpath (username.github.io/<repo>/).
   Strategy:
     - App shell (html/css/js/icons) → cache-first.
     - configs/*  → network-first (so apiUrl/theme edits propagate;
                    falls back to cache when offline).
     - Apps Script requests + non-GET → straight to network.
   Bump CACHE when you change shell files to drop the old cache.
============================================================ */

const CACHE = 'salmon-v12';

// Relative URLs — resolved against the worker's scope (the repo dir).
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Backend calls and writes: never cache.
  if (url.hostname.includes('script.google') || req.method !== 'GET') return;

  // Client configs: network-first, cache as fallback.
  if (url.pathname.includes('/configs/')) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App shell: cache-first.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});
