// Offline support. The page is fetched fresh whenever there is a connection (so updates arrive
// on the next open), and falls back to the cached copy offline. Built assets have hashed names,
// so they are cached on first use and served from the cache afterwards.
const CACHE = "birdseye-v2";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch("./", { cache: "no-cache" });
      const html = await res.clone().text();
      await cache.put("./", res);
      const assets = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(assets);
    } catch { /* offline during install: cache fills on first use */ }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put("./", res.clone());
        return res;
      } catch {
        return (await caches.match("./")) ?? Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && (url.pathname.includes("/assets/") || url.pathname.includes("/pdfjs/"))) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
