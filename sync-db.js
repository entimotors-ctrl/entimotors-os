/* ============================================================================
 * ENTIMOTORS OS · sync-db.js  (3.14.0 · SYNC-4)
 * ----------------------------------------------------------------------------
 * Base local de la sincronización: IndexedDB `entimotors_sync` (v1). Es una base
 * NUEVA e independiente: `entimotors_os_demo` (v6) NO se toca, ni se sube a v7,
 * para que un rollback a 3.13.0 pueda abrirla igual que siempre.
 *
 * QUÉ HAY DENTRO
 *   · una tabla local por entidad (mismos nombres y forma que la app de siempre:
 *     id entero + campos), más `uid` (UUID de la nube) y sellos internos (_rev, _base, _pend);
 *   · mapa      uid ↔ id local (sobrevive a los borrados para resolver referencias);
 *   · outbox    cola de operaciones pendientes, en orden y con estado;
 *   · cursores  hasta dónde se descargó cada entidad, por (updated_at, id);
 *   · conflictos, blobs (fotos pendientes, aparte de la cola) y meta (device_id…).
 *
 * El PIN administrativo y las autorizaciones NO se guardan aquí, jamás.
 * ==========================================================================*/
(function (global) {
  "use strict";

  var NOMBRE = "entimotors_sync";
  var VERSION = 1;
  // Mismos nombres que la base de siempre (app.js). web_cms usa `key` como llave.
  var ENTIDADES = ["clientes", "motos", "citas", "ordenes", "inventario", "cotizaciones", "categorias_inv",
    "ventas_rapidas", "caja_movimientos", "creditos", "web_cms", "auditoria"];
  var OTRAS = ["meta", "mapa", "outbox", "cursores", "conflictos", "blobs"];
  /* SYNC-8: la identidad del DISPOSITIVO vive en su propia base, aparte de las cachés. Así es UNA por dispositivo
     (perfil de navegador), la misma para el Taller y para cada caché de mecánico (entimotors_sync_mec_*), no cambia al
     recargar ni al cambiar de usuario, y no forma parte de ningún respaldo (el respaldo es de la base de siempre): ni se
     restaura de un archivo ni se copia a otro equipo (SYNC-9). Otro perfil de navegador = otro almacenamiento = otro id. */
  var NOMBRE_DISPOSITIVO = "entimotors_dispositivo";

  function nombreParaSesion(sesion) {
    if (sesion && sesion.rol === "mecanico" && sesion.perfilId) return NOMBRE + "_mec_" + sesion.perfilId;
    return NOMBRE;
  }

  function uuid() {
    var c = global.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    var b = new Uint8Array(16); c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  function promesa(req) {
    return new Promise(function (ok, mal) {
      req.onsuccess = function () { ok(req.result); };
      req.onerror = function () { mal(req.error || new Error("IndexedDB")); };
    });
  }
  function fin(t) {
    return new Promise(function (ok, mal) {
      t.oncomplete = function () { ok(); };
      t.onerror = function () { mal(t.error || new Error("IndexedDB")); };
      t.onabort = function () { mal(t.error || new Error("transacción cancelada")); };
    });
  }

  /** device_id del dispositivo. `sugerido`: el que esta caché ya tenía (antes de SYNC-8 cada caché guardaba el suyo):
      si el dispositivo aún no tiene uno, se ADOPTA ese, para no cambiarle la identidad a un Taller ya en uso. */
  function idDispositivo(idbf, sugerido) {
    return new Promise(function (ok, mal) {
      var req = idbf.open(NOMBRE_DISPOSITIVO, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("meta", { keyPath: "k" }); };
      req.onerror = function () { mal(req.error || new Error("no se pudo abrir " + NOMBRE_DISPOSITIVO)); };
      req.onsuccess = function () {
        var d = req.result, t = d.transaction(["meta"], "readwrite"), st = t.objectStore("meta"), id = null;
        var g = st.get("device_id");
        g.onsuccess = function () {
          if (g.result && g.result.v) { id = g.result.v; return; }
          id = sugerido || uuid();
          st.put({ k: "device_id", v: id });
        };
        t.oncomplete = function () { d.close(); ok(id); };
        t.onerror = t.onabort = function () { d.close(); mal(t.error || new Error("device_id")); };
      };
    });
  }

  function abrir(o) {
    o = o || {};
    var idbf = o.indexedDB || global.indexedDB;
    var nombre = o.nombre || NOMBRE;
    return new Promise(function (ok, mal) {
      var req = idbf.open(nombre, VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        ENTIDADES.forEach(function (e) {
          var s = e === "web_cms" ? d.createObjectStore(e, { keyPath: "key" }) : d.createObjectStore(e, { keyPath: "id", autoIncrement: true });
          if (e !== "web_cms") s.createIndex("by_uid", "uid", { unique: true });
        });
        d.createObjectStore("meta", { keyPath: "k" });
        var m = d.createObjectStore("mapa", { keyPath: "uid" });
        m.createIndex("by_local", ["entidad", "local_id"], { unique: true });
        var q = d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
        q.createIndex("by_estado", "estado");
        q.createIndex("by_registro", ["entidad", "uid"]);
        d.createObjectStore("cursores", { keyPath: "entidad" });
        d.createObjectStore("conflictos", { keyPath: "id", autoIncrement: true });
        var b = d.createObjectStore("blobs", { keyPath: "id", autoIncrement: true });
        b.createIndex("by_registro", ["entidad", "uid"]);
      };
      req.onblocked = function () { /* otra pestaña con la versión anterior abierta: no ocurre con v1 */ };
      req.onerror = function () { mal(req.error || new Error("no se pudo abrir " + nombre)); };
      req.onsuccess = function () { ok(envolver(req.result, nombre, idbf)); };
    });
  }

  function envolver(idb, nombre, idbf) {
    var bd = { nombre: nombre, idb: idb };

    /* Transacción con varias tablas. `fn` recibe un acceso `t` cuyas operaciones devuelven promesas de IndexedDB:
       dentro de `fn` solo se debe esperar a `t.*` (esperar a cualquier otra cosa cierra la transacción). */
    bd.transaccion = function (tablas, modo, fn) {
      var t = idb.transaction(tablas, modo);
      var fin_ = fin(t);
      var acc = {
        get: function (s, k) { return promesa(t.objectStore(s).get(k)); },
        put: function (s, v) { return promesa(t.objectStore(s).put(v)); },
        add: function (s, v) { return promesa(t.objectStore(s).add(v)); },
        borrar: function (s, k) { return promesa(t.objectStore(s).delete(k)); },
        todos: function (s) { return promesa(t.objectStore(s).getAll()); },
        porIndice: function (s, ind, k) { return promesa(t.objectStore(s).index(ind).get(k)); },
        todosPorIndice: function (s, ind, k) { return promesa(t.objectStore(s).index(ind).getAll(k)); },
        vaciar: function (s) { return promesa(t.objectStore(s).clear()); },
        abortar: function () { try { t.abort(); } catch (e) { /* ya cerrada */ } },
      };
      var res;
      var corrida = Promise.resolve().then(function () { return fn(acc); }).then(function (v) { res = v; }, function (e) { try { t.abort(); } catch (x) { /* ya */ } throw e; });
      return corrida.then(function () { return fin_; }).then(function () { return res; }, function (e) { return fin_.catch(function () { /* la cancelación ya se reporta con e */ }).then(function () { throw e; }); });
    };

    bd.meta = {
      get: function (k) { return bd.transaccion(["meta"], "readonly", function (t) { return t.get("meta", k); }).then(function (r) { return r ? r.v : undefined; }); },
      set: function (k, v) { return bd.transaccion(["meta"], "readwrite", function (t) { return t.put("meta", { k: k, v: v }); }); },
    };
    var idCache = null;
    bd.deviceId = function () {
      if (idCache) return idCache;
      var local = function () {
        return bd.transaccion(["meta"], "readwrite", function (t) {
          return t.get("meta", "device_id").then(function (r) {
            if (r && r.v) return r.v;
            var id = uuid();
            return t.put("meta", { k: "device_id", v: id }).then(function () { return id; });
          });
        });
      };
      idCache = bd.meta.get("device_id").then(function (propio) {
        if (!idbf) return local();
        return idDispositivo(idbf, propio).then(function (id) {
          return propio === id ? id : bd.meta.set("device_id", id).then(function () { return id; });   // la caché lo refleja
        }, function () { return local(); });   // sin la base del dispositivo (bloqueada): el de la caché, como antes
      });
      idCache.catch(function () { idCache = null; });
      return idCache;
    };
    bd.cursor = {
      get: function (entidad) { return bd.transaccion(["cursores"], "readonly", function (t) { return t.get("cursores", entidad); }); },
      set: function (entidad, c) { return bd.transaccion(["cursores"], "readwrite", function (t) { return t.put("cursores", { entidad: entidad, t: c.t, id: c.id }); }); },
    };
    bd.datos = {
      todos: function (e) { return bd.transaccion([e], "readonly", function (t) { return t.todos(e); }); },
      get: function (e, id) { return bd.transaccion([e], "readonly", function (t) { return t.get(e, id); }); },
      porUid: function (e, uid) { return bd.transaccion([e], "readonly", function (t) { return t.porIndice(e, "by_uid", uid); }); },
    };
    bd.outbox = {
      todos: function () { return bd.transaccion(["outbox"], "readonly", function (t) { return t.todos("outbox"); }); },
      porEstado: function (estado) { return bd.transaccion(["outbox"], "readonly", function (t) { return t.todosPorIndice("outbox", "by_estado", estado); }); },
      get: function (seq) { return bd.transaccion(["outbox"], "readonly", function (t) { return t.get("outbox", seq); }); },
      actualizar: function (seq, cambios) {
        return bd.transaccion(["outbox"], "readwrite", function (t) {
          return t.get("outbox", seq).then(function (op) { if (!op) return null; Object.keys(cambios).forEach(function (k) { op[k] = cambios[k]; }); return t.put("outbox", op).then(function () { return op; }); });
        });
      },
      borrar: function (seq) { return bd.transaccion(["outbox"], "readwrite", function (t) { return t.borrar("outbox", seq); }); },
      contar: function () {
        return bd.outbox.todos().then(function (ops) {
          var c = { pending: 0, syncing: 0, conflict: 0, rejected: 0, total: ops.length };
          ops.forEach(function (o) { if (c[o.estado] !== undefined) c[o.estado]++; });
          return c;
        });
      },
    };
    bd.mapa = {
      uidDe: function (entidad, localId) { return bd.transaccion(["mapa"], "readonly", function (t) { return t.porIndice("mapa", "by_local", [entidad, localId]); }).then(function (r) { return r ? r.uid : null; }); },
      localDe: function (uid) { return bd.transaccion(["mapa"], "readonly", function (t) { return t.get("mapa", uid); }).then(function (r) { return r ? r.local_id : null; }); },
    };
    bd.conflictos = {
      todos: function () { return bd.transaccion(["conflictos"], "readonly", function (t) { return t.todos("conflictos"); }); },
      agregar: function (c) { return bd.transaccion(["conflictos"], "readwrite", function (t) { return t.add("conflictos", c); }); },
      borrar: function (id) { return bd.transaccion(["conflictos"], "readwrite", function (t) { return t.borrar("conflictos", id); }); },
    };
    bd.blobs = {
      agregar: function (b) { return bd.transaccion(["blobs"], "readwrite", function (t) { return t.add("blobs", b); }); },
      todos: function () { return bd.transaccion(["blobs"], "readonly", function (t) { return t.todos("blobs"); }); },
      borrar: function (id) { return bd.transaccion(["blobs"], "readwrite", function (t) { return t.borrar("blobs", id); }); },
    };

    /* Vacía TODO salvo device_id (la identidad del dispositivo). Se usa al cambiar de dueño de la caché. */
    bd.vaciarCache = function () {
      var todas = ENTIDADES.concat(["mapa", "outbox", "cursores", "conflictos", "blobs"]);
      return bd.transaccion(todas, "readwrite", function (t) { return Promise.all(todas.map(function (s) { return t.vaciar(s); })); });
    };
    bd.cerrar = function () { try { idb.close(); } catch (e) { /* ya */ } };
    return bd;
  }

  global.SyncDB = { abrir: abrir, nombre: NOMBRE, nombreDispositivo: NOMBRE_DISPOSITIVO, version: VERSION, ENTIDADES: ENTIDADES, OTRAS: OTRAS, nombreParaSesion: nombreParaSesion, uuid: uuid };
})(typeof window !== "undefined" ? window : this);
