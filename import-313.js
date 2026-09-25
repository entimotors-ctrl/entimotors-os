/* ============================================================================
 * ENTIMOTORS OS · import-313.js  (3.14.0 · SYNC-10)
 * ----------------------------------------------------------------------------
 * MIGRACIÓN SEGURA 3.13 → NUBE. La 3.13 guardaba todo el taller SOLO en el
 * teléfono (IndexedDB entimotors_os_demo v6). La 3.14 trabaja contra la nube:
 * sin este paso, el día del cambio el taller vería un sistema vacío.
 *
 *   respaldo 3.13 (el MISMO archivo de «Respaldar», o los datos de este
 *   teléfono armados con ese mismo formato) → validar → vista previa (solo
 *   cantidades) → confirmación explícita → UNA llamada atómica al servidor
 *   (import_aplicar_paquete, sync-10-importacion.sql: todo o nada) →
 *   verificación contra la nube (import_totales).
 *
 * REGLAS
 *   · El respaldo es entrada NO confiable: aquí solo se leen campos conocidos y
 *     se escriben columnas de una lista fija. Nunca decide identidad, rol,
 *     dueño ni mecánico (mecanico_id va siempre vacío: el nombre se conserva
 *     como texto y el administrador reasigna). El servidor además excluye las
 *     columnas que gobierna él (rev, created_by, cantidad…).
 *   · Nada de dinero se recalcula ni se «arregla»: un respaldo cuyos números no
 *     cuadran (venta ≠ renglones, abonado ≠ abonos, saldo ≠ total − abonado) se
 *     RECHAZA entero. Lo histórico entra como histórico: no mueve stock ni caja
 *     de hoy. El stock entra tal cual (apertura única del ledger en el servidor).
 *   · Ids deterministas: el mismo registro 3.13 da siempre el mismo UUID, y el
 *     lote sale de la huella de los datos → reintentar (respuesta perdida,
 *     cierre de la app) nunca duplica: el servidor devuelve «repetida».
 *   · Nunca borra el origen: ni entimotors_os_demo ni el archivo.
 *   · Privacidad: ningún console.* con contenido del respaldo; los errores
 *     nombran tabla e id local, nunca nombres, teléfonos ni montos.
 *
 * Clasificación de los 12 stores del respaldo 3.13 (V313_DATA_MANIFEST):
 *   IMPORT        clientes, motos, ordenes, inventario, citas, cotizaciones,
 *                 ventas_rapidas (→ ventas), creditos, caja_movimientos, categorias_inv
 *   DERIVE        orden_items, cotizacion_items, venta_items, credito_items (de `items`),
 *                 abonos (de creditos.historialAbonos), apertura de inventario (servidor)
 *   LOCAL_ONLY    web_cms (la 3.14 lo sigue leyendo del teléfono; no hay mapper de nube)
 *   DO_NOT_IMPORT auditoria (la del servidor sella identidad real; queda en el respaldo)
 *   (sync_cola nunca viaja en el respaldo: es la cola local, no datos del taller)
 * ==========================================================================*/
