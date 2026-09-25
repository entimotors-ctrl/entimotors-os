/* ============================================================================
 * ENTIMOTORS OS · sync-engine.js  (3.14.0 · SYNC-4)
 * ----------------------------------------------------------------------------
 * Motor de sincronización: cola de salida (outbox), descarga incremental (pull),
 * fusión de cambios y conflictos. Apagado por defecto: sin
 * `ENTIMOTORS_SYNC.enabled === true` no abre ninguna base ni hace ninguna petición.
 *
 * MODELO
 *   · La NUBE manda. La base local (entimotors_sync) es caché + trabajo sin conexión.
 *   · Cada escritura local es UNA transacción: el registro y su operación en la cola.
 *   · Cada operación lleva un op_id (idempotencia) y la revisión de la que partió.
 *   · Actualizar = PATCH solo de los campos cambiados, condicionado a la revisión conocida.
 *     Si la revisión cambió, se fusiona campo a campo (base, mío, servidor): solo hay
 *     conflicto cuando ambos lados cambiaron el MISMO campo a valores distintos.
 *   · Nada se pierde en silencio: un rechazo o un conflicto queda en la cola/lista, a la vista.
 *   · El PIN administrativo y sus autorizaciones NO entran jamás en la cola: esas acciones
 *     solo corren en línea (se rechaza cualquier intento de encolarlas).
 *   · Solo se envían las operaciones del usuario que las creó (created_by lo sella el servidor
 *     con el token de quien envía): las de otra persona esperan a que ella inicie sesión.
 *
 * SYNC-8 · CONTRATO DE LA COLA (auditado; nombres reales, sin estados nuevos)
 *   estados:  pending (espera; `siguiente_en` = no antes de) → syncing (enviándose, con `enviando_en`)
 *             → [aplicada = se BORRA de la cola] | rejected (terminal, a la vista) | conflict (+ fila en `conflictos`).
 *             Un rechazo por dependencia es `rejected` con error.clase = "dependencia" (no se envió nunca).
 *   clases:   (sync-rest.js) permiso 403/42501 · validacion 400 (23514, 22000, 22023…) · conflicto 409 (23503, 23505)
 *             → TERMINALES, nunca se reintentan. red (sin red, DNS, tiempo agotado) · servidor 5xx (55P03, 40001…) ·
 *             limite 429 (Retry-After) · esquema → reintento con espera exponencial + variación (esperaMs), nunca en
 *             bucle. auth → PAUSA (no gasta intentos; nada sale como anónimo) hasta sesión válida y perfil revalidado.
 *   orden:    por `seq`, pero con dependencias explícitas (elegirSiguiente): un hijo espera a su padre aunque el padre
 *             esté en espera; si el padre fue rechazado, el hijo se rechaza sin enviarse. Lo independiente sigue.
 *   cierre:   una op en «syncing» al arrancar un envío es de un envío que murió a mitad → vuelve a pending y se
 *             reintenta con el MISMO op_id (idempotente: un solo efecto aunque el servidor ya la hubiera aplicado).
 *   pestañas: una sola envía (Web Locks; si no hay, arrendamiento en la base RENOVADO en cada operación).
 *   revisión: revision() junta rechazos, dependencias y conflictos (persisten en la base); la UI los muestra.
 * ==========================================================================*/
