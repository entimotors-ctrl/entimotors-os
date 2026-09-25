/* ============================================================================
 * ENTIMOTORS OS · sync-mappers.js  (3.14.0 · SYNC-7A)
 * ----------------------------------------------------------------------------
 * Mappers REALES para el motor de sincronización (SyncEngine, sync-engine.js):
 * clientes, motos, citas, categorias_inv, inventario, cotizaciones, ordenes.
 * Cada mapper describe, para UNA entidad, cómo se traduce entre el objeto
 * local (mismos nombres que siempre usó app.js) y la fila de la nube
 * (columnas en snake_case).
 *
 * INVENTARIO (SYNC-7A) — SOLO EL MAESTRO, NUNCA LA CANTIDAD
 *   `inventario` ya existía como tabla cloud (fase4d) con UNIQUE(dispositivo,
 *   local_id) igual que clientes/motos, y SYNC-1/SYNC-2/SYNC-3 ya la dejaron
 *   lista: `cantidad` es columna derivada del ledger (inventario_movimientos,
 *   trigger sync_ledger_aplicar) y authenticated NO tiene GRANT de INSERT/
 *   UPDATE sobre ella (D-4, sync-2-seguridad.sql) — el maestro (nombre,
 *   modelo, categoria_id, costo_compra, precio_venta, stock_minimo,
 *   codigo_barras, publicar_en_web, foto_url, foto_path) sí, y solo para
 *   admin (RLS inventario_admin_crea/inventario_admin_edita). Por eso este
 *   mapper es un CRUD normal (mismo patrón que clientes/motos, sin RPC propia
 *   para crear/editar el maestro) con UNA sola regla: `columnas`/`aCloud()`
 *   JAMÁS incluyen `cantidad` — ni de ida ni de vuelta:
 *     · aCloud(): no la manda nunca (ni en alta ni en edición): columnasNube()
 *       de sync-engine.js solo envía lo que está en `columnas`/`fks`, así que
 *       aunque el objeto local siempre trae `cantidad`, jamás sale de aquí.
 *     · aLocal(): tampoco la lee (a propósito, ver más abajo). La existencia
 *       inicial de un producto NUEVO va por la RPC `registrar_stock_inicial`
 *       (sync-7a-inventario.sql), encolada UNA sola vez justo después del
 *       alta del maestro (ver guardarSincronizado() en app.js) — un solo
 *       movimiento de apertura por producto, nunca un UPDATE de `cantidad`.
 *   Por qué aLocal() NO trae `cantidad` todavía (decisión explícita, no un
 *   olvido): las ventas/créditos/órdenes del Taller SIGUEN moviendo el stock
 *   100% local (IndexedDB, `DB.save("inventario", rep)` con `rep.cantidad`
 *   editado a mano) — eso es SYNC-7B, no está conectado a la nube todavía. Si
 *   aLocal() empezara a bajar `cantidad` de la nube, un pull() podría
 *   PISAR silenciosamente una venta local recién hecha y sin sincronizar
 *   (dos fuentes divergentes — justo lo que la fase prohíbe). Cuando SYNC-7B
 *   conecte esas ventas al ledger real, ese es el momento de agregar
 *   `cantidad`/`requiere_revision` a aLocal() (la cloud ya es la única
 *   autoridad desde SYNC-1: MATERIALIZED_RPC vía sync_ledger_aplicar).
 *   `categoria_id` se resuelve con el MISMO mapa local↔uid que ya usa
 *   `categorias_inv` desde SYNC-5 — sin mapa nuevo, sin tabla nueva.
 *   `foto`: mismo criterio que motos.foto (esRuta()) — una foto local en
 *   base64 nunca sale; si ya es una ruta/URL, viaja como `foto_url`. Nunca se
 *   sobreescribe al bajar (igual que motos): subir de verdad a Storage sigue
 *   pendiente (sección 14 de la fase, fuera de alcance de SYNC-7A).
 *   `puedeEscribir(rol)`: D-4 es "solo admin" tanto para `inventario` como
 *   para `categorias_inv` — mismo campo en ambos mappers, para que app.js
 *   tenga un único lugar de donde leer la regla (ver puedeEscribirEntidadNube
 *   en app.js) en vez de hardcodear el rol en cada botón.
 *
 * SYNC-7B — DINERO Y CANTIDAD
 *   · inventario.aLocal() ahora SÍ baja `cantidad`/`requiere_revision`: en modo nube el Taller ya no mueve
 *     stock local; todo movimiento va por RPC al ledger (sync-finanzas.js), así que la nube es la única verdad
 *     y la caché la refleja. Siguen fuera de `columnas`: nunca suben por el CRUD.
 *   · ventas_rapidas / creditos / caja_movimientos: mappers de SOLO LECTURA (ver el bloque al final).
 *   · ordenes (Taller): `finalizada`/`anulada` bajan (solo lectura) para que otro dispositivo no cobre dos veces.
 *
 * SYNC-8 — ÍTEMS DE ORDEN MULTIDISPOSITIVO Y CAMPOS DEL SERVIDOR
 *   · ordenes (Taller) baja `orden_items` EMBEBIDOS (select) → `items` locales con su uid, precio, costo y el repuesto
 *     resuelto a id local (refsALocal). Es SOLO lectura/caché: bajar un ítem nunca mueve stock (el stock ya lo movió
 *     agregar_item_orden en el servidor, y la cantidad del repuesto baja por su propio mapper). Así otro dispositivo
 *     reconstruye el detalle y el reporte de producción (también bajan finalizado_en/entregado_en).
 *     Los renglones locales SIN uid (nunca llegaron a la nube) se conservan al bajar (fusionarLocal). Una respuesta que
 *     no trae el embebido (el PATCH de la cabecera) NO toca `items`. El mecánico no usa este mapper: sigue con
 *     ordenes_tecnico_mias (solo nombre y cantidad, nunca precio ni costo).
 *   · soloServidor: campos que decide solo el servidor (existencia y revisión del repuesto; cobro/anulación de la
 *     orden). Bajan aunque haya un cambio local pendiente del mismo registro (ver aplicarPagina en sync-engine.js).
 *
 * ORDENES (SYNC-6) ES DOS MAPPERS DISTINTOS SEGÚN EL BUILD, NO UNO
 *   SYNC-2 cerró el acceso DIRECTO del mecánico a `ordenes`/`orden_items`: solo
 *   admin/cajero tienen GRANT de columnas sobre la tabla real. Por eso este
 *   archivo lee window.ENTIMOTORS_BUILD (build-target.js, cargado ANTES que
 *   este script — ver el orden de <script> en index.html) y arma un mapper
 *   distinto para cada producto:
 *     · Taller (admin/cajero): tabla = "ordenes" (la tabla real), de solo
 *       cabecera técnica — cliente/moto/estado/falla/diagnóstico/notas/
 *       checklist/mecánico/origen/km/garantía. NO incluye fotos, items, ni
 *       nada de dinero (finalizada, margen, tipo_cobro, metodo_pago, abono*,
 *       credito_id): eso sigue siendo 100% local contra entimotors_os_demo,
 *       tal cual antes de SYNC-6 — conectarlo a las RPC de agregar_item_orden/
 *       finalizar_orden es trabajo de SYNC-7, no de este. Así, cada
 *       DB.save("ordenes", …) del flujo de cobro (que sí toca esos campos)
 *       genera un diff vacío para la nube y no intenta un PATCH que la base
 *       rechazaría por falta de privilegio en esas columnas.
 *     · Mi Trabajo (mecánico): tabla = "rpc/ordenes_tecnico_mias", la función
 *       SECURITY DEFINER de sync-6-mecanicos-ordenes.sql — PostgREST sirve una
 *       función STABLE sin argumentos por GET exactamente como una vista, así
 *       que el motor la pagina con el mismo cursor (updated_at, id) sin saber
 *       que es una función. `columnas` va vacío a propósito: el mecánico NUNCA
 *       empuja cambios por aquí (columnasNube()/escribir() nunca se llaman
 *       para él — ver guardarSincronizado() en app.js), solo por la RPC
 *       avanzar_orden_tecnico, que sync-engine.js ya sabe encolar con
 *       encolarRpc() (mismo patrón que sync_guardar_items_cotizacion, SYNC-5).
 *       aLocal() sí lee fotos/items porque el mecánico no tiene ninguna otra
 *       fuente local con la que puedan chocar (a diferencia del Taller, que
 *       sigue guardando sus propias fotos en base64 sin sincronizar — ver
 *       ENTIMOTORS-SYNC-3.14-STATE.md, "Pendiente" de SYNC-6, antes de asumir
 *       que el Taller refleja solo cambios de fotos del mecánico).
 *
 * QUÉ NO SE SINCRONIZA TODAVÍA (a propósito, ver ENTIMOTORS-SYNC-3.14-STATE.md)
 *   · motos.foto: solo viaja si YA es una ruta/URL (foto_path, columna con CHECK
 *     "sin base64"). Una foto guardada como base64 se queda local hasta que
 *     exista subida real a Storage — no se sube inline.
 *   · cotizaciones.moto: el snapshot {marca,modelo,placa} de la cabecera NO se
 *     reconstruye en un dispositivo nuevo (solo viaja motoDesc, ya sincronizado
 *     como texto). Reabrir "Editar" en un dispositivo que nunca creó esa
 *     cotización muestra esos tres campos vacíos: no afecta motoDesc ni al total.
 *   · cotizaciones.ordenId / aceptadaEn: la conversión a orden de servicio
 *     (inventario, ordenes) sigue siendo 100% local en esta fase — ordenes e
 *     inventario no están en SYNC-5. Solo el campo `estado` (pendiente/aceptada/
 *     rechazada) viaja, para que otro dispositivo sepa que ya se resolvió.
 *   · cotizaciones.items: NO es una columna de `cotizaciones` (no hay tal
 *     columna) ni una entidad propia del motor (cotizacion_items no tiene
 *     rev/updated_at: SYNC-1 lo dejó así porque es hijo de la cotización). Viaja
 *     por dos caminos que sync-integracion.js combina:
 *       - bajada: PostgREST embebe cotizacion_items en cada fila de
 *         cotizaciones (mapper.select), y aLocal() los transforma en `items`.
 *       - subida: una RPC idempotente (sync_guardar_items_cotizacion, SYNC-5,
 *         mismo patrón sync_op_iniciar/sync_op_guardar que agregar_item_orden)
 *         reemplaza TODOS los renglones. item.inventarioId es un id LOCAL
 *         (entero, propio del dispositivo) — como `inventario` no se sincroniza
 *         todavía, no hay forma de resolverlo a un uid de nube: se manda
 *         inventario_id = null a propósito (limitación conocida, no se inventa
 *         una referencia cruzada que no existe).
 * ==========================================================================*/
