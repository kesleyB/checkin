/**
 * Service worker — cache app shell + QR library for fully offline check-in.
 * Check-in never requires network; only import/sync URL does.
 */

const CACHE_NAME = "church-concert-checkin-v3";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./sync.js",
  "./manifest.json",
  "./sample-tickets.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each asset individually so one failure (e.g. CDN) does not block install
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(url);
          } catch (err) {
            console.warn("Precache failed:", url, err);
          }
        })
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never cache opaque admin sync URLs — those are online-only imports
  // App shell + same-origin + known CDN: cache-first
  const isAppAsset =
    url.origin === self.location.origin ||
    url.href.includes("unpkg.com/html5-qrcode");

  if (!isAppAsset) {
    return; // let browser handle (e.g. Apps Script sync)
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (!response || response.status !== 200) {
            return response;
          }
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }
          return new Response("Offline", { status: 503, statusText: "Offline" });
        });
    })
  );
});
