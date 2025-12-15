// Simple App-Shell SW
const CACHE = "seeyou-v1.0.2";
const PRECACHE = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./static/logo.png",
  "./static/bg.jpg",
  "https://cdn.tailwindcss.com" // wird als 'opaque' gecacht – reicht fürs Offline
];

// Install: Precache
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// Activate: alte Caches aufräumen
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: Cache-first, dann Netz; bei Fehler auf index.html zurückfallen
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // im Hintergrund aktualisieren (SWAP)
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(()=>{});
        return cached;
      }
      return fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
