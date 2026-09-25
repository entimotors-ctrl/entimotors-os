/* ============================================================================
 * ENTIMOTORS OS · sync-finanzas.js  (3.14.0 · SYNC-7B)
 * ----------------------------------------------------------------------------
 * Dinero y stock del Taller en MODO NUBE. Todo pasa por las RPC transaccionales e
 * idempotentes de sync-3-rpc.sql; esta hoja solo ARMA sus parámetros y decide CÓMO
 * se envían. Nunca calcula un saldo, un total ni una existencia con autoridad: eso lo
 * decide el servidor (la caché local solo lo refleja al bajar).
 *
 * REGLAS
 *   · operation_id se genera UNA vez, antes de enviar, y viaja en el outbox con los
 *     parámetros exactos: un reintento repite los MISMOS bytes → mismo resultado, un
 *     solo efecto (sync_op_iniciar). Los ids de venta/crédito/renglón también se generan
 *     aquí (p_venta_id, p_credito_id, item_id), así la caché local y la nube hablan del
 *     mismo registro desde el primer instante, con o sin red.
 *   · `offline` se decide al crear la operación (nunca después: cambiarlo cambiaría el
 *     hash y el servidor rechazaría el reintento como OP_ID_REUTILIZADO).
 *     OFFLINE_SALE_ACCEPT_AND_REVIEW: la venta hecha sin red se acepta aunque deje stock
 *     negativo; el servidor marca requiere_revision. Nunca se recorta ni se descarta.
 *   · Los repuestos viajan por su UUID de nube (inventario.uid), jamás por el id entero local.
 *   · meta.crea (SYNC-8): la venta y el crédito DAN DE ALTA su uid; lo que dependa de ellos (un abono a ese crédito
 *     guardado sin red) espera en la cola a que existan y, si la nube los rechaza, no se envía (sync-engine.js).
 *   · Acciones con PIN (reversos, devoluciones, ajuste de stock, anular orden): SOLO en
 *     línea, nunca al outbox (sync-engine.js lo impide además). El PIN no pasa por aquí:
 *     lo pide PinUI (pin-ui.js) y esta hoja solo recibe el autorizacion_id de un solo uso.
 *
 * Fábrica pura + inyección (mismo patrón que SyncRest.crear / PinUI.crear): se prueba en
 * Node con un motor y una base falsos (pruebas/sync/node/sync7b.test.mjs).
 * ==========================================================================*/
