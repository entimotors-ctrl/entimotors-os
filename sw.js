// Red primero, caché como respaldo solo si no hay internet. Mientras seguimos
// cambiando la app todos los días, "caché primero" deja a los dispositivos ya
// instalados atascados en una versión vieja para siempre — network-first evita
// eso y de todos modos cae al caché cuando de verdad no hay señal.
const CACHE_NAME = "entimotors-v3.14.0";
// La capa de Supabase va en el SHELL por el mismo motivo que app.js: index.html
// la carga antes de arrancar, y sin ella la app tardaría o fallaría al abrirse
// sin señal. config-local.js NO va aquí (es solo de desarrollo y no se publica)
// y panel-tecnico.html tampoco (es una página aparte, no parte de la PWA).
const SHELL = ["./", "./index.html",
  // build-target.js va en el SHELL a propósito: sin él, un arranque sin señal
  // no sabría qué producto es esta copia y asumiría el taller.
  "./build-target.js?v=3.14.0",
  "./supabase-config.js?v=3.14.0", "./supabase-client.js?v=3.14.0",
  "./auth.js?v=3.14.0", "./recovery.js?v=3.14.0",
  // Núcleo de sincronización (SYNC-4) + mappers reales (SYNC-5) + fotos de Mi Trabajo (SYNC-6): mismo
  // motivo que la capa de Supabase, index.html los carga antes de app.js.
  "./sync-rest.js?v=3.14.0", "./sync-db.js?v=3.14.0", "./sync-engine.js?v=3.14.0", "./sync-mappers.js?v=3.14.0",
  "./sync-fotos.js?v=3.14.0", "./sync-finanzas.js?v=3.14.0",
  // Autorización con PIN administrativo (SYNC-7): mismo motivo, index.html la carga antes de app.js.
  "./pin-ui.js?v=3.14.0",
  // Importador 3.13 → nube (SYNC-10): mismo motivo, index.html lo carga antes de app.js.
  "./import-313.js?v=3.14.0",
  "./app.js?v=3.14.0", "./usuarios.js?v=3.14.0",
  "./manifest.json", "./icons/icon-192.png", "./icons/logo-watermark-doc.png"];

// Librerías que convierten la factura en imagen/PDF para poder mandarla por
// WhatsApp. Van aparte del SHELL y con .catch(): si el CDN no responde, la app
// se tiene que instalar igual — sin ellas solo se pierde el botón de enviar.
const EXTRAS = [
  "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
];

self.addEventListener("install", (event) => {
  // cache.addAll() no deja pasar { cache: "no-store" } — sin eso, el propio
  // navegador podía contestar estos fetch con algo de su caché HTTP normal y
  // dejar precacheado un index.html/app.js viejo, aunque CACHE_NAME cambiara.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all([
        ...SHELL.map((url) => fetch(url, { cache: "no-store" }).then((res) => cache.put(url, res))),
        // cache.add() rechaza las respuestas opacas (status 0) que devuelve un CDN
        // sin CORS, así que se hace el fetch a mano y se guarda con put().
        ...EXTRAS.map((url) => fetch(url, { mode: "no-cors" }).then((res) => cache.put(url, res)).catch(() => {})),
      ])
    )
  );
  // OJO: aquí NO va self.skipWaiting().
  // Con skipWaiting() la versión nueva tomaba el control sola y la app se
  // recargaba sin avisar. El cliente tiene información que solo existe en su
  // dispositivo, así que la versión nueva se queda esperando en "waiting" hasta
  // que la persona acepte el aviso —y haya guardado su copia—. Ese aviso manda
  // el mensaje "activar-ya" que se atiende más abajo.
  // En la primerísima instalación no hay ningún Service Worker anterior, así que
  // el navegador activa esta directamente sin pasar por la espera.
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
  // la app autorizó la actualización: recién ahora esta versión toma el control
  if (event.data?.tipo === "activar-ya") { self.skipWaiting(); return; }
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

/* Qué puede pasar por el caché de este Service Worker.
   3.14.0 (sincronización): la app ahora habla con la nube (Supabase REST/Auth/Storage y el api-server) con el token de la persona.
   Esas respuestas NUNCA se guardan aquí: serían datos del taller (clientes, caja, créditos…) en un caché que sobrevive al cierre de
   sesión, y —peor— una lectura vieja tapando a la nube cuando hay señal. Solo se cachea la propia app (mismo origen) y las librerías
   del CDN que index.html ya cargaba. Todo lo demás se deja pasar SIN respondWith: el navegador lo resuelve directo. */
const ORIGENES_CACHEABLES = new Set([self.location.origin, "https://cdn.jsdelivr.net"]);
// 3.14.0 · SYNC-8 (defensa en profundidad): aunque un proxy o un despliegue sirviera la API, Supabase o Storage desde el
// MISMO origen que la app, esas rutas tampoco pasan por el caché — una lectura vieja de stock, saldo o caja nunca puede
// contestar en lugar del servidor, ni con la red caída.
const RUTAS_NUNCA_CACHE = /^\/(?:rest|auth|storage|functions|realtime)\/v1\/|^\/api\//;

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (!ORIGENES_CACHEABLES.has(new URL(event.request.url).origin)) return;   // API / Supabase / Storage: jamás por el caché
  if (event.request.headers && event.request.headers.has("authorization")) return;   // una petición con credenciales no es un archivo de la app
  if (event.request.headers && event.request.headers.has("apikey")) return;          // ni una de Supabase (lleva apikey aunque no tenga sesión)
  if (RUTAS_NUNCA_CACHE.test(new URL(event.request.url).pathname)) return;             // API / REST / Auth / Storage del mismo origen

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