(function (global) {
  "use strict";

  var VERSION_RESPALDO = 2;
  var ESQUEMA_313 = 6;
  var DISPOSITIVO = "legado-313";           // origen de TODOS los registros importados (UNIQUE dispositivo+local_id)
  var STORES = ["clientes", "motos", "ordenes", "inventario", "citas", "cotizaciones", "ventas_rapidas", "caja_movimientos",
    "creditos", "web_cms", "categorias_inv", "auditoria"];
  var CLASIFICACION = {
    clientes: "IMPORT", motos: "IMPORT", ordenes: "IMPORT", inventario: "IMPORT", citas: "IMPORT", cotizaciones: "IMPORT",
    ventas_rapidas: "IMPORT", caja_movimientos: "IMPORT", creditos: "IMPORT", categorias_inv: "IMPORT",
    web_cms: "LOCAL_ONLY", auditoria: "DO_NOT_IMPORT",
  };
  /* Límites (FASE 31). Un taller real ronda cientos o pocos miles de registros (≈ 1–3 MB de JSON sin fotos); lo que
     infla el archivo son las fotos en base64, que NO se suben (se quedan en el respaldo). 60 MB deja margen de sobra
     y evita que un archivo absurdo congele el teléfono; 30 000 filas es el tope de UNA transacción del servidor. */
  var LIMITE_BYTES = 60 * 1024 * 1024;
  var LIMITE_FILAS = 30000;
  var ESTADOS_ORDEN = ["recibido", "diagnostico", "presupuesto", "reparacion", "calidad", "entregado"];
  var ESTADOS_COT = ["pendiente", "aceptada", "rechazada"];
  var ESTADOS_CRED = ["pendiente", "parcial", "pagado"];
  var CENTAVO = 0.01;
  /* B2 · FIRMA de los datos inventados que la 3.13 siembra sola: «Ver un ejemplo» (seedIfEmpty) y la cuenta «prueba»
     (sembrarDatosPrueba). Son valores FIJOS del código (nombre+teléfono, placa). Un respaldo que los trae mezcla datos
     de ejemplo con los reales → NO se sube: los datos de ejemplo nunca llegan a la nube del taller. */
  var FIRMA_DEMO_CLIENTES = ["Carlos Reyes|9704-1122", "Marlon Zúniga|9988-3344", "Deysi Martínez|9811-5566",
    "Ana Gómez|9911-2233", "Roberto Cruz|9822-4455", "Fernanda López|9733-6677"];
  var FIRMA_DEMO_PLACAS = ["HAX-4471", "PAO-0912", "MDC-2201", "HAM-2210", "PAG-1187", "HAX-9042"];

  // ---------------------------------------------------------------- utilidades puras
  function esEntero(v) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v; }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && isFinite(Number(v)) ? Number(v) : null); }
  function texto(v) { return typeof v === "string" ? v : (v === null || v === undefined ? null : String(v)); }
  function entero(v) { var n = num(v); return n === null ? null : Math.round(n); }
  function fecha(v) {
    if (v === null || v === undefined || v === "") return null;
    var d = typeof v === "number" ? new Date(v) : new Date(String(v));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  function soloFecha(v) {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var f = fecha(v); return f ? f.slice(0, 10) : null;
  }
  function objeto(v) { return v && typeof v === "object" ? v : null; }
  function esBase64(v) { return typeof v === "string" && /^data:/i.test(v); }
  function redondear(n) { return Math.round(n * 100) / 100; }

  async function sha256Hex(txt) {
    var bytes = new TextEncoder().encode(txt);
    var h = new Uint8Array(await global.crypto.subtle.digest("SHA-256", bytes));
    var s = ""; for (var i = 0; i < h.length; i++) s += (h[i] < 16 ? "0" : "") + h[i].toString(16);
    return s;
  }
  /** UUID determinista (variante RFC 4122, versión 8 «a medida») a partir de SHA-256: mismo origen → mismo UUID. */
  async function uuidDe(tabla, clave) {
    var hex = await sha256Hex("entimotors-313|" + tabla + "|" + clave);
    var b = hex.slice(0, 32).split("");
    b[12] = "8";
    b[16] = ((parseInt(b[16], 16) & 0x3) | 0x8).toString(16);
    var s = b.join("");
    return s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" + s.slice(16, 20) + "-" + s.slice(20, 32);
  }

  // ---------------------------------------------------------------- lectura y validación (FASE 5)
  /** Texto del archivo → {ok, respaldo} | {ok:false, errores}. Nunca lanza. */
  function leerTexto(txt) {
    if (typeof txt !== "string" || !txt.length) return { ok: false, errores: ["El archivo está vacío."] };
    if (txt.length > LIMITE_BYTES) return { ok: false, errores: ["El archivo es demasiado grande (" + Math.round(txt.length / 1048576) + " MB; máximo " + (LIMITE_BYTES / 1048576) + " MB)."] };
    var r;
    try { r = JSON.parse(txt); } catch (e) { return { ok: false, errores: ["El archivo no es un respaldo válido (JSON dañado)."] }; }
    return { ok: true, respaldo: r };
  }

  /** Valida estructura, versión, ids, referencias y cuadre del dinero. Errores = no se importa NADA. Avisos = se importa
      con la corrección indicada (referencia a algo borrado → vacía; foto base64 → se queda en el respaldo). */
  function validar(r) {
    var errores = [], avisos = [];
    var mal = function (m) { if (errores.length < 50) errores.push(m); };
    if (!objeto(r) || Array.isArray(r)) return { ok: false, errores: ["El archivo no es un respaldo de ENTIMOTORS."], avisos: [] };
    if (!objeto(r.data)) return { ok: false, errores: ["El archivo no trae datos (falta «data»)."], avisos: [] };
    if (r.version !== VERSION_RESPALDO) mal("Formato de respaldo " + JSON.stringify(r.version) + " no compatible (se espera " + VERSION_RESPALDO + ").");
    if (r.esquemaDB !== ESQUEMA_313) mal("Esquema " + JSON.stringify(r.esquemaDB) + " no compatible (se espera el de la 3.13: " + ESQUEMA_313 + ").");
    if (typeof r.versionApp !== "string" || !/^3\.\d+\.\d+$/.test(r.versionApp)) mal("Versión de la app desconocida.");
    else if (!/^3\.13\./.test(r.versionApp)) avisos.push("El respaldo es de la versión " + r.versionApp + " (no 3.13): revisa bien la vista previa.");
    var desconocidas = Object.keys(r.data).filter(function (k) { return STORES.indexOf(k) < 0; });
    if (desconocidas.length) mal("El respaldo trae tablas que esta versión no conoce: " + desconocidas.join(", ") + ".");
    var total = 0;
    STORES.forEach(function (s) {
      var filas = r.data[s];
      if (!Array.isArray(filas)) { mal("Respaldo incompleto: falta la tabla «" + s + "»."); return; }
      total += filas.length;
      if (r.conteos && typeof r.conteos[s] === "number" && r.conteos[s] !== filas.length) mal("Respaldo incompleto: «" + s + "» dice " + r.conteos[s] + " y trae " + filas.length + ".");
      var vistos = {};
      filas.forEach(function (x, i) {
        if (!objeto(x)) { mal(s + ": el registro " + (i + 1) + " no es válido."); return; }
        var k = s === "web_cms" ? x.key : x.id;
        if (s === "web_cms" ? (typeof k !== "string" || !k) : !(esEntero(k) && k > 0)) { mal(s + ": el registro " + (i + 1) + " tiene un identificador inválido."); return; }
        if (vistos[k]) mal(s + ": identificador repetido #" + k + ".");
        vistos[k] = true;
      });
    });
    if (typeof r.totalRegistros === "number" && r.totalRegistros !== total) mal("Respaldo incompleto: dice " + r.totalRegistros + " registros y trae " + total + ".");
    if (errores.length) return { ok: false, errores: errores, avisos: avisos };

    var d = r.data;
    var ids = {}; STORES.forEach(function (s) { ids[s] = {}; d[s].forEach(function (x) { ids[s][x.id] = x; }); });
    var colgantes = 0, fotos = 0, negativos = 0, mecanicos = {};
    var ref = function (s, v) { if (v === null || v === undefined || v === "") return; if (!ids[s][v]) colgantes++; };
    var dinero = function (s, x, campo, min) { var n = num(x[campo]); if (n === null || n < min) mal(s + " #" + x.id + ": «" + campo + "» inválido."); return n; };
    var nombreItems = function (s, x) { (Array.isArray(x.items) ? x.items : []).forEach(function (it, i) {
      if (!objeto(it) || !texto(it.nombre) || num(it.cantidad) === null || num(it.precio) === null || num(it.precio) < 0) mal(s + " #" + x.id + ": el renglón " + (i + 1) + " es inválido.");
    }); };

    d.clientes.forEach(function (x) { if (!texto(x.nombre) || !String(x.nombre).trim()) mal("clientes #" + x.id + ": falta el nombre."); });
    d.categorias_inv.forEach(function (x) { if (!texto(x.nombre) || !String(x.nombre).trim()) mal("categorias_inv #" + x.id + ": falta el nombre."); });
    d.motos.forEach(function (x) { ref("clientes", x.clienteId); if (esBase64(x.foto)) fotos++; });
    d.inventario.forEach(function (x) {
      if (!texto(x.nombre) || !String(x.nombre).trim()) mal("inventario #" + x.id + ": falta el nombre.");
      var c = num(x.cantidad); if (c === null) mal("inventario #" + x.id + ": cantidad inválida."); else if (c < 0) negativos++;
      if (num(x.costoCompra) !== null && num(x.costoCompra) < 0) mal("inventario #" + x.id + ": costo negativo.");
      var pv = num(x.precioVenta !== undefined ? x.precioVenta : x.precio); if (pv !== null && pv < 0) mal("inventario #" + x.id + ": precio negativo.");
      ref("categorias_inv", x.categoriaId); if (esBase64(x.foto)) fotos++;
    });
    d.ordenes.forEach(function (x) {
      if (ESTADOS_ORDEN.indexOf(x.estado) < 0) mal("ordenes #" + x.id + ": etapa «" + texto(x.estado) + "» desconocida.");
      if (x.tipoCobro && ["contado", "credito"].indexOf(x.tipoCobro) < 0) mal("ordenes #" + x.id + ": tipo de cobro desconocido.");
      if (x.origenTrabajo && ["taller", "negocio"].indexOf(x.origenTrabajo) < 0) mal("ordenes #" + x.id + ": origen de trabajo desconocido.");
      ref("clientes", x.clienteId); ref("motos", x.motoId); ref("creditos", x.creditoId);
      nombreItems("ordenes", x);
      (Array.isArray(x.items) ? x.items : []).forEach(function (it) { ref("inventario", it && it.origenInventarioId); });
      (Array.isArray(x.fotos) ? x.fotos : []).forEach(function (f) { if (esBase64(f) || (objeto(f) && esBase64(f.data || f.src || f.url))) fotos++; });
      if (texto(x.mecanico)) mecanicos[x.mecanico] = true;
    });
    d.cotizaciones.forEach(function (x) {
      if (!texto(x.clienteNombre) || !String(x.clienteNombre).trim()) mal("cotizaciones #" + x.id + ": falta el nombre del cliente.");
      if (!fecha(x.venceISO)) mal("cotizaciones #" + x.id + ": fecha de vencimiento inválida.");
      if (x.estado && ESTADOS_COT.indexOf(x.estado) < 0) mal("cotizaciones #" + x.id + ": estado desconocido.");
      if (x.validezDias !== undefined && x.validezDias !== null && !(num(x.validezDias) > 0)) mal("cotizaciones #" + x.id + ": validez inválida.");
      ref("clientes", x.clienteId); ref("motos", x.motoId); ref("ordenes", x.ordenId);
      nombreItems("cotizaciones", x);
      (Array.isArray(x.items) ? x.items : []).forEach(function (it) { ref("inventario", it && it.inventarioId); });
    });
    d.citas.forEach(function (x) {
      if (!soloFecha(x.fecha) || !texto(x.hora)) mal("citas #" + x.id + ": fecha u hora inválida.");
      ref("clientes", x.clienteId); ref("ordenes", x.ordenId);
      if (texto(x.mecanico)) mecanicos[x.mecanico] = true;
    });
    d.ventas_rapidas.forEach(function (x) {
      var t = dinero("ventas_rapidas", x, "total", 0);
      if (!texto(x.metodoPago)) mal("ventas_rapidas #" + x.id + ": falta el método de pago.");
      nombreItems("ventas_rapidas", x);
      var suma = (Array.isArray(x.items) ? x.items : []).reduce(function (a, it) { return a + (num(it && it.cantidad) || 0) * (num(it && it.precio) || 0); }, 0);
      if (t !== null && Math.abs(t - suma) > CENTAVO) mal("ventas_rapidas #" + x.id + ": el total no cuadra con sus renglones.");
      ref("clientes", x.clienteId);
      (Array.isArray(x.items) ? x.items : []).forEach(function (it) { ref("inventario", it && it.inventarioId); });
    });
    d.creditos.forEach(function (x) {
      if (!texto(x.clienteNombre) || !String(x.clienteNombre).trim()) mal("creditos #" + x.id + ": falta el nombre del cliente.");
      var t = dinero("creditos", x, "total", 0), ab = dinero("creditos", x, "abonado", 0), sa = dinero("creditos", x, "saldo", -Infinity);
      if (x.estado && ESTADOS_CRED.indexOf(x.estado) < 0) mal("creditos #" + x.id + ": estado desconocido.");
      var hist = Array.isArray(x.historialAbonos) ? x.historialAbonos : [];
      var suma = 0;
      hist.forEach(function (a, i) {
        var m = num(a && a.monto);
        if (m === null || m <= 0) mal("creditos #" + x.id + ": el abono " + (i + 1) + " es inválido."); else suma += m;
      });
      if (ab !== null && Math.abs(ab - suma) > CENTAVO) mal("creditos #" + x.id + ": lo abonado no cuadra con su historial de abonos.");
      if (t !== null && ab !== null && sa !== null && Math.abs(sa - (t - ab)) > CENTAVO) mal("creditos #" + x.id + ": el saldo no cuadra (total − abonado).");
      nombreItems("creditos", x);
      ref("clientes", x.clienteId); ref("ordenes", x.ordenId);
      (Array.isArray(x.items) ? x.items : []).forEach(function (it) { ref("inventario", it && it.inventarioId); });
    });
    d.caja_movimientos.forEach(function (x) {
      if (["ingreso", "egreso"].indexOf(x.tipo) < 0) mal("caja_movimientos #" + x.id + ": tipo inválido.");
      dinero("caja_movimientos", x, "monto", 0);
      ref("ventas_rapidas", x.ventaId); ref("creditos", x.creditoId); ref("ordenes", x.ordenId);
    });

    var demo = d.clientes.filter(function (x) { return FIRMA_DEMO_CLIENTES.indexOf(String(x.nombre) + "|" + String(x.telefono)) >= 0; }).length +
      d.motos.filter(function (x) { return FIRMA_DEMO_PLACAS.indexOf(String(x.placa)) >= 0; }).length;
    if (demo >= 2) mal("El respaldo trae los datos de EJEMPLO de la 3.13 («Ver un ejemplo» o la cuenta de prueba: " + demo + " registros reconocidos). Los datos de ejemplo nunca se suben a la nube del taller.");

    var nFilas = contarFilas(d);
    if (nFilas > LIMITE_FILAS) mal("El respaldo trae " + nFilas + " filas: más de las " + LIMITE_FILAS + " que se importan de una vez. Pide ayuda técnica.");
    if (colgantes) avisos.push(colgantes + " referencia(s) apuntan a algo que ya se había borrado en el teléfono (p. ej. un repuesto eliminado): se importan sin ese enlace; el texto y los montos se conservan.");
    if (fotos) avisos.push(fotos + " foto(s) guardadas dentro del teléfono NO se suben a la nube: se quedan en el respaldo.");
    if (negativos) avisos.push(negativos + " repuesto(s) con existencia negativa: entran tal cual y quedan marcados «por revisar».");
    var nm = Object.keys(mecanicos).length;
    if (nm) avisos.push(nm + " nombre(s) de mecánico se conservan como texto; las órdenes quedan sin asignar a una cuenta hasta que el administrador las asigne.");
    if (d.web_cms.length) avisos.push("El contenido de la página web (" + d.web_cms.length + ") sigue en este teléfono: no se sube a la nube.");
    if (d.auditoria.length) avisos.push("La bitácora local (" + d.auditoria.length + ") no se sube: la nube lleva su propia auditoría. Queda en el respaldo.");
    return { ok: errores.length === 0, errores: errores, avisos: avisos };
  }

  function contarFilas(d) {
    var n = 0;
    ["clientes", "motos", "inventario", "citas", "categorias_inv", "caja_movimientos"].forEach(function (s) { n += (d[s] || []).length; });
    ["ordenes", "cotizaciones", "ventas_rapidas", "creditos"].forEach(function (s) {
      (d[s] || []).forEach(function (x) { n += 1 + (Array.isArray(x.items) ? x.items.length : 0) + (Array.isArray(x.historialAbonos) ? x.historialAbonos.length : 0); });
    });
    return n;
  }

  // ---------------------------------------------------------------- vista previa (FASE 6)
  /** Solo cantidades: nada de nombres, teléfonos ni montos individuales. */
  function resumen(r) {
    var d = r.data;
    var n = function (s) { return (d[s] || []).length; };
    return {
      idRespaldo: texto(r.idRespaldo), versionApp: texto(r.versionApp), exportadoEn: fecha(r.exportadoEn),
      conteos: {
        clientes: n("clientes"), motos: n("motos"), ordenes: n("ordenes"), productos: n("inventario"), categorias: n("categorias_inv"),
        citas: n("citas"), cotizaciones: n("cotizaciones"), ventas: n("ventas_rapidas"), creditos: n("creditos"),
        abonos: (d.creditos || []).reduce(function (a, c) { return a + (Array.isArray(c.historialAbonos) ? c.historialAbonos.length : 0); }, 0),
        movimientosCaja: n("caja_movimientos"),
      },
      seQuedanEnElTelefono: { paginaWeb: n("web_cms"), bitacora: n("auditoria") },
    };
  }

  // ---------------------------------------------------------------- mapeo 3.13 → nube (FASES 3, 9, 10, 11, 12)
  /** Construye el paquete para import_aplicar_paquete. Orden de dependencias lo fija el SERVIDOR (no el del JSON).
      Devuelve también `esperado` (totales para verificar contra import_totales). */
  async function construirPaquete(r) {
    var d = r.data;
    var ids = {}; STORES.forEach(function (s) { ids[s] = {}; (d[s] || []).forEach(function (x) { ids[s][x.id] = true; }); });
    var U = function (tabla, clave) { return uuidDe(tabla, clave); };
    var fk = async function (store, tabla, v) { return v !== null && v !== undefined && v !== "" && ids[store][v] ? U(tabla, v) : null; };
    var base = function (x) { return { local_id: x.id, dispositivo: DISPOSITIVO }; };
    var p = { categorias_inv: [], clientes: [], motos: [], inventario: [], ordenes: [], orden_items: [], cotizaciones: [], cotizacion_items: [],
      citas: [], ventas: [], venta_items: [], creditos: [], credito_items: [], abonos: [], caja_movimientos: [], enlaces: [] };
    var i, x, j, it, fila;

    for (i = 0; i < d.categorias_inv.length; i++) { x = d.categorias_inv[i];
      p.categorias_inv.push(Object.assign(base(x), { id: await U("categorias_inv", x.id), nombre: String(x.nombre).trim() }));
    }
    for (i = 0; i < d.clientes.length; i++) { x = d.clientes[i];
      p.clientes.push(Object.assign(base(x), { id: await U("clientes", x.id), nombre: String(x.nombre).trim(), telefono: texto(x.telefono) }));
    }
    for (i = 0; i < d.motos.length; i++) { x = d.motos[i];
      p.motos.push(Object.assign(base(x), { id: await U("motos", x.id), cliente_id: await fk("clientes", "clientes", x.clienteId),
        marca: texto(x.marca), modelo: texto(x.modelo), placa: texto(x.placa), km: entero(x.km), cilindraje: texto(x.cilindraje),
        mantenimiento: objeto(x.mantenimiento) }));
    }
    for (i = 0; i < d.inventario.length; i++) { x = d.inventario[i];
      p.inventario.push(Object.assign(base(x), { id: await U("inventario", x.id), nombre: String(x.nombre).trim(), modelo: texto(x.modelo),
        categoria_id: await fk("categorias_inv", "categorias_inv", x.categoriaId),
        cantidad: num(x.cantidad),                          // el servidor NO la inserta: la usa para la apertura única del ledger
        costo_compra: num(x.costoCompra) === null ? 0 : num(x.costoCompra),
        precio_venta: num(x.precioVenta !== undefined ? x.precioVenta : x.precio) === null ? 0 : num(x.precioVenta !== undefined ? x.precioVenta : x.precio),
        stock_minimo: num(x.stockMinimo), codigo_barras: texto(x.codigoBarras) || null, publicar_en_web: x.publicarEnWeb === true }));
    }
    for (i = 0; i < d.ordenes.length; i++) { x = d.ordenes[i];
      var oid = await U("ordenes", x.id);
      p.ordenes.push(Object.assign(base(x), { id: oid, cliente_id: await fk("clientes", "clientes", x.clienteId), moto_id: await fk("motos", "motos", x.motoId),
        estado: x.estado, falla: texto(x.falla), diagnostico: objeto(x.diagnostico), reparacion_notas: texto(x.reparacionNotas),
        calidad_checklist: objeto(x.calidadChecklist), aprobacion: objeto(x.aprobacion),
        fotos: (Array.isArray(x.fotos) ? x.fotos : []).filter(function (f) { return typeof f === "string" && !esBase64(f); }),
        mecanico: texto(x.mecanico), cita_local_id: esEntero(x.citaId) ? x.citaId : null, cotizacion_local_id: esEntero(x.cotizacionId) ? x.cotizacionId : null,
        finalizada: x.finalizada === true, finalizado_en: fecha(x.finalizadoEn), entregado_en: fecha(x.entregadoEn), margen: num(x.margen),
        tipo_cobro: x.tipoCobro || null, metodo_pago: texto(x.metodoPago), garantia_dias: entero(x.garantiaDias), km_salida: entero(x.kmSalida),
        creado_en: fecha(x.creadoEn), origen_trabajo: x.origenTrabajo || "taller", abono_inicial: num(x.abonoInicial), abono_metodo: texto(x.abonoMetodo) }));
      var its = Array.isArray(x.items) ? x.items : [];
      for (j = 0; j < its.length; j++) { it = its[j];
        p.orden_items.push({ id: await U("orden_items", x.id + ":" + j), orden_id: oid, inventario_id: await fk("inventario", "inventario", it.origenInventarioId),
          nombre: String(it.nombre), cantidad: num(it.cantidad), precio: num(it.precio), costo_unitario: num(it.costoUnitario), costo_estimado: it.costoEstimado === true,
          creado_en: fecha(x.creadoEn) });
      }
      if (x.creditoId !== null && x.creditoId !== undefined && ids.creditos[x.creditoId]) p.enlaces.push({ id: oid, credito_id: await U("creditos", x.creditoId) });
    }
    for (i = 0; i < d.cotizaciones.length; i++) { x = d.cotizaciones[i];
      var cid = await U("cotizaciones", x.id);
      p.cotizaciones.push(Object.assign(base(x), { id: cid, cliente_id: await fk("clientes", "clientes", x.clienteId), cliente_nombre: String(x.clienteNombre).trim(),
        cliente_telefono: texto(x.clienteTelefono), moto_id: await fk("motos", "motos", x.motoId), moto_desc: texto(x.motoDesc),
        diagnostico: texto(x.diagnostico), notas: texto(x.notas), validez_dias: entero(x.validezDias) || 15, vence_en: fecha(x.venceISO),
        estado: x.estado || "pendiente", orden_id: await fk("ordenes", "ordenes", x.ordenId), creado_por: texto(x.creadoPor),
        creado_en: fecha(x.fechaISO), aceptada_en: fecha(x.aceptadaEn) }));
      var ci = Array.isArray(x.items) ? x.items : [];
      for (j = 0; j < ci.length; j++) { it = ci[j];
        p.cotizacion_items.push({ id: await U("cotizacion_items", x.id + ":" + j), cotizacion_id: cid, inventario_id: await fk("inventario", "inventario", it.inventarioId),
          nombre: String(it.nombre), cantidad: num(it.cantidad), precio: num(it.precio), creado_en: fecha(x.fechaISO) });
      }
    }
    for (i = 0; i < d.citas.length; i++) { x = d.citas[i];
      p.citas.push(Object.assign(base(x), { id: await U("citas", x.id), cliente_id: await fk("clientes", "clientes", x.clienteId),
        nombre_tmp: texto(x.nombreTmp), telefono_tmp: texto(x.telefonoTmp), fecha: soloFecha(x.fecha), hora: texto(x.hora), mecanico: texto(x.mecanico),
        motivo: texto(x.motivo), origen: texto(x.origen), estado: texto(x.estado), cerrada_en: fecha(x.cerradaEn), orden_id: await fk("ordenes", "ordenes", x.ordenId),
        recordatorio_enviado: x.recordatorioEnviado === true, reprogramaciones: Array.isArray(x.reprogramaciones) ? x.reprogramaciones : [],
        creado_en: fecha(x.creadoEn), aviso_cliente_wa: objeto(x.avisoClienteWA), confirmada: x.confirmada === true }));
    }
    for (i = 0; i < d.ventas_rapidas.length; i++) { x = d.ventas_rapidas[i];
      var vid = await U("ventas", x.id), cuando = fecha(x.fechaISO) || fecha(x.creadoEn);
      p.ventas.push(Object.assign(base(x), { id: vid, cliente_id: await fk("clientes", "clientes", x.clienteId), cliente_nombre: texto(x.clienteNombre),
        metodo_pago: String(x.metodoPago), total: num(x.total), efectivo_recibido: num(x.efectivoRecibido), cambio: num(x.cambio),
        mecanico: texto(x.mecanico), creado_en: cuando, occurred_at: cuando }));
      var vi = Array.isArray(x.items) ? x.items : [];
      for (j = 0; j < vi.length; j++) { it = vi[j];
        p.venta_items.push({ id: await U("venta_items", x.id + ":" + j), venta_id: vid, inventario_id: await fk("inventario", "inventario", it.inventarioId),
          nombre: String(it.nombre), cantidad: num(it.cantidad), precio: num(it.precio), costo_unitario: num(it.costoUnitario), costo_estimado: it.costoEstimado === true,
          creado_en: cuando });
      }
    }
    var claveAbono = {};   // (crédito local, idAbono local) → id_abono en la nube: lo usa también la caja
    for (i = 0; i < d.creditos.length; i++) { x = d.creditos[i];
      var crid = await U("creditos", x.id), cc = fecha(x.fechaISO) || fecha(x.creadoEn);
      p.creditos.push(Object.assign(base(x), { id: crid, cliente_id: await fk("clientes", "clientes", x.clienteId), cliente_nombre: String(x.clienteNombre).trim(),
        cliente_telefono: texto(x.clienteTelefono), total: num(x.total), abonado: num(x.abonado), saldo: num(x.saldo),
        estado: x.estado || (num(x.saldo) <= CENTAVO ? "pagado" : (num(x.abonado) > 0 ? "parcial" : "pendiente")),
        origen: texto(x.origen), orden_id: await fk("ordenes", "ordenes", x.ordenId), nota: texto(x.nota), vencimiento: soloFecha(x.vencimiento),
        mecanico: texto(x.mecanico), creado_en: cc, occurred_at: cc }));
      var cri = Array.isArray(x.items) ? x.items : [];
      for (j = 0; j < cri.length; j++) { it = cri[j];
        p.credito_items.push({ id: await U("credito_items", x.id + ":" + j), credito_id: crid, inventario_id: await fk("inventario", "inventario", it.inventarioId),
          nombre: String(it.nombre), cantidad: num(it.cantidad), precio: num(it.precio), costo_unitario: num(it.costoUnitario), creado_en: cc });
      }
      var hist = Array.isArray(x.historialAbonos) ? x.historialAbonos : [];
      for (j = 0; j < hist.length; j++) { var a = hist[j];
        var idAb = DISPOSITIVO + ":" + x.id + ":" + (texto(a.idAbono) || ("#" + j));
        if (a.idAbono) claveAbono[x.id + "|" + a.idAbono] = idAb;
        var ca = fecha(a.fechaISO) || cc;
        p.abonos.push({ id: await U("abonos", x.id + ":" + j), id_abono: idAb, credito_id: crid, monto: num(a.monto), metodo_pago: texto(a.metodoPago) || "efectivo",
          creado_en: ca, occurred_at: ca });
      }
    }
    for (i = 0; i < d.caja_movimientos.length; i++) { x = d.caja_movimientos[i];
      var cm = fecha(x.fechaISO) || fecha(x.creadoEn);
      fila = Object.assign(base(x), { id: await U("caja_movimientos", x.id), tipo: x.tipo, categoria: texto(x.categoria), monto: num(x.monto),
        metodo_pago: texto(x.metodoPago), descripcion: texto(x.descripcion),
        venta_id: await fk("ventas_rapidas", "ventas", x.ventaId), credito_id: await fk("creditos", "creditos", x.creditoId),
        orden_id: await fk("ordenes", "ordenes", x.ordenId),
        id_abono: x.idAbono && x.creditoId !== undefined ? (claveAbono[x.creditoId + "|" + x.idAbono] || null) : null,
        creado_en: cm, occurred_at: cm });
      p.caja_movimientos.push(fila);
    }
    // lo vacío no se manda: así cada columna toma su DEFAULT de la nube (costo_unitario 0, creado_en now()…) en vez de
    // un NULL explícito que violaría NOT NULL. Todos esos DEFAULT son neutros; las columnas que admiten NULL lo dejan igual.
    Object.keys(p).forEach(function (t) { p[t] = p[t].map(sinVacios); });
    return { paquete: p, esperado: esperado(p) };
  }
  function sinVacios(fila) {
    var out = {};
    Object.keys(fila).forEach(function (k) { if (fila[k] !== null && fila[k] !== undefined) out[k] = fila[k]; });
    return out;
  }

  /** Totales que la nube debe mostrar tras importar (mismo formato que import_totales()). */
  function esperado(p) {
    var suma = function (filas, f) { return redondear(filas.reduce(function (a, x) { return a + (f(x) || 0); }, 0)); };
    return {
      clientes: p.clientes.length, motos: p.motos.length, ordenes: p.ordenes.length, citas: p.citas.length, cotizaciones: p.cotizaciones.length,
      inventario: { n: p.inventario.length, unidades: suma(p.inventario, function (x) { return x.cantidad; }) },
      ventas: { n: p.ventas.length, total: suma(p.ventas, function (x) { return x.total; }) },
      creditos: { n: p.creditos.length, total: suma(p.creditos, function (x) { return x.total; }), saldo: suma(p.creditos, function (x) { return x.saldo; }) },
      abonos: { n: p.abonos.length, monto: suma(p.abonos, function (x) { return x.monto; }) },
      caja: { ingresos: suma(p.caja_movimientos.filter(function (x) { return x.tipo === "ingreso"; }), function (x) { return x.monto; }),
              egresos: suma(p.caja_movimientos.filter(function (x) { return x.tipo === "egreso"; }), function (x) { return x.monto; }) },
    };
  }

  /** Compara lo esperado con import_totales(). Devuelve {ok, diferencias:[ruta]} (solo rutas, nunca datos personales). */
  function compararTotales(esp, real) {
    var dif = [];
    (function rec(a, b, ruta) {
      Object.keys(a).forEach(function (k) {
        var va = a[k], vb = b ? b[k] : undefined;
        if (va && typeof va === "object") return rec(va, vb, ruta + k + ".");
        if (typeof vb === "string") vb = Number(vb);
        if (typeof vb !== "number" || Math.abs(va - vb) > CENTAVO) dif.push(ruta + k);
      });
    })(esp, real, "");
    return { ok: dif.length === 0, diferencias: dif };
  }

  function nubeVacia(tot) {
    if (!objeto(tot)) return null;
    var n = function (v) { return typeof v === "number" ? v : Number(v) || 0; };
    return n(tot.clientes) + n(tot.motos) + n(tot.ordenes) + n(tot.citas) + n(tot.cotizaciones) + n(tot.inventario && tot.inventario.n) +
      n(tot.ventas && tot.ventas.n) + n(tot.creditos && tot.creditos.n) + n(tot.abonos && tot.abonos.n) === 0 &&
      n(tot.caja && tot.caja.ingresos) === 0 && n(tot.caja && tot.caja.egresos) === 0;
  }

  // ---------------------------------------------------------------- flujo con el servidor (FASES 7, 8, 13, 14, 24, 25)
  /** Prepara todo lo local (sin tocar la red): valida, resume, construye paquete, huella y lote. */
  async function preparar(r) {
    var v = validar(r);
    if (!v.ok) return { ok: false, errores: v.errores, avisos: v.avisos };
    var huella = await sha256Hex(JSON.stringify(r.data));        // huella de los DATOS (no de la cabecera): re-exportar lo mismo = mismo lote
    var c = await construirPaquete(r);
    return { ok: true, avisos: v.avisos, resumen: resumen(r), huella: huella, lote: await uuidDe("lote", huella), paquete: c.paquete, esperado: c.esperado,
      cabecera: { idRespaldo: texto(r.idRespaldo) || "sin-id", versionApp: texto(r.versionApp), esquemaDB: r.esquemaDB, conteos: objeto(r.conteos) || {} } };
  }

  /** Estado de la nube ANTES de importar: EMPTY | NON_EMPTY | UNKNOWN (+ el lote si ya existía). Nunca escribe. */
  async function comprobarDestino(rpc, lote) {
    var e = await rpc("import_estado", { p_lote: lote });
    if (!e.ok) return { destino: "UNKNOWN", error: e };
    var t = await rpc("import_totales", {});
    if (!t.ok) return { destino: "UNKNOWN", error: t, lote: e.datos };
    var vacia = nubeVacia(t.datos);
    return { destino: vacia === null ? "UNKNOWN" : (vacia ? "EMPTY" : "NON_EMPTY"), lote: e.datos, totales: t.datos };
  }

  /** Importa. `rpc(nombre, params, {timeout})` → {ok, datos, clase, codigo, mensaje} (SyncRest). `enLinea()` → bool.
      Idempotente: el mismo respaldo reanuda o devuelve el resultado ya aplicado; nunca duplica. */
  async function importar(o) {
    var rpc = o.rpc, prep = o.preparado, paso = o.onPaso || function () {};
    if (o.enLinea && !o.enLinea()) return { ok: false, codigo: "SIN_RED", mensaje: "No hay conexión: la importación necesita internet estable. No se tocó nada." };
    paso("destino");
    var dst = await comprobarDestino(rpc, prep.lote);
    if (dst.destino === "UNKNOWN") return { ok: false, codigo: "DESTINO_DESCONOCIDO", mensaje: mensajeError(dst.error), error: dst.error };
    var yaAplicado = dst.lote && (dst.lote.estado === "aplicado" || dst.lote.estado === "confirmado");
    if (!yaAplicado && dst.destino === "NON_EMPTY") {
      return { ok: false, codigo: "NUBE_CON_DATOS", mensaje: "La nube ya tiene datos del taller. Por seguridad no se importa encima: revísalo con soporte técnico antes de continuar." };
    }
    if (!yaAplicado) {
      paso("iniciar");
      var ini = await rpc("import_iniciar", { p_lote: prep.lote, p_legacy_device: DISPOSITIVO, p_sha256: prep.huella, p_backup_id: prep.cabecera.idRespaldo,
        p_version_app: prep.cabecera.versionApp, p_esquema: prep.cabecera.esquemaDB, p_conteos: prep.cabecera.conteos });
      if (!ini.ok) return { ok: false, codigo: ini.codigo || "INICIAR", mensaje: mensajeError(ini), error: ini };
      var dr = await rpc("import_dry_run_ok", { p_lote: prep.lote, p_informe: { conteos: prep.resumen.conteos, avisos: prep.avisos.length, validado_en_cliente: true } });
      if (!dr.ok) return { ok: false, codigo: dr.codigo || "DRY_RUN", mensaje: mensajeError(dr), error: dr };
      if (o.antesDeAplicar) await o.antesDeAplicar(prep.lote);
      paso("aplicar");
      var ap = await rpc("import_aplicar_paquete", { p_lote: prep.lote, p_paquete: prep.paquete }, { timeout: 180000 });
      if (!ap.ok) {
        // respuesta perdida / corte: el servidor decide. Todo o nada → o quedó aplicado entero, o no quedó nada.
        if (ap.clase === "red" || ap.clase === "servidor") {
          var re = await rpc("import_estado", { p_lote: prep.lote });
          if (!(re.ok && re.datos && (re.datos.estado === "aplicado" || re.datos.estado === "confirmado"))) {
            return { ok: false, codigo: "SIN_CONFIRMAR", reintentable: true, mensaje: "Se cortó la conexión y la nube no confirmó la importación. No quedó nada a medias: vuelve a intentarlo con el mismo respaldo." };
          }
        } else return { ok: false, codigo: ap.codigo || "APLICAR", mensaje: mensajeError(ap), error: ap };
      }
    }
    paso("verificar");
    var tot = await rpc("import_totales", {});
    if (!tot.ok) return { ok: true, lote: prep.lote, verificado: false, mensaje: "Importado, pero no se pudo verificar ahora: vuelve a abrir la importación para verificar." };
    var cmp = compararTotales(prep.esperado, tot.datos);
    return { ok: true, lote: prep.lote, repetida: !!yaAplicado, verificado: cmp.ok, diferencias: cmp.diferencias };
  }

  function mensajeError(e) {
    if (!e) return "No se pudo comunicar con la nube.";
    if (e.clase === "red") return "No hay conexión con la nube. No se tocó nada.";
    if (e.clase === "auth") return "Tu sesión caducó: vuelve a iniciar sesión. No se tocó nada.";
    if (e.clase === "permiso") return "Solo el administrador puede importar los datos del taller.";
    return e.mensaje || "La nube rechazó la importación.";
  }

  var API = {
    FIRMA_DEMO_CLIENTES: FIRMA_DEMO_CLIENTES, FIRMA_DEMO_PLACAS: FIRMA_DEMO_PLACAS,
    STORES: STORES, CLASIFICACION: CLASIFICACION, DISPOSITIVO: DISPOSITIVO, LIMITE_BYTES: LIMITE_BYTES, LIMITE_FILAS: LIMITE_FILAS,
    leerTexto: leerTexto, validar: validar, resumen: resumen, construirPaquete: construirPaquete, esperado: esperado,
    compararTotales: compararTotales, nubeVacia: nubeVacia, preparar: preparar, comprobarDestino: comprobarDestino, importar: importar,
    uuidDe: uuidDe, sha256Hex: sha256Hex,
  };
  global.Import313 = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
