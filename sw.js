// Red primero, caché como respaldo solo si no hay internet. Mientras seguimos
// cambiando la app todos los días, "caché primero" deja a los dispositivos ya
// instalados atascados en una versión vieja para siempre — network-first evita
// eso y de todos modos cae al caché cuando de verdad no hay señal.
const CACHE_NAME = "entimotors-v3.9.2";
const SHELL = ["./", "./index.html", "./app.js?v=3.9.2", "./manifest.json", "./icons/icon-192.png", "./icons/logo-watermark-doc.png"];

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

/* ---- documento para imprimir ----
   En el iPhone, una pestaña abierta como about:blank no tiene dirección real,
   y sin dirección Safari no le ofrece "Imprimir" ni "Guardar en Archivos" —
   por eso el botón no hacía nada. La solución es darle al documento una URL
   de verdad: la app manda aquí el HTML de la factura, lo guardamos, y cuando
   el navegador pida /impresion.html se lo servimos desde aquí. */
const URL_IMPRESION = new URL("impresion.html", self.location).href;

self.addEventListener("message", (event) => {
  if (event.data?.tipo !== "guardar-impresion") return;
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.put(
        new Request(URL_IMPRESION),
        new Response(event.data.html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
      ))
      .then(() => event.source?.postMessage({ tipo: "impresion-lista" }))
      .catch(() => event.source?.postMessage({ tipo: "impresion-fallo" }))
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // este documento solo existe en el caché (no está en el servidor), así que
  // se responde directo sin intentar la red — si no, el 404 taparía la factura.
  if (new URL(event.request.url).pathname.endsWith("/impresion.html")) {
    event.respondWith(
      caches.match(new Request(URL_IMPRESION))
        .then((res) => res || new Response("<p>No hay ningún documento para imprimir.</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    );
    return;
  }

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