(function (global) {
  "use strict";

  /* Acciones que exigen el PIN del administrador: SOLO en línea, jamás en la cola. */
  var ACCIONES_CON_PIN = ["ajustar_stock", "reversar_venta", "registrar_devolucion", "reversar_abono", "reversar_credito", "reversar_caja", "anular_orden"];
  var CLAVES_PROHIBIDAS = /^(pin|pin_nuevo|pin_actual|clave_cuenta|autorizacion_id|p_autorizacion_id|admin_pin)$/i;

  /* ---------------- funciones puras (probadas en Node) ---------------- */
  function estable(v) {
    if (v === undefined) return "null";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(estable).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + estable(v[k]); }).join(",") + "}";
  }
  function igual(a, b) { return estable(a) === estable(b); }

  /** Campos de `nuevo` que difieren de `base` (base puede ser null = todo es nuevo). */
  function diferencias(base, nuevo) {
    var d = {};
    Object.keys(nuevo).forEach(function (k) { if (!base || !igual(base[k], nuevo[k])) d[k] = nuevo[k]; });
    return d;
  }

  /** Fusión de tres vías por campo. base = de donde partí, mios = lo que cambié, servidor = lo que hay ahora. */
  function fusionar(base, mios, servidor) {
    var fusion = {}, conflictos = [];
    Object.keys(mios).forEach(function (c) {
      var s = servidor[c], b = base ? base[c] : undefined, m = mios[c];
      if (igual(s, m)) return;                       // ya está así en el servidor: nada que enviar
      if (igual(s, b)) fusion[c] = m;                // el servidor no lo tocó: mi cambio aplica
      else conflictos.push(c);                       // los dos lo cambiaron a valores distintos
    });
    return { fusion: fusion, conflictos: conflictos };
  }

  /** Espera antes de reintentar: 2 s, 4 s, 8 s… tope 5 min, con variación para no sincronizar todos a la vez. */
  function esperaMs(intentos, aleatorio) {
    var base = Math.min(2000 * Math.pow(2, Math.max(0, intentos - 1)), 300000);
    return Math.round(base * (0.75 + 0.5 * (aleatorio === undefined ? Math.random() : aleatorio)));
  }

  /** Compara dos sellos de tiempo del servidor (texto, microsegundos) sin pasar por Date. -1, 0, 1. */
  function compararTiempo(a, b) {
    var n = function (s) {
      var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(String(s));
      if (!m) return String(s);
      var frac = (m[3] || "").padEnd(6, "0").slice(0, 6);
      return m[1] + "T" + m[2] + "." + frac;
    };
    var x = n(a), y = n(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function compararCursor(a, b) {
    var c = compararTiempo(a.t, b.t);
    if (c !== 0) return c;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /** Rechaza cualquier intento de encolar una acción con PIN o con datos de autorización. */
  function verificarSinPin(nombre, params) {
    if (ACCIONES_CON_PIN.indexOf(nombre) >= 0) throw new Error("La acción «" + nombre + "» requiere el PIN del administrador y solo puede hacerse en línea.");
    (function rec(o, prof) {
      if (!o || typeof o !== "object" || prof > 4) return;
      Object.keys(o).forEach(function (k) {
        if (CLAVES_PROHIBIDAS.test(k)) throw new Error("La cola de sincronización no admite datos de autorización (" + k + ").");
        rec(o[k], prof + 1);
      });
    })(params, 0);
  }

  /* SYNC-8 · ORDEN DE DEPENDENCIAS. Una operación «crea» un registro (insert, o una RPC marcada `crea`: venta, crédito). */
  function esCreacion(op) { return op.kind === "insert" || (op.kind === "rpc" && op.crea === true); }
  /** ¿La operación toca o apunta al registro `uid`? (su propio registro, o el uid aparece en lo que envía: llave foránea,
      parámetro de RPC). Los uid son UUID: buscarlos como texto JSON exacto no da falsos positivos. */
  function referencia(op, uid) {
    if (!uid) return false;
    if (op.uid === uid) return true;
    return estable(op.kind === "rpc" ? op.params : op.cambios).indexOf(JSON.stringify(uid)) >= 0;
  }
  /** Siguiente operación a procesar para `actor`, respetando dependencias explícitas y no solo el orden de llegada.
      ops: TODA la cola. Devuelve null (nada que hacer ahora) o {op, accion:"enviar"|"rechazar-dependencia", padre?}.
        · Un padre que todavía no salió (en espera por reintento, o de OTRA persona que aún no inicia sesión) retiene a
          sus hijos: nunca se envía un hijo antes que su padre, aunque el hijo esté listo.
        · Un padre RECHAZADO (su registro no existe en la nube) hace que sus hijos se rechacen sin enviarse, con motivo
          visible — en cascada, porque ese hijo rechazado es a su vez padre de los suyos.
        · Lo que no depende de nada retenido sigue su curso (un reintento largo no congela toda la cola). */
  function elegirSiguiente(ops, actor, ahora) {
    var orden = ops.slice().sort(function (a, b) { return a.seq - b.seq; });
    // retCrea: altas retenidas (retienen a todo lo que las apunte); retReg: otras operaciones retenidas (solo retienen a
    // las siguientes del MISMO registro — un reintento de una edición no frena a los hijos de ese registro, que ya existe)
    var rechazados = [], retCrea = [], retReg = [];
    orden.forEach(function (x) { if (x.estado === "rejected" && esCreacion(x)) rechazados.push(x.uid); });
    for (var i = 0; i < orden.length; i++) {
      var op = orden[i];
      if (op.estado !== "pending" && op.estado !== "syncing") continue;
      if (op.actor_uid !== actor) { if (esCreacion(op)) retCrea.push(op.uid); continue; }   // de otra persona: espera a su dueño
      var padreRechazado = rechazados.filter(function (u) { return referencia(op, u); })[0];
      if (padreRechazado && op.estado === "pending") return { op: op, accion: "rechazar-dependencia", padre: padreRechazado };
      var retenido = retCrea.some(function (u) { return referencia(op, u); }) || retReg.indexOf(op.uid) >= 0;
      if (retenido || op.estado !== "pending" || (op.siguiente_en || 0) > ahora) { (esCreacion(op) ? retCrea : retReg).push(op.uid); continue; }
      return { op: op, accion: "enviar" };
    }
    return null;
  }

  var puras = { estable: estable, igual: igual, diferencias: diferencias, fusionar: fusionar, esperaMs: esperaMs, compararTiempo: compararTiempo, compararCursor: compararCursor, verificarSinPin: verificarSinPin, ACCIONES_CON_PIN: ACCIONES_CON_PIN,
    esCreacion: esCreacion, referencia: referencia, elegirSiguiente: elegirSiguiente };

  /* ---------------- motor ---------------- */
  function crearMotor(o) {
    var bd = o.bd, rest = o.rest, mappers = o.mappers || {};
    var ORDEN = o.orden || Object.keys(mappers);
    var sesion = o.sesion || function () { return null; };
    var reloj = o.ahora || function () { return Date.now(); };
    var nuevoUuid = o.uuid || (global.SyncDB && global.SyncDB.uuid);
    var habilitado = o.habilitado || function () { return !!(global.ENTIMOTORS_SYNC && global.ENTIMOTORS_SYNC.enabled === true); };
    var locks = o.locks !== undefined ? o.locks : (global.navigator && global.navigator.locks);
    var escuchas = [];
    var estadoVivo = { sincronizando: false, ultimaOk: null, ultimoError: null, ultimoPull: null };
    var duenoLease = nuevoUuid();
    /* SYNC-8: pausa por sesión. "auth" = la sesión caducó y no se pudo refrescar: NADA se envía (jamás como anónimo)
       hasta reanudar() o hasta que pase PAUSA_AUTH_MS (se vuelve a probar el refresco una vez). "cuenta-inactiva" = el
       perfil está desactivado: fail closed, no se reanuda sola. `validarPerfil`: comprobar rol/activo del perfil antes
       del primer envío de este motor (y tras cada pausa por sesión). */
    var PAUSA_AUTH_MS = o.pausaAuthMs || 60000;
    var pausa = null;                     // null | {motivo:"auth"|"cuenta-inactiva", desde}
    var perfilOk = !o.validarPerfil;

    function emitir(tipo, datos) { escuchas.slice().forEach(function (f) { try { f({ tipo: tipo, datos: datos }); } catch (e) { /* un oyente roto no rompe la cola */ } }); }
    function apagado() { return !habilitado(); }
    function mapper(entidad) { var m = mappers[entidad]; if (!m) throw new Error("entidad sin mapper: " + entidad); return m; }

    function normalizarTiempo(v) { if (v === null || v === undefined) return null; var d = new Date(v); return isNaN(d.getTime()) ? v : d.toISOString(); }
    /* Instantánea de lo que el cliente escribe (columnas del mapper + llaves foráneas). Del lado del servidor (parcial=false) las
       columnas ausentes valen null; del lado local (parcial=true) una columna `undefined` significa «esta app no la maneja» y se
       omite: así no se envía null a una columna NOT NULL con valor por defecto ni se inventan diferencias. */
    function columnasNube(m, fila, parcial) {
      var s = {}, tiempos = m.tiempos || [];
      var poner = function (c, v) {
        if (v === undefined) { if (parcial) return; v = null; }
        s[c] = tiempos.indexOf(c) >= 0 ? normalizarTiempo(v) : v;
      };
      (m.columnas || []).forEach(function (c) { poner(c, fila[c]); });
      (m.fks || []).forEach(function (f) { poner(f.cloud, fila[f.cloud]); });
      return s;
    }

    /* uid → id local de otra entidad, dentro de la transacción */
    function localDeUid(t, uid) {
      if (uid === null || uid === undefined) return Promise.resolve(null);
      return t.get("mapa", uid).then(function (r) { return r ? r.local_id : null; });
    }
    async function fksALocal(t, m, row) {
      var out = {};
      for (var i = 0; i < (m.fks || []).length; i++) { var f = m.fks[i]; out[f.local] = await localDeUid(t, row[f.cloud]); }
      return out;
    }
    /* SYNC-7B: referencias DENTRO de hijos embebidos (p. ej. venta_items.inventario_id → id local del repuesto).
       El mapper declara `refsALocal(campos, resolver)`; `resolver(uid)` consulta el mapa dentro de la MISMA
       transacción. Sin ese campo en el mapper, no cambia nada (las entidades de SYNC-5/6/7A no lo usan). */
    async function camposLocales(t, m, row, faltan) {
      var fks = await fksALocal(t, m, row);
      // SYNC-8: una llave foránea que la nube trae pero el mapa todavía no conoce (el padre se creó después de bajar su
      // tabla, o la descarga se cortó) no se pierde en silencio: se anota para volver a resolverla tras la descarga.
      (m.fks || []).forEach(function (f) { if (faltan && row[f.cloud] != null && fks[f.local] == null) faltan.push(f.cloud); });
      var campos = Object.assign({}, m.aLocal(row), fks);
      if (typeof m.refsALocal === "function") campos = await m.refsALocal(campos, function (uid) {
        return localDeUid(t, uid).then(function (id) { if (faltan && uid != null && id == null) faltan.push("ref"); return id; });
      });
      return campos;
    }
    /* SYNC-8: el mapper puede declarar cómo combinar lo que baja con lo que solo existe en ESTE dispositivo (p. ej. los
       renglones de una orden que todavía no llegaron a la nube). Sin el hook, lo de la nube reemplaza campo a campo. */
    function combinarLocal(m, local, campos) { return typeof m.fusionarLocal === "function" && local ? m.fusionarLocal(local, campos) : campos; }
    /* SYNC-8: campos que decide SOLO el servidor (cantidad, estado de cobro…). Bajan aunque haya un cambio local pendiente
       del mismo registro: nunca son parte de lo que el cliente edita, así que no hay nada que fusionar. */
    function soloServidor(m, campos) {
      var s = {}; (m.soloServidor || []).forEach(function (k) { if (campos[k] !== undefined) s[k] = campos[k]; }); return s;
    }
    async function anotarFkPendiente(t, entidad, uid, pendiente) {
      var r = await t.get("meta", "fk_pendientes"), v = (r && r.v) || {};
      var l = v[entidad] || [];
      var i = l.indexOf(uid);
      if (pendiente && i < 0) l.push(uid); else if (!pendiente && i >= 0) l.splice(i, 1); else return;
      if (l.length) v[entidad] = l.slice(-500); else delete v[entidad];
      await t.put("meta", { k: "fk_pendientes", v: v });
    }

    /* ============ ESCRITURA LOCAL (registro + cola en UNA transacción) ============ */
    async function escribir(entidad, local, opciones) {
      if (apagado()) return { omitido: "apagado" };
      opciones = opciones || {};
      var m = mapper(entidad), s = sesion();
      // SYNC-7B: dinero (ventas, créditos, caja) es de SOLO LECTURA por el CRUD: se escribe únicamente por RPC.
      if (m.soloLectura) throw new Error("«" + entidad + "» solo se modifica por su operación (RPC), nunca por el CRUD.");
      if (!s || !s.uid) throw new Error("No hay sesión: no se puede guardar en modo nube.");
      var dev = await bd.deviceId();
      return bd.transaccion([m.store, "mapa", "outbox"], "readwrite", async function (t) {
        var previo = local.id !== undefined && local.id !== null ? await t.get(m.store, local.id) : null;
        var uid = (previo && previo.uid) || local.uid || nuevoUuid();
        var ops = previo ? await t.todosPorIndice("outbox", "by_registro", [entidad, uid]) : [];
        // SYNC-8: solo se reescriben las operaciones PROPIAS. Una pendiente de otra persona (cambio de usuario en el mismo
        // dispositivo) se trata como «en camino»: jamás se le mezcla un cambio ajeno ni cambia de autor.
        var pendientes = ops.filter(function (x) { return x.estado === "pending" && x.actor_uid === s.uid; });
        var enCurso = ops.filter(function (x) { return x.estado === "syncing" || (x.estado === "pending" && x.actor_uid !== s.uid); });

        if (opciones.borrar) {
          if (!previo) return { id: null, uid: null };
          await t.borrar(m.store, previo.id);
          var insertPend = pendientes.filter(function (x) { return x.kind === "insert"; })[0];
          if (insertPend && !enCurso.length) {                        // nunca llegó a la nube: no hay nada que borrar allá
            for (var i = 0; i < ops.length; i++) await t.borrar("outbox", ops[i].seq);
            return { id: previo.id, uid: uid, descartada: true };
          }
          for (var j = 0; j < pendientes.length; j++) if (pendientes[j].kind !== "delete") await t.borrar("outbox", pendientes[j].seq);
          if (!pendientes.some(function (x) { return x.kind === "delete"; })) {
            await t.add("outbox", { op_id: nuevoUuid(), entidad: entidad, tabla: m.tabla, uid: uid, kind: "delete", cambios: {}, base: previo._base || null, base_rev: previo._rev || 0,
              estado: "pending", intentos: 0, siguiente_en: 0, actor_uid: s.uid, device_id: dev, creado_en: reloj(), error: null });
          }
          return { id: previo.id, uid: uid };
        }

        var fkc = {};
        for (var k = 0; k < (m.fks || []).length; k++) {
          var fk = m.fks[k], v = local[fk.local];
          if (v === undefined || v === null) { fkc[fk.cloud] = null; continue; }
          var mp = await t.porIndice("mapa", "by_local", [fk.entidad, v]);
          if (!mp) throw new Error("La referencia " + fk.local + "=" + v + " no existe en «" + fk.entidad + "».");
          fkc[fk.cloud] = mp.uid;
        }
        var nube = columnasNube(m, Object.assign({}, m.aCloud(local), fkc), true);
        var reg = Object.assign({}, local, { uid: uid, _rev: previo ? previo._rev || 0 : 0, _base: previo ? previo._base || null : null, _pend: true });
        if (reg.id === undefined || reg.id === null) delete reg.id;
        var id = await t.put(m.store, reg);
        if (!previo) await t.put("mapa", { uid: uid, entidad: entidad, local_id: id });

        var insertaPend = pendientes.filter(function (x) { return x.kind === "insert"; })[0];
        var insertEnCurso = enCurso.some(function (x) { return x.kind === "insert"; });
        var updPend = pendientes.filter(function (x) { return x.kind === "update"; })[0];
        var nueva = function (kind, cambios, base, baseRev) {
          return { op_id: nuevoUuid(), entidad: entidad, tabla: m.tabla, uid: uid, kind: kind, cambios: cambios, base: base, base_rev: baseRev,
            estado: "pending", intentos: 0, siguiente_en: 0, actor_uid: s.uid, device_id: dev, creado_en: reloj(), error: null };
        };
        var nuncaSincronizado = !previo || (!previo._base && !(previo._rev > 0));
        if (nuncaSincronizado) {
          var fila = Object.assign({ id: uid, local_id: id, dispositivo: dev }, nube);
          if (insertaPend) { insertaPend.cambios = fila; await t.put("outbox", insertaPend); }
          else if (insertEnCurso) {           // el alta va en camino: esta edición se envía después, ya con la revisión que devuelva la nube
            if (updPend) { updPend.cambios = nube; await t.put("outbox", updPend); } else await t.add("outbox", nueva("update", nube, null, 0));
          } else await t.add("outbox", nueva("insert", fila, null, 0));
        } else if (updPend) {
          var d = diferencias(updPend.base, nube);
          if (Object.keys(d).length) { updPend.cambios = d; await t.put("outbox", updPend); }
          else await t.borrar("outbox", updPend.seq);
        } else {
          var d2 = diferencias(previo._base, nube);
          if (Object.keys(d2).length) await t.add("outbox", nueva("update", d2, previo._base, previo._rev || 0));
        }
        var quedan = await t.todosPorIndice("outbox", "by_registro", [entidad, uid]);
        var pend = quedan.some(function (x) { return x.estado === "pending" || x.estado === "syncing"; });
        if (reg._pend !== pend) { reg._pend = pend; reg.id = id; await t.put(m.store, reg); }
        return { id: id, uid: uid };
      }).then(function (r) { programarEnvio(); emitir("cambio-local", { entidad: entidad }); return r; });
    }

    /* ============ DESCARGA ============ */
    /* forzar (SYNC-8): re-aplicar aunque la revisión ya se conozca — solo para resolver llaves foráneas pendientes.
       nuevoCursor null: no mueve el cursor (una re-lectura puntual no es una página de la descarga incremental). */
    async function aplicarPagina(m, filas, nuevoCursor, forzar) {
      var tablas = [m.store, "mapa", "outbox", "cursores", "meta"];
      // los padres de las llaves foráneas solo se consultan por el mapa
      return bd.transaccion(tablas, "readwrite", async function (t) {
        for (var i = 0; i < filas.length; i++) {
          var row = filas[i], uid = row.id;
          var mp = await t.get("mapa", uid);
          var local = mp ? await t.get(m.store, mp.local_id) : null;
          var ops = local ? await t.todosPorIndice("outbox", "by_registro", [m.entidad, uid]) : [];
          if (row.deleted_at) {
            if (local) {
              await t.borrar(m.store, local.id);
              for (var q = 0; q < ops.length; q++) if (ops[q].estado === "pending") { ops[q].estado = "conflict"; ops[q].error = "borrado_remoto"; await t.put("outbox", ops[q]); }
            }
            await anotarFkPendiente(t, m.entidad, uid, false);
            continue;
          }
          if (local && !forzar && (row.rev || 0) <= (local._rev || 0)) continue;             // ya lo tengo (solapamiento)
          var faltan = [];
          var campos = await camposLocales(t, m, row, faltan);
          var snap = columnasNube(m, row);
          if (local && ops.some(function (x) { return x.estado === "pending" || x.estado === "syncing" || x.estado === "conflict"; })) {
            // Hay un cambio mío sin enviar: lo mío se queda a la vista y la revisión conocida NO avanza: al enviar,
            // el PATCH condicionado detectará el cambio remoto y lo fusionará campo a campo. Lo que decide SOLO el
            // servidor (existencia, cobro) sí baja: no es parte de lo que el cliente edita (SYNC-8, reconciliación).
            var srv = soloServidor(m, campos);
            if (Object.keys(srv).length) await t.put(m.store, Object.assign({}, local, srv));
            continue;
          }
          var reg = Object.assign({}, local || {}, combinarLocal(m, local, campos), { uid: uid, _rev: row.rev || 0, _base: snap, _pend: false });
          if (local) reg.id = local.id; else if (mp) reg.id = mp.local_id; else delete reg.id;
          var id = await t.put(m.store, reg);
          if (!mp) await t.put("mapa", { uid: uid, entidad: m.entidad, local_id: id });
          await anotarFkPendiente(t, m.entidad, uid, faltan.length > 0);
        }
        if (!nuevoCursor) return;
        var previo = await t.get("cursores", m.entidad);
        if (!previo || compararCursor(nuevoCursor, previo) > 0) await t.put("cursores", { entidad: m.entidad, t: nuevoCursor.t, id: nuevoCursor.id });
      });
    }

    async function pull(entidad, opciones) {
      if (apagado()) return { omitido: "apagado" };
      var m = mapper(entidad);
      var cur = await bd.cursor.get(entidad);
      // select: para una entidad con hijos embebidos sin cursor propio (SYNC-5: cotizacion_items dentro de
      // cotizaciones), el mapper declara `select` (p. ej. "*,cotizacion_items(...)") y viaja tal cual a PostgREST.
      var r = await rest.paginar(m.tabla, { cursor: cur ? { t: cur.t, id: cur.id } : null, pagina: (opciones && opciones.pagina) || 500, maxPaginas: opciones && opciones.maxPaginas,
        solapamientoMs: opciones && opciones.solapamientoMs, select: m.select, onPagina: function (filas, nuevo) { return aplicarPagina(m, filas, nuevo); } });
      if (!r.ok) return { ok: false, clase: r.clase, codigo: r.codigo, mensaje: r.mensaje, entidad: entidad };
      return { ok: true, total: r.total, completo: r.completo, entidad: entidad };
    }
    /* SYNC-8 · DESCARGA COMPLETA CON PUNTO DE CONTROL.
       · Las páginas se aplican a medida que llegan y el cursor avanza por página: si la descarga se corta, se retoma
         donde quedó (y el solapamiento re-lee lo último), nunca desde cero ni borrando lo ya bajado.
       · Un fallo en una entidad DETIENE las siguientes (sus hijos): bajar motos sin haber terminado clientes dejaría
         relaciones a medias.
       · meta.bootstrap = {completo:true} SOLO cuando todas las entidades bajaron hasta el final al menos una vez. Hasta
         entonces estado().bootstrapCompleto = false y la UI no presenta lo bajado como sincronización completa.
       · Al final se re-resuelven las llaves foráneas que quedaron pendientes (fk_pendientes). */
    async function pullTodo(opciones) {
      if (apagado()) return [{ omitido: "apagado" }];
      var salida = [], todoOk = true;
      for (var i = 0; i < ORDEN.length; i++) {
        var r = await pull(ORDEN[i], opciones);
        salida.push(r);
        if (r.ok === false) { todoOk = false; break; }
        if (r.completo === false) todoOk = false;
      }
      if (todoOk) {
        try { await resolverFkPendientes(); } catch (e) { todoOk = false; }
        var b = await bd.meta.get("bootstrap");
        if (!b || !b.completo) { await bd.meta.set("bootstrap", { completo: true, en: reloj() }); emitir("bootstrap-completo", null); }
      }
      estadoVivo.ultimoPull = reloj();
      return salida;
    }
    async function resolverFkPendientes() {
      var v = (await bd.meta.get("fk_pendientes")) || {};
      var entidades = Object.keys(v);
      for (var i = 0; i < entidades.length; i++) {
        var m = mappers[entidades[i]], uids = v[entidades[i]] || [];
        if (!m || !uids.length || /^rpc\//.test(m.tabla)) continue;
        for (var j = 0; j < uids.length; j += 50) {
          var lote = uids.slice(j, j + 50);
          var r = await rest.seleccionar(m.tabla, { select: m.select || "*", filtros: [["id", "in", "(" + lote.join(",") + ")"]] });
          if (!r.ok) throw new Error("fk_pendientes: " + r.clase);
          var filas = Array.isArray(r.datos) ? r.datos : [];
          await aplicarPagina(m, filas, null, true);
          var vistos = filas.map(function (f) { return f.id; });
          // lo que la nube ya no devuelve (borrado u oculto por RLS) deja de estar pendiente: no hay nada más que resolver
          var fuera = lote.filter(function (u) { return vistos.indexOf(u) < 0; });
          if (fuera.length) await bd.transaccion(["meta"], "readwrite", async function (t) { for (var k = 0; k < fuera.length; k++) await anotarFkPendiente(t, m.entidad, fuera[k], false); });
        }
      }
    }

    /* ============ ENVÍO ============ */
    function descripcionError(r) { return { clase: r.clase, codigo: r.codigo || "", mensaje: String(r.mensaje || "").slice(0, 300), http: r.status || 0 }; }

    async function aplicarRespuesta(op, row) {
      var m = mapper(op.entidad);
      await bd.transaccion([m.store, "mapa", "outbox"], "readwrite", async function (t) {
        var mp = await t.get("mapa", op.uid);
        var local = mp ? await t.get(m.store, mp.local_id) : null;
        var restantes = (await t.todosPorIndice("outbox", "by_registro", [op.entidad, op.uid])).filter(function (x) { return x.seq !== op.seq; });
        await t.borrar("outbox", op.seq);
        if (!local || !row) return;
        var snap = columnasNube(m, row);
        var hayMas = restantes.some(function (x) { return x.estado === "pending" || x.estado === "syncing" || x.estado === "conflict"; });
        var reg;
        if (!hayMas) {
          reg = Object.assign({}, local, combinarLocal(m, local, await camposLocales(t, m, row)), { _rev: row.rev || 0, _base: snap, _pend: false });
        } else {
          reg = Object.assign({}, local, { _rev: row.rev || 0, _base: snap, _pend: true });
          for (var i = 0; i < restantes.length; i++) if (restantes[i].estado === "pending" && restantes[i].kind !== "insert") { restantes[i].base = snap; restantes[i].base_rev = row.rev || 0; await t.put("outbox", restantes[i]); }
        }
        await t.put(m.store, reg);
      });
    }

    async function marcar(op, estado, extra) {
      var cambios = Object.assign({ estado: estado }, extra || {});
      await bd.outbox.actualizar(op.seq, cambios);
    }

    async function crearConflicto(op, tipo, servidor, campos) {
      await bd.conflictos.agregar({ op_seq: op.seq, op_id: op.op_id, entidad: op.entidad, uid: op.uid, tipo: tipo, campos: campos || [], mio: op.cambios, base: op.base, servidor: servidor, creado_en: reloj() });
      await marcar(op, "conflict", { error: tipo });
      emitir("conflicto", { entidad: op.entidad, uid: op.uid, tipo: tipo });
    }

    /* Resultado de ejecutar UNA operación: {fin:'ok'|'siguiente'|'detener', ...} */
    async function ejecutar(op) {
      // SYNC-8: una RPC no necesita mapper (su entidad es solo una etiqueta: "rpc" por defecto). Antes se buscaba el
      // mapper primero y una RPC sin entidad mapeada lanzaba → «servidor» → reintento infinito.
      var m = op.kind === "rpc" ? null : mapper(op.entidad);
      if (op.kind === "insert") {
        var r = await rest.insertar(m.tabla, [op.cambios], { ignorarDuplicados: true });
        if (r.ok) {
          var fila = Array.isArray(r.datos) && r.datos[0] ? r.datos[0] : null;
          if (!fila) { var g = await rest.obtener(m.tabla, op.uid); if (!g.ok) return { error: g }; fila = g.datos; }   // reintento tras respuesta perdida
          if (!fila) return { rechazo: { clase: "permiso", codigo: "SIN_FILA", mensaje: "La nube no aceptó el registro." } };
          await aplicarRespuesta(op, fila); return { ok: true };
        }
        return { error: r };
      }
      if (op.kind === "update") {
        var revBase = op.base_rev, cambios = op.cambios;
        for (var intento = 0; intento < 3; intento++) {
          var r2 = await rest.modificar(m.tabla, [["id", "eq", op.uid], ["rev", "eq", revBase]], cambios);
          if (!r2.ok) return { error: r2 };
          if (Array.isArray(r2.datos) && r2.datos.length === 1) { await aplicarRespuesta(op, r2.datos[0]); return { ok: true }; }
          // 0 filas: cambió la revisión (u otra persona borró el registro, o la política lo oculta)
          var srv = await rest.obtener(m.tabla, op.uid);
          if (!srv.ok) return { error: srv };
          if (!srv.datos || srv.datos.deleted_at) { await crearConflicto(op, "borrado_remoto", null, []); return { conflicto: true }; }
          var snap = columnasNube(m, srv.datos);
          var f = fusionar(op.base, op.cambios, snap);
          if (f.conflictos.length) {
            await crearConflicto(op, "campos", { fila: srv.datos, snapshot: snap }, f.conflictos);
            return { conflicto: true };
          }
          if (!Object.keys(f.fusion).length) { await aplicarRespuesta(op, srv.datos); return { ok: true }; }   // el servidor ya tiene lo mío
          cambios = f.fusion; revBase = srv.datos.rev;
        }
        return { error: { clase: "servidor", codigo: "REINTENTOS_AGOTADOS", mensaje: "El registro cambia sin parar en la nube." } };
      }
      if (op.kind === "delete") {
        var r3 = await rest.modificar(m.tabla, [["id", "eq", op.uid]], { deleted_at: new Date(reloj()).toISOString() });
        if (!r3.ok) return { error: r3 };
        if (Array.isArray(r3.datos) && r3.datos.length === 1) { await aplicarRespuesta(op, null); return { ok: true }; }
        var g3 = await rest.obtener(m.tabla, op.uid);
        if (!g3.ok) return { error: g3 };
        if (!g3.datos || g3.datos.deleted_at) { await aplicarRespuesta(op, null); return { ok: true }; }
        return { rechazo: { clase: "permiso", codigo: "SIN_PERMISO", mensaje: "No tienes permiso para eliminar este registro." }, restaurar: g3.datos };
      }
      if (op.kind === "rpc") {
        var r4 = await rest.rpc(op.rpc, op.params);
        if (r4.ok) { await bd.outbox.borrar(op.seq); emitir("rpc-ok", { op_id: op.op_id, rpc: op.rpc, resultado: r4.datos }); return { ok: true }; }
        return { error: r4 };
      }
      return { rechazo: { clase: "validacion", codigo: "TIPO_DESCONOCIDO", mensaje: "Operación desconocida." } };
    }

    /** Cola de una operación de la nube que no es una tabla (RPC de dinero, SYNC-7). Nunca con PIN. */
    async function encolarRpc(nombre, params, meta) {
      if (apagado()) return { omitido: "apagado" };
      verificarSinPin(nombre, params);
      var s = sesion(); if (!s || !s.uid) throw new Error("No hay sesión.");
      var dev = await bd.deviceId();
      var opId = (meta && meta.op_id) || nuevoUuid();
      // p_op: TODAS las RPC de sync-3-rpc.sql (y sync_guardar_items_cotizacion, SYNC-5) llaman a su
      // primer parámetro `p_op`, nunca `p_op_id` — es la clave de idempotencia que lee sync_op_iniciar.
      // crea (SYNC-8): la RPC da de alta el registro `uid` (venta, crédito): sus hijos esperan a que exista (elegirSiguiente)
      var op = { op_id: opId, entidad: (meta && meta.entidad) || "rpc", uid: (meta && meta.uid) || opId, kind: "rpc", rpc: nombre, params: Object.assign({}, params, { p_op: opId }), crea: !!(meta && meta.crea),
        estado: "pending", intentos: 0, siguiente_en: 0, actor_uid: s.uid, device_id: dev, creado_en: reloj(), error: null };
      var seq = await bd.transaccion(["outbox"], "readwrite", function (t) { return t.add("outbox", op); });
      programarEnvio();
      return { seq: seq, op_id: opId };
    }

    /** Llama una RPC AHORA MISMO, sin pasar por la cola (SYNC-7): las acciones con PIN nunca se
        encolan (ver verificarSinPin arriba) — necesitan ejecutarse en línea, con la autorización
        recién emitida por PinUI, y fallar A LA VISTA si algo sale mal (nadie las reintenta solas).
        p_op se genera aquí igual que en encolarRpc, para que la RPC sea idempotente si la propia
        UI decide reintentar la MISMA acción tras un error de red.
        SYNC-7B: `opciones.op_id` permite que la UI genere el operation_id UNA vez y lo reutilice en un
        reintento de la MISMA acción (mismo efecto una sola vez, sync_op_iniciar). Sin él, uno nuevo. */
    async function rpcInmediato(nombre, params, opciones) {
      if (apagado()) return { ok: false, clase: "red", codigo: "APAGADO", mensaje: "La sincronización no está activa." };
      var s = sesion(); if (!s || !s.uid) return { ok: false, clase: "auth", codigo: "SIN_SESION", mensaje: "No hay sesión." };
      var opId = (opciones && opciones.op_id) || nuevoUuid();
      var r = await rest.rpc(nombre, Object.assign({}, params, { p_op: opId }));
      if (r.ok) emitir("rpc-ok", { op_id: opId, rpc: nombre, resultado: r.datos });
      return Object.assign({ op_id: opId }, r);
    }

    /* Una sola pestaña envía a la vez. Con Web Locks el navegador suelta el candado solo si la pestaña muere. Sin Web
       Locks, arrendamiento en la base: dura LEASE_MS y quien lo tiene lo RENUEVA en cada operación (SYNC-8), así un envío
       largo no deja que otra pestaña «herede» la cola a mitad; si la pestaña muere, caduca y otra lo toma. */
    var LEASE_MS = o.leaseMs || 60000;
    async function conBloqueo(fn) {
      if (locks && typeof locks.request === "function") {
        return locks.request("entimotors-sync-flush", { ifAvailable: true }, function (lock) { return lock ? fn(function () { return Promise.resolve(true); }) : { omitido: "otra-pestana" }; });
      }
      var tomar = function () {
        return bd.transaccion(["meta"], "readwrite", async function (t) {
          var r = await t.get("meta", "lease"), ahora = reloj();
          if (r && r.v && r.v.until > ahora && r.v.dueno !== duenoLease) return false;
          await t.put("meta", { k: "lease", v: { dueno: duenoLease, until: ahora + LEASE_MS } });
          return true;
        });
      };
      if (!(await tomar())) return { omitido: "otra-pestana" };
      try { return await fn(tomar); } finally {
        await bd.transaccion(["meta"], "readwrite", async function (t) {
          var r = await t.get("meta", "lease");
          if (r && r.v && r.v.dueno === duenoLease) await t.put("meta", { k: "lease", v: { dueno: duenoLease, until: 0 } });   // solo suelta el suyo
        });
      }
    }

    /* SYNC-8: rol/activo del perfil ANTES de enviar nada con esta sesión. Inactivo o inexistente → fail closed. Si no se
       puede comprobar (red), no se envía todavía: se vuelve a intentar en el próximo ciclo. */
    async function comprobarPerfil(s) {
      if (perfilOk) return true;
      var r = await rest.seleccionar("perfiles", { select: "id,rol,activo", filtros: [["id", "eq", s.uid]], limite: 1 });
      if (!r.ok) { if (r.clase === "auth") pausar("auth"); return false; }
      var p = Array.isArray(r.datos) ? r.datos[0] : null;
      if (!p || p.activo === false) { pausar("cuenta-inactiva"); return false; }
      perfilOk = true;
      return true;
    }
    function pausar(motivo) {
      if (pausa && pausa.motivo === motivo) return;
      pausa = { motivo: motivo, desde: reloj() };
      emitir(motivo === "auth" ? "auth-requerida" : "cuenta-inactiva", null);
      emitir("estado", null);
    }
    /** Tras un nuevo inicio de sesión: se levanta la pausa por sesión y se revalida el perfil antes de enviar. */
    function reanudar() {
      if (pausa && pausa.motivo === "cuenta-inactiva") return false;   // fail closed: solo un motor nuevo (nuevo login) la levanta
      pausa = null; perfilOk = !o.validarPerfil; programarEnvio(); return true;
    }
    function pausado() {
      if (!pausa) return null;
      if (pausa.motivo === "auth" && reloj() - pausa.desde >= PAUSA_AUTH_MS) { pausa = null; perfilOk = !o.validarPerfil; return null; }   // se prueba una vez más
      return pausa.motivo;
    }

    async function flush() {
      if (apagado()) return { omitido: "apagado" };
      var s = sesion(); if (!s || !s.uid) return { omitido: "sin-sesion" };
      var p0 = pausado(); if (p0) return { omitido: p0 };
      return conBloqueo(async function (renovar) {
        var res = { enviadas: 0, rechazadas: 0, conflictos: 0, detenido: null };
        // RECUPERACIÓN TRAS CIERRE (SYNC-8): quien tiene el candado es el único que envía, así que una operación en
        // «syncing» es de un envío que murió a mitad (pestaña cerrada, app matada, corte). Vuelve a «pending»: el op_id es
        // idempotente, así que reintentarla da UN solo efecto aunque el servidor ya la hubiera aplicado.
        var colgadas = await bd.outbox.porEstado("syncing");
        for (var c = 0; c < colgadas.length; c++) await marcar(colgadas[c], "pending", { recuperada: (colgadas[c].recuperada || 0) + 1, siguiente_en: 0 });
        if (!(await comprobarPerfil(s))) { res.detenido = pausa ? pausa.motivo : "perfil"; return res; }
        if (!(await bd.outbox.porEstado("pending")).some(function (x) { return x.actor_uid === s.uid; })) return res;   // nada propio que enviar
        estadoVivo.sincronizando = true; emitir("estado", null);
        try {
          for (var guarda = 0; guarda < 5000; guarda++) {
            if (!(await renovar())) { res.detenido = "otra-pestana"; break; }
            var eleccion = elegirSiguiente(await bd.outbox.todos(), s.uid, reloj());
            if (!eleccion) break;
            var op = eleccion.op;
            if (eleccion.accion === "rechazar-dependencia") {   // su padre no existe en la nube: enviarlo solo produciría basura o un 23503
              var ed = { clase: "dependencia", codigo: "DEPENDENCIA_RECHAZADA", mensaje: "Depende de un registro que la nube rechazó: no se envió.", http: 0 };
              await marcar(op, "rejected", { error: ed, padre: eleccion.padre }); res.rechazadas++;
              emitir("rechazada", { entidad: op.entidad, uid: op.uid, error: ed }); continue;
            }
            await marcar(op, "syncing", { intentos: (op.intentos || 0) + 1, enviando_en: reloj() });
            var r;
            try { r = await ejecutar(Object.assign({}, op, { estado: "syncing" })); }
            catch (e) { r = { error: { clase: "servidor", codigo: "EXCEPCION", mensaje: e && e.message ? e.message : "error" } }; }
            if (r.ok) { res.enviadas++; continue; }
            if (r.conflicto) { res.conflictos++; continue; }
            if (r.rechazo) {
              await marcar(op, "rejected", { error: descripcionError(r.rechazo) }); res.rechazadas++;
              if (r.restaurar) await restaurar(op, r.restaurar);
              emitir("rechazada", { entidad: op.entidad, uid: op.uid, error: descripcionError(r.rechazo) }); continue;
            }
            var e = r.error, k = e.clase;
            if (k === "permiso" || k === "validacion" || k === "conflicto") {   // no se arregla reintentando
              await marcar(op, "rejected", { error: descripcionError(e) }); res.rechazadas++;
              if (op.kind === "delete") await restaurarBorrado(op);   // al borrar el registro salió de la pantalla: si la nube lo rechazó (403), vuelve
              emitir("rechazada", { entidad: op.entidad, uid: op.uid, error: descripcionError(e) });
              continue;
            }
            if (k === "auth") {
              // La sesión caducó y no se pudo refrescar. No cuenta como intento ni espera: NADA más sale (ni como anónimo)
              // hasta que haya sesión válida; entonces se revalida el perfil antes de volver a enviar.
              await marcar(op, "pending", { intentos: op.intentos || 0, error: descripcionError(e), siguiente_en: 0 });
              res.detenido = "auth"; pausar("auth"); perfilOk = !o.validarPerfil;
              break;
            }
            // red, servidor (5xx, 55P03, tiempo agotado), límite, esquema: se conserva y se reintenta más tarde, con espera
            // creciente y variación (nunca en bucle apretado). Se corta la ronda: lo más probable es que lo demás falle igual.
            var espera = k === "limite" && e.reintentarEnS ? e.reintentarEnS * 1000 : esperaMs(op.intentos + 1, o.aleatorio ? o.aleatorio() : undefined);
            await marcar(op, "pending", { error: descripcionError(e), siguiente_en: reloj() + espera });
            res.detenido = k;
            break;
          }
        } finally { estadoVivo.sincronizando = false; }
        if (res.detenido) estadoVivo.ultimoError = { clase: res.detenido, en: reloj() }; else { estadoVivo.ultimaOk = reloj(); estadoVivo.ultimoError = null; }
        emitir("estado", null);
        return res;
      });
    }

    /* Una operación rechazada por permisos deja el registro local distinto de la nube: se vuelve a la versión del servidor. */
    async function restaurar(op, filaServidor) {
      var m = mapper(op.entidad);
      await bd.transaccion([m.store, "mapa"], "readwrite", async function (t) {
        var mp = await t.get("mapa", op.uid);
        var local = mp ? await t.get(m.store, mp.local_id) : null;
        var reg = Object.assign({}, combinarLocal(m, local, await camposLocales(t, m, filaServidor)), { uid: op.uid, _rev: filaServidor.rev || 0, _base: columnasNube(m, filaServidor), _pend: false });
        if (mp) reg.id = mp.local_id;
        var id = await t.put(m.store, reg);
        if (!mp) await t.put("mapa", { uid: op.uid, entidad: op.entidad, local_id: id });
      });
    }

    /* Un borrado que la nube NO aceptó (p. ej. 403: solo el administrador borra). Se devuelve la versión de la nube; si en ese instante no hay
       conexión, la copia que se tenía al borrar (el próximo pull la pone al día). Si la nube ya no tiene la fila viva, no hay nada que devolver. */
    async function restaurarBorrado(op) {
      var m = mapper(op.entidad), g = await rest.obtener(m.tabla, op.uid);
      if (g.ok) { if (g.datos && !g.datos.deleted_at) await restaurar(op, g.datos); return; }
      if (op.base) await restaurar(op, Object.assign({}, op.base, { id: op.uid, rev: op.base_rev || 0 }));
    }

    async function resolverConflicto(idConflicto, decision) {
      var todos = await bd.conflictos.todos();
      var c = todos.filter(function (x) { return x.id === idConflicto; })[0];
      if (!c) return { ok: false, motivo: "no-existe" };
      var op = await bd.outbox.get(c.op_seq);
      var m = mapper(c.entidad);
      if (decision === "mio" && op) {
        var srv = c.servidor && c.servidor.fila ? c.servidor.fila : null;
        if (srv) await bd.outbox.actualizar(op.seq, { estado: "pending", intentos: 0, siguiente_en: 0, error: null, base: c.servidor.snapshot, base_rev: srv.rev });
        else if (c.tipo === "borrado_remoto") return { ok: false, motivo: "registro-borrado-en-la-nube" };
      } else if (decision === "servidor") {
        if (op) await bd.outbox.borrar(op.seq);
        if (c.servidor && c.servidor.fila) await restaurar({ entidad: c.entidad, uid: c.uid }, c.servidor.fila);
        else await bd.transaccion([m.store, "mapa"], "readwrite", async function (t) { var mp = await t.get("mapa", c.uid); if (mp) await t.borrar(m.store, mp.local_id); });
      } else return { ok: false, motivo: "decision-invalida" };
      await bd.conflictos.borrar(idConflicto);
      programarEnvio();
      emitir("cambio-local", { entidad: c.entidad });
      return { ok: true };
    }

    /* ============ CICLO Y DISPAROS ============ */
    var temporizadorEnvio = null, intervalo = null, oyentes = [];
    function programarEnvio() {
      if (apagado() || !o.autoenvio) return;
      if (temporizadorEnvio) return;
      temporizadorEnvio = setTimeout(function () { temporizadorEnvio = null; sincronizar(); }, o.retardoEnvioMs === undefined ? 400 : o.retardoEnvioMs);
    }
    async function sincronizar() {
      if (apagado()) return { omitido: "apagado" };
      if (global.navigator && global.navigator.onLine === false) return { omitido: "sin-conexion" };
      // flush → pull correctivo: lo que queda en la caché lo decide el servidor (stock, saldo, caja, estado de la orden,
      // rev, requiere_revision), nunca lo que se envió. Sin sesión válida, sin red o con la cuenta inactiva no se baja nada.
      var f = await flush();
      if (f && f.omitido) return { flush: f };
      var p = ["auth", "red", "cuenta-inactiva", "perfil"].indexOf(f.detenido) >= 0 ? [] : await pullTodo();
      return { flush: f, pull: p };
    }
    function arrancar() {
      if (apagado() || intervalo) return;
      var alVolver = function () { if (!global.document || global.document.visibilityState === "visible") sincronizar(); };
      if (global.addEventListener) { global.addEventListener("online", alVolver); oyentes.push(["online", alVolver, global]); }
      if (global.document && global.document.addEventListener) { global.document.addEventListener("visibilitychange", alVolver); oyentes.push(["visibilitychange", alVolver, global.document]); }
      intervalo = setInterval(function () { sincronizar(); }, o.cadaMs || 30000);
      sincronizar();
    }
    function detener() {
      if (intervalo) { clearInterval(intervalo); intervalo = null; }
      if (temporizadorEnvio) { clearTimeout(temporizadorEnvio); temporizadorEnvio = null; }
      oyentes.forEach(function (x) { x[2].removeEventListener(x[0], x[1]); }); oyentes = [];
    }

    async function estado() {
      var cola = await bd.outbox.contar(), conflictos = await bd.conflictos.todos();
      var s = sesion();
      var ajenas = s ? (await bd.outbox.todos()).filter(function (x) { return x.actor_uid !== s.uid && (x.estado === "pending" || x.estado === "syncing"); }).length : 0;
      var b = await bd.meta.get("bootstrap"), fk = (await bd.meta.get("fk_pendientes")) || {};
      return { habilitado: !apagado(), enLinea: !(global.navigator && global.navigator.onLine === false), sincronizando: estadoVivo.sincronizando, ultimaOk: estadoVivo.ultimaOk,
        ultimoError: estadoVivo.ultimoError, ultimoPull: estadoVivo.ultimoPull, cola: cola, conflictos: conflictos.length, deOtraPersona: ajenas,
        rechazadas: cola.rejected, bootstrapCompleto: !!(b && b.completo), pausa: pausado(),
        fkPendientes: Object.keys(fk).reduce(function (n, k) { return n + fk[k].length; }, 0) };
    }

    /* SYNC-8 · LO QUE REQUIERE REVISIÓN, en un solo lugar (persistente: vive en la cola y en `conflictos`, sobrevive a
       recargas). Solo metadatos para la UI — qué pasó, qué entidad, cuándo — nunca los parámetros ni los cambios
       enviados (pueden llevar montos o datos del cliente). */
    async function revision() {
      var ops = await bd.outbox.todos(), conf = await bd.conflictos.todos();
      var rechazadas = ops.filter(function (x) { return x.estado === "rejected"; }).map(function (x) {
        var er = x.error && typeof x.error === "object" ? x.error : { clase: "", codigo: String(x.error || ""), mensaje: "" };
        return { tipo: er.clase === "dependencia" ? "dependencia" : "rechazada", seq: x.seq, entidad: x.entidad, uid: x.uid, kind: x.kind, rpc: x.rpc || null,
          clase: er.clase || "", codigo: er.codigo || "", mensaje: String(er.mensaje || "").slice(0, 200), creadoEn: x.creado_en || null, actor: x.actor_uid };
      });
      var conflictos = conf.map(function (c) { return { tipo: "conflicto", id: c.id, entidad: c.entidad, uid: c.uid, motivo: c.tipo, campos: c.campos || [], creadoEn: c.creado_en || null }; });
      var s = sesion();
      var esperando = ops.filter(function (x) { return s && x.actor_uid !== s.uid && (x.estado === "pending" || x.estado === "syncing"); }).length;
      return { rechazadas: rechazadas, conflictos: conflictos, esperandoOtraPersona: esperando, total: rechazadas.length + conflictos.length };
    }
    /** La persona ya vio un rechazo y lo da por atendido: sale de la lista (el registro local no se toca). Solo rechazadas. */
    async function descartarRechazada(seq) {
      var op = await bd.outbox.get(seq);
      if (!op || op.estado !== "rejected") return false;
      await bd.outbox.borrar(seq); emitir("estado", null); return true;
    }

    return { escribir: escribir, pull: pull, pullTodo: pullTodo, flush: flush, sincronizar: sincronizar, encolarRpc: encolarRpc, rpcInmediato: rpcInmediato, resolverConflicto: resolverConflicto,
      revision: revision, descartarRechazada: descartarRechazada, reanudar: reanudar,
      estado: estado, arrancar: arrancar, detener: detener, onCambio: function (f) { escuchas.push(f); return function () { escuchas = escuchas.filter(function (x) { return x !== f; }); }; } };
  }

  global.SyncEngine = { crearMotor: crearMotor, puras: puras };
})(typeof window !== "undefined" ? window : this);
