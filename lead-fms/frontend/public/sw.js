/* Service worker — keeps the app shell available offline.
 *
 *  • Page navigations: network-first (so a new deploy shows up immediately),
 *    falling back to the cached shell, then to /offline.html. The cached
 *    shell boots React, which then shows the proper "You're offline" screen.
 *  • /assets/* (Vite's content-hashed files): cache-first — they never change.
 *  • Other same-origin GETs (logo, favicon): stale-while-revalidate.
 *  • /api/* and anything cross-origin is NEVER touched, so data is always live.
 *
 * Bump VERSION to invalidate every cache.
 */
const VERSION = "v1";
const SHELL = "msl-shell-" + VERSION;
const ASSETS = "msl-assets-" + VERSION;
const PRECACHE = ["/", "/offline.html", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL && key !== ASSETS) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function navigate(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await withTimeout(fetch(request), 5000);
    const url = new URL(request.url);
    const isSpaRoute = !/\.\w+$/.test(url.pathname);
    if (res && res.ok && isSpaRoute && (res.headers.get("content-type") || "").includes("text/html")) {
      cache.put("/", res.clone());
    }
    return res;
  } catch (err) {
    return (await cache.match("/")) || (await cache.match("/offline.html")) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  if (request.mode === "navigate") return event.respondWith(navigate(request));
  if (url.pathname.startsWith("/assets/")) return event.respondWith(cacheFirst(request));
  event.respondWith(staleWhileRevalidate(request));
});
