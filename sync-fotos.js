/* ============================================================================
 * ENTIMOTORS OS · sync-fotos.js  (3.14.0 · SYNC-6)
 * ----------------------------------------------------------------------------
 * Fotos de órdenes para Mi Trabajo: comprimir, subir a Supabase Storage y, sin
 * conexión, encolar en `blobs` (entimotors_sync, sync-db.js — la tabla ya
 * existía desde SYNC-4, pensada exactamente para esto) hasta poder subirlas.
 *
 * NUNCA base64 en la cola ni en la nube: se sube el Blob tal cual (IndexedDB lo
 * guarda con structured clone, sin pasar por texto) y solo el PATH resultante
 * viaja después a `ordenes.fotos` (SYNC-9: por agregar_foto_orden, sync-9-fotos.sql; antes avanzar_orden_tecnico).
 *
 * LA SUBIDA ES EL CHEQUEO DE ASIGNACIÓN. No hay una llamada aparte para
 * comprobar "¿sigue siendo mía esta orden?": la política de Storage
 * (taller_sube_media, SYNC-2) usa mecanico_asignado_a_orden(), así que un
 * PUT a una orden reasignada o ya cerrada lo rechaza el servidor con 403,
 * que aquí se traduce en clase "permiso" — la cola no reintenta eso, lo
 * marca "rechazada" y lo deja a la vista (mismo criterio que sync-engine.js:
 * permiso/validacion no se arreglan reintentando).
 *
 * SYNC-9 (verificado contra storage-api REAL v1.60.15 + RLS de SYNC-2):
 *   · Storage contesta HTTP 400 con {"statusCode":"403"|"404"|"409",…} en el CUERPO: la clase sale del cuerpo, no
 *     solo del status. Un JWT vencido/ausente llega como 400/403 "exp claim"/"Invalid Compact JWS" → clase "auth"
 *     (pausa, jamás rechazo), y sin token NO se envía nada (nunca "Bearer null").
 *   · Reintento de una subida que SÍ llegó (respuesta perdida, cierre): la ruta es determinista por operation_id, así
 *     que el segundo PUT choca (400/403 RLS o 409). Antes eso marcaba la foto "rechazada" y NUNCA se ligaba a la
 *     orden. Ahora se pregunta si el objeto ya existe (GET /object/info/authenticated, bajo la misma RLS: un objeto
 *     ajeno se ve como inexistente) y, si existe, la subida cuenta como hecha. Idempotente, sin copias.
 *   · La foto se LIGA a la orden (alSubirUna → RPC agregar_foto_orden por el outbox, op_id = operation_id) ANTES de
 *     borrar el blob local: un cierre entre ambos pasos repite el ligado (idempotente) en vez de perder la foto.
 *   · Fallos temporales: espera creciente por blob (siguiente_en), sin bucle; una sola pestaña procesa a la vez
 *     (Web Locks; sin ellos, la idempotencia de ruta + ligado evita duplicados).
 * ==========================================================================*/
