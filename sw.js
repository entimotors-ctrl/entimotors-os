// Red primero, caché como respaldo solo si no hay internet. Mientras seguimos
// cambiando la app todos los días, "caché primero" deja a los dispositivos ya
// instalados atascados en una versión vieja para siempre — network-first evita
// eso y de todos modos cae al caché cuando de verdad no hay señal.
const CACHE_NAME = "entimotors-v2.7.0";
const SHELL = ["./", "./index.html", "./app.js?v=2.7.0", "./manifest.json", "./icons/icon-192.png"];

self.addEventListener("install", (event) => {
  // cache.addAll() no deja pasar { cache: "no-store" } — sin eso, el propio
  // navegador podía contestar estos fetch con algo de su caché HTTP normal y
  // dejar precacheado un index.html/app.js viejo, aunque CACHE_NAME cambiara.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(SHELL.map((url) => fetch(url, { cache: "no-store" }).then((res) => cache.put(url, res))))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // cache: "no-store" evita que el propio navegador conteste esto desde su
  // caché HTTP normal (Last-Modified/heurística) antes de que el SW decida algo.
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
