/*
 * Ambry service worker — hand-written, ~50 lines, no Workbox (PLAN.md §3).
 *
 * Strategy: cache-first for everything (instant launch on flaky supermarket
 * LTE — network-first would hang the aisle test on one bar), with background
 * revalidation of navigations so the cache tracks the deployed app. A new
 * deploy bumps SW_VERSION (via the build stamp below), which installs a fresh
 * cache; the app shows an "Update ready" pill when a new worker is waiting
 * (registration.waiting) and calls skipWaiting on tap.
 *
 * SW_VERSION: bump manually on each deploy, or wire the build to stamp it.
 */
const SW_VERSION = "v1";
const CACHE = `ambry-${SW_VERSION}`;
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith(self.location.origin)) return;
  // Navigations: serve cached shell instantly, revalidate in the background.
  const isNav = req.mode === "navigate";
  const key = isNav ? "/" : req;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => undefined);
      if (cached) {
        e.waitUntil(refresh); // stale-while-revalidate
        return cached;
      }
      const fresh = await refresh;
      return fresh ?? Response.error();
    }),
  );
});