(function (global) {
  "use strict";

  var MAX_LADO = 1600;
  var CALIDAD = 0.82;
  var TIMEOUT_MS = 30000;

  function uuid() { return (global.SyncDB && global.SyncDB.uuid) ? global.SyncDB.uuid() : (Date.now() + "-" + Math.random().toString(36).slice(2)); }

  /** Redimensiona/comprime una foto de orden. Usa createImageBitmap (respeta la orientación EXIF
      con {imageOrientation:"from-image"} en los navegadores que lo soportan) y cae a <img> si no existe. */
  function comprimir(file, opciones) {
    opciones = opciones || {};
    var ladoMax = opciones.ladoMax || MAX_LADO, calidad = opciones.calidad || CALIDAD;
    function aBlobDesdeFuente(fuente, anchoOrig, altoOrig) {
      var escala = Math.min(1, ladoMax / Math.max(anchoOrig, altoOrig));
      var w = Math.max(1, Math.round(anchoOrig * escala)), h = Math.max(1, Math.round(altoOrig * escala));
      var lienzo = document.createElement("canvas");
      lienzo.width = w; lienzo.height = h;
      var ctx = lienzo.getContext("2d");
      ctx.drawImage(fuente, 0, 0, w, h);
      return new Promise(function (resolve, reject) {
        lienzo.toBlob(function (blob) {
          if (!blob) { reject(new Error("No se pudo comprimir la imagen")); return; }
          resolve({ blob: blob, ancho: w, alto: h });
        }, "image/jpeg", calidad);
      });
    }
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(file, { imageOrientation: "from-image" })
        .then(function (bmp) { return aBlobDesdeFuente(bmp, bmp.width, bmp.height).then(function (r) { bmp.close && bmp.close(); return r; }); })
        .catch(function () { return comprimirConImg(file, ladoMax, calidad); });
    }
    return comprimirConImg(file, ladoMax, calidad);
  }
  function comprimirConImg(file, ladoMax, calidad) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var escala = Math.min(1, ladoMax / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * escala)), h = Math.max(1, Math.round(img.naturalHeight * escala));
        var lienzo = document.createElement("canvas");
        lienzo.width = w; lienzo.height = h;
        lienzo.getContext("2d").drawImage(img, 0, 0, w, h);
        lienzo.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (!blob) { reject(new Error("No se pudo comprimir la imagen")); return; }
          resolve({ blob: blob, ancho: w, alto: h });
        }, "image/jpeg", calidad);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen")); };
      img.src = url;
    });
  }

  /** ordenes/<orden_uuid>/<foto_uuid>.jpg — SINGLE_WORKSHOP, sin taller_id (SYNC-6 sección 10). */
  function ruta(ordenUid, fotoUid) { return "ordenes/" + ordenUid + "/" + (fotoUid || uuid()) + ".jpg"; }

  function conTimeout(promesaFetch, ms) {
    return Promise.race([
      promesaFetch,
      new Promise(function (_, rej) { setTimeout(function () { rej({ falloRed: true, abortado: true, mensaje: "tiempo agotado" }); }, ms); }),
    ]);
  }

  /** PUT directo a Supabase Storage. Nunca lanza: {ok:true,status} | {ok:false, clase, status, codigo, mensaje}.
      SYNC-8/9: sin token no sale nada (se intenta refrescar una vez; si no, clase "auth"). */
  function conToken(o, fn) {
    return Promise.resolve(o.obtenerToken ? o.obtenerToken() : null).catch(function () { return null; }).then(function (token) {
      if (token) return fn(token);
      if (!o.refrescar) return { ok: false, clase: "auth", status: 0, codigo: "SIN_SESION", mensaje: "No hay sesión válida." };
      return Promise.resolve(o.refrescar()).catch(function () { return false; }).then(function (ok) {
        return ok ? Promise.resolve(o.obtenerToken()).then(function (t2) { return t2 ? fn(t2) : { ok: false, clase: "auth", status: 0, codigo: "SIN_SESION", mensaje: "No hay sesión válida." }; })
          : { ok: false, clase: "auth", status: 0, codigo: "SIN_SESION", mensaje: "No hay sesión válida." };
      });
    });
  }
  function leerCuerpo(res) {
    return (res && typeof res.text === "function" ? res.text() : Promise.resolve("")).then(function (txt) {
      var c = null; if (txt) { try { c = JSON.parse(txt); } catch (e) { c = null; } }
      return { status: res.status, cuerpo: c };
    }).catch(function () { return { status: res.status, cuerpo: null }; });
  }
  function subir(o) {
    var f = o.fetch || global.fetch;
    var url = String(o.baseUrl || "").replace(/\/+$/, "") + "/storage/v1/object/" + encodeURIComponent(o.bucket) + "/" + o.path.split("/").map(encodeURIComponent).join("/");
    function unaVez(token) {
      return conTimeout(f(url, {
        method: "PUT",
        headers: { apikey: o.anonKey, Authorization: "Bearer " + token, "Content-Type": o.blob.type || "image/jpeg", "x-upsert": "false", "cache-control": "3600" },
        body: o.blob,
      }), o.timeout || TIMEOUT_MS).then(leerCuerpo).catch(function (e) { return { falloRed: true, mensaje: e && e.mensaje }; });
    }
    return conToken(o, function (token) {
      return unaVez(token).then(function (r) {
        if (r && r.falloRed) return { ok: false, clase: "red", status: 0, mensaje: r.mensaje || "sin red" };
        var k = clasificarStorage(r);
        if (k.clase === "auth" && o.refrescar) {
          return Promise.resolve(o.refrescar()).catch(function () { return false; }).then(function (ok) {
            if (!ok) return k;
            return conToken({ obtenerToken: o.obtenerToken }, function (t2) {
              return unaVez(t2).then(function (r2) { return r2 && r2.falloRed ? { ok: false, clase: "red", status: 0, mensaje: r2.mensaje || "sin red" } : clasificarStorage(r2); });
            });
          });
        }
        return k;
      });
    });
  }
  /** Clase de una respuesta de Storage. storage-api responde a menudo HTTP 400 con el código REAL en el cuerpo
      ({"statusCode":"403","message":"new row violates row-level security policy"}); se usa ese. */
  function clasificarStorage(r) {
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
    var c = r.cuerpo && typeof r.cuerpo === "object" ? r.cuerpo : {};
    var codigo = Number(c.statusCode) || r.status, msg = typeof c.message === "string" ? c.message : "";
    var clase;
    if (codigo === 401 || /jwt|jws|"?exp"? claim|token/i.test(msg)) clase = "auth";
    else if (codigo === 409 || /duplicate|already exists/i.test(msg)) clase = "conflicto";
    else if (codigo === 403) clase = "permiso";
    else if (codigo === 429) clase = "limite";
    else if (codigo === 408 || codigo >= 500) clase = "servidor";
    else clase = "validacion";
    return { ok: false, clase: clase, status: r.status, codigo: String(codigo), mensaje: "No se pudo subir la foto (" + codigo + ")" };
  }

  /** ¿Existe ya el objeto? GET /object/info/authenticated bajo la MISMA RLS de lectura: un objeto ajeno se ve como
      inexistente (no se filtra su existencia). {ok:true, existe} | {ok:false, clase}. Nunca lanza. */
  function existe(o) {
    var f = o.fetch || global.fetch;
    var url = String(o.baseUrl || "").replace(/\/+$/, "") + "/storage/v1/object/info/authenticated/" + encodeURIComponent(o.bucket) + "/" + o.path.split("/").map(encodeURIComponent).join("/");
    return conToken(o, function (token) {
      return conTimeout(f(url, { method: "GET", headers: { apikey: o.anonKey, Authorization: "Bearer " + token } }), o.timeout || TIMEOUT_MS).then(leerCuerpo).then(function (r) {
        if (r.status >= 200 && r.status < 300) return { ok: true, existe: true };
        var k = clasificarStorage(r);
        if (k.codigo === "404" || k.clase === "permiso") return { ok: true, existe: false };
        return { ok: false, clase: k.clase };
      }).catch(function () { return { ok: false, clase: "red" }; });
    });
  }

  /** URL firmada de UNA foto (SYNC-6 sección 10: nunca una URL pública permanente). Nunca lanza. */
  function firmar(o) {
    var f = o.fetch || global.fetch;
    var base = String(o.baseUrl || "").replace(/\/+$/, "");
    var url = base + "/storage/v1/object/sign/" + encodeURIComponent(o.bucket) + "/" + o.path.split("/").map(encodeURIComponent).join("/");
    function unaVez(token) {
      return conTimeout(f(url, {
        method: "POST", headers: { apikey: o.anonKey, Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: o.expiresIn || 3600 }),
      }), o.timeout || TIMEOUT_MS).then(function (res) {
        return res.text().then(function (txt) {
          var cuerpo = null; if (txt) { try { cuerpo = JSON.parse(txt); } catch (e) { /* respuesta no-json */ } }
          return { status: res.status, cuerpo: cuerpo };
        });
      }).catch(function (e) { return { falloRed: true, mensaje: e && e.mensaje }; });
    }
    function armar(r) {
      if (r.status >= 200 && r.status < 300 && r.cuerpo && r.cuerpo.signedURL) {
        var ruta = r.cuerpo.signedURL;
        var abs = /^https?:\/\//i.test(ruta) ? ruta : base + "/storage/v1" + ruta.replace(/^\/storage\/v1/, "");
        return { ok: true, url: abs };
      }
      return { ok: false, clase: r.status === 403 ? "permiso" : r.status === 401 ? "auth" : "servidor", status: r.status };
    }
    return Promise.resolve(o.obtenerToken ? o.obtenerToken() : null).then(function (token) {
      return unaVez(token).then(function (r) {
        if (r && r.falloRed) return { ok: false, clase: "red", mensaje: r.mensaje || "sin red" };
        if (r.status === 401 && o.refrescar) {
          return Promise.resolve(o.refrescar()).then(function (ok) {
            if (!ok) return { ok: false, clase: "auth" };
            return Promise.resolve(o.obtenerToken()).then(unaVez).then(armar);
          });
        }
        return armar(r);
      });
    });
  }

  /* ---------------- cola offline (bd.blobs, sync-db.js) ---------------- */
  /** Encola una foto pendiente. NUNCA base64: se guarda el Blob tal cual. */
  function encolar(bd, o) {
    var registro = {
      entidad: "ordenes", uid: o.ordenUid, operation_id: uuid(), estado: "pendiente",
      archivo: o.blob, nombre_archivo: o.nombreArchivo || (uuid() + ".jpg"),
      creado_en: Date.now(), intentos: 0,
    };
    return bd.blobs.agregar(registro).then(function (id) { registro.id = id; return registro; });
  }
  /** Fotos que la nube rechazó de forma definitiva (orden reasignada/cerrada, sin permiso): para «⚠ Por revisar». */
  function rechazadas(bd) {
    return bd.blobs.todos().then(function (todos) { return todos.filter(function (b) { return b.entidad === "ordenes" && b.estado === "rechazada"; }); });
  }
  function pendientes(bd, ordenUid) {
    return bd.blobs.todos().then(function (todos) {
      return todos.filter(function (b) { return b.entidad === "ordenes" && (!ordenUid || b.uid === ordenUid) && b.estado === "pendiente"; });
    });
  }

  /** Sube en orden cada blob pendiente de una orden. Nunca revienta: cada intento fallido queda registrado.
      o = {bd, ordenUid, baseUrl, anonKey, bucket, obtenerToken, refrescar, alSubirUna(path, registro)}. */
  function esperaMs(intentos) {
    var e = global.SyncEngine && global.SyncEngine.puras && global.SyncEngine.puras.esperaMs;
    return e ? e(intentos) : Math.min(2000 * Math.pow(2, Math.max(0, intentos - 1)), 300000);
  }
  function actualizarBlob(bd, b, cambios) {
    return bd.transaccion(["blobs"], "readwrite", function (t) { return t.put("blobs", Object.assign({}, b, cambios)); });
  }
  function procesarCola(o) {
    var locks = o.locks !== undefined ? o.locks : (global.navigator && global.navigator.locks);
    if (locks && typeof locks.request === "function") {
      return locks.request("entimotors-sync-fotos", { ifAvailable: true }, function (lock) {
        return lock ? procesarSinCandado(o) : { subidas: 0, rechazadas: 0, pendientes: 0, omitido: "otra-pestana" };
      });
    }
    return procesarSinCandado(o);
  }
  function procesarSinCandado(o) {
    var ahora = (o.ahora || Date.now)();
    return pendientes(o.bd, o.ordenUid).then(function (lista) {
      var resultado = { subidas: 0, rechazadas: 0, pendientes: 0 };
      var cadena = Promise.resolve(), detenido = null;
      lista.forEach(function (b) {
        cadena = cadena.then(function () {
          if (detenido) { resultado.pendientes++; return; }                             // sin sesión / sin red: ni se intenta
          if ((b.siguiente_en || 0) > ahora) { resultado.pendientes++; return; }       // esperando su reintento
          var path = ruta(b.uid, b.operation_id);
          var base = { baseUrl: o.baseUrl, anonKey: o.anonKey, bucket: o.bucket || "entimotors-taller", path: path, obtenerToken: o.obtenerToken, refrescar: o.refrescar, fetch: o.fetch };
          var ligar = function () {
            // primero se LIGA (durable, idempotente) y recién después se borra el blob: un cierre entre ambos no pierde la foto
            return Promise.resolve(o.alSubirUna ? o.alSubirUna(path, b) : null).then(function () { return o.bd.blobs.borrar(b.id); })
              .then(function () { resultado.subidas++; });
          };
          return subir(Object.assign({ blob: b.archivo }, base)).then(function (r) {
            if (r.ok) return ligar();
            if (r.clase === "auth") { detenido = "auth"; resultado.pendientes++; return; }   // pausa: no gasta intentos
            if (r.clase === "permiso" || r.clase === "conflicto") {
              // ¿ya estaba arriba (reintento de una subida que sí llegó)? — ruta única por operation_id
              return existe(base).then(function (e) {
                if (e.ok && e.existe) return ligar();
                if (!e.ok) { resultado.pendientes++; return actualizarBlob(o.bd, b, { intentos: (b.intentos || 0) + 1, siguiente_en: ahora + esperaMs((b.intentos || 0) + 1), error: "no se pudo comprobar" }); }
                resultado.rechazadas++;
                return actualizarBlob(o.bd, b, { estado: "rechazada", error: r.mensaje, error_clase: r.clase });
              });
            }
            if (r.clase === "validacion") {
              resultado.rechazadas++;
              return actualizarBlob(o.bd, b, { estado: "rechazada", error: r.mensaje, error_clase: r.clase });
            }
            // red / servidor / límite: se reintenta más tarde con espera creciente; sin red, no se sigue con las demás
            if (r.clase === "red") detenido = "red";
            resultado.pendientes++;
            return actualizarBlob(o.bd, b, { intentos: (b.intentos || 0) + 1, siguiente_en: ahora + esperaMs((b.intentos || 0) + 1), error: r.mensaje });
          });
        });
      });
      return cadena.then(function () { if (detenido) resultado.detenido = detenido; return resultado; });
    });
  }

  global.SyncFotos = { comprimir: comprimir, ruta: ruta, subir: subir, firmar: firmar, existe: existe, clasificarStorage: clasificarStorage,
    encolar: encolar, pendientes: pendientes, rechazadas: rechazadas, procesarCola: procesarCola };
})(typeof window !== "undefined" ? window : this);
