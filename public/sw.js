/*
 * Ambry service worker — hand-written, no Workbox (PLAN.md §3).
 *
 * Update lifecycle (how a deploy reaches the phone):
 *   1. `npm run build` runs scripts/stamp-sw.mjs after `vite build`. It
 *      rewrites SW_VERSION below to a content hash of the built shell and
 *      PRECACHE to the full built asset list — so any deploy that changes
 *      the app also changes this file's bytes.
 *   2. The browser re-fetches /sw.js on navigation; changed bytes install a
 *      new worker, whose install step precaches the NEW shell (HTML + hashed
 *      assets, atomically) into a NEW versioned cache. It then sits waiting.
 *   3. sw-client.ts spots the waiting worker; the App shows the "Update
 *      ready" pill; tapping it posts SKIP_WAITING.
 *   4. The new worker activates, deletes old caches, claims the clients; the
 *      page reloads once (controllerchange) into the new precached shell.
 *
 * Fetch strategy: cache-first, no background revalidation. Refreshing "/"
 * behind the scenes (the old stale-while-revalidate) could pair new HTML
 * with hashed assets that were never cached — a white screen on the next
 * offline standalone launch. HTML and its assets now move only together,
 * via the versioned precache above.
 *
 * SW_VERSION and PRECACHE are placeholders; the build stamp rewrites both.
 */
const SW_VERSION = "dev";
const PRECACHE = ["/"];
const CACHE = `ambry-${SW_VERSION}`;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
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
  // Only the synthetic check has its own document and initialization boundary.
  // All ordinary app navigations continue to use the cached root shell.
  const key = req.mode === "navigate"
    ? (new URL(req.url).pathname === "/caret-check.html" ? "/caret-check.html" : "/")
    : req;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      if (cached) return cached;
      // Miss — a request outside the precache (or a failed precache): go to
      // the network and keep the answer so next launch is offline-safe.
      const fresh = await fetch(req).catch(() => undefined);
      if (fresh === undefined) return Response.error();
      if (fresh.ok) cache.put(key, fresh.clone());
      return fresh;
    }),
  );
});