(function (global) {
  "use strict";

  var SIN_CONEXION_PIN = "Esta operación requiere conexión para obtener autorización del administrador.";
  var CLASES_REINTENTABLES = ["red", "servidor", "limite", "auth", "esquema"];

  function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function falla(msg) { var e = new Error(msg); e.validacion = true; throw e; }
  function uuidPor(o) { return (o && o.uuid) || (global.SyncDB && global.SyncDB.uuid); }
  function texto(v) { return typeof v === "string" && v.trim() ? v.trim() : null; }

  /** Renglones de venta/crédito: {inventarioUid|null, nombre, cantidad, precio} → formato de la RPC. */
  function renglones(items, nuevoUuid) {
    if (!Array.isArray(items) || !items.length) falla("El carrito está vacío");
    return items.map(function (it) {
      var cant = Number(it.cantidad), precio = Number(it.precio);
      if (!isFinite(cant) || cant <= 0) falla("Cantidad inválida en «" + (it.nombre || "renglón") + "»");
      if (!isFinite(precio) || precio < 0) falla("Precio inválido en «" + (it.nombre || "renglón") + "»");
      if (it.inventarioId != null && !it.inventarioUid) falla("El repuesto «" + (it.nombre || "") + "» todavía no tiene identidad en la nube");
      if (!it.inventarioUid && !texto(it.nombre)) falla("Renglón sin nombre");
      return { item_id: it.itemUid || nuevoUuid(), inventario_id: it.inventarioUid || null, nombre: texto(it.nombre) || "", cantidad: cant, precio: r2(precio) };
    });
  }
  function motivoValido(m) { if (!texto(m) || texto(m).length < 3) falla("El motivo es obligatorio (mínimo 3 caracteres)"); return texto(m); }

  /* ---------------- constructores puros: {rpc, params, meta} ---------------- */
  function construir(nuevoUuid) {
    return {
      venta: function (o) {
        var uid = o.ventaUid || nuevoUuid();
        var metodo = texto(o.metodoPago); if (!metodo) falla("Falta el método de pago");
        return { rpc: "registrar_venta_v2", meta: { entidad: "ventas_rapidas", uid: uid, crea: true }, params: {
          p_venta_id: uid, p_cliente_id: o.clienteUid || null, p_cliente_nombre: texto(o.clienteNombre),
          p_metodo_pago: metodo, p_efectivo: metodo === "efectivo" ? r2(Number(o.efectivoRecibido) || 0) : null,
          p_items: renglones(o.items, nuevoUuid), p_occurred_at: o.ocurrioEn, p_offline: !!o.offline, p_device: o.deviceId || null,
        } };
      },
      credito: function (o) {
        var uid = o.creditoUid || nuevoUuid();
        if (!texto(o.clienteNombre)) falla("Falta el cliente");
        var abono = r2(Number(o.abonoInicial) || 0);
        if (abono < 0) falla("El abono no puede ser negativo");
        var items = renglones(o.items, nuevoUuid);
        var total = r2(items.reduce(function (s, it) { return s + it.cantidad * it.precio; }, 0));
        if (abono > total + 0.01) falla("La entrada supera el total del crédito");
        return { rpc: "registrar_credito", meta: { entidad: "creditos", uid: uid, crea: true }, params: {
          p_credito_id: uid, p_cliente_id: o.clienteUid || null, p_cliente_nombre: texto(o.clienteNombre), p_cliente_telefono: texto(o.clienteTelefono),
          p_items: items, p_vencimiento: o.vencimiento || null, p_nota: texto(o.nota), p_abono_inicial: abono,
          p_abono_metodo: abono > 0 ? (texto(o.abonoMetodo) || "efectivo") : null, p_occurred_at: o.ocurrioEn, p_offline: !!o.offline,
          p_device: o.deviceId || null, p_origen: texto(o.origen), p_orden_id: o.ordenUid || null,
        } };
      },
      abono: function (o) {
        if (!o.creditoUid) falla("Crédito sin identidad en la nube");
        var monto = r2(o.monto); if (!(monto > 0)) falla("El monto debe ser mayor a cero");
        return { rpc: "registrar_abono_v2", meta: { entidad: "creditos", uid: o.creditoUid }, params: {
          p_credito_id: o.creditoUid, p_monto: monto, p_metodo: texto(o.metodo) || "efectivo", p_occurred_at: o.ocurrioEn, p_device: o.deviceId || null,
        } };
      },
      movimientoCaja: function (o) {
        if (o.tipo !== "ingreso" && o.tipo !== "egreso") falla("Tipo de movimiento inválido");
        var monto = r2(o.monto); if (!(monto > 0)) falla("El monto debe ser mayor a cero");
        var uid = nuevoUuid();
        return { rpc: "registrar_movimiento_caja", meta: { entidad: "caja_movimientos", uid: uid }, params: {
          p_tipo: o.tipo, p_categoria: texto(o.categoria), p_monto: monto, p_metodo: texto(o.metodo), p_descripcion: texto(o.descripcion),
          p_occurred_at: o.ocurrioEn, p_device: o.deviceId || null,
        } };
      },
      itemOrden: function (o) {
        if (!o.ordenUid) falla("La orden todavía no tiene identidad en la nube");
        var cant = Number(o.cantidad), precio = Number(o.precio);
        if (!isFinite(cant) || cant <= 0 || !isFinite(precio) || precio < 0) falla("Cantidad y precio deben ser válidos");
        if (o.inventarioId != null && !o.inventarioUid) falla("El repuesto todavía no tiene identidad en la nube");
        var item = o.itemUid || nuevoUuid();
        return { rpc: "agregar_item_orden", meta: { entidad: "ordenes", uid: o.ordenUid }, params: {
          p_orden_id: o.ordenUid, p_inventario_id: o.inventarioUid || null, p_nombre: texto(o.nombre), p_cantidad: cant, p_precio: r2(precio),
          p_item_id: item, p_offline: !!o.offline, p_occurred_at: o.ocurrioEn, p_device: o.deviceId || null,
        } };
      },
      quitarItemOrden: function (o) {
        if (!o.itemUid) falla("El ítem no tiene identidad en la nube");
        return { rpc: "quitar_item_orden", meta: { entidad: "ordenes", uid: o.ordenUid }, params: { p_item_id: o.itemUid, p_device: o.deviceId || null } };
      },
      finalizarOrden: function (o) {
        if (!o.ordenUid) falla("La orden todavía no tiene identidad en la nube");
        if (o.tipoCobro !== "contado" && o.tipoCobro !== "credito") falla("Tipo de cobro inválido");
        var credito = o.tipoCobro === "credito";
        return { rpc: "finalizar_orden", meta: { entidad: "ordenes", uid: o.ordenUid }, params: {
          p_orden_id: o.ordenUid, p_tipo_cobro: o.tipoCobro, p_metodo_pago: texto(o.metodoPago) || "efectivo",
          p_abono: credito ? r2(Number(o.abono) || 0) : 0, p_abono_metodo: credito ? (texto(o.abonoMetodo) || "efectivo") : null,
          p_vencimiento: o.vencimiento || null, p_occurred_at: o.ocurrioEn, p_device: o.deviceId || null,
          p_credito_id: credito ? (o.creditoUid || nuevoUuid()) : null,
        } };
      },
      /* ---- acciones con PIN (nunca al outbox): solo params, sin p_autorizacion (lo pone quien ejecuta) ---- */
      ajusteStock: function (o) {
        if (!o.inventarioUid) falla("El repuesto todavía no tiene identidad en la nube");
        var tieneDelta = o.delta !== undefined && o.delta !== null, tieneConteo = o.conteo !== undefined && o.conteo !== null;
        if (tieneDelta === tieneConteo) falla("Indica la diferencia o el conteo (uno solo)");
        if (tieneDelta && (!isFinite(Number(o.delta)) || Number(o.delta) === 0)) falla("La diferencia debe ser distinta de cero");
        if (tieneConteo && (!isFinite(Number(o.conteo)))) falla("Conteo inválido");
        return { rpc: "ajustar_stock", registro: o.inventarioUid, params: {
          p_inventario_id: o.inventarioUid, p_motivo: motivoValido(o.motivo), p_delta: tieneDelta ? Number(o.delta) : null,
          p_conteo: tieneConteo ? Number(o.conteo) : null, p_device: o.deviceId || null,
        }, monto: tieneDelta ? Number(o.delta) : null };
      },
      reversarVenta: function (o) {
        if (!o.ventaUid) falla("Venta sin identidad en la nube");
        return { rpc: "reversar_venta", registro: o.ventaUid, params: { p_venta_id: o.ventaUid, p_motivo: motivoValido(o.motivo), p_device: o.deviceId || null }, monto: r2(o.total) };
      },
      devolucion: function (o) {
        if (!o.ventaUid) falla("Venta sin identidad en la nube");
        if (!Array.isArray(o.items) || !o.items.length) falla("Indica qué se devuelve");
        var monto = 0;
        var items = o.items.map(function (it) {
          var c = Number(it.cantidad); if (!it.ventaItemUid || !(c > 0)) falla("Renglón de devolución inválido");
          monto += r2(c * Number(it.precio || 0));
          return { venta_item_id: it.ventaItemUid, cantidad: c };
        });
        return { rpc: "registrar_devolucion", registro: o.ventaUid, params: {
          p_venta_id: o.ventaUid, p_items: items, p_motivo: motivoValido(o.motivo), p_reingresa_stock: o.reingresa !== false, p_device: o.deviceId || null,
        }, monto: r2(monto) };
      },
      reversarAbono: function (o) {
        if (!o.abonoUid) falla("Abono sin identidad en la nube");
        return { rpc: "reversar_abono", registro: o.abonoUid, params: { p_abono_id: o.abonoUid, p_motivo: motivoValido(o.motivo), p_device: o.deviceId || null }, monto: r2(o.monto) };
      },
      reversarCredito: function (o) {
        if (!o.creditoUid) falla("Crédito sin identidad en la nube");
        return { rpc: "reversar_credito", registro: o.creditoUid, params: { p_credito_id: o.creditoUid, p_motivo: motivoValido(o.motivo), p_device: o.deviceId || null }, monto: r2(o.total) };
      },
      reversarCaja: function (o) {
        if (!o.cajaUid) falla("Movimiento sin identidad en la nube");
        return { rpc: "reversar_caja", registro: o.cajaUid, params: { p_caja_id: o.cajaUid, p_motivo: motivoValido(o.motivo), p_device: o.deviceId || null }, monto: r2(o.monto) };
      },
      anularOrden: function (o) {
        if (!o.ordenUid) falla("La orden todavía no tiene identidad en la nube");
        return { rpc: "anular_orden", registro: o.ordenUid, params: {
          p_orden_id: o.ordenUid, p_motivo: motivoValido(o.motivo), p_devolver_stock: !!o.devolverStock, p_device: o.deviceId || null,
        }, monto: null };
      },
    };
  }

  /* ---------------- ejecución ----------------
     deps: { motor (SyncEngine), bd (SyncDB), enLinea(), autorizar(o) (PinUI.autorizarAccion), esperar(ms), uuid } */
  function crear(deps) {
    deps = deps || {};
    var nuevoUuid = uuidPor(deps);
    var enLinea = deps.enLinea || function () { return typeof navigator === "undefined" || navigator.onLine !== false; };
    var esperar = deps.esperar || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var intentosMax = deps.intentos || 40;

    /** Operación sin PIN, por el OUTBOX (offline-safe). Devuelve {estado:'ok'|'pendiente'|'rechazada', op_id, resultado?, error?}.
        En línea espera el veredicto del servidor (hasta ~10 s); sin red queda pendiente y se envía sola al volver. */
    async function ejecutar(op) {
      var motor = deps.motor, bd = deps.bd;
      var opId = (op.meta && op.meta.op_id) || nuevoUuid();
      var resultado; var hecho = false;
      var quitar = motor.onCambio(function (ev) {
        if (ev.tipo === "rpc-ok" && ev.datos && ev.datos.op_id === opId) { resultado = ev.datos.resultado; hecho = true; }
      });
      try {
        var enc = await motor.encolarRpc(op.rpc, op.params, Object.assign({}, op.meta, { op_id: opId }));
        if (!enLinea()) return { estado: "pendiente", op_id: opId };
        for (var i = 0; i < intentosMax; i++) {
          if (!hecho) await motor.flush();
          var enCola = await bd.outbox.get(enc.seq);
          if (!enCola || hecho) return { estado: "ok", op_id: opId, resultado: resultado };
          if (enCola.estado === "rejected") return { estado: "rechazada", op_id: opId, seq: enc.seq, error: enCola.error };
          if (enCola.estado === "pending" && enCola.error && CLASES_REINTENTABLES.indexOf(enCola.error.clase) >= 0) {
            return { estado: "pendiente", op_id: opId, error: enCola.error };
          }
          await esperar(250);
        }
        return { estado: "pendiente", op_id: opId };
      } finally { quitar(); }
    }

    /** Un rechazo que la persona YA vio en pantalla (venta online sin stock, abono mayor al saldo): se retira de la
        cola para no dejarlo colgando como "rechazado" para siempre. Solo si sigue rechazado. */
    async function descartarRechazo(seq) {
      var op = await deps.bd.outbox.get(seq);
      if (op && op.estado === "rejected") await deps.bd.outbox.borrar(seq);
    }

    /** Acción sensible: SIEMPRE en línea y nunca al outbox. Cajero → PIN (autorización de un solo uso ligada a
        solicitante/acción/registro/dispositivo/monto); admin → sin PIN; cualquier otro rol → negado sin red.
        accion: {rpc, registro, params, monto} de los constructores. rol: currentUser.rol. */
    async function conAutorizacion(accion, rol) {
      if (rol !== "admin" && rol !== "cajero") return { ok: false, motivo: "sin-permiso", mensaje: "Tu rol no puede realizar esta acción." };
      if (!enLinea()) return { ok: false, motivo: "sin-conexion", mensaje: SIN_CONEXION_PIN };
      var aut = await deps.autorizar({ accion: accion.rpc, rol: rol, registroId: accion.registro, monto: accion.monto, deviceId: accion.params.p_device });
      if (!aut || !aut.ok) return Object.assign({ ok: false }, aut || { motivo: "sin-autorizacion", mensaje: "No se obtuvo la autorización." });
      var params = Object.assign({}, accion.params, { p_autorizacion: aut.autorizacion_id || null });
      var opId = nuevoUuid();
      var r = await deps.motor.rpcInmediato(accion.rpc, params, { op_id: opId });
      // un corte de red justo al enviar: se repite UNA vez con el MISMO op_id (si el primero sí llegó, el servidor
      // devuelve el resultado guardado; la autorización es de un solo uso y ya quedó ligada a este op_id)
      if (!r.ok && r.clase === "red") r = await deps.motor.rpcInmediato(accion.rpc, params, { op_id: opId });
      if (r.ok) return { ok: true, op_id: opId, resultado: r.datos };
      return { ok: false, motivo: r.codigo || r.clase, clase: r.clase, mensaje: r.mensaje || "No se pudo completar la operación.", op_id: opId };
    }

    return { ejecutar: ejecutar, descartarRechazo: descartarRechazo, conAutorizacion: conAutorizacion, construir: construir(nuevoUuid) };
  }

  global.SyncFinanzas = { crear: crear, construir: function (o) { return construir(uuidPor(o)); }, r2: r2, SIN_CONEXION_PIN: SIN_CONEXION_PIN };
})(typeof window !== "undefined" ? window : this);
