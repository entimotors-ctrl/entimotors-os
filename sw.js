// Red primero, caché como respaldo solo si no hay internet. Mientras seguimos
// cambiando la app todos los días, "caché primero" deja a los dispositivos ya
// instalados atascados en una versión vieja para siempre — network-first evita
// eso y de todos modos cae al caché cuando de verdad no hay señal.
const CACHE_NAME = "entimotors-v3.15.0";
// La capa de Supabase va en el SHELL por el mismo motivo que app.js: index.html
// la carga antes de arrancar, y sin ella la app tardaría o fallaría al abrirse
// sin señal. config-local.js NO va aquí (es solo de desarrollo y no se publica)
// y panel-tecnico.html tampoco (es una página aparte, no parte de la PWA).
const SHELL = ["./", "./index.html",
  // build-target.js va en el SHELL a propósito: sin él, un arranque sin señal
  // no sabría qué producto es esta copia y asumiría el taller.
  "./build-target.js?v=3.15.0",
  "./supabase-config.js?v=3.15.0", "./supabase-client.js?v=3.15.0",
  "./auth.js?v=3.15.0", "./recovery.js?v=3.15.0",
  // 3.15 (Bloque 3): día empresarial (Honduras) — index.html lo carga antes de app.js
  "./fecha-negocio.js?v=3.15.0",
  // 3.15 (Bloque 5): indicadores de efectivo sin red (cobrado / por cobrar / entregado sin cobrar) — index.html lo carga antes de app.js
  "./finanzas-calc.js?v=3.15.0",
  // Núcleo de sincronización (SYNC-4) + mappers reales (SYNC-5) + fotos de Mi Trabajo (SYNC-6): mismo
  // motivo que la capa de Supabase, index.html los carga antes de app.js.
  "./sync-rest.js?v=3.15.0", "./sync-db.js?v=3.15.0", "./sync-engine.js?v=3.15.0", "./sync-realtime.js?v=3.15.0", "./sync-mappers.js?v=3.15.0",
  "./sync-fotos.js?v=3.15.0", "./sync-finanzas.js?v=3.15.0",
  // Autorización con PIN administrativo (SYNC-7): mismo motivo, index.html la carga antes de app.js.
  "./pin-ui.js?v=3.15.0",
  // Importador 3.13 → nube (SYNC-10): mismo motivo, index.html lo carga antes de app.js.
  "./import-313.js?v=3.15.0",
  "./app.js?v=3.15.0", "./usuarios.js?v=3.15.0",
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
    limpiarCachesViejas()
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

  /* 3.15 (Bloque 8): solo pasa por el caché lo que ES de la app — las navegaciones (el documento), los archivos del SHELL y las librerías
     del CDN. Cualquier otro GET del mismo origen (una ruta dinámica, una consulta larga) sigue directo a la red: guardarlo y, con el plazo,
     contestar con una copia vieja sería devolver una respuesta que no corresponde (lo detectó el estrés del Bloque 8 con el puente de las
     pruebas, que es justo una consulta larga del mismo origen). */
  const u = new URL(event.request.url);
  if (event.request.mode !== "navigate" && u.origin === self.location.origin && !ARCHIVOS_APP.has(u.href)) return;
  event.respondWith(responderApp(event));
});
const ARCHIVOS_APP = new Set(SHELL.map((x) => new URL(x, self.location).href));

/* 3.15 (Bloque 8) · RED PRIMERO CON PLAZO (solo para los archivos de la app y del CDN; la API nunca pasa por aquí).
   Antes: red primero SIN plazo — con señal que conecta pero no responde («lie-fi») o un servidor colgado, la app esperaba para
   siempre aunque tuviera su copia. Ahora:
   · respuesta de la red a tiempo (rápida, o lenta pero dentro del plazo) → se usa, como siempre (así llegan las versiones nuevas);
   · la red FALLA (sin conexión, servidor caído) → la copia, como siempre;
   · la red NO CONTESTA en el plazo y HAY copia → la copia. Si no hay copia (primer uso) se sigue esperando a la red: nunca se inventa.
   · Una página que arrancó desde la copia pide TODO lo demás a la copia (y a la red solo lo que falte): no se mezclan archivos de una
     versión con los de otra. Entre versiones además cambia `?v=`, así que un archivo nuevo nunca se confunde con uno viejo del caché.
   · Solo se guarda en el caché una respuesta BUENA (antes también un 404/500 podía tapar una copia buena).
   La respuesta tardía de la red se guarda igual al llegar (la próxima apertura ya la tiene). */
const PLAZO_NAVEGACION_MS = 4000;     // el documento: si en 4 s no contestó, se abre con lo guardado
const PLAZO_ARCHIVO_MS = 8000;        // cada archivo de una página que SÍ vino de la red
const paginasDesdeCopia = new Map();  // clientId → instante en que su documento se sirvió desde la copia
let ultimaNavegacionDesdeCopia = 0;   // respaldo para navegadores sin resultingClientId
const esperar = (ms) => new Promise((r) => setTimeout(() => r(PLAZO_AGOTADO), ms));
const PLAZO_AGOTADO = Symbol("plazo");

function pedirRed(request) {
  // cache: "no-store" evita que el propio navegador conteste esto desde su caché HTTP normal antes de que el SW decida algo
  return fetch(request, { cache: "no-store" }).then((res) => {
    if (res && (res.ok || res.type === "opaque")) {
      const copia = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copia)).catch(() => {});
    }
    return res;
  });
}
/* 3.15 (Bloque 8) · Las cachés de OTRAS versiones se borran al activar y, además, en cada navegación: el worker 3.14.1 (ya publicado)
   guarda en SU caché cada respuesta al llegar, así que una petición suya que termina DESPUÉS de este activate la vuelve a crear
   (visto en la prueba real de actualización). Y esta versión solo LEE su propia caché: nunca contesta con un archivo de otra. */
function limpiarCachesViejas() {
  return caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))));
}
const deMiCopia = (req) => caches.open(CACHE_NAME).then((c) => c.match(req));
async function responderApp(event) {
  const req = event.request;
  const navegacion = req.mode === "navigate";
  if (navegacion) event.waitUntil(limpiarCachesViejas().catch(() => {}));
  const cliente = navegacion ? (event.resultingClientId || "") : (event.clientId || "");
  const desdeCopia = !navegacion && ((cliente && paginasDesdeCopia.has(cliente)) || (!cliente && Date.now() - ultimaNavegacionDesdeCopia < 60000));
  if (desdeCopia) {
    const guardada = await deMiCopia(req);
    if (guardada) return guardada;
    return pedirRed(req);
  }
  const red = pedirRed(req);
  red.catch(() => {});   // si se abandona por plazo, su fallo tardío no es un error sin manejar
  const guardada = await deMiCopia(req);
  if (!guardada) return red;              // primer uso: solo la red puede contestar (si falla, falla como siempre)
  let r;
  try { r = await Promise.race([red, esperar(navegacion ? PLAZO_NAVEGACION_MS : PLAZO_ARCHIVO_MS)]); }
  catch (e) { r = null; }                 // la red falló (sin conexión, servidor caído)
  if (r && r !== PLAZO_AGOTADO) { if (navegacion && cliente) paginasDesdeCopia.delete(cliente); return r; }
  if (navegacion) {
    if (cliente) paginasDesdeCopia.set(cliente, Date.now()); else ultimaNavegacionDesdeCopia = Date.now();
    if (paginasDesdeCopia.size > 50) paginasDesdeCopia.delete(paginasDesdeCopia.keys().next().value);
  }
  return guardada;
}
