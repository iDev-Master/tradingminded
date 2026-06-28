/* ============================================================
   Salmon — Service Worker (офлайн-кэш статики для PWA)
   ============================================================
   Стратегия:
   - Статика (html/css/js/иконки) → cache-first.
   - Запросы к Apps Script (script.google.com) → НЕ кэшируем,
     всегда идём в сеть (данные должны быть свежими).
   При обновлении файлов поднимите версию CACHE — старый кэш
   будет удалён.
------------------------------------------------------------- */

const CACHE = 'salmon-v1';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Установка — кладём статику в кэш
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Активация — чистим старые версии кэша
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Перехват запросов
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Запросы к бэкенду (Apps Script) — всегда сеть, мимо кэша
  if (url.hostname.includes('script.google') || req.method !== 'GET') {
    return; // браузер обработает сам
  }

  // Статика: сначала кэш, потом сеть
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // кладём в кэш только успешные ответы того же origin
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