(function (global) {
  "use strict";

  function esRuta(v) { return typeof v === "string" && v.length > 0 && !/^data:/i.test(v); }
  // Mismo criterio que build-target.js/app.js (ES_APP_MECANICOS), leído aquí de forma independiente porque
  // este script se carga ANTES que app.js: build-target.js ya corrió, así que window.ENTIMOTORS_BUILD existe.
  var esMecanico = !!(global.ENTIMOTORS_BUILD && global.ENTIMOTORS_BUILD.producto === "mecanico");

  var mappers = {
    clientes: {
      entidad: "clientes", tabla: "clientes", store: "clientes",
      columnas: ["nombre", "telefono"], tiempos: [], fks: [],
      aCloud: function (l) { return { nombre: l.nombre || "", telefono: l.telefono || null }; },
      aLocal: function (r) { return { nombre: r.nombre, telefono: r.telefono || "" }; },
    },

    motos: {
      entidad: "motos", tabla: "motos", store: "motos",
      columnas: ["marca", "modelo", "placa", "km", "cilindraje", "foto_path", "mantenimiento"], tiempos: [],
      fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }],
      aCloud: function (l) {
        return {
          marca: l.marca || null, modelo: l.modelo || null, placa: l.placa || null, km: l.km == null ? 0 : l.km,
          cilindraje: l.cilindraje || null,
          foto_path: esRuta(l.foto) ? l.foto : null,
          mantenimiento: l.mantenimiento || null,
        };
      },
      aLocal: function (r) {
        var campos = { marca: r.marca, modelo: r.modelo, placa: r.placa, km: r.km, cilindraje: r.cilindraje || "", mantenimiento: r.mantenimiento || null };
        // foto NO se toca aquí: si el dispositivo ya tenía una foto local (base64), se conserva tal cual.
        return campos;
      },
    },

    citas: {
      entidad: "citas", tabla: "citas", store: "citas",
      columnas: ["nombre_tmp", "telefono_tmp", "fecha", "hora", "mecanico", "mecanico_id", "motivo", "origen", "estado",
        "cerrada_en", "recordatorio_enviado", "reprogramaciones", "aviso_cliente_wa", "confirmada"],
      tiempos: ["cerrada_en"],
      fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }],
      aCloud: function (l) {
        return {
          nombre_tmp: l.nombreTmp || null, telefono_tmp: l.telefonoTmp || null,
          fecha: l.fecha || null, hora: l.hora || null,
          // mecanico_id YA es el uuid de perfiles (currentUser.perfilId): no pasa por el mapa local↔uid.
          mecanico: l.mecanico || null, mecanico_id: l.mecanicoId || null,
          motivo: l.motivo || null, origen: l.origen || null, estado: l.estado || null,
          cerrada_en: l.cerradaEn || undefined,
          recordatorio_enviado: !!l.recordatorioEnviado,
          reprogramaciones: l.reprogramaciones || [],
          aviso_cliente_wa: l.avisoClienteWA || null,
          confirmada: !!l.confirmada,
        };
      },
      aLocal: function (r) {
        return {
          nombreTmp: r.nombre_tmp || "", telefonoTmp: r.telefono_tmp || "", fecha: r.fecha, hora: r.hora,
          mecanico: r.mecanico || "", mecanicoId: r.mecanico_id || null,
          motivo: r.motivo || "", origen: r.origen || "", estado: r.estado,
          cerradaEn: r.cerrada_en ? new Date(r.cerrada_en).getTime() : null,
          recordatorioEnviado: !!r.recordatorio_enviado,
          reprogramaciones: r.reprogramaciones || [],
          avisoClienteWA: r.aviso_cliente_wa || null,
          confirmada: !!r.confirmada,
        };
      },
    },

    categorias_inv: {
      entidad: "categorias_inv", tabla: "categorias_inv", store: "categorias_inv",
      columnas: ["nombre"], tiempos: [], fks: [],
      // D-4 (igual que inventario, SYNC-7A): el maestro de categorías también es solo del administrador.
      puedeEscribir: function (rol) { return rol === "admin"; },
      aCloud: function (l) { return { nombre: l.nombre || "" }; },
      aLocal: function (r) { return { nombre: r.nombre }; },
    },

    // SYNC-7A: ver la cabecera del archivo — SOLO el maestro; `cantidad` nunca viaja por aquí.
    inventario: {
      entidad: "inventario", tabla: "inventario", store: "inventario",
      columnas: ["nombre", "modelo", "costo_compra", "precio_venta", "stock_minimo", "codigo_barras", "publicar_en_web", "foto_url"],
      tiempos: [], fks: [{ local: "categoriaId", cloud: "categoria_id", entidad: "categorias_inv" }],
      puedeEscribir: function (rol) { return rol === "admin"; },
      aCloud: function (l) {
        return {
          nombre: l.nombre || "", modelo: l.modelo || null,
          costo_compra: l.costoCompra || 0, precio_venta: l.precio || 0,
          stock_minimo: l.stockMinimo == null ? 3 : l.stockMinimo,
          codigo_barras: l.codigoBarras || null, publicar_en_web: !!l.publicarEnWeb,
          foto_url: esRuta(l.foto) ? l.foto : null,
        };
      },
      aLocal: function (r) {
        // SYNC-7B: `cantidad` y `requiere_revision` SÍ bajan ahora (ver la cabecera, sección SYNC-7B): el Taller ya
        // no mueve stock local en modo nube — ventas/créditos/órdenes/ajustes van por RPC al ledger, así que la
        // cantidad de la nube es la única verdad y la caché solo la refleja. Siguen SIN estar en `columnas`:
        // nunca suben por el CRUD del maestro.
        return {
          nombre: r.nombre, modelo: r.modelo || "",
          costoCompra: Number(r.costo_compra) || 0, precio: Number(r.precio_venta) || 0, precioVenta: Number(r.precio_venta) || 0,
          stockMinimo: r.stock_minimo == null ? 3 : Number(r.stock_minimo),
          codigoBarras: r.codigo_barras || "", publicarEnWeb: !!r.publicar_en_web,
          cantidad: Number(r.cantidad) || 0,
          requiereRevision: !!r.requiere_revision,
          // foto NO se toca aquí (igual que motos.foto): una foto local en base64 se conserva tal cual.
        };
      },
      // SYNC-8: la existencia la decide el ledger del servidor, aunque haya una edición del maestro sin enviar.
      soloServidor: ["cantidad", "requiereRevision"],
    },

    cotizaciones: {
      entidad: "cotizaciones", tabla: "cotizaciones", store: "cotizaciones",
      // embebe los renglones hijos en la misma bajada (ver la nota de cabecera): no hay entidad "cotizacion_items".
      select: "*,cotizacion_items(id,inventario_id,nombre,cantidad,precio)",
      columnas: ["cliente_nombre", "cliente_telefono", "moto_desc", "diagnostico", "notas", "validez_dias", "vence_en", "estado"],
      tiempos: ["vence_en"],
      fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }, { local: "motoId", cloud: "moto_id", entidad: "motos" }],
      aCloud: function (l) {
        return {
          cliente_nombre: l.clienteNombre || "", cliente_telefono: l.clienteTelefono || null,
          moto_desc: l.motoDesc || null, diagnostico: l.diagnostico || null, notas: l.notas || null,
          validez_dias: l.validezDias || 15, vence_en: l.venceISO || null, estado: l.estado || "pendiente",
        };
      },
      aLocal: function (r) {
        var venceMs = r.vence_en ? new Date(r.vence_en).getTime() : null;
        var diasMs = (r.validez_dias || 15) * 86400000;
        var c = {
          clienteNombre: r.cliente_nombre || "", clienteTelefono: r.cliente_telefono || "",
          motoDesc: r.moto_desc || "", diagnostico: r.diagnostico || "", notas: r.notas || "",
          validezDias: r.validez_dias || 15, venceISO: r.vence_en || null,
          // fechaISO no tiene columna propia: se deriva de vence_en - validez_dias (ver cabecera del archivo).
          fechaISO: venceMs ? new Date(venceMs - diasMs).toISOString() : (r.creado_en || null),
          estado: r.estado || "pendiente",
        };
        // SYNC-8: solo si la fila trae los renglones embebidos (la descarga). La respuesta de un PATCH de la cabecera no
        // los trae: devolver [] ahí borraba de la caché los renglones que sí existen.
        if (Array.isArray(r.cotizacion_items)) c.items = r.cotizacion_items.map(function (it) {
          return { nombre: it.nombre, cantidad: Number(it.cantidad), precio: Number(it.precio), inventarioId: null };
        });
        return c;
      },
    },
    // SYNC-6: ver la cabecera del archivo — el Taller y Mi Trabajo usan objetos
    // MUY distintos aquí, elegidos una sola vez al cargar el script.
    ordenes: esMecanico ? {
      entidad: "ordenes", tabla: "rpc/ordenes_tecnico_mias", store: "ordenes",
      columnas: [], tiempos: [], fks: [],
      // El mecánico nunca empuja por aquí (ver cabecera): devuelve vacío por si algo llamara a escribir() por error.
      aCloud: function () { return {}; },
      aLocal: function (r) {
        return {
          estado: r.estado, falla: r.falla || "", diagnostico: r.diagnostico || null,
          reparacionNotas: r.reparacion_notas || "", calidadChecklist: r.calidad_checklist || null,
          fotos: Array.isArray(r.fotos) ? r.fotos : [],
          kmSalida: r.km_salida == null ? null : Number(r.km_salida),
          garantiaDias: r.garantia_dias == null ? null : Number(r.garantia_dias),
          mecanico: r.mecanico || "", mecanicoId: r.mecanico_id || null,
          origenTrabajo: r.origen_trabajo || "taller",
          finalizada: !!r.finalizada,
          finalizadoEn: r.finalizado_en ? new Date(r.finalizado_en).getTime() : null,
          entregadoEn: r.entregado_en ? new Date(r.entregado_en).getTime() : null,
          clienteNombre: r.cliente_nombre || "", clienteTelefono: r.cliente_telefono || "",
          motoMarca: r.moto_marca || "", motoModelo: r.moto_modelo || "", motoPlaca: r.moto_placa || "",
          // Solo nombre y cantidad: nunca precio ni costo (SYNC-6 sección 7 — nada financiero para el mecánico).
          items: Array.isArray(r.items) ? r.items.map(function (it) { return { nombre: it.nombre, cantidad: Number(it.cantidad) }; }) : [],
        };
      },
    } : {
      entidad: "ordenes", tabla: "ordenes", store: "ordenes",
      // Sin fotos a propósito (ver cabecera). SYNC-8: los ítems BAJAN embebidos (solo lectura: suben por
      // agregar_item_orden/quitar_item_orden, nunca por `columnas`).
      select: "*,orden_items(id,inventario_id,nombre,cantidad,precio,costo_unitario,costo_estimado,creado_en)",
      soloServidor: ["finalizada", "anulada", "finalizadoEn", "entregadoEn"],
      columnas: ["estado", "falla", "diagnostico", "reparacion_notas", "calidad_checklist",
        "mecanico", "mecanico_id", "origen_trabajo", "km_salida", "garantia_dias"],
      tiempos: [],
      fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }, { local: "motoId", cloud: "moto_id", entidad: "motos" }],
      aCloud: function (l) {
        return {
          estado: l.estado || "recibido", falla: l.falla || null,
          diagnostico: l.diagnostico || null, reparacion_notas: l.reparacionNotas || null,
          calidad_checklist: l.calidadChecklist || null,
          mecanico: l.mecanico || null, mecanico_id: l.mecanicoId || null,
          origen_trabajo: l.origenTrabajo || "taller",
          km_salida: l.kmSalida == null ? null : l.kmSalida,
          garantia_dias: l.garantiaDias == null ? null : l.garantiaDias,
        };
      },
      aLocal: function (r) {
        var c = {
          estado: r.estado, falla: r.falla || "", diagnostico: r.diagnostico || null,
          reparacionNotas: r.reparacion_notas || "", calidadChecklist: r.calidad_checklist || null,
          mecanico: r.mecanico || "", mecanicoId: r.mecanico_id || null,
          origenTrabajo: r.origen_trabajo || "taller",
          kmSalida: r.km_salida == null ? null : Number(r.km_salida),
          garantiaDias: r.garantia_dias == null ? null : Number(r.garantia_dias),
          // SYNC-7B: solo lectura (NO están en `columnas`, nunca suben): la finalización y la anulación las decide
          // la nube (finalizar_orden / anular_orden), así otro dispositivo no vuelve a cobrar una orden ya cobrada.
          finalizada: !!r.finalizada,
          anulada: !!r.anulada,
        };
        // SYNC-8: fechas de cobro/entrega (el reporte de producción las usa) solo si la fila las trae
        if (r.finalizado_en !== undefined) c.finalizadoEn = r.finalizado_en ? new Date(r.finalizado_en).getTime() : null;
        if (r.entregado_en !== undefined) c.entregadoEn = r.entregado_en ? new Date(r.entregado_en).getTime() : null;
        if (Array.isArray(r.orden_items)) {
          c.items = r.orden_items.slice().sort(function (a, b) { return String(a.creado_en || "").localeCompare(String(b.creado_en || "")) || String(a.id).localeCompare(String(b.id)); })
            .map(function (it) {
              return { uid: it.id, nombre: it.nombre, cantidad: Number(it.cantidad), precio: Number(it.precio),
                costoUnitario: Number(it.costo_unitario) || 0, costoEstimado: !!it.costo_estimado,
                inventarioUid: it.inventario_id || null, origenInventarioId: null };
            });
        }
        return c;
      },
      // el repuesto de cada renglón (uid de nube) → id local, dentro de la misma transacción del pull
      refsALocal: async function (c, resolver) {
        if (!Array.isArray(c.items)) return c;
        var items = [];
        for (var i = 0; i < c.items.length; i++) {
          var it = c.items[i];
          items.push(Object.assign({}, it, { origenInventarioId: it.inventarioUid ? await resolver(it.inventarioUid) : null }));
        }
        return Object.assign({}, c, { items: items });
      },
      // los renglones que SOLO existen aquí (sin uid: nunca llegaron a la nube) no se pierden al bajar
      fusionarLocal: function (local, c) {
        if (!Array.isArray(c.items)) return c;
        var soloLocales = (local.items || []).filter(function (it) { return it && !it.uid; });
        return soloLocales.length ? Object.assign({}, c, { items: c.items.concat(soloLocales) }) : c;
      },
    },
  };

  /* ================= SYNC-7B · DINERO (solo lectura por el CRUD) =================
     ventas_rapidas / creditos / caja_movimientos BAJAN de la nube para la UI y la caché, pero NUNCA suben por
     escribir(): `soloLectura: true` hace que sync-engine.js lance si alguien lo intenta, y app.js además las
     bloquea en DB.save/DB.delete. Toda escritura de dinero va por las RPC transaccionales e idempotentes de
     sync-3-rpc.sql (ver sync-finanzas.js). La caché NUNCA es autoridad para escribir: el servidor calcula
     totales, saldos y stock. Los hijos (venta_items, credito_items, abonos) bajan EMBEBIDOS en su cabecera
     (PostgREST `select`); las RPC tocan la cabecera en cada cambio (rev/updated_at), así el cursor los re-baja.
     Solo el Taller: el mecánico no tiene RLS de lectura de dinero (SYNC-2) y su build no carga estos mappers. */
  function iso(v) { return v ? new Date(v).toISOString() : null; }
  function ms(v) { return v ? new Date(v).getTime() : null; }
  function num(v) { return v === null || v === undefined ? null : Number(v); }
  // inventario_id (uid) de cada renglón → id local del repuesto, dentro de la misma transacción del pull
  async function itemsALocal(items, resolver) {
    var out = [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      out.push(Object.assign({}, it, { inventarioId: it.inventarioUid ? await resolver(it.inventarioUid) : null }));
    }
    return out;
  }
  function renglon(it) {
    return {
      uid: it.id, inventarioUid: it.inventario_id || null, inventarioId: null, nombre: it.nombre,
      cantidad: Number(it.cantidad), precio: Number(it.precio),
      costoUnitario: Number(it.costo_unitario) || 0, costoEstimado: !!it.costo_estimado,
    };
  }
  var financieros = {
    ventas_rapidas: {
      entidad: "ventas_rapidas", tabla: "ventas", store: "ventas_rapidas", soloLectura: true,
      select: "*,venta_items(id,inventario_id,nombre,cantidad,precio,costo_unitario,costo_estimado)",
      columnas: [], tiempos: [], fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }],
      aCloud: function () { return {}; },
      aLocal: function (r) {
        return {
          items: Array.isArray(r.venta_items) ? r.venta_items.map(renglon) : [],
          clienteNombre: r.cliente_nombre || null, metodoPago: r.metodo_pago, total: Number(r.total),
          efectivoRecibido: num(r.efectivo_recibido), cambio: Number(r.cambio) || 0,
          mecanico: r.mecanico || "", mecanicoId: r.mecanico_id || null,
          fechaISO: iso(r.occurred_at || r.creado_en), creadoEn: ms(r.creado_en),
          anulada: !!r.anulada, anuladaEn: ms(r.anulada_en), capturadaOffline: !!r.capturada_offline,
        };
      },
      refsALocal: async function (c, resolver) { return Object.assign({}, c, { items: await itemsALocal(c.items, resolver) }); },
    },
    creditos: {
      entidad: "creditos", tabla: "creditos", store: "creditos", soloLectura: true,
      select: "*,credito_items(id,inventario_id,nombre,cantidad,precio,costo_unitario),abonos(id,id_abono,monto,metodo_pago,occurred_at,creado_en,anulado,anulado_en)",
      columnas: [], tiempos: [],
      fks: [{ local: "clienteId", cloud: "cliente_id", entidad: "clientes" }, { local: "ordenId", cloud: "orden_id", entidad: "ordenes" }],
      aCloud: function () { return {}; },
      aLocal: function (r) {
        var abonos = Array.isArray(r.abonos) ? r.abonos.slice().sort(function (a, b) { return String(a.creado_en).localeCompare(String(b.creado_en)); }) : [];
        var ab = function (a) { return { uid: a.id, idAbono: a.id_abono, monto: Number(a.monto), metodoPago: a.metodo_pago, fechaISO: iso(a.occurred_at || a.creado_en), anulado: !!a.anulado }; };
        return {
          clienteNombre: r.cliente_nombre, clienteTelefono: r.cliente_telefono || "",
          items: Array.isArray(r.credito_items) ? r.credito_items.map(renglon) : [],
          total: Number(r.total), abonado: Number(r.abonado), saldo: Number(r.saldo), estado: r.estado,
          vencimiento: r.vencimiento || null, nota: r.nota || "", origen: r.origen || null,
          historialAbonos: abonos.filter(function (a) { return !a.anulado; }).map(ab),
          abonosAnulados: abonos.filter(function (a) { return a.anulado; }).map(ab),
          mecanico: r.mecanico || "", mecanicoId: r.mecanico_id || null,
          fechaISO: iso(r.occurred_at || r.creado_en), creadoEn: ms(r.creado_en),
          anulado: !!r.anulado, anuladoEn: ms(r.anulado_en),
        };
      },
      refsALocal: async function (c, resolver) { return Object.assign({}, c, { items: await itemsALocal(c.items, resolver) }); },
    },
    caja_movimientos: {
      entidad: "caja_movimientos", tabla: "caja_movimientos", store: "caja_movimientos", soloLectura: true,
      columnas: [], tiempos: [],
      fks: [{ local: "ventaId", cloud: "venta_id", entidad: "ventas_rapidas" }, { local: "creditoId", cloud: "credito_id", entidad: "creditos" },
        { local: "ordenId", cloud: "orden_id", entidad: "ordenes" }],
      aCloud: function () { return {}; },
      aLocal: function (r) {
        return {
          tipo: r.tipo, categoria: r.categoria || "", monto: Number(r.monto), metodoPago: r.metodo_pago || null,
          descripcion: r.descripcion || "", idAbono: r.id_abono || null, reversoDe: r.reverso_de || null,
          fechaISO: iso(r.occurred_at || r.creado_en), creadoEn: ms(r.creado_en),
        };
      },
    },
  };
  if (!esMecanico) Object.keys(financieros).forEach(function (k) { mappers[k] = financieros[k]; });

  // "inventario" va DESPUÉS de "categorias_inv" (SYNC-7A): su fk categoriaId se resuelve por el mapa
  // local↔uid, que solo existe una vez que categorias_inv ya se sincronizó (mismo motivo que "ordenes" va
  // después de "clientes"/"motos").
  var orden = ["clientes", "motos", "citas", "categorias_inv", "inventario", "cotizaciones", "ordenes"];
  // SYNC-7B: el dinero va al final — sus llaves foráneas (clientes, ordenes, ventas, créditos) ya están en el mapa.
  if (!esMecanico) orden = orden.concat(["ventas_rapidas", "creditos", "caja_movimientos"]);

  global.ENTIMOTORS_SYNC_MAPPERS = mappers;
  global.ENTIMOTORS_SYNC_ORDEN = orden;
})(typeof window !== "undefined" ? window : this);
