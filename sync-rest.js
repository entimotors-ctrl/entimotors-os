/* ============================================================================
 * ENTIMOTORS OS · sync-rest.js  (3.14.0 · SYNC-4)
 * ----------------------------------------------------------------------------
 * Cliente REST (PostgREST de Supabase) para la sincronización. NO sabe de
 * entidades ni de IndexedDB: solo habla HTTP, clasifica los errores y pagina.
 *
 * REGLAS
 *   · Nunca lanza: todo método devuelve {ok:true,...} o {ok:false, clase, ...}.
 *   · `clase` decide qué hace la cola: red | auth | permiso | conflicto |
 *     validacion | servidor | esquema | limite.
 *   · Un 401 se reintenta UNA vez tras refrescar la sesión; si sigue → `auth`.
 *   · Sin límite fijo de 100 filas: pagina por cursor (updated_at, id) hasta
 *     agotar, con solapamiento para no perder filas que se confirmaron tarde.
 *   · Los sellos de tiempo se tratan como TEXTO opaco del servidor (microsegundos):
 *     pasarlos por Date() perdería precisión y saltaría o repetiría filas.
 *   · Ningún token ni cabecera Authorization se guarda ni se registra aquí.
 * ==========================================================================*/
(function (global) {
  "use strict";

  var TIMEOUT_MS = 20000;

  /** Clasifica una respuesta HTTP de error de PostgREST. Pura y exportada para las pruebas. */
  function clasificar(status, cuerpo) {
    var c = cuerpo && typeof cuerpo === "object" ? cuerpo : {};
    var codigo = typeof c.code === "string" ? c.code : "";
    var mensaje = typeof c.message === "string" ? c.message : (typeof c.msg === "string" ? c.msg : "");
    var clase;
    if (status === 401) clase = "auth";
    else if (status === 403 || codigo === "42501") clase = "permiso";
    else if (status === 409 || codigo === "23505" || codigo === "23503") clase = "conflicto";
    else if (codigo === "PGRST202" || codigo === "PGRST205" || codigo === "42883" || codigo === "42P01") clase = "esquema";
    else if (status === 429) clase = "limite";
    else if (status === 408 || status >= 500) clase = "servidor";
    else if (status === 404) clase = "esquema";
    else clase = "validacion";
    return { clase: clase, codigo: codigo, mensaje: mensaje, detalle: typeof c.details === "string" ? c.details : "", pista: typeof c.hint === "string" ? c.hint : "" };
  }

  function segundosReintento(res) {
    var v = res && res.headers && res.headers.get && res.headers.get("retry-after");
    var n = v ? Number(v) : NaN;
    return isFinite(n) && n >= 0 ? Math.min(n, 3600) : null;
  }

  /** Filtro de PostgREST: ["col","eq",valor] → col=eq.valor */
  function filtro(par) { return [par[0], par[1] + "." + par[2]]; }

  function construirQuery(o) {
    o = o || {};
    var p = [];
    var add = function (k, v) { p.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)); };
    if (o.select) add("select", o.select);
    (o.filtros || []).forEach(function (f) { var kv = filtro(f); add(kv[0], kv[1]); });
    if (o.or) add("or", o.or);
    if (o.orden) add("order", o.orden);
    if (o.limite !== undefined) add("limit", String(o.limite));
    if (o.offset !== undefined) add("offset", String(o.offset));
    if (o.onConflict) add("on_conflict", o.onConflict);
    return p.length ? "?" + p.join("&") : "";
  }

  /** Condición de cursor (updated_at, id): filas estrictamente posteriores a {t,id}. */
  function condicionCursor(cursor) {
    return "(updated_at.gt." + cursor.t + ",and(updated_at.eq." + cursor.t + ",id.gt." + cursor.id + "))";
  }

  /** t - ms como texto ISO (solo ensancha la ventana: el redondeo a ms cae SIEMPRE hacia atrás). */
  function restarMs(t, ms) {
    var d = new Date(t);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() - ms).toISOString();
  }

  function crear(cfg) {
    var f = cfg.fetch || (typeof fetch === "function" ? fetch.bind(global) : null);
    var base = String(cfg.baseUrl || "").replace(/\/+$/, "");
    var anon = cfg.anonKey || "";
    var timeout = cfg.timeoutMs || TIMEOUT_MS;

    function url(ruta, query) { return base + "/rest/v1/" + ruta + (query || ""); }

    function unaVez(metodo, u, opciones, token) {
      var cab = { apikey: anon };
      if (token) cab.Authorization = "Bearer " + token;
      if (opciones.cuerpo !== undefined) cab["Content-Type"] = "application/json";
      if (opciones.prefer) cab.Prefer = opciones.prefer;
      if (opciones.cabeceras) for (var k in opciones.cabeceras) cab[k] = opciones.cabeceras[k];
      var ctl = typeof AbortController === "function" ? new AbortController() : null;
      var t = ctl ? setTimeout(function () { ctl.abort(); }, opciones.timeout || timeout) : null;
      return f(u, { method: metodo, headers: cab, body: opciones.cuerpo !== undefined ? JSON.stringify(opciones.cuerpo) : undefined, signal: ctl ? ctl.signal : undefined, cache: "no-store" })
        .then(function (res) {
          if (t) clearTimeout(t);
          return res.text().then(function (txt) {
            var cuerpo = null;
            if (txt) { try { cuerpo = JSON.parse(txt); } catch (e) { cuerpo = txt; } }
            return { res: res, status: res.status, cuerpo: cuerpo };
          });
        })
        .catch(function (err) {
          if (t) clearTimeout(t);
          return { falloRed: true, abortado: !!(err && err.name === "AbortError"), mensaje: err && err.message ? String(err.message) : "sin red" };
        });
    }

    /** Petición completa: token, reintento tras 401, clasificación. Nunca lanza. */
    function pedir(metodo, ruta, query, opciones) {
      opciones = opciones || {};
      var u = url(ruta, query);
      var conToken = function (yaRefrescado) {
        return Promise.resolve(cfg.getToken ? cfg.getToken() : null).catch(function () { return null; }).then(function (token) {
          // SYNC-8: con un cliente que trabaja con sesión (getToken), una petición SIN token saldría como ANÓNIMA: la RLS la
          // negaría (403 → «permiso», terminal) y la cola descartaría trabajo bueno por una sesión caducada. Nunca sale:
          // se intenta refrescar UNA vez y, si sigue sin token, es «auth» (la cola se pausa y espera un inicio de sesión).
          if (cfg.getToken && !token) {
            if (!yaRefrescado && cfg.refrescar) {
              return Promise.resolve(cfg.refrescar()).catch(function () { return false; }).then(function (ok) {
                return ok ? conToken(true) : { ok: false, clase: "auth", status: 0, codigo: "SIN_SESION", mensaje: "No hay sesión válida." };
              });
            }
            return { ok: false, clase: "auth", status: 0, codigo: "SIN_SESION", mensaje: "No hay sesión válida." };
          }
          return unaVez(metodo, u, opciones, token).then(function (r) {
            if (r.falloRed) return { ok: false, clase: "red", status: 0, codigo: r.abortado ? "TIMEOUT" : "SIN_RED", mensaje: r.mensaje };
            if (r.status === 401 && !yaRefrescado && cfg.refrescar) {
              return Promise.resolve(cfg.refrescar()).catch(function () { return false; }).then(function (ok) {
                return ok ? conToken(true) : { ok: false, clase: "auth", status: 401, codigo: "SESION_CADUCADA", mensaje: "La sesión caducó." };
              });
            }
            if (r.status >= 200 && r.status < 300) {
              return { ok: true, status: r.status, datos: r.cuerpo, rango: r.res.headers.get("content-range") || null };
            }
            var k = clasificar(r.status, r.cuerpo);
            return { ok: false, clase: k.clase, status: r.status, codigo: k.codigo, mensaje: k.mensaje, detalle: k.detalle, pista: k.pista, reintentarEnS: segundosReintento(r.res) };
          });
        });
      };
      return conToken(false);
    }

    var api = {
      /** GET de una tabla. Devuelve {ok, datos:[...]} */
      seleccionar: function (tabla, o) { return pedir("GET", tabla, construirQuery(o)); },

      /** Una fila por su llave, o null. */
      obtener: function (tabla, id, select) {
        return pedir("GET", tabla, construirQuery({ select: select || "*", filtros: [["id", "eq", id]], limite: 1 })).then(function (r) {
          return r.ok ? { ok: true, datos: (r.datos && r.datos[0]) || null } : r;
        });
      },

      /** Descarga incremental por cursor (updated_at,id). onPagina(filas) se llama por página; si devuelve una promesa
          se espera y, si devuelve false, se detiene. Cursor: {t,id} exacto (o null = desde el principio).
          Solapamiento: la PRIMERA página de una corrida pide updated_at >= t - solapamientoMs para recuperar filas
          confirmadas tarde (dos transacciones concurrentes pueden hacerse visibles en orden distinto al de su sello). */
      paginar: function (tabla, o) {
        var pagina = o.pagina || 500, maxPaginas = o.maxPaginas || 200, solape = o.solapamientoMs === undefined ? 60000 : o.solapamientoMs;
        var cursor = o.cursor || null, primera = true, total = 0, paginas = 0;
        function siguiente() {
          if (paginas >= maxPaginas) return Promise.resolve({ ok: true, total: total, cursor: cursor, completo: false });
          var q = { select: o.select || "*", orden: "updated_at.asc,id.asc", limite: pagina, filtros: (o.filtros || []).slice() };
          if (cursor) {
            if (primera && solape > 0) {
              var desde = restarMs(cursor.t, solape);
              if (desde) q.filtros.push(["updated_at", "gte", desde]); else q.or = condicionCursor(cursor);
            } else q.or = condicionCursor(cursor);
          }
          primera = false;
          return pedir("GET", tabla, construirQuery(q)).then(function (r) {
            if (!r.ok) return { ok: false, clase: r.clase, status: r.status, codigo: r.codigo, mensaje: r.mensaje, total: total, cursor: cursor };
            var filas = Array.isArray(r.datos) ? r.datos : [];
            paginas++; total += filas.length;
            var ultimo = filas.length ? filas[filas.length - 1] : null;
            var nuevo = ultimo ? { t: ultimo.updated_at, id: ultimo.id } : cursor;
            if (!filas.length) return { ok: true, total: total, cursor: cursor, completo: true };
            return Promise.resolve(o.onPagina ? o.onPagina(filas, nuevo) : undefined).then(function (seguir) {
              cursor = nuevo;
              if (seguir === false) return { ok: true, total: total, cursor: cursor, completo: false, detenido: true };
              // Se sigue hasta recibir una página VACÍA: el servidor puede recortar la página por su propio máximo de filas
              // (max-rows), así que «vino corta» no significa «se acabó».
              return siguiente();
            });
          });
        }
        return siguiente();
      },

      /** INSERT idempotente. ignorarDuplicados: una fila que ya existe se ignora (reintento tras respuesta perdida). */
      insertar: function (tabla, filas, o) {
        o = o || {};
        var prefer = ["return=" + (o.devolver === false ? "minimal" : "representation")];
        if (o.ignorarDuplicados) prefer.push("resolution=ignore-duplicates");
        return pedir("POST", tabla, construirQuery({ onConflict: o.onConflict }), { cuerpo: filas, prefer: prefer.join(",") });
      },

      /** PATCH por filtros. Con return=representation devuelve las filas afectadas: [] = ninguna coincidió
          (por ejemplo, la revisión cambió) o la política RLS la ocultó. */
      modificar: function (tabla, filtros, cambios) {
        return pedir("PATCH", tabla, construirQuery({ filtros: filtros }), { cuerpo: cambios, prefer: "return=representation" });
      },

      /** Llamada a una función de la base. */
      rpc: function (nombre, params, o) {
        return pedir("POST", "rpc/" + encodeURIComponent(nombre), "", { cuerpo: params || {}, timeout: o && o.timeout });
      },
    };
    // rpc no cuelga de /rest/v1/ + tabla sino de /rest/v1/rpc/…: mismo prefijo, ya cubierto por url().
    return api;
  }

  global.SyncRest = { crear: crear, clasificar: clasificar, construirQuery: construirQuery, condicionCursor: condicionCursor, restarMs: restarMs };
})(typeof window !== "undefined" ? window : this);
