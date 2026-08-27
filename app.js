// ENTIMOTORS OS — demo local. Todo vive en IndexedDB del navegador: no hay backend.
// El "sincronizado / sin conexión" de la barra superior es una simulación para
// mostrar cómo se sentiría el modo híbrido; la versión real empujaría esta
// misma cola de cambios hacia Supabase cuando vuelva la señal.
//
// Los botones de WhatsApp abren la conversación con el mensaje ya escrito —
// igual que cualquier link wa.me, todavía hace falta que una persona presione
// "enviar" dentro de WhatsApp. Un envío 100% desatendido (sin que nadie toque
// nada) requiere WhatsApp Business API con un backend real, no solo el navegador.

const STAGES = [
  { key: "recibido", label: "Recibido" },
  { key: "diagnostico", label: "Diagnóstico" },
  { key: "presupuesto", label: "Presupuesto" },
  { key: "reparacion", label: "Reparación" },
  { key: "calidad", label: "Calidad" },
  { key: "entregado", label: "Entregado" },
];

// Credenciales de demo en texto plano en el cliente: sirven para probar el flujo
// de login de la PWA, no son autenticación real. Antes de usar esto en el taller
// de verdad, esto debe validarse contra un backend (igual que el resto de la app).
const TEAM = [
  { user: "wilkin", nombre: "Wilkin", telefono: "97049635", password: "enti2026", rol: "admin" },
  { user: "mecanico1", nombre: "Mecánico 1", telefono: "", password: "enti2026", rol: "mecanico" },
  { user: "mecanico2", nombre: "Mecánico 2", telefono: "", password: "enti2026", rol: "mecanico" },
  // cuenta aparte solo para pruebas — mismo dispositivo y misma base de datos que
  // "wilkin" (esto no es multi-taller: todos los usuarios ven la misma información
  // guardada en este dispositivo), rol admin para poder probar todas las secciones.
  { user: "prueba", nombre: "Usuario de Prueba", telefono: "", password: "prueba2026", rol: "admin" },
];
// Secciones que solo el rol "admin" (dueño) puede ver — un mecánico no necesita
// entrar a la caja, la web o los respaldos para hacer su trabajo diario.
const VISTAS_SOLO_ADMIN = ["finanzas", "web-cms", "ajustes"];

// Horario del taller para el selector de citas: ajusta estos 3 valores si el
// taller abre/cierra en otro horario o quieres citas cada X minutos.
const HORARIO_TALLER = { horaInicio: "08:00", horaFin: "17:00", intervaloMin: 30 };

// Código de administrador para acciones irreversibles (borrar una orden). Igual
// que las contraseñas de TEAM, es un valor fijo en el cliente para probar el
// flujo — no reemplaza un permiso real validado por un backend.
const ADMIN_CODE = "2468";

let db;
let currentUser = null;
let currentOrderId = null;
let currentOrderCache = null; // { o, moto, cliente } — la llena openOrder(); así el
// botón de imprimir factura no necesita leer IndexedDB (con await) antes de
// llamar a window.print(), lo cual en navegadores móviles hace que el
// navegador ya no reconozca el clic como el gesto que autoriza imprimir.

/* ---------------- utilidades ---------------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(n) { return `L. ${(Number(n) || 0).toFixed(2)}`; }
function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}
function toWaDigits(raw) {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length < 8) return null;
  return digits.startsWith("504") ? digits : `504${digits}`;
}
// abrirVentanaWA() debe llamarse de inmediato, ANTES de cualquier await, en el
// mismo evento de clic — si primero se espera a leer datos de IndexedDB y
// hasta entonces se llama a window.open(), el gesto del usuario ya "expiró" en
// varios navegadores móviles (sobre todo iOS) y el navegador lo bloquea en
// silencio, sin ningún error: el botón "no hace nada". Por eso se abre la
// pestaña en blanco de una vez y se le pone la URL real después, cuando ya se
// tenga el texto armado.
function abrirVentanaWA() {
  return window.open("", "_blank");
}
function navegarWA(ventana, phoneRaw, text) {
  const digits = toWaDigits(phoneRaw);
  if (!digits) {
    ventana?.close();
    toast("Falta un teléfono válido para enviar por WhatsApp", "off");
    return false;
  }
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  if (ventana && !ventana.closed) ventana.location.href = url;
  else window.open(url, "_blank");
  return true;
}

/* ---------------- IndexedDB helper mínimo ---------------- */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("entimotors_os_demo", 4);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      const t = req.transaction;
      const oldV = e.oldVersion;

      if (!d.objectStoreNames.contains("clientes")) d.createObjectStore("clientes", { keyPath: "id", autoIncrement: true });
      if (!d.objectStoreNames.contains("motos")) d.createObjectStore("motos", { keyPath: "id", autoIncrement: true });
      if (!d.objectStoreNames.contains("citas")) d.createObjectStore("citas", { keyPath: "id", autoIncrement: true });

      const ordenesStore = d.objectStoreNames.contains("ordenes") ? t.objectStore("ordenes") : d.createObjectStore("ordenes", { keyPath: "id", autoIncrement: true });
      if (!ordenesStore.indexNames.contains("by_estado")) ordenesStore.createIndex("by_estado", "estado");

      const invStore = d.objectStoreNames.contains("inventario") ? t.objectStore("inventario") : d.createObjectStore("inventario", { keyPath: "id", autoIncrement: true });
      if (!invStore.indexNames.contains("by_codigo")) invStore.createIndex("by_codigo", "codigoBarras");

      if (!d.objectStoreNames.contains("ventas_rapidas")) {
        const s = d.createObjectStore("ventas_rapidas", { keyPath: "id", autoIncrement: true });
        s.createIndex("by_fecha", "fechaISO");
        s.createIndex("by_cliente", "clienteId");
        s.createIndex("by_metodo", "metodoPago");
      }
      if (!d.objectStoreNames.contains("caja_movimientos")) {
        const s = d.createObjectStore("caja_movimientos", { keyPath: "id", autoIncrement: true });
        s.createIndex("by_fecha", "fechaISO");
        s.createIndex("by_tipo", "tipo");
        s.createIndex("by_categoria", "categoria");
      }
      if (!d.objectStoreNames.contains("creditos")) {
        const s = d.createObjectStore("creditos", { keyPath: "id", autoIncrement: true });
        s.createIndex("by_fecha", "fechaISO");
        s.createIndex("by_cliente", "clienteId");
        s.createIndex("by_estado", "estado");
      }
      if (!d.objectStoreNames.contains("web_cms")) d.createObjectStore("web_cms", { keyPath: "key" });
      if (!d.objectStoreNames.contains("categorias_inv")) {
        const s = d.createObjectStore("categorias_inv", { keyPath: "id", autoIncrement: true });
        s.createIndex("by_nombre", "nombre");
      }

      // Los repuestos/órdenes creados con el esquema viejo (v2) no traen los
      // campos nuevos — se rellenan aquí con valores por defecto dentro de la
      // misma transacción de actualización, así el resto del código nunca se
      // topa con "undefined" en un registro antiguo.
      if (oldV < 3) {
        invStore.openCursor().onsuccess = (ev) => {
          const cur = ev.target.result;
          if (!cur) return;
          const v = cur.value;
          if (v.costoCompra === undefined) v.costoCompra = 0;
          if (v.precioVenta === undefined) v.precioVenta = v.precio || 0;
          if (v.stockMinimo === undefined) v.stockMinimo = 3;
          if (v.codigoBarras === undefined) v.codigoBarras = "";
          if (v.publicarEnWeb === undefined) v.publicarEnWeb = false;
          if (v.categoriaId === undefined) v.categoriaId = null;
          cur.update(v);
          cur.continue();
        };
        ordenesStore.openCursor().onsuccess = (ev) => {
          const cur = ev.target.result;
          if (!cur) return;
          const v = cur.value;
          if (v.metodoPago === undefined) v.metodoPago = null;
          if (v.margen === undefined) v.margen = null;
          cur.update(v);
          cur.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode = "readonly") { return db.transaction(store, mode).objectStore(store); }

/* ---------------- adaptador de datos ----------------
   Las 9 secciones del sistema piden y guardan todo a través de DB.*, nunca
   tocan IndexedDB directo. El día que se conecte una base de datos real
   (Supabase), solo hay que reescribir estos 5 métodos — el resto de la app
   no cambia ni una línea.
   Las transacciones atómicas de varias tablas a la vez (venta rápida, cierre
   de caja) siguen usando db.transaction([...]) directo donde ya estaban:
   pasarlas por aquí una fila a la vez les haría perder la atomicidad. */
const DB = {
  getAll(store) {
    return new Promise((resolve, reject) => {
      const out = [];
      const req = tx(store).openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { out.push(cur.value); cur.continue(); } else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  },
  get(store, id) {
    return new Promise((resolve, reject) => {
      const req = tx(store).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  save(store, value) {
    return new Promise((resolve, reject) => {
      const req = tx(store, "readwrite").put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  delete(store, id) {
    return new Promise((resolve, reject) => {
      const req = tx(store, "readwrite").delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  clear(store) {
    return new Promise((resolve, reject) => {
      const req = tx(store, "readwrite").clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
};
const ALL_STORES = ["clientes", "motos", "ordenes", "inventario", "citas", "ventas_rapidas", "caja_movimientos", "creditos", "web_cms", "categorias_inv"];
async function updateOrder(id, mutator) {
  const o = await DB.get("ordenes", id);
  mutator(o);
  await DB.save("ordenes", o);
  markDirty();
  return o;
}
function setStage(ord, key) {
  ord.estado = key;
  if (key === "entregado") {
    if (!ord.entregadoEn) ord.entregadoEn = Date.now();
    if (ord.garantiaDias === undefined) ord.garantiaDias = 30;
  }
}

// mensajes de progreso por WhatsApp — uno por etapa, se envían desde el detalle
// de la orden con el botón "📲 Progreso por WhatsApp".
const PROGRESO_MENSAJES = {
  recibido: (m) => `hemos recibido tu ${m} en el taller. Pronto comenzamos el diagnóstico.`,
  diagnostico: (m) => `estamos revisando tu ${m} para diagnosticar la falla.`,
  presupuesto: (m) => `ya tenemos el presupuesto de tu ${m} listo.`,
  reparacion: (m) => `tu ${m} ya está en reparación.`,
  calidad: (m) => `tu ${m} está en control de calidad final, ya casi lista.`,
  entregado: (m) => `¡tu ${m} está lista! Ya puedes pasar a recogerla.`,
};

/* ---------------- venta rápida (TPV): transacción atómica multi-store ----------------
   IndexedDB ya garantiza atomicidad dentro de una misma transacción: si cualquier
   request falla, el navegador aborta TODA la transacción automáticamente (no hay
   que revertir nada a mano) y t.onerror/t.onabort se disparan en vez de t.oncomplete. */
function registrarVentaRapida({ items, clienteId, clienteNombre, metodoPago, efectivoRecibido }) {
  return new Promise((resolve, reject) => {
    if (!items || !items.length) { reject(new Error("El carrito está vacío")); return; }

    const t = db.transaction(["ventas_rapidas", "inventario", "caja_movimientos"], "readwrite");
    const ventasStore = t.objectStore("ventas_rapidas");
    const invStore = t.objectStore("inventario");
    const cajaStore = t.objectStore("caja_movimientos");

    const total = items.reduce((s, it) => s + it.cantidad * it.precio, 0);
    const fechaISO = new Date().toISOString();
    let ventaId = null;

    const venta = {
      items, clienteId: clienteId || null, clienteNombre: clienteNombre || null, metodoPago, total,
      efectivoRecibido: metodoPago === "efectivo" ? Number(efectivoRecibido) || 0 : null,
      cambio: metodoPago === "efectivo" ? Math.max(0, (Number(efectivoRecibido) || 0) - total) : 0,
      fechaISO, creadoEn: Date.now(), mecanico: currentUser?.nombre || "",
    };

    const ventaReq = ventasStore.add(venta);
    ventaReq.onsuccess = () => {
      ventaId = ventaReq.result;
      cajaStore.add({
        tipo: "ingreso", categoria: "Venta mostrador", monto: total, metodoPago,
        descripcion: `Venta rápida #${ventaId}`, ventaId, fechaISO, creadoEn: Date.now(),
      });
    };

    items.forEach((it) => {
      if (!it.inventarioId) return; // ítem manual (mano de obra suelta, etc.) sin control de stock
      const getReq = invStore.get(it.inventarioId);
      getReq.onsuccess = () => {
        const rep = getReq.result;
        if (rep) { rep.cantidad = Math.max(0, rep.cantidad - it.cantidad); invStore.put(rep); }
      };
    });

    t.oncomplete = () => resolve({ id: ventaId, total, venta });
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* ---------------- créditos: clientes que se llevan repuestos/servicios a crédito ----------------
   Se descuenta el inventario igual que una venta (el repuesto sí sale del
   estante), pero NO se registra ingreso en caja_movimientos todavía — el
   dinero no ha entrado. Ese ingreso se crea después, cuando el cliente abona
   (ver registrarAbonoCredito), y es lo que hace que los créditos se vean
   reflejados en Finanzas y caja. */
function registrarCredito({ clienteId, clienteNombre, clienteTelefono, items, vencimiento, nota }) {
  return new Promise((resolve, reject) => {
    if (!items || !items.length) { reject(new Error("Agrega al menos un repuesto o servicio")); return; }

    const t = db.transaction(["creditos", "inventario"], "readwrite");
    const credStore = t.objectStore("creditos");
    const invStore = t.objectStore("inventario");

    const total = items.reduce((s, it) => s + it.cantidad * it.precio, 0);
    const fechaISO = new Date().toISOString();
    let credId = null;

    const credito = {
      clienteId: clienteId || null, clienteNombre, clienteTelefono: clienteTelefono || "",
      items, total, abonado: 0, saldo: total, estado: "pendiente",
      vencimiento: vencimiento || null, nota: nota || "",
      historialAbonos: [], fechaISO, creadoEn: Date.now(), mecanico: currentUser?.nombre || "",
    };
    const credReq = credStore.add(credito);
    credReq.onsuccess = () => { credId = credReq.result; };

    items.forEach((it) => {
      if (!it.inventarioId) return;
      const getReq = invStore.get(it.inventarioId);
      getReq.onsuccess = () => {
        const rep = getReq.result;
        if (rep) { rep.cantidad = Math.max(0, rep.cantidad - it.cantidad); invStore.put(rep); }
      };
    });

    t.oncomplete = () => resolve({ id: credId, credito });
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function registrarAbonoCredito(creditoId, monto, metodoPago) {
  const cred = await DB.get("creditos", creditoId);
  if (!cred) throw new Error("Crédito no encontrado");
  const abonado = cred.abonado + monto;
  const saldo = Math.max(0, cred.total - abonado);
  cred.abonado = abonado;
  cred.saldo = saldo;
  cred.estado = saldo <= 0 ? "pagado" : "parcial";
  cred.historialAbonos = (cred.historialAbonos || []).concat([{ monto, metodoPago, fechaISO: new Date().toISOString() }]);
  await DB.save("creditos", cred);
  await DB.save("caja_movimientos", {
    tipo: "ingreso", categoria: "Cobro de crédito", monto, metodoPago,
    descripcion: `Abono crédito #${creditoId} — ${cred.clienteNombre}`, creditoId,
    fechaISO: new Date().toISOString(), creadoEn: Date.now(),
  });
  markDirty();
  return cred;
}

// solo se puede eliminar un crédito que todavía no tiene abonos — si ya
// recibió pagos, borrarlo dejaría ese dinero sin respaldo en la factura.
async function eliminarCredito(id) {
  const cred = await DB.get("creditos", id);
  if (!cred) return;
  if (cred.abonado > 0) { toast("No se puede eliminar un crédito que ya tiene abonos registrados", "off"); return; }

  const t = db.transaction(["creditos", "inventario"], "readwrite");
  const invStore = t.objectStore("inventario");
  cred.items.forEach((it) => {
    if (!it.inventarioId) return;
    const getReq = invStore.get(it.inventarioId);
    getReq.onsuccess = () => {
      const rep = getReq.result;
      if (rep) { rep.cantidad += it.cantidad; invStore.put(rep); }
    };
  });
  t.objectStore("creditos").delete(id);
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  markDirty();
}

/* Un crédito necesita saber a quién cobrarle. Si se eligió un cliente de la
   lista usamos ese; si solo se escribió un nombre suelto, reutilizamos el
   cliente que ya exista con ese mismo nombre y solo creamos uno nuevo si de
   verdad no está — así cobrar al crédito desde el TPV no llena la lista de
   clientes repetidos. */
async function resolverClienteCredito(clienteId, nombreLibre) {
  if (clienteId) {
    const c = await DB.get("clientes", clienteId);
    return { clienteId, clienteNombre: c?.nombre || nombreLibre || "Cliente", clienteTelefono: c?.telefono || "" };
  }
  const nombre = (nombreLibre || "").trim();
  if (!nombre) return null;
  const clientes = await DB.getAll("clientes");
  const existente = clientes.find(c => (c.nombre || "").trim().toLowerCase() === nombre.toLowerCase());
  if (existente) return { clienteId: existente.id, clienteNombre: existente.nombre, clienteTelefono: existente.telefono || "" };
  const nuevoId = await DB.save("clientes", { nombre, telefono: "" });
  markDirty();
  return { clienteId: nuevoId, clienteNombre: nombre, clienteTelefono: "" };
}

/* Cobrar al crédito desde cualquier parte del sistema (TPV, servicio suelto,
   orden de taller entregada): crea la factura pendiente y, si el cliente dejó
   algo de entrada, registra ese abono de una vez — que es lo que hace que el
   dinero recibido sí entre a caja y el saldo quede en lo que falta. */
async function cobrarAlCredito({ clienteId, clienteNombre, clienteTelefono, items, abono, abonoMetodo, nota, origen, ordenId }) {
  const { id, credito } = await registrarCredito({ clienteId, clienteNombre, clienteTelefono, items, vencimiento: null, nota });
  if (origen || ordenId) {
    const cred = await DB.get("creditos", id);
    if (origen) cred.origen = origen;
    if (ordenId) cred.ordenId = ordenId;
    await DB.save("creditos", cred);
  }
  let credFinal = credito;
  if (abono > 0) credFinal = await registrarAbonoCredito(id, abono, abonoMetodo || "efectivo");
  markDirty();
  return { id, credito: await DB.get("creditos", id) };
}

/* ---------------- caja chica: registrar un ingreso de una orden de taller entregada ---------------- */
function registrarIngresoTaller(orden, total, metodoPago) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(["caja_movimientos"], "readwrite");
    t.objectStore("caja_movimientos").add({
      tipo: "ingreso", categoria: "Servicio taller", monto: total, metodoPago: metodoPago || "efectivo",
      descripcion: `Orden de taller #${orden.id}`, ordenId: orden.id,
      fechaISO: new Date().toISOString(), creadoEn: Date.now(),
    });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ---------------- estado de sincronización (simulado) ---------------- */
let pending = 0;
let forcedOffline = false;
function isOnline() { return !forcedOffline && navigator.onLine; }
function markDirty() {
  pending++;
  renderSyncChip();
  if (isOnline()) setTimeout(() => { pending = Math.max(0, pending - 1); renderSyncChip(); }, 900);
}
function renderSyncChip() {
  const dot = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  if (!isOnline()) {
    dot.className = "dot off";
    label.textContent = pending > 0
      ? `Sin conexión · ${pending} cambio${pending === 1 ? "" : "s"} pendiente${pending === 1 ? "" : "s"}`
      : "Sin conexión · guardado en este dispositivo";
  } else if (pending > 0) {
    dot.className = "dot off";
    label.textContent = `Sincronizando ${pending}…`;
  } else {
    dot.className = "dot on";
    label.textContent = "En línea · sincronizado";
  }
}

/* ---------------- botones que cobran/registran: bloquea doble-tap ----------------
   en un taller usando esto en pantalla táctil, un toque doble accidental en
   "Cobrar" o "Registrar" disparaba la acción varias veces (venta duplicada +
   inventario descontado de más, o un movimiento de caja repetido) porque nada
   deshabilitaba el botón mientras la primera se procesaba. */
function alHacerClicUnaVez(btn, handler) {
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await handler();
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- toasts ---------------- */
function toast(msg, kind = "on") {
  const wrap = document.getElementById("toastWrap");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="dot ${kind}"></span>${msg}`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

/* ---- confirmación con código de administrador para acciones que no se pueden deshacer ---- */
let adminCodeCallback = null;
function requestAdminCode(onConfirm) {
  adminCodeCallback = onConfirm;
  document.getElementById("adminCodeInput").value = "";
  document.getElementById("adminCodeError").textContent = "";
  document.getElementById("modalAdminCode").classList.add("active");
  document.getElementById("adminCodeInput").focus();
}
document.getElementById("btnCancelarAdminCode").addEventListener("click", () => {
  document.getElementById("modalAdminCode").classList.remove("active");
  adminCodeCallback = null;
});
document.getElementById("btnConfirmarAdminCode").addEventListener("click", async () => {
  const code = document.getElementById("adminCodeInput").value.trim();
  if (code !== ADMIN_CODE) {
    document.getElementById("adminCodeError").textContent = "Código incorrecto.";
    return;
  }
  document.getElementById("modalAdminCode").classList.remove("active");
  const cb = adminCodeCallback;
  adminCodeCallback = null;
  if (cb) await cb();
});

/* ================= modales genéricos (reemplazan confirm()/prompt() nativos) ================= */
function showConfirm(mensaje, { titulo = "Confirmar", textoOk = "Aceptar", textoCancelar = "Cancelar" } = {}) {
  return new Promise((resolve) => {
    document.getElementById("confirmTitulo").textContent = titulo;
    document.getElementById("confirmMensaje").textContent = mensaje;
    const modal = document.getElementById("modalConfirm");
    const btnOk = document.getElementById("btnConfirmAceptar");
    const btnCancel = document.getElementById("btnConfirmCancelar");
    btnOk.textContent = textoOk;
    btnCancel.textContent = textoCancelar;
    const cleanup = (result) => {
      modal.classList.remove("active");
      btnOk.removeEventListener("click", onOk);
      btnCancel.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    btnOk.addEventListener("click", onOk);
    btnCancel.addEventListener("click", onCancel);
    modal.classList.add("active");
  });
}

function showPrompt(mensaje, { titulo = "Ingresa un valor", valorInicial = "" } = {}) {
  return new Promise((resolve) => {
    document.getElementById("promptTitulo").textContent = titulo;
    document.getElementById("promptLabel").textContent = mensaje;
    const input = document.getElementById("promptInput");
    input.value = valorInicial;
    const modal = document.getElementById("modalPrompt");
    const btnOk = document.getElementById("btnPromptAceptar");
    const btnCancel = document.getElementById("btnPromptCancelar");
    const cleanup = (result) => {
      modal.classList.remove("active");
      btnOk.removeEventListener("click", onOk);
      btnCancel.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKeydown);
      resolve(result);
    };
    const onOk = () => cleanup(input.value.trim() || null);
    const onCancel = () => cleanup(null);
    const onKeydown = (e) => { if (e.key === "Enter") onOk(); };
    btnOk.addEventListener("click", onOk);
    btnCancel.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKeydown);
    modal.classList.add("active");
    setTimeout(() => input.focus(), 50);
  });
}

/* ================= GATE 1: instalación como PWA ================= */
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function devBypassed() { return sessionStorage.getItem("enti_dev_bypass") === "1"; }

/* ---------------- impresión ----------------
   En iOS, una app instalada en la pantalla de inicio corre en modo
   "standalone", y ahí Safari IGNORA window.print(): al tocar imprimir no pasa
   absolutamente nada. Como este sistema solo arranca instalado, en el iPhone
   ningún botón de imprimir funcionaba.

   La salida es sacar el documento de la app: se abre una pestaña de Safari con
   la factura ya armada, y desde ahí el botón Compartir del navegador sí ofrece
   "Imprimir" y "Guardar en Archivos" (PDF). En una computadora no hace falta
   nada de esto, así que se sigue imprimiendo directo como siempre. */
function necesitaVentanaDeImpresion() {
  return isStandalone();
}

// debe llamarse SINCRÓNICAMENTE dentro del clic: si se abre después de un
// await, el navegador la bloquea por "gesto vencido" (igual que con WhatsApp).
function abrirVentanaImpresion() {
  return necesitaVentanaDeImpresion() ? window.open("", "_blank") : null;
}

const CSS_IMPRESION = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #f2f0ed; color: #1a1613;
         font-family: -apple-system, "Segoe UI", system-ui, sans-serif; font-size: 14px; line-height: 1.55;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  /* la hoja: en pantalla se ve como un papel centrado, al imprimir ocupa todo */
  .doc { position: relative; width: 100%; max-width: 190mm; margin: 1.2rem auto; padding: 16mm 14mm;
         background: #fff; box-shadow: 0 10px 40px -12px rgba(0,0,0,0.25); overflow: hidden; }

  /* Marca de agua: va como <img> real y no como fondo CSS, porque los
     navegadores no imprimen fondos a menos que la persona marque "gráficos de
     fondo" a mano — una imagen normal sí sale siempre. */
  .marca-agua { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: 62%; max-width: 340px; opacity: 0.07; pointer-events: none; z-index: 0; }
  .doc > *:not(.marca-agua) { position: relative; z-index: 1; }
  /* las plantillas del HTML traen su propia marca de agua pensada para el
     @media print de la app; aquí sobra, porque ya ponemos la nuestra */
  .factura-watermark, .print-watermark { display: none !important; }

  .factura-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;
                    border-bottom: 3px solid #1a1613; padding-bottom: 0.9rem; margin-bottom: 1.4rem; }
  .factura-marca { display: flex; align-items: center; gap: 0.7rem; }
  .factura-logo { width: 46px; height: 46px; border-radius: 0.5rem; object-fit: cover; }
  .factura-header .marca { font-weight: 800; font-size: 1.7rem; letter-spacing: 0.01em;
                           text-transform: uppercase; line-height: 1; }
  .factura-meta { text-align: right; font-size: 0.85rem; color: #5c5349; white-space: nowrap; }
  .factura-meta div:first-child { font-weight: 700; color: #1a1613; font-size: 0.95rem; }

  /* datos del cliente / moto en fichas claras */
  .factura-block { background: #f7f5f2; border-left: 3px solid #e11d48; border-radius: 0 0.4rem 0.4rem 0;
                   padding: 0.6rem 0.8rem; margin-bottom: 0.7rem; font-size: 0.9rem; }
  .factura-block b { display: block; font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase;
                     color: #8a8078; margin-bottom: 0.15rem; font-weight: 700; }

  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; margin-top: 1.2rem; }
  th { text-align: left; font-size: 0.66rem; letter-spacing: 0.09em; text-transform: uppercase;
       color: #fff; background: #1a1613; font-weight: 700; padding: 0.55rem 0.7rem; }
  td { padding: 0.6rem 0.7rem; border-bottom: 1px solid #e6e2dd; }
  tbody tr:nth-child(even) td { background: #faf9f7; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }

  .factura-total { text-align: right; font-size: 1rem; margin-top: 0.45rem; color: #5c5349; }
  .factura-total span { display: inline-block; min-width: 7rem; font-weight: 700; color: #1a1613;
                        font-variant-numeric: tabular-nums; }
  .factura-total:first-of-type { border-top: 2px solid #1a1613; padding-top: 0.7rem; margin-top: 1rem;
                                 font-size: 1.15rem; }

  .edc-factura { margin-bottom: 1.4rem; break-inside: avoid; page-break-inside: avoid; }
  .edc-factura-head { font-size: 0.92rem; font-weight: 700; margin-bottom: 0.2rem;
                      border-bottom: 2px solid #1a1613; padding-bottom: 0.25rem; }
  .edc-factura-tot { text-align: right; font-size: 0.85rem; margin-top: 0.35rem; color: #5c5349; }
  .ticket-item-row { display: flex; justify-content: space-between; gap: 4px; }
  hr { border: none; border-top: 1px dashed #1a1613; margin: 5px 0; }

  /* barra de acción: solo en pantalla, nunca en el papel ni en el PDF */
  .barra-imprimir { position: sticky; top: 0; z-index: 9; display: flex; gap: 0.6rem; align-items: center;
                    flex-wrap: wrap; background: #1a1613; color: #fff; padding: 0.75rem 1rem;
                    font-family: -apple-system, system-ui, sans-serif; font-size: 0.82rem; }
  .barra-imprimir button { font: inherit; font-weight: 700; border: none; border-radius: 0.5rem;
                           padding: 0.6rem 1.1rem; background: #e11d48; color: #fff; cursor: pointer; }
  .barra-imprimir .ayuda { opacity: 0.75; }
  @media print {
    body { background: #fff; }
    .barra-imprimir { display: none !important; }
    .doc { max-width: none; margin: 0; padding: 0; box-shadow: none; }
  }
`;

const CSS_TICKET = `
  body { background: #fff; }
  .doc { width: 62mm; max-width: 62mm; margin: 0; padding: 3mm;
         font-family: "Courier New", monospace; font-size: 11px; line-height: 1.45; box-shadow: none; }
  .doc .marca-agua { width: 40%; opacity: 0.08; }
  @media print { .doc { width: 58mm; max-width: 58mm; padding: 2mm; } }
`;

/* Arma el documento completo, autocontenido: sus propios estilos, la marca de
   agua y un <base> para que las rutas relativas de los logos no salgan rotas. */
function armarDocumentoImpresion(idPlantilla) {
  const contenido = document.getElementById(idPlantilla).innerHTML;
  const esTicket = idPlantilla === "ticketPrint";
  const base = location.href.replace(/[^/]*$/, "");
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${base}">
<title>ENTIMOTORS</title>
<style>${CSS_IMPRESION}${esTicket ? CSS_TICKET : ""}</style>
</head><body>
<div class="barra-imprimir">
  <button type="button" onclick="window.print()">🖨️ Imprimir o guardar PDF</button>
  <span class="ayuda">o usa el botón Compartir del navegador</span>
</div>
<div class="doc">
  <img class="marca-agua" src="icons/logo-watermark-doc.png" alt="">
  ${contenido}
</div>
</body></html>`;
}

/* Le pasa el documento al service worker para que lo publique en una dirección
   real. Sin dirección real (about:blank) el iPhone no ofrece ni Imprimir ni
   Guardar en Archivos, que era justo el problema. */
function publicarDocumentoEnSW(html) {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return Promise.reject(new Error("sin service worker"));
  return new Promise((resolve, reject) => {
    const alResponder = (e) => {
      if (e.data?.tipo === "impresion-lista") { limpiar(); resolve(); }
      else if (e.data?.tipo === "impresion-fallo") { limpiar(); reject(new Error("no se pudo guardar")); }
    };
    const limpiar = () => {
      clearTimeout(temporizador);
      navigator.serviceWorker.removeEventListener("message", alResponder);
    };
    const temporizador = setTimeout(() => { limpiar(); reject(new Error("sin respuesta")); }, 3000);
    navigator.serviceWorker.addEventListener("message", alResponder);
    sw.postMessage({ tipo: "guardar-impresion", html });
  });
}

function imprimirPlantilla(idPlantilla, claseBody, ventana) {
  if (!ventana) {
    if (claseBody) document.body.classList.add(claseBody);
    window.print();
    if (claseBody) setTimeout(() => document.body.classList.remove(claseBody), 300);
    return;
  }

  const html = armarDocumentoImpresion(idPlantilla);
  publicarDocumentoEnSW(html)
    // ?t= evita que el navegador muestre la factura anterior desde su caché
    .then(() => { ventana.location.href = `impresion.html?t=${Date.now()}`; })
    .catch(() => {
      // respaldo si el service worker no está activo: se vuelca el HTML directo
      ventana.document.write(html);
      ventana.document.close();
    });
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

function wireInstallGate() {
  document.getElementById("btnInstallApp").addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
    } else {
      toast("Este navegador no ofrece instalación con un clic aquí — usa el menú ⋮ y busca \"Instalar aplicación\"", "off");
    }
  });
  document.getElementById("devBypassLink").addEventListener("click", (e) => {
    e.preventDefault();
    sessionStorage.setItem("enti_dev_bypass", "1");
    location.reload();
  });
}

/* ================= GATE 2: login ================= */
function readSession() {
  try { return JSON.parse(localStorage.getItem("enti_session") || "null"); } catch { return null; }
}
function wireLoginGate() {
  document.getElementById("loginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const u = document.getElementById("loginUser").value.trim().toLowerCase();
    const p = document.getElementById("loginPass").value;
    const found = TEAM.find(t => t.user === u && t.password === p);
    const errEl = document.getElementById("loginError");
    if (!found) { errEl.textContent = "Usuario o contraseña incorrectos."; return; }
    errEl.textContent = "";
    const session = { user: found.user, nombre: found.nombre, telefono: found.telefono, rol: found.rol };
    localStorage.setItem("enti_session", JSON.stringify(session));
    document.getElementById("gateLogin").classList.remove("active");
    startApp(session);
  });
}
document.getElementById("btnLogout").addEventListener("click", () => {
  localStorage.removeItem("enti_session");
  location.reload();
});

/* ================= modo claro / oscuro ================= */
// el <script> inline en <head> ya aplicó el tema guardado antes de pintar;
// aquí solo hace falta que el botón muestre el estado correcto y lo cambie.
function temaActual() {
  const explicito = document.documentElement.getAttribute("data-theme");
  if (explicito === "light" || explicito === "dark") return explicito;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function actualizarBotonTema() {
  const btn = document.getElementById("btnTema");
  if (!btn) return;
  btn.textContent = temaActual() === "dark" ? "☀️ Modo claro" : "🌙 Modo oscuro";
}
document.getElementById("btnTema").addEventListener("click", () => {
  const nuevo = temaActual() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", nuevo);
  localStorage.setItem("enti_theme", nuevo);
  actualizarBotonTema();
});
actualizarBotonTema();

/* ================= navegación entre vistas ================= */
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
  document.querySelectorAll(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.getElementById("fabHome").classList.toggle("fab-hidden", name === "dashboard");
  closeMobileSidebar();
}

document.getElementById("fabHome").addEventListener("click", () => {
  showView("dashboard");
  renderByView.dashboard();
});

/* ================= menú hamburguesa (mobile/tablet) ================= */
function openMobileSidebar() {
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("sidebarBackdrop").classList.add("open");
}
function closeMobileSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarBackdrop").classList.remove("open");
}
document.getElementById("btnMenuToggle").addEventListener("click", () => {
  document.getElementById("sidebar").classList.contains("open") ? closeMobileSidebar() : openMobileSidebar();
});
document.getElementById("sidebarBackdrop").addEventListener("click", closeMobileSidebar);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMobileSidebar(); });

/* ================= cerrar cualquier modal al tocar fuera de él ================= */
document.querySelectorAll(".modal-bg").forEach(bg => {
  bg.addEventListener("click", (e) => {
    if (e.target !== bg) return;
    const cancelBtn = bg.querySelector(".modal-actions button.ghost");
    if (cancelBtn) cancelBtn.click(); else bg.classList.remove("active");
  });
});

/* ================= buscador global (Ctrl+K) ================= */
function abrirBuscadorGlobal() {
  document.getElementById("modalBuscarGlobal").classList.add("active");
  const input = document.getElementById("buscarGlobalInput");
  input.value = "";
  document.getElementById("buscarGlobalResultados").innerHTML = "";
  setTimeout(() => input.focus(), 50);
}
function cerrarBuscadorGlobal() { document.getElementById("modalBuscarGlobal").classList.remove("active"); }

document.getElementById("btnBuscarGlobal").addEventListener("click", abrirBuscadorGlobal);
document.getElementById("btnCerrarBuscarGlobal").addEventListener("click", cerrarBuscadorGlobal);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); abrirBuscadorGlobal(); }
});

document.getElementById("buscarGlobalInput").addEventListener("input", async (e) => {
  const q = e.target.value.trim().toLowerCase();
  const box = document.getElementById("buscarGlobalResultados");
  if (!q) { box.innerHTML = ""; return; }

  const [clientes, motos, ordenes, inventario] = await Promise.all([DB.getAll("clientes"), DB.getAll("motos"), DB.getAll("ordenes"), DB.getAll("inventario")]);
  const resultados = [];

  clientes.filter(c => c.nombre.toLowerCase().includes(q) || (c.telefono || "").includes(q)).forEach(c => {
    const moto = motos.find(m => m.clienteId === c.id);
    resultados.push({
      ic: "👤", tipo: "Cliente", titulo: c.nombre,
      sub: moto ? `${moto.marca} ${moto.modelo} · ${moto.placa || "sin placa"}` : "sin moto registrada",
      onClick: () => { cerrarBuscadorGlobal(); showView("clientes"); renderClientes(); openClienteDetalle(c.id); },
    });
  });
  motos.filter(m => (m.placa || "").toLowerCase().includes(q) && !(m.clienteId && clientes.find(c => c.id === m.clienteId && c.nombre.toLowerCase().includes(q)))).forEach(m => {
    const cliente = clientes.find(c => c.id === m.clienteId);
    resultados.push({
      ic: "🏍️", tipo: "Moto", titulo: `${m.marca} ${m.modelo} — ${m.placa || "sin placa"}`, sub: cliente?.nombre || "sin cliente asociado",
      onClick: () => { cerrarBuscadorGlobal(); showView("clientes"); renderClientes(); if (cliente) openClienteDetalle(cliente.id); },
    });
  });
  ordenes.filter(o => (o.falla || "").toLowerCase().includes(q)).forEach(o => {
    const cliente = clientes.find(c => c.id === o.clienteId);
    resultados.push({
      ic: "🧾", tipo: "Orden", titulo: `Orden #${o.id} — ${STAGES.find(s => s.key === o.estado)?.label || o.estado}`, sub: cliente?.nombre || "",
      onClick: () => { cerrarBuscadorGlobal(); showView("ordenes"); openOrder(o.id); },
    });
  });
  inventario.filter(r => r.nombre.toLowerCase().includes(q) || (r.codigoBarras || "").toLowerCase().includes(q)).forEach(r => {
    resultados.push({
      ic: "📦", tipo: "Repuesto", titulo: r.nombre, sub: `${r.cantidad} en stock · ${money(r.precio)}`,
      onClick: () => { cerrarBuscadorGlobal(); showView("inventario"); renderInventario(); openRepuestoDetalle(r.id); },
    });
  });

  box.innerHTML = resultados.length
    ? resultados.slice(0, 20).map((r, i) => `
      <div class="search-result-row" data-i="${i}">
        <span class="ic">${r.ic}</span>
        <div class="txt"><b>${esc(r.titulo)}</b><span class="sub">${esc(r.tipo)}${r.sub ? " · " + esc(r.sub) : ""}</span></div>
      </div>`).join("")
    : `<div class="empty" style="padding:1rem 0;">Sin resultados</div>`;
  box.querySelectorAll(".search-result-row").forEach((el, i) => el.addEventListener("click", () => resultados[i].onClick()));
});

/* ================= centro de notificaciones ================= */
async function renderNotificaciones() {
  const [citasAll, motos, inventario] = await Promise.all([DB.getAll("citas"), DB.getAll("motos"), DB.getAll("inventario")]);
  const avisos = [];

  citasAll.filter(c => !citaCerrada(c) && citaWhenInfo(c).diffDays === 0).forEach(c => {
    avisos.push({ ic: "📅", titulo: "Cita hoy", sub: c.motivo || "Sin motivo especificado", onClick: () => { showView("citas"); renderCitasList(); } });
  });
  motos.filter(m => ["due", "soon"].includes(mantStatus(m).cls)).forEach(m => {
    avisos.push({ ic: "🛠️", titulo: `Mantenimiento: ${m.marca} ${m.modelo}`, sub: mantStatus(m).cls === "due" ? "Vencido" : "Por vencer", onClick: () => { showView("clientes"); renderClientes(); } });
  });
  inventario.filter(r => r.cantidad <= (r.stockMinimo ?? 3)).forEach(r => {
    avisos.push({ ic: "📦", titulo: `Stock bajo: ${r.nombre}`, sub: `Quedan ${r.cantidad}`, onClick: () => { showView("inventario"); renderInventario(); } });
  });

  const badge = document.getElementById("notifBadge");
  if (avisos.length) { badge.style.display = "flex"; badge.textContent = avisos.length; } else { badge.style.display = "none"; }

  document.getElementById("notifLista").innerHTML = avisos.length
    ? avisos.map((a, i) => `<div class="notif-row" data-i="${i}"><span class="ic">${a.ic}</span><div class="txt"><b>${esc(a.titulo)}</b><span>${esc(a.sub)}</span></div></div>`).join("")
    : `<div class="notif-row" style="cursor:default;"><div class="txt"><span>Todo al día — sin avisos pendientes.</span></div></div>`;
  document.getElementById("notifLista").querySelectorAll(".notif-row[data-i]").forEach((el, i) => {
    el.addEventListener("click", () => { avisos[i].onClick(); document.getElementById("notifPanel").classList.remove("open"); });
  });
}

document.getElementById("btnNotificaciones").addEventListener("click", async () => {
  const panel = document.getElementById("notifPanel");
  if (panel.classList.contains("open")) { panel.classList.remove("open"); return; }
  await renderNotificaciones();
  panel.classList.add("open");
});
document.addEventListener("click", (e) => {
  const wrap = document.getElementById("notifPanel").closest(".topbar-icon-wrap");
  if (!wrap.contains(e.target)) document.getElementById("notifPanel").classList.remove("open");
});

document.getElementById("btnCuenta")?.addEventListener("click", () => {
  document.getElementById("accountPanel").classList.toggle("open");
});
document.addEventListener("click", (e) => {
  const wrap = document.getElementById("accountWrap");
  if (wrap && !wrap.contains(e.target)) document.getElementById("accountPanel").classList.remove("open");
});
const renderByView = {
  dashboard: () => renderDashboard(),
  ordenes: () => renderOrdersList(),
  citas: () => renderCitasList(),
  clientes: () => renderClientes(),
  inventario: () => renderInventario(),
  pos: () => renderPOS(),
  finanzas: () => renderFinanzas(),
  creditos: () => renderCreditos(),
  "web-cms": () => renderWebCMS(),
  ajustes: () => renderAjustes(),
};
document.querySelectorAll(".nav-item[data-view]").forEach(btn => {
  btn.addEventListener("click", () => {
    showView(btn.dataset.view);
    renderByView[btn.dataset.view]?.();
  });
});

// botones de "acceso rápido" en la página principal: mismos 8 destinos que el
// menú hamburguesa, mismo despacho de render.
document.querySelectorAll(".qa-btn[data-view]").forEach(btn => {
  btn.addEventListener("click", () => {
    showView(btn.dataset.view);
    renderByView[btn.dataset.view]?.();
  });
});

/* ================= widgets compartidos (mini-tarjetas clicables) ================= */
function sameMonth(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
function countMantenimientos(motos) { return motos.filter(m => ["due", "soon"].includes(mantStatus(m).cls)).length; }

// items: { ic, val, lbl, active?, goto? (navega a otra vista) | onClick? (ej. aplicar un filtro en la misma vista) }
function renderWidgetRow(containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.map((m, i) => `
    <button type="button" class="widget-mini ${m.active ? "active" : ""}" data-i="${i}"><span class="ic">${m.ic}</span><span class="val">${m.val}</span><span class="lbl">${esc(m.lbl)}</span></button>
  `).join("");
  el.querySelectorAll(".widget-mini").forEach((btn, i) => {
    const item = items[i];
    if (item.goto) {
      btn.addEventListener("click", () => {
        showView(item.goto);
        document.querySelectorAll(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === item.goto));
        renderByView[item.goto]?.();
      });
    } else if (item.onClick) {
      btn.addEventListener("click", item.onClick);
    }
  });
}

/* ================= DASHBOARD ================= */
async function renderDashboard() {
  const [ordenes, motos, clientes, inventario, citas] = await Promise.all([
    DB.getAll("ordenes"), DB.getAll("motos"), DB.getAll("clientes"), DB.getAll("inventario"), DB.getAll("citas"),
  ]);

  const activas = ordenes.filter(o => o.estado !== "entregado").length;
  const hoyStr = new Date().toISOString().slice(0, 10);
  const citasHoy = citas.filter(c => c.fecha === hoyStr && !citaCerrada(c)).length;
  const mantenimientos = countMantenimientos(motos);
  const repuestosBajos = inventario.filter(r => r.cantidad <= 3).length;

  const now = new Date();
  const ingresosMes = ordenes
    .filter(o => o.estado === "entregado" && o.entregadoEn && sameMonth(new Date(o.entregadoEn), now))
    .reduce((s, o) => s + (o.items || []).reduce((ss, it) => ss + it.cantidad * it.precio, 0), 0);

  renderWidgetRow("widgetRow", [
    { ic: "🧾", val: activas, lbl: "Órdenes activas", goto: "ordenes" },
    { ic: "📅", val: citasHoy, lbl: "Citas hoy", goto: "citas" },
    { ic: "🛠️", val: mantenimientos, lbl: "Mantenimientos", goto: "clientes" },
    { ic: "📦", val: repuestosBajos, lbl: "Stock bajo", goto: "inventario" },
    { ic: "👥", val: clientes.length, lbl: "Clientes", goto: "clientes" },
  ]);

  const stageColor = { recibido: "var(--text-faint)", diagnostico: "var(--amber)", presupuesto: "var(--amber)", reparacion: "var(--red)", calidad: "var(--red)", entregado: "var(--green)" };
  const porEtapa = STAGES.map(s => ({ ...s, count: ordenes.filter(o => o.estado === s.key).length }));
  const totalOrdenes = ordenes.length || 1;

  document.getElementById("widgetGrid").innerHTML = `
    <div class="widget-card tint-green">
      <span class="eyebrow">Ingresos del mes</span>
      <span class="big">${money(ingresosMes)}</span>
      <span class="sub">De órdenes entregadas en ${esc(now.toLocaleDateString("es-HN", { month: "long" }))}</span>
    </div>
    <button type="button" class="widget-card ${mantenimientos > 0 ? "tint-amber" : ""}" id="cardMantenimientos" style="text-align:left; font-family:inherit; cursor:pointer;">
      <span class="eyebrow">Mantenimientos</span>
      <span class="big">${mantenimientos}</span>
      <span class="sub">Vencidos o por vencer en 7 días</span>
    </button>
    <div class="widget-card span-2">
      <span class="eyebrow" style="color:var(--text-faint);">Órdenes por etapa</span>
      <div class="seg-bar">${porEtapa.map(s => `<span title="${esc(s.label)}: ${s.count}" style="width:${(s.count / totalOrdenes) * 100}%; background:${stageColor[s.key]};"></span>`).join("")}</div>
      <div class="seg-legend">${porEtapa.map(s => `<span><span class="dot" style="background:${stageColor[s.key]}"></span>${esc(s.label)} <b>${s.count}</b></span>`).join("")}</div>
    </div>
  `;
  document.getElementById("cardMantenimientos").addEventListener("click", () => {
    showView("clientes");
    document.querySelectorAll(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === "clientes"));
  });

  // Estadísticas del sitio web: no hay analítica real conectada todavía
  // (ni Google Analytics ni una tabla de visitas en el backend), así que
  // esto son números de ejemplo fijos, solo para mostrar cómo se vería.
  const webStats = { hoy: 47, mes: 1284, top: "Catálogo", topPct: 38, semana: [12, 18, 15, 22, 19, 25, 31] };
  const maxV = Math.max(...webStats.semana);
  document.getElementById("webWidgetGrid").innerHTML = `
    <div class="widget-card">
      <span class="eyebrow" style="color:var(--text-faint);">Visitas hoy</span>
      <span class="big">${webStats.hoy}</span>
      <span class="sub">Dato de ejemplo</span>
    </div>
    <div class="widget-card">
      <span class="eyebrow" style="color:var(--text-faint);">Visitas este mes</span>
      <span class="big">${webStats.mes.toLocaleString("es-HN")}</span>
      <span class="sub">Página más vista: ${esc(webStats.top)} (${webStats.topPct}%)</span>
    </div>
    <div class="widget-card span-2">
      <span class="eyebrow" style="color:var(--text-faint);">Últimos 7 días</span>
      <div class="sparkline">${webStats.semana.map((v, i) => `<span class="bar ${i === webStats.semana.length - 1 ? "now" : ""}" style="height:${Math.max((v / maxV) * 100, 6)}%" title="Día ${i + 1}: ${v} visitas"></span>`).join("")}</div>
      <span class="sub">Hoy: ${webStats.semana[webStats.semana.length - 1]} visitas (ejemplo)</span>
    </div>
  `;
}

/* ---------------- gráficos del dashboard (Chart.js) ---------------- */
let chartInstances = {};
function chartColors() {
  const dark = !document.documentElement.classList.contains("light") && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return { grid: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)", text: dark ? "#a8a8a8" : "#555" };
}

async function renderFinanzasCharts() {
  if (typeof Chart === "undefined") return; // sin internet la primera vez, la librería no llegó a cargar

  const [movs, ventas, ordenes, inv, creditos] = await Promise.all([DB.getAll("caja_movimientos"), DB.getAll("ventas_rapidas"), DB.getAll("ordenes"), DB.getAll("inventario"), DB.getAll("creditos")]);
  const { grid, text } = chartColors();
  Chart.defaults.color = text;
  Chart.defaults.borderColor = grid;

  document.getElementById("finanzasChartsFlag").style.display = (movs.length || ventas.length) ? "none" : "block";

  // 1) Ingresos vs Gastos, últimos 7 días
  const dias = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return d.toISOString().slice(0, 10); });
  const ingresosPorDia = dias.map(d => movs.filter(m => m.tipo === "ingreso" && m.fechaISO.slice(0, 10) === d).reduce((s, m) => s + m.monto, 0));
  const gastosPorDia = dias.map(d => movs.filter(m => m.tipo === "egreso" && m.fechaISO.slice(0, 10) === d).reduce((s, m) => s + m.monto, 0));

  chartInstances.ingresosGastos?.destroy();
  chartInstances.ingresosGastos = new Chart(document.getElementById("chartIngresosGastos"), {
    type: "line",
    data: {
      labels: dias.map(d => new Date(d + "T00:00").toLocaleDateString("es-HN", { day: "2-digit", month: "2-digit" })),
      datasets: [
        { label: "Ingresos", data: ingresosPorDia, borderColor: "#34d399", backgroundColor: "rgba(52,211,153,0.15)", tension: 0.3, fill: true },
        { label: "Gastos", data: gastosPorDia, borderColor: "#ef4444", backgroundColor: "rgba(239,68,68,0.15)", tension: 0.3, fill: true },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { display: false } }, y: { grid: { color: grid }, beginAtZero: true } } },
  });

  // 2) Ganancias por línea de negocio: taller (órdenes de servicio) vs venta de
  // repuestos vs trabajo rápido — se calcula directo de las órdenes/ventas/créditos
  // (no de caja_movimientos) para poder separar cada ítem por su origen, algo que
  // el registro de caja ya no distingue una vez que el dinero entra como un solo monto.
  const totalTaller = ordenes
    .filter(o => o.estado === "entregado")
    .reduce((s, o) => s + (o.items || []).reduce((ss, it) => ss + it.cantidad * it.precio, 0), 0);
  let totalRepuestos = 0, totalTrabajoRapido = 0;
  // los créditos que nacen de una orden de taller ya están contados arriba en
  // "Taller" — incluirlos aquí otra vez inflaría las ganancias al doble.
  const creditosNoTaller = creditos.filter(c => c.origen !== "orden");
  [...ventas, ...creditosNoTaller].forEach(v => (v.items || []).forEach(it => {
    const sub = it.cantidad * it.precio;
    if (it.inventarioId) totalRepuestos += sub; else totalTrabajoRapido += sub;
  }));
  chartInstances.origenIngresos?.destroy();
  chartInstances.origenIngresos = new Chart(document.getElementById("chartOrigenIngresos"), {
    type: "doughnut",
    data: {
      labels: [`Taller (${money(totalTaller)})`, `Venta de repuestos (${money(totalRepuestos)})`, `Trabajo rápido (${money(totalTrabajoRapido)})`],
      datasets: [{ data: [totalTaller, totalRepuestos, totalTrabajoRapido], backgroundColor: ["#ef4444", "#f5a524", "#34d399"] }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } } },
  });

  // 3) Top 5 repuestos con mayor rotación (unidades vendidas por TPV)
  const rotacion = {};
  // los repuestos vendidos al crédito también salieron del estante, así que
  // cuentan igual que los de contado para medir rotación
  [...ventas, ...creditos].forEach(v => (v.items || []).forEach(it => {
    if (!it.inventarioId) return;
    rotacion[it.inventarioId] = (rotacion[it.inventarioId] || 0) + it.cantidad;
  }));
  const top5 = Object.entries(rotacion)
    .map(([id, cant]) => ({ nombre: inv.find(r => r.id === Number(id))?.nombre || `#${id}`, cant }))
    .sort((a, b) => b.cant - a.cant).slice(0, 5);

  chartInstances.topRepuestos?.destroy();
  chartInstances.topRepuestos = new Chart(document.getElementById("chartTopRepuestos"), {
    type: "bar",
    data: { labels: top5.map(x => x.nombre), datasets: [{ label: "Unidades vendidas", data: top5.map(x => x.cant), backgroundColor: "#ef4444" }] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, grid: { color: grid } }, y: { grid: { display: false } } } },
  });
}

/* ================= ÓRDENES ================= */
let ordenesFiltro = null; // null (todas) | "activas" | "entregadas"

async function renderOrdersList() {
  const [ordenesAll, motos, clientes] = await Promise.all([DB.getAll("ordenes"), DB.getAll("motos"), DB.getAll("clientes")]);

  const entregadasMes = ordenesAll.filter(o => o.estado === "entregado" && o.entregadoEn && sameMonth(new Date(o.entregadoEn), new Date()));
  const activas = ordenesAll.filter(o => o.estado !== "entregado");

  renderWidgetRow("ordenesWidgetRow", [
    { ic: "🧾", val: activas.length, lbl: "Activas", active: ordenesFiltro === "activas", onClick: () => { ordenesFiltro = ordenesFiltro === "activas" ? null : "activas"; renderOrdersList(); } },
    { ic: "✅", val: entregadasMes.length, lbl: "Entregadas este mes", active: ordenesFiltro === "entregadas", onClick: () => { ordenesFiltro = ordenesFiltro === "entregadas" ? null : "entregadas"; renderOrdersList(); } },
    { ic: "📋", val: ordenesAll.length, lbl: "Total", active: ordenesFiltro === null, onClick: () => { ordenesFiltro = null; renderOrdersList(); } },
  ]);

  let ordenes = ordenesAll;
  if (ordenesFiltro === "activas") ordenes = activas;
  else if (ordenesFiltro === "entregadas") ordenes = entregadasMes;

  const list = document.getElementById("ordersList");
  if (!ordenes.length) {
    list.innerHTML = ordenesAll.length
      ? `<div class="empty">Ninguna orden coincide con este filtro.</div>`
      : `<div class="empty">Todavía no hay órdenes.<br><button class="btn primary small" id="btnEmptyNuevaOrden" style="margin-top:0.8rem;">+ Crear la primera</button></div>`;
    document.getElementById("btnEmptyNuevaOrden")?.addEventListener("click", () => document.getElementById("btnNuevaOrden").click());
    return;
  }
  ordenes = [...ordenes].sort((a, b) => b.id - a.id);
  list.innerHTML = ordenes.map(o => {
    const moto = motos.find(m => m.id === o.motoId);
    const cliente = clientes.find(c => c.id === o.clienteId);
    const total = (o.items || []).reduce((s, it) => s + it.cantidad * it.precio, 0);
    const foto = (o.fotos || [])[0];
    return `
      <div class="order-row" data-id="${o.id}">
        ${foto ? `<img class="order-thumb" src="${foto}">` : `<div class="order-thumb">🏍️</div>`}
        <span class="pill ${o.estado}">${STAGES.find(s => s.key === o.estado)?.label ?? o.estado}${o.finalizada ? " ✓" : ""}</span>
        <div class="order-info">
          <div class="moto">${esc(moto ? `${moto.marca} ${moto.modelo}` : "Moto")} <span class="cliente">— ${esc(cliente?.nombre ?? "cliente")}</span></div>
          <div class="meta">placa ${esc(moto?.placa || "s/p")} · orden #${o.id}${o.citaId ? ' · <span class="mant-badge soon">📅 Desde cita</span>' : ""}</div>
        </div>
        <span class="amount">${money(total)}</span>
        <span class="meta mech">${esc(o.mecanico ?? "")}</span>
        <button type="button" class="btn ghost small danger" data-del="${o.id}" title="Eliminar orden" aria-label="Eliminar orden">🗑</button>
      </div>`;
  }).join("");
  list.querySelectorAll(".order-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-del]")) return;
      openOrder(Number(row.dataset.id));
    });
  });
  list.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      requestAdminCode(async () => {
        await DB.delete("ordenes", Number(btn.dataset.del));
        markDirty();
        toast("Orden eliminada");
        renderOrdersList();
        renderDashboard();
      });
    });
  });
}

async function openOrder(id) {
  currentOrderId = id;
  const o = await DB.get("ordenes", id);
  const moto = await DB.get("motos", o.motoId);
  const cliente = await DB.get("clientes", o.clienteId);
  currentOrderCache = { o, moto, cliente };

  document.getElementById("detalleTitulo").textContent = `Orden #${o.id} — ${moto.marca} ${moto.modelo}`;
  const desdeCita = o.citaId
    ? ` · <span class="mant-badge soon">📅 Desde cita${o.citaFechaISO ? " del " + new Date(o.citaFechaISO).toLocaleDateString("es-HN") : ""}</span>`
    : "";
  document.getElementById("detalleSub").innerHTML =
    `${esc(cliente.nombre)} · ${esc(cliente.telefono || "sin teléfono")} · placa ${esc(moto.placa || "s/p")} · asignada a ${esc(o.mecanico)}${desdeCita}`;
  document.getElementById("detalleFalla").textContent = o.falla || "(sin descripción)";
  document.getElementById("inputKm").value = moto.km ?? "";
  document.getElementById("inputKm").previousElementSibling.textContent = o.estado === "entregado" ? "Kilometraje de salida" : "Kilometraje actual";

  document.getElementById("detalleFotos").innerHTML = (o.fotos || []).map(src => `<img src="${src}">`).join("");

  renderStageTracker(o.estado, o.finalizada);
  await renderStageContent(o);
  updateActionBar(o);

  showView("detalle");
}

function updateActionBar(o) {
  const isLast = o.estado === STAGES[STAGES.length - 1].key;
  const btnAvanzar = document.getElementById("btnAvanzar");
  const btnRetroceder = document.getElementById("btnRetroceder");
  const btnFactura = document.getElementById("btnImprimirFactura");
  const badge = document.getElementById("finalizadoBadge");

  btnFactura.style.display = isLast ? "inline-flex" : "none";

  if (o.finalizada) {
    btnAvanzar.style.display = "none";
    btnRetroceder.style.display = "none";
    badge.style.display = "inline-flex";
    badge.textContent = `✓ Trabajo finalizado el ${new Date(o.finalizadoEn).toLocaleDateString()}`;
  } else {
    badge.style.display = "none";
    btnRetroceder.style.display = "inline-flex";
    btnAvanzar.style.display = "inline-flex";
    btnAvanzar.textContent = isLast ? "Finalizar trabajo y guardar registro" : "Avanzar a la siguiente etapa →";
  }
}

function renderStageTracker(estado, finalizada) {
  const idx = STAGES.findIndex(s => s.key === estado);
  document.getElementById("stageTracker").innerHTML = STAGES.map((s, i) => {
    const cls = i < idx ? "done" : i === idx ? "current" : "";
    return `<button class="stage ${cls}" data-i="${i}"><div class="idx">${String(i + 1).padStart(2, "0")}</div><h4>${s.label}</h4></button>`;
  }).join("");
  document.querySelectorAll(".stage").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (finalizada) { toast("Este trabajo ya está finalizado", "off"); return; }
      const i = Number(btn.dataset.i);
      const o = await updateOrder(currentOrderId, ord => setStage(ord, STAGES[i].key));
      toast(`Etapa: ${STAGES[i].label}`);
      openOrder(o.id);
    });
  });
}

async function renderStageContent(o) {
  const el = document.getElementById("stageContent");

  if (o.estado === "recibido") {
    el.innerHTML = `<div class="card"><p style="color:var(--text-muted); margin:0;">Moto recibida. Cuando el mecánico la revise, avanza a <b>Diagnóstico</b> (o toca esa etapa arriba).</p></div>`;

  } else if (o.estado === "diagnostico") {
    el.innerHTML = `
      <div class="card">
        <h4 class="font-display" style="font-size:0.95rem; margin-bottom:0.6rem;">Diagnóstico</h4>
        <label>Notas del mecánico</label>
        <textarea id="diagNotas" rows="3">${esc(o.diagnostico?.notas || "")}</textarea>
        <label>Tiempo estimado (horas)</label>
        <input type="number" id="diagHoras" style="max-width:160px;" value="${o.diagnostico?.horas ?? ""}">
      </div>`;
    document.getElementById("diagNotas").addEventListener("change", (e) => updateOrder(o.id, ord => { ord.diagnostico = { ...(ord.diagnostico || {}), notas: e.target.value }; }));
    document.getElementById("diagHoras").addEventListener("change", (e) => updateOrder(o.id, ord => { ord.diagnostico = { ...(ord.diagnostico || {}), horas: Number(e.target.value) || 0 }; }));

  } else if (o.estado === "presupuesto") {
    await renderPresupuestoStage(o);

  } else if (o.estado === "reparacion") {
    el.innerHTML = `
      <div class="card">
        <h4 class="font-display" style="font-size:0.95rem; margin-bottom:0.6rem;">Reparación en curso</h4>
        <label>Notas de avance</label>
        <textarea id="repNotas" rows="3" placeholder="Qué se ha hecho, qué falta...">${esc(o.reparacionNotas || "")}</textarea>
      </div>`;
    document.getElementById("repNotas").addEventListener("change", (e) => updateOrder(o.id, ord => { ord.reparacionNotas = e.target.value; }));

  } else if (o.estado === "calidad") {
    const chk = o.calidadChecklist || {};
    const items = [
      ["pruebaManejo", "Prueba de manejo"],
      ["fugas", "Sin fugas de aceite/combustible"],
      ["torque", "Torque de piezas verificado"],
      ["limpieza", "Moto limpia y lista para entregar"],
    ];
    el.innerHTML = `
      <div class="card">
        <h4 class="font-display" style="font-size:0.95rem; margin-bottom:0.4rem;">Control de calidad</h4>
        <div class="checklist">
          ${items.map(([key, label]) => `
            <label><input type="checkbox" data-key="${key}" ${chk[key] ? "checked" : ""}> ${label}</label>
          `).join("")}
        </div>
      </div>`;
    el.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", (e) => updateOrder(o.id, ord => {
        ord.calidadChecklist = { ...(ord.calidadChecklist || {}), [e.target.dataset.key]: e.target.checked };
      }));
    });

  } else if (o.estado === "entregado") {
    const total = (o.items || []).reduce((s, it) => s + it.cantidad * it.precio, 0);
    const esCredito = o.tipoCobro === "credito";
    const garantiaDias = o.garantiaDias ?? 30;
    const venceEn = o.entregadoEn ? o.entregadoEn + garantiaDias * 86400000 : null;
    const vigente = !venceEn || Date.now() <= venceEn;
    const fechaVence = venceEn ? new Date(venceEn).toLocaleDateString("es-HN") : "—";
    el.innerHTML = `
      <div class="card">
        <h4 class="font-display" style="font-size:0.95rem; margin-bottom:0.4rem;">Entregada</h4>
        <p style="color:var(--text-muted); margin-bottom:0.6rem;">Total a cobrar: <b style="color:var(--text);">${money(total)}</b>. Imprime la factura con el botón de abajo antes de despedir al cliente.</p>
        <label>Tipo de cobro</label>
        <div class="seg-toggle" id="entregaTipoCobro" style="max-width:320px;">
          <button type="button" class="seg-opt ${esCredito ? "" : "active"}" data-tipo="contado">💵 Contado</button>
          <button type="button" class="seg-opt ${esCredito ? "active" : ""}" data-tipo="credito">💳 Crédito</button>
        </div>
        <div id="entregaContadoBox" style="display:${esCredito ? "none" : "block"};">
          <label>Método de pago</label>
          <select id="entregaMetodoPago" style="max-width:220px;">
            <option value="efectivo" ${o.metodoPago === "efectivo" || !o.metodoPago ? "selected" : ""}>Efectivo</option>
            <option value="transferencia" ${o.metodoPago === "transferencia" ? "selected" : ""}>Transferencia</option>
            <option value="tarjeta" ${o.metodoPago === "tarjeta" ? "selected" : ""}>Tarjeta</option>
          </select>
        </div>
        <div id="entregaCreditoBox" style="display:${esCredito ? "block" : "none"};">
          <label>¿Abonó algo ahora? (L.)</label>
          <input type="number" id="entregaAbono" min="0" step="0.01" style="max-width:220px;" placeholder="0.00" value="${o.abonoInicial || ""}">
          <div id="entregaAbonoMetodoBox" style="display:${(o.abonoInicial || 0) > 0 ? "block" : "none"};">
            <label>Método del abono</label>
            <select id="entregaAbonoMetodo" style="max-width:220px;">
              <option value="efectivo" ${o.abonoMetodo === "efectivo" || !o.abonoMetodo ? "selected" : ""}>Efectivo</option>
              <option value="transferencia" ${o.abonoMetodo === "transferencia" ? "selected" : ""}>Transferencia</option>
              <option value="tarjeta" ${o.abonoMetodo === "tarjeta" ? "selected" : ""}>Tarjeta</option>
            </select>
          </div>
          <div class="saldo-aviso" style="max-width:320px;"><span>Queda debiendo</span><b id="entregaSaldo">${money(Math.max(0, total - (o.abonoInicial || 0)))}</b></div>
          <p class="hint" style="margin:0;">Al finalizar el trabajo se creará la factura pendiente en Créditos.</p>
        </div>
      </div>
      <div class="card" style="margin-top:1rem;">
        <h4 class="font-display" style="font-size:0.95rem; margin-bottom:0.4rem;">Garantía</h4>
        <div class="field-row" style="grid-template-columns:1fr 1fr;">
          <div><label>Días de garantía</label><input type="number" id="garantiaDiasInput" min="0" value="${garantiaDias}"></div>
          <div><label>Vence</label>
            <p style="margin:0.55rem 0 0; display:flex; align-items:center; gap:0.5rem;">
              ${fechaVence} <span class="pill ${vigente ? "entregado" : "reparacion"}">${vigente ? "Vigente" : "Vencida"}</span>
            </p>
          </div>
        </div>
        <button class="btn wa small" id="btnEnviarGarantiaWA" style="margin-top:0.4rem;">Enviar nota de garantía por WhatsApp</button>
      </div>`;
    document.getElementById("entregaMetodoPago").addEventListener("change", (e) => {
      updateOrder(o.id, ord => { ord.metodoPago = e.target.value; });
    });
    document.getElementById("entregaTipoCobro").querySelectorAll(".seg-opt").forEach(btn => {
      btn.addEventListener("click", async () => {
        const tipo = btn.dataset.tipo;
        const ord = await updateOrder(o.id, x => { x.tipoCobro = tipo; });
        renderStageContent(ord);
      });
    });
    document.getElementById("entregaAbono").addEventListener("input", (e) => {
      const abono = Number(e.target.value) || 0;
      document.getElementById("entregaSaldo").textContent = money(Math.max(0, total - abono));
      document.getElementById("entregaAbonoMetodoBox").style.display = abono > 0 ? "block" : "none";
    });
    document.getElementById("entregaAbono").addEventListener("change", (e) => {
      updateOrder(o.id, ord => { ord.abonoInicial = Number(e.target.value) || 0; });
    });
    document.getElementById("entregaAbonoMetodo").addEventListener("change", (e) => {
      updateOrder(o.id, ord => { ord.abonoMetodo = e.target.value; });
    });
    document.getElementById("garantiaDiasInput").addEventListener("change", async (e) => {
      const dias = Number(e.target.value) || 0;
      const ord = await updateOrder(o.id, x => { x.garantiaDias = dias; });
      renderStageContent(ord);
    });
    document.getElementById("btnEnviarGarantiaWA").addEventListener("click", () => {
      const ventana = abrirVentanaWA(); // sincrónico, antes de cualquier await
      const { cliente, moto } = currentOrderCache;
      const motoDesc = `${moto.marca} ${moto.modelo}`.trim();
      const cuerpo = vigente
        ? `tu garantía por el trabajo en tu ${motoDesc} (orden #${o.id}) sigue vigente hasta el ${fechaVence}. Cualquier falla relacionada, contáctanos.`
        : `tu garantía por el trabajo en tu ${motoDesc} (orden #${o.id}) venció el ${fechaVence}. Si necesitas otra revisión, con gusto te ayudamos.`;
      const texto = `Hola ${cliente.nombre}, ${cuerpo} — ENTIMOTORS`;
      navegarWA(ventana, cliente.telefono, texto);
    });
  }
}

async function renderPresupuestoStage(o) {
  const inv = await DB.getAll("inventario");
  const items = o.items || [];
  const el = document.getElementById("stageContent");
  el.innerHTML = `
    <div class="card">
      <h4 class="font-display" style="font-size:0.95rem; margin-bottom:0.6rem;">Presupuesto</h4>
      <table id="tablaItems">
        <thead><tr><th>Ítem</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Subtotal</th><th></th></tr></thead>
        <tbody id="itemsBody"></tbody>
      </table>
      <div style="display:flex; justify-content:space-between; margin-top:0.6rem; font-weight:600;">
        <span>Total</span><span id="itemsTotal" style="font-variant-numeric:tabular-nums;">${money(items.reduce((s, it) => s + it.cantidad * it.precio, 0))}</span>
      </div>
      <button class="btn small" id="btnAgregarItem" style="margin-top:0.7rem;">+ Agregar repuesto / mano de obra</button>

      <div id="aprobacionBox" style="margin-top:1rem; padding-top:1rem; border-top:1px solid var(--line);">
        <p class="hint" style="margin-top:0;">El cliente puede aprobar por WhatsApp (se le escribe a su número), o directo aquí si está en el local.</p>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button class="btn wa" id="btnEnviarWA">Enviar presupuesto por WhatsApp</button>
          <button class="btn primary" id="btnAprobarLocal">Aprobar en el local</button>
        </div>
        <p id="aprobacionEstado" style="margin-top:0.6rem; font-size:0.85rem;"></p>
      </div>
    </div>`;

  document.getElementById("itemsBody").innerHTML = items.length ? items.map((it, i) => `
    <tr>
      <td>${esc(it.nombre)}</td><td class="num">${it.cantidad}</td><td class="num">${money(it.precio)}</td><td class="num">${money(it.cantidad * it.precio)}</td>
      <td class="num"><button type="button" class="btn ghost small danger" data-quitar="${i}" title="Quitar ítem" aria-label="Quitar ítem">🗑</button></td>
    </tr>
  `).join("") : `<tr><td colspan="5" style="color:var(--text-faint);">Sin ítems todavía</td></tr>`;

  document.getElementById("itemsBody").querySelectorAll("[data-quitar]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.quitar);
      const ord = await DB.get("ordenes", o.id);
      const [removido] = (ord.items || []).splice(idx, 1);
      if (removido?.origenInventarioId) {
        const rep = await DB.get("inventario", removido.origenInventarioId);
        if (rep) { rep.cantidad += removido.cantidad; await DB.save("inventario", rep); }
      }
      await DB.save("ordenes", ord);
      markDirty();
      toast(removido?.origenInventarioId ? "Ítem quitado y stock devuelto al inventario" : "Ítem quitado");
      renderPresupuestoStage(ord);
    });
  });

  renderAprobacionEstado(o);

  document.getElementById("btnAgregarItem").addEventListener("click", async () => {
    const invNow = await DB.getAll("inventario");
    document.getElementById("itemInventarioSelect").innerHTML = invNow.map(r => `<option value="${r.id}">${esc(r.nombre)} (quedan ${r.cantidad})</option>`).join("") || `<option value="">Inventario vacío</option>`;
    document.getElementById("itemNombre").value = "";
    document.getElementById("itemCantidad").value = 1;
    document.getElementById("itemPrecio").value = "";
    document.getElementById("itemOrigen").value = "manual";
    toggleItemOrigen();
    document.getElementById("modalItem").classList.add("active");
  });

  document.getElementById("btnEnviarWA").addEventListener("click", async () => {
    const ventanaWA = abrirVentanaWA();
    const ord = await DB.get("ordenes", o.id);
    const moto = await DB.get("motos", ord.motoId);
    const cliente = await DB.get("clientes", ord.clienteId);
    const total = (ord.items || []).reduce((s, it) => s + it.cantidad * it.precio, 0);
    const lineas = (ord.items || []).map(it => `- ${it.nombre} x${it.cantidad}: ${money(it.cantidad * it.precio)}`).join("\n");
    const texto = `Hola ${cliente.nombre}, este es el presupuesto para tu ${moto.marca} ${moto.modelo} (orden #${ord.id}):\n\n${lineas}\n\nTotal: ${money(total)}\n\n¿Lo aprobamos para empezar la reparación?`;
    const sent = navegarWA(ventanaWA, cliente.telefono, texto);
    if (!sent) return;
    await updateOrder(o.id, x => { x.aprobacion = { via: "whatsapp", en: Date.now() }; });
    renderAprobacionEstado(await DB.get("ordenes", o.id));
    toast(`Presupuesto enviado por WhatsApp a ${cliente.nombre}`);
  });

  document.getElementById("btnAprobarLocal").addEventListener("click", async () => {
    const ord = await updateOrder(o.id, x => { x.aprobacion = { via: "local", en: Date.now() }; });
    renderAprobacionEstado(ord);
    toast("Aprobado en el local");
  });
}

function renderAprobacionEstado(o) {
  const el = document.getElementById("aprobacionEstado");
  if (!el) return;
  if (o.aprobacion) {
    el.textContent = o.aprobacion.via === "whatsapp"
      ? `Enviado por WhatsApp el ${new Date(o.aprobacion.en).toLocaleString()} — pendiente de confirmación del cliente.`
      : `Aprobado en el local el ${new Date(o.aprobacion.en).toLocaleString()}.`;
  } else {
    el.textContent = "Sin enviar todavía.";
  }
}

/* ---- autocompletado genérico: buscar cliente por nombre o placa ---- */
function wireAutocompleteCliente(inputEl, listEl, onPick) {
  let items = [];
  async function search(q) {
    if (!q) { listEl.classList.remove("open"); listEl.innerHTML = ""; return; }
    const [clientes, motos] = await Promise.all([DB.getAll("clientes"), DB.getAll("motos")]);
    const ql = q.toLowerCase();
    items = clientes
      .map(c => ({ cliente: c, moto: motos.find(m => m.clienteId === c.id) }))
      .filter(({ cliente, moto }) => cliente.nombre.toLowerCase().includes(ql) || (moto?.placa || "").toLowerCase().includes(ql))
      .slice(0, 8);
    listEl.innerHTML = items.length
      ? items.map((it, i) => `
        <div class="autocomplete-item" data-i="${i}">
          <b>${esc(it.cliente.nombre)}</b>
          <span class="sub">${it.moto ? esc(it.moto.placa || "sin placa") + " · " + esc(`${it.moto.marca} ${it.moto.modelo}`.trim()) : "sin moto registrada"}${it.cliente.telefono ? " · " + esc(it.cliente.telefono) : ""}</span>
        </div>`).join("")
      : `<div class="autocomplete-item empty">Sin coincidencias — se creará como cliente nuevo</div>`;
    listEl.classList.add("open");
    listEl.querySelectorAll(".autocomplete-item[data-i]").forEach(el => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault(); // evita que el blur del input cierre la lista antes del click
        const it = items[Number(el.dataset.i)];
        onPick(it.cliente, it.moto);
        listEl.classList.remove("open");
        inputEl.value = it.cliente.nombre;
      });
    });
  }
  inputEl.addEventListener("input", (e) => search(e.target.value.trim()));
  inputEl.addEventListener("focus", (e) => { if (e.target.value.trim()) search(e.target.value.trim()); });
  inputEl.addEventListener("blur", () => setTimeout(() => listEl.classList.remove("open"), 150));
}

/* ---- crear orden ---- */
let ordenClienteSel = null; // { clienteId, motoId|null } cuando se elige un cliente existente

function renderOrdenClienteChip() {
  const wrap = document.getElementById("ordenClienteChipWrap");
  wrap.innerHTML = ordenClienteSel
    ? `<span class="selected-chip">Cliente existente seleccionado <button type="button" id="btnQuitarOrdenClienteSel" title="Quitar selección" aria-label="Quitar cliente seleccionado">✕</button></span>`
    : "";
  document.getElementById("btnQuitarOrdenClienteSel")?.addEventListener("click", () => {
    ordenClienteSel = null;
    document.getElementById("ordenBuscarCliente").value = "";
    renderOrdenClienteChip();
  });
}

wireAutocompleteCliente(document.getElementById("ordenBuscarCliente"), document.getElementById("ordenBuscarClienteList"), (cliente, moto) => {
  ordenClienteSel = { clienteId: cliente.id, motoId: moto?.id || null };
  document.getElementById("ordenNombre").value = cliente.nombre;
  document.getElementById("ordenTelefono").value = cliente.telefono || "";
  document.getElementById("ordenPlaca").value = moto?.placa || "";
  document.getElementById("ordenMarca").value = moto?.marca || "";
  document.getElementById("ordenModelo").value = moto?.modelo || "";
  document.getElementById("ordenKm").value = moto?.km || 0;
  renderOrdenClienteChip();
});
document.getElementById("ordenBuscarCliente").addEventListener("input", () => { ordenClienteSel = null; renderOrdenClienteChip(); });

/* El cliente llegó a su cita: se le abre la orden de servicio con todo lo que
   ya sabíamos de la cita (cliente, su moto, el motivo y el mecánico con quien
   la apartó), y al crearla la cita se marca como atendida y sale del listado.
   La cita NO se borra: queda en el historial ligada a su orden, para poder
   saber después cuántas citas se cumplieron y cuáles no. */
let citaPendienteDeConvertir = null;

async function abrirOrdenDesdeCita(citaId) {
  const cita = await DB.get("citas", citaId);
  if (!cita) return;
  citaPendienteDeConvertir = cita;

  ordenClienteSel = null;
  ["ordenNombre", "ordenTelefono", "ordenPlaca", "ordenMarca", "ordenModelo", "ordenKm", "ordenFalla"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("ordenFoto").value = "";
  document.getElementById("ordenBuscarCliente").value = "";

  if (cita.clienteId) {
    const cliente = await DB.get("clientes", cita.clienteId);
    const motos = await DB.getAll("motos");
    const moto = motos.find(m => m.clienteId === cita.clienteId) || null;
    if (cliente) {
      ordenClienteSel = { clienteId: cliente.id, motoId: moto?.id || null };
      document.getElementById("ordenBuscarCliente").value = cliente.nombre;
      document.getElementById("ordenNombre").value = cliente.nombre;
      document.getElementById("ordenTelefono").value = cliente.telefono || "";
      document.getElementById("ordenPlaca").value = moto?.placa || "";
      document.getElementById("ordenMarca").value = moto?.marca || "";
      document.getElementById("ordenModelo").value = moto?.modelo || "";
      document.getElementById("ordenKm").value = moto?.km || 0;
    }
  } else {
    // cita de alguien que todavía no estaba registrado (típico de la web)
    document.getElementById("ordenNombre").value = cita.nombreTmp || "";
    document.getElementById("ordenTelefono").value = cita.telefonoTmp || "";
  }
  document.getElementById("ordenFalla").value = cita.motivo || "";
  renderOrdenClienteChip();

  document.getElementById("ordenDesdeCitaAviso").style.display = "block";
  document.getElementById("ordenDesdeCitaTexto").textContent =
    `Viene de la cita del ${citaWhenInfo(cita).dt.toLocaleDateString("es-HN")} a las ${citaWhenInfo(cita).dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${cita.mecanico ? ` con ${cita.mecanico}` : ""}.`;
  document.getElementById("modalOrden").classList.add("active");
}

document.getElementById("btnNuevaOrden").addEventListener("click", async () => {
  citaPendienteDeConvertir = null;
  document.getElementById("ordenDesdeCitaAviso").style.display = "none";
  ordenClienteSel = null;
  document.getElementById("ordenBuscarCliente").value = "";
  renderOrdenClienteChip();
  ["ordenNombre", "ordenTelefono", "ordenPlaca", "ordenMarca", "ordenModelo", "ordenKm", "ordenFalla"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("ordenFoto").value = "";
  document.getElementById("modalOrden").classList.add("active");
});
document.getElementById("btnCancelarOrden").addEventListener("click", () => {
  citaPendienteDeConvertir = null;
  document.getElementById("modalOrden").classList.remove("active");
});

alHacerClicUnaVez(document.getElementById("btnCrearOrden"), async () => {
  let clienteId, motoId;

  if (ordenClienteSel?.clienteId) {
    clienteId = ordenClienteSel.clienteId;
    motoId = ordenClienteSel.motoId;
    const datosMoto = {
      marca: document.getElementById("ordenMarca").value.trim() || "—",
      modelo: document.getElementById("ordenModelo").value.trim() || "",
      placa: document.getElementById("ordenPlaca").value.trim(),
      km: Number(document.getElementById("ordenKm").value) || 0,
    };
    if (motoId) {
      // el cliente ya existía: aprovechamos para actualizar su km/datos con lo que se acaba de escribir
      const moto = await DB.get("motos", motoId);
      await DB.save("motos", { ...moto, ...datosMoto });
      markDirty();
    } else {
      motoId = await DB.save("motos", { clienteId, ...datosMoto });
      markDirty();
    }
  } else {
    const nombre = document.getElementById("ordenNombre").value.trim();
    const telefono = document.getElementById("ordenTelefono").value.trim();
    if (!nombre) { toast("Falta el nombre del cliente", "off"); return; }
    if (!(await checkDuplicateBeforeCreate(nombre, telefono))) return;
    clienteId = await DB.save("clientes", { nombre, telefono });
    markDirty();
    motoId = await DB.save("motos", {
      clienteId,
      marca: document.getElementById("ordenMarca").value.trim() || "—",
      modelo: document.getElementById("ordenModelo").value.trim() || "",
      placa: document.getElementById("ordenPlaca").value.trim(),
      km: Number(document.getElementById("ordenKm").value) || 0,
    });
    markDirty();
  }

  const fotoFile = document.getElementById("ordenFoto").files[0];
  const fotos = fotoFile ? [await fileToDataUrl(fotoFile)] : [];

  const cita = citaPendienteDeConvertir;
  const id = await DB.save("ordenes", {
    clienteId, motoId, estado: "recibido",
    falla: document.getElementById("ordenFalla").value.trim(),
    items: [], fotos, aprobacion: null,
    diagnostico: null, reparacionNotas: "", calidadChecklist: null,
    // si viene de una cita, la atiende el mecánico con quien se apartó
    mecanico: cita?.mecanico || currentUser?.nombre || "—",
    citaId: cita?.id || null,
    citaFechaISO: cita ? `${cita.fecha}T${cita.hora}` : null,
    creadoEn: Date.now(),
  });
  markDirty();

  if (cita) {
    await DB.save("citas", { ...cita, estado: "atendida", ordenId: id, cerradaEn: Date.now() });
    markDirty();
    citaPendienteDeConvertir = null;
    await renderCitasList();
  }

  document.getElementById("modalOrden").classList.remove("active");
  toast(cita ? `Orden #${id} creada desde la cita` : "Orden creada");
  await renderOrdersList();
  renderDashboard();
  openOrder(id);
});

document.getElementById("btnVolverOrdenes").addEventListener("click", async () => {
  await renderOrdersList();
  showView("ordenes");
});

/* ---- avanzar / retroceder etapa ---- */
document.getElementById("btnAvanzar").addEventListener("click", async () => {
  const o = await DB.get("ordenes", currentOrderId);
  const idx = STAGES.findIndex(s => s.key === o.estado);
  if (idx >= STAGES.length - 1) {
    const total = (o.items || []).reduce((s, it) => s + it.cantidad * it.precio, 0);
    let costo = 0;
    const inv = await DB.getAll("inventario");
    (o.items || []).forEach(it => {
      if (!it.origenInventarioId) return;
      const rep = inv.find(r => r.id === it.origenInventarioId);
      if (rep) costo += (rep.costoCompra || 0) * it.cantidad;
    });
    const margen = total > 0 ? ((total - costo) / total) * 100 : null;
    const ord = await updateOrder(o.id, x => { x.finalizada = true; x.finalizadoEn = Date.now(); x.margen = margen; });

    if (total > 0 && ord.tipoCobro === "credito") {
      // al crédito NO entra dinero a caja todavía: se crea la factura pendiente
      // y, si dejó algo de entrada, ese abono sí se registra como ingreso.
      const cliente = await DB.get("clientes", ord.clienteId);
      const abono = Math.min(Number(ord.abonoInicial) || 0, total);
      try {
        const { id: credId, credito } = await cobrarAlCredito({
          clienteId: ord.clienteId,
          clienteNombre: cliente?.nombre || "Cliente",
          clienteTelefono: cliente?.telefono || "",
          // inventarioId en null a propósito: el repuesto ya salió del stock
          // cuando se agregó a la orden, volver a descontarlo lo restaría dos veces
          items: (ord.items || []).map(it => ({ inventarioId: null, nombre: it.nombre, cantidad: it.cantidad, precio: it.precio })),
          abono, abonoMetodo: ord.abonoMetodo || "efectivo",
          nota: `Orden de taller #${ord.id}`, origen: "orden", ordenId: ord.id,
        });
        await updateOrder(ord.id, x => { x.creditoId = credId; });
        toast(abono > 0
          ? `Crédito #${credId} creado — abonó ${money(abono)}, queda debiendo ${money(credito.saldo)}`
          : `Crédito #${credId} creado — queda debiendo ${money(credito.saldo)}`);
      } catch (err) {
        toast("No se pudo crear el crédito: " + err.message, "off");
      }
    } else {
      if (total > 0) await registrarIngresoTaller(ord, total, ord.metodoPago || "efectivo");
      toast("Trabajo finalizado y guardado como registro");
    }
    renderOrdersList();
    renderDashboard();
    openOrder(ord.id);
    return;
  }
  await updateOrder(o.id, ord => setStage(ord, STAGES[idx + 1].key));
  toast(`Etapa: ${STAGES[idx + 1].label}`);
  openOrder(o.id);
});
document.getElementById("btnRetroceder").addEventListener("click", async () => {
  const o = await DB.get("ordenes", currentOrderId);
  const idx = STAGES.findIndex(s => s.key === o.estado);
  if (idx <= 0) return;
  await updateOrder(o.id, ord => { ord.estado = STAGES[idx - 1].key; });
  openOrder(o.id);
});

/* ---- km ---- */
document.getElementById("inputKm").addEventListener("change", async (e) => {
  const o = await DB.get("ordenes", currentOrderId);
  const moto = await DB.get("motos", o.motoId);
  moto.km = Number(e.target.value) || moto.km;
  await DB.save("motos", moto);
  markDirty();
  toast("Kilometraje actualizado");
});

/* ---- fotos ---- */
document.getElementById("inputFotos").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const urls = await Promise.all(files.map(fileToDataUrl));
  const o = await updateOrder(currentOrderId, ord => { ord.fotos = (ord.fotos || []).concat(urls); });
  e.target.value = "";
  openOrder(o.id);
});

/* ---- ítems de presupuesto (modal) ---- */
document.getElementById("btnCancelarItem").addEventListener("click", () => document.getElementById("modalItem").classList.remove("active"));
document.getElementById("itemOrigen").addEventListener("change", toggleItemOrigen);
function toggleItemOrigen() {
  const fromInv = document.getElementById("itemOrigen").value === "inventario";
  document.getElementById("itemManualFields").style.display = fromInv ? "none" : "block";
  document.getElementById("itemInventarioFields").style.display = fromInv ? "block" : "none";
}

alHacerClicUnaVez(document.getElementById("btnGuardarItem"), async () => {
  const cantidad = Number(document.getElementById("itemCantidad").value) || 1;
  const precio = Number(document.getElementById("itemPrecio").value) || 0;
  const fromInv = document.getElementById("itemOrigen").value === "inventario";
  let nombre;
  let origenInventarioId = null;

  // una cantidad negativa aquí, si venía de inventario, terminaba SUMANDO
  // stock en vez de restarlo (rep.cantidad -= cantidad con cantidad negativo).
  if (cantidad <= 0) { toast("La cantidad debe ser mayor a cero", "off"); return; }
  if (precio < 0) { toast("El precio no puede ser negativo", "off"); return; }

  if (fromInv) {
    const repId = Number(document.getElementById("itemInventarioSelect").value);
    const rep = await DB.get("inventario", repId);
    if (!rep) { toast("Elige un repuesto", "off"); return; }
    if (rep.cantidad < cantidad) { toast(`Solo quedan ${rep.cantidad} en inventario`, "off"); return; }
    nombre = rep.nombre;
    origenInventarioId = repId;
    rep.cantidad -= cantidad;
    await DB.save("inventario", rep);
    markDirty();
  } else {
    nombre = document.getElementById("itemNombre").value.trim();
    if (!nombre) { toast("Falta el nombre del ítem", "off"); return; }
  }

  const o = await updateOrder(currentOrderId, ord => { ord.items = (ord.items || []).concat([{ nombre, cantidad, precio, origenInventarioId }]); });
  document.getElementById("modalItem").classList.remove("active");
  openOrder(o.id);
});

/* ---- enviar progreso de la reparación por WhatsApp ---- */
document.getElementById("btnEnviarProgresoWA").addEventListener("click", () => {
  const ventana = abrirVentanaWA(); // sincrónico, antes de cualquier await
  const { o, moto, cliente } = currentOrderCache;
  const motoDesc = `${moto.marca} ${moto.modelo}`.trim();
  const cuerpo = (PROGRESO_MENSAJES[o.estado] || (() => `tu ${motoDesc} avanzó de etapa.`))(motoDesc);
  const texto = `Hola ${cliente.nombre}, ${cuerpo} — ENTIMOTORS`;
  navegarWA(ventana, cliente.telefono, texto);
});

/* ---- imprimir factura ---- */
document.getElementById("btnImprimirFactura").addEventListener("click", () => {
  const ventana = abrirVentanaImpresion(); // sincrónico, antes que nada
  // sincrónico a propósito: usa lo que openOrder() ya dejó en currentOrderCache
  // en vez de volver a leer con await — así el clic sigue "fresco" para que el
  // navegador permita el diálogo de impresión (ver nota en currentOrderCache).
  const { o, moto, cliente } = currentOrderCache;
  const items = o.items || [];
  const total = items.reduce((s, it) => s + it.cantidad * it.precio, 0);

  document.getElementById("facOrdenId").textContent = o.id;
  document.getElementById("facFecha").textContent = new Date().toLocaleDateString();
  document.getElementById("facCliente").textContent = cliente.nombre;
  document.getElementById("facTelefono").textContent = cliente.telefono || "—";
  document.getElementById("facMoto").textContent = `${moto.marca} ${moto.modelo} · placa ${moto.placa || "s/p"} · ${moto.km || 0} km`;
  document.getElementById("facItems").innerHTML = items.length
    ? items.map(it => `<tr><td>${esc(it.nombre)}</td><td class="num">${it.cantidad}</td><td class="num">${money(it.precio)}</td><td class="num">${money(it.cantidad * it.precio)}</td></tr>`).join("")
    : `<tr><td colspan="4">Sin ítems</td></tr>`;
  document.getElementById("facTotal").textContent = money(total);

  imprimirPlantilla("facturaPrint", null, ventana);
});

/* ================= CITAS ================= */
function generarSlotsDelDia() {
  const [hIni, mIni] = HORARIO_TALLER.horaInicio.split(":").map(Number);
  const [hFin, mFin] = HORARIO_TALLER.horaFin.split(":").map(Number);
  const slots = [];
  let mins = hIni * 60 + mIni;
  const finMins = hFin * 60 + mFin;
  while (mins < finMins) {
    const h = String(Math.floor(mins / 60)).padStart(2, "0");
    const m = String(mins % 60).padStart(2, "0");
    slots.push(`${h}:${m}`);
    mins += HORARIO_TALLER.intervaloMin;
  }
  return slots;
}

// solo se ofrecen horas libres para ese mecánico ese día, así ya no se puede
// ni seleccionar un horario que otro cliente ya apartó.
async function slotsDisponibles(fecha, mecanico, excluirCitaId = null) {
  const todos = generarSlotsDelDia();
  if (!fecha || !mecanico) return todos;
  const citas = await DB.getAll("citas");
  const ocupadas = new Set(citas
    // al mover una cita, su propio horario actual no debe contar como ocupado;
    // y una cita ya cerrada (atendida o no asistida) tampoco bloquea el hueco.
    .filter(c => c.id !== excluirCitaId && !citaCerrada(c) && c.fecha === fecha && c.mecanico === mecanico)
    .map(c => c.hora));
  return todos.filter(h => !ocupadas.has(h));
}

async function refreshCitaHoraOptions() {
  const sel = document.getElementById("citaHora");
  const valorPrevio = sel.value;
  const fecha = document.getElementById("citaFecha").value;
  const mecanico = document.getElementById("citaMecanico").value;
  if (!fecha) {
    sel.innerHTML = `<option value="">Elige una fecha primero</option>`;
    return;
  }
  const libres = await slotsDisponibles(fecha, mecanico);
  sel.innerHTML = libres.length
    ? libres.map(h => `<option value="${h}">${h}</option>`).join("")
    : `<option value="">Sin horarios disponibles ese día — elige otra fecha</option>`;
  if (libres.includes(valorPrevio)) sel.value = valorPrevio;
}
document.getElementById("citaFecha").addEventListener("change", refreshCitaHoraOptions);
document.getElementById("citaMecanico").addEventListener("change", refreshCitaHoraOptions);

async function checkCitaConflicto(fecha, hora, mecanico) {
  if (!mecanico) return true;
  const citas = await DB.getAll("citas");
  const choque = citas.find(c => c.fecha === fecha && c.hora === hora && c.mecanico === mecanico);
  if (!choque) return true;
  return showConfirm(
    `${mecanico} ya tiene otra cita agendada el ${fecha} a las ${hora}. ¿Agendar esta de todas formas?`,
    { titulo: "Choque de horario", textoOk: "Agendar de todas formas" }
  );
}
/* ---- mover una cita a otro día ----
   Guarda el historial del cambio (de cuándo a cuándo y por qué) en vez de solo
   pisar la fecha: si un cliente reclama "pero si mi cita era el martes", ahí
   queda registrado que se movió y por qué motivo. */
let citaAMover = null;

async function refreshMoverHoraOptions() {
  const sel = document.getElementById("moverHora");
  const valorPrevio = sel.value;
  const fecha = document.getElementById("moverFecha").value;
  const mecanico = document.getElementById("moverMecanico").value;
  if (!fecha) { sel.innerHTML = `<option value="">Elige una fecha primero</option>`; return; }
  const libres = await slotsDisponibles(fecha, mecanico, citaAMover?.id ?? null);
  sel.innerHTML = libres.length
    ? libres.map(h => `<option value="${h}">${h}</option>`).join("")
    : `<option value="">Sin horarios disponibles ese día — elige otra fecha</option>`;
  if (libres.includes(valorPrevio)) sel.value = valorPrevio;
}

async function abrirModalMoverCita(citaId) {
  const cita = await DB.get("citas", citaId);
  if (!cita) return;
  citaAMover = cita;

  const cliente = cita.clienteId ? await DB.get("clientes", cita.clienteId) : null;
  const nombre = cliente?.nombre || cita.nombreTmp || "Cliente";
  const telefono = cliente?.telefono || cita.telefonoTmp || "";
  const { dt } = citaWhenInfo(cita);

  document.getElementById("moverCitaActualTexto").textContent =
    `${nombre} — ahora está para el ${dt.toLocaleDateString("es-HN")} a las ${cita.hora} con ${cita.mecanico}.`;
  document.getElementById("moverAvisoSinTel").style.display = telefono ? "none" : "block";

  document.getElementById("moverMecanico").innerHTML = TEAM.map(t => `<option value="${esc(t.nombre)}">${esc(t.nombre)}</option>`).join("");
  document.getElementById("moverMecanico").value = cita.mecanico;
  document.getElementById("moverMotivo").value = "cliente";
  document.getElementById("moverFecha").value = cita.fecha;
  await refreshMoverHoraOptions();
  document.getElementById("moverHora").value = cita.hora;

  document.getElementById("modalMoverCita").classList.add("active");
}

document.getElementById("moverFecha").addEventListener("change", refreshMoverHoraOptions);
document.getElementById("moverMecanico").addEventListener("change", refreshMoverHoraOptions);
document.getElementById("btnCancelarMover").addEventListener("click", () => {
  citaAMover = null;
  document.getElementById("modalMoverCita").classList.remove("active");
});

const MOTIVO_MOVER_TEXTO = {
  cliente: "",  // fue el propio cliente quien pidió el cambio: no hace falta explicárselo
  mecanico: " El mecánico no estará disponible ese día.",
  taller: " Tuvimos que hacer un ajuste en la agenda del taller.",
};

alHacerClicUnaVez(document.getElementById("btnConfirmarMover"), async () => {
  const cita = citaAMover;
  if (!cita) return;

  const fecha = document.getElementById("moverFecha").value;
  const hora = document.getElementById("moverHora").value;
  const mecanico = document.getElementById("moverMecanico").value;
  const motivo = document.getElementById("moverMotivo").value;

  if (!fecha) { toast("Elige la nueva fecha", "off"); return; }
  if (!hora) { toast("Elige la nueva hora", "off"); return; }
  if (fecha === cita.fecha && hora === cita.hora && mecanico === cita.mecanico) {
    toast("No cambiaste nada: elige otra fecha, hora o mecánico", "off");
    return;
  }
  if (!(await checkCitaConflicto(fecha, hora, mecanico))) return;

  const cliente = cita.clienteId ? await DB.get("clientes", cita.clienteId) : null;
  const nombre = cliente?.nombre || cita.nombreTmp || "Cliente";
  const telefono = cliente?.telefono || cita.telefonoTmp || "";

  // la ventana de WhatsApp se abre desde el propio clic, antes de guardar: si
  // se abriera después del await, el celular la bloquearía por "gesto vencido".
  const ventanaWA = telefono ? abrirVentanaWA() : null;

  const antes = { fecha: cita.fecha, hora: cita.hora, mecanico: cita.mecanico };
  await DB.save("citas", {
    ...cita, fecha, hora, mecanico,
    // si estaba marcada como no asistida, moverla la vuelve a poner en juego
    estado: cita.estado === "ausente" ? undefined : cita.estado,
    cerradaEn: cita.estado === "ausente" ? undefined : cita.cerradaEn,
    // se vuelve a avisar en la fecha nueva, así que el recordatorio se reinicia
    recordatorioEnviado: false,
    reprogramaciones: (cita.reprogramaciones || []).concat([{ de: antes, a: { fecha, hora, mecanico }, motivo, fechaISO: new Date().toISOString() }]),
  });
  markDirty();

  const dtAntes = new Date(`${antes.fecha}T${antes.hora}`);
  const dtNueva = new Date(`${fecha}T${hora}`);
  const texto = `Hola ${nombre}, tu cita en ENTIMOTORS del ${dtAntes.toLocaleDateString("es-HN")} a las ${antes.hora} fue movida para el ${dtNueva.toLocaleDateString("es-HN")} a las ${hora}.${MOTIVO_MOVER_TEXTO[motivo] || ""} ¡Te esperamos!`;
  if (telefono) navegarWA(ventanaWA, telefono, texto);

  citaAMover = null;
  document.getElementById("modalMoverCita").classList.remove("active");
  toast(telefono ? "Cita movida y aviso abierto en WhatsApp" : "Cita movida");
  renderCitasList();
  renderDashboard();
});

function citaWhenInfo(cita) {
  const now = new Date();
  const dt = new Date(`${cita.fecha}T${cita.hora || "00:00"}`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const citaDay = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const diffDays = Math.round((citaDay - today) / 86400000);
  let label;
  if (diffDays < 0) label = "Pasada";
  else if (diffDays === 0) label = "Hoy";
  else if (diffDays === 1) label = "Mañana";
  else label = dt.toLocaleDateString();
  return { diffDays, label, dt };
}

let citasFiltro = null; // null | "hoy" | "semana" | "sinRecordatorio" | "historial"

// Una cita se "cierra" cuando ya sabemos qué pasó con ella: o el cliente llegó
// (y se le abrió su orden de servicio) o no llegó. Mientras siga abierta se
// queda en la lista para que alguien decida — así el listado no se llena de
// citas viejas de las que nadie sabe en qué terminaron.
function citaCerrada(c) { return c.estado === "atendida" || c.estado === "ausente"; }

async function renderCitasList() {
  const [citasAll, clientes] = await Promise.all([DB.getAll("citas"), DB.getAll("clientes")]);

  const abiertas = citasAll.filter(c => !citaCerrada(c));
  const cerradas = citasAll.filter(citaCerrada);
  const hoy = abiertas.filter(c => citaWhenInfo(c).diffDays === 0);
  const semana = abiertas.filter(c => { const d = citaWhenInfo(c).diffDays; return d >= 0 && d <= 6; });
  const sinRecordatorio = abiertas.filter(c => !c.recordatorioEnviado && citaWhenInfo(c).diffDays >= 0);
  // citas cuya hora ya pasó y que nadie marcó: hay que cerrarlas
  const porCerrar = abiertas.filter(c => citaWhenInfo(c).diffDays < 0);

  renderWidgetRow("citasWidgetRow", [
    { ic: "📅", val: hoy.length, lbl: "Hoy", active: citasFiltro === "hoy", onClick: () => { citasFiltro = citasFiltro === "hoy" ? null : "hoy"; renderCitasList(); } },
    { ic: "🗓️", val: semana.length, lbl: "Esta semana", active: citasFiltro === "semana", onClick: () => { citasFiltro = citasFiltro === "semana" ? null : "semana"; renderCitasList(); } },
    { ic: "💬", val: sinRecordatorio.length, lbl: "Sin recordatorio", active: citasFiltro === "sinRecordatorio", onClick: () => { citasFiltro = citasFiltro === "sinRecordatorio" ? null : "sinRecordatorio"; renderCitasList(); } },
    { ic: "⏳", val: porCerrar.length, lbl: "Por cerrar", active: citasFiltro === "porCerrar", onClick: () => { citasFiltro = citasFiltro === "porCerrar" ? null : "porCerrar"; renderCitasList(); } },
    { ic: "📂", val: cerradas.length, lbl: "Historial", active: citasFiltro === "historial", onClick: () => { citasFiltro = citasFiltro === "historial" ? null : "historial"; renderCitasList(); } },
  ]);

  // por defecto la lista muestra solo las citas abiertas: las ya atendidas
  // pasaron a ser órdenes de servicio y viven allá, no aquí.
  let citas = abiertas;
  if (citasFiltro === "hoy") citas = hoy;
  else if (citasFiltro === "semana") citas = semana;
  else if (citasFiltro === "sinRecordatorio") citas = sinRecordatorio;
  else if (citasFiltro === "porCerrar") citas = porCerrar;
  else if (citasFiltro === "historial") citas = cerradas;

  const list = document.getElementById("citasList");
  if (!citas.length) {
    list.innerHTML = citasAll.length
      ? `<div class="empty">${citasFiltro === "historial" ? "Todavía no hay citas cerradas." : citasFiltro ? "Ninguna cita coincide con este filtro." : "No hay citas pendientes. Las ya atendidas están en el historial."}</div>`
      : `<div class="empty">Sin citas todavía.<br><button class="btn primary small" id="btnEmptyNuevaCita" style="margin-top:0.8rem;">+ Crear la primera</button></div>`;
    document.getElementById("btnEmptyNuevaCita")?.addEventListener("click", () => document.getElementById("btnNuevaCita").click());
    updateCitasBadge(0);
    return;
  }
  citas = [...citas].sort((a, b) => `${a.fecha}${a.hora}`.localeCompare(`${b.fecha}${b.hora}`));
  list.innerHTML = citas.map(c => {
    const cliente = clientes.find(cl => cl.id === c.clienteId);
    const nombre = cliente?.nombre || c.nombreTmp || "Cliente";
    const telefono = cliente?.telefono || c.telefonoTmp || "";
    const { label, dt } = citaWhenInfo(c);
    const { diffDays } = citaWhenInfo(c);
    // los botones cambian según en qué momento está la cita: no tiene sentido
    // preguntar "¿llegó?" por una cita de la próxima semana, ni ofrecer
    // recordatorio de una que ya se atendió.
    let acciones;
    if (c.estado === "atendida") {
      acciones = `<button type="button" class="btn ghost small" data-action="ver-orden" data-orden="${c.ordenId}">Ver orden #${c.ordenId} →</button>`;
    } else if (c.estado === "ausente") {
      acciones = `<button type="button" class="btn ghost small" data-action="reabrir" data-id="${c.id}">Reabrir</button>
        <button type="button" class="btn ghost small" data-action="mover" data-id="${c.id}">📅 Mover</button>
        <button type="button" class="btn ghost small danger" data-action="eliminar" data-id="${c.id}" data-tel="" data-nombre="${esc(nombre)}" title="Eliminar cita" aria-label="Eliminar cita">🗑</button>`;
    } else if (diffDays <= 0) {
      // ya llegó el día (o ya pasó): toca decidir si vino o no
      acciones = `<button class="btn primary small" data-action="llego" data-id="${c.id}">✅ Llegó</button>
        <button type="button" class="btn ghost small" data-action="ausente" data-id="${c.id}">🚫 No llegó</button>
        <button type="button" class="btn ghost small" data-action="mover" data-id="${c.id}">📅 Mover</button>
        <button type="button" class="btn ghost small danger" data-action="eliminar" data-id="${c.id}" data-tel="${esc(telefono)}" data-nombre="${esc(nombre)}" title="Eliminar cita" aria-label="Eliminar cita">🗑</button>`;
    } else {
      acciones = `<button class="btn wa small" data-action="recordar" data-id="${c.id}" data-tel="${esc(telefono)}" data-nombre="${esc(nombre)}">${c.recordatorioEnviado ? "Recordatorio enviado ✓" : "Enviar recordatorio"}</button>
        <button type="button" class="btn ghost small" data-action="mover" data-id="${c.id}">📅 Mover</button>
        <button type="button" class="btn ghost small danger" data-action="eliminar" data-id="${c.id}" data-tel="${esc(telefono)}" data-nombre="${esc(nombre)}" title="Eliminar cita" aria-label="Eliminar cita">🗑</button>`;
    }

    let etiqueta = "";
    if (c.estado === "atendida") etiqueta = '<span class="mant-badge ok">Atendida</span>';
    else if (c.estado === "ausente") etiqueta = '<span class="mant-badge due">No llegó</span>';
    else if (diffDays < 0) etiqueta = '<span class="mant-badge due">Ya pasó — ciérrala</span>';
    const veces = (c.reprogramaciones || []).length;
    if (veces) {
      const desde = new Date(`${c.reprogramaciones[0].de.fecha}T${c.reprogramaciones[0].de.hora}`);
      etiqueta += ` <span class="mant-badge soon" title="Movida desde el ${desde.toLocaleDateString("es-HN")} a las ${c.reprogramaciones[0].de.hora}">🔁 Movida${veces > 1 ? ` ${veces}×` : ""}</span>`;
    }

    return `
      <div class="cita-row${citaCerrada(c) ? " cita-cerrada" : ""}" data-id="${c.id}">
        <div class="cita-when"><div class="d">${label}</div><div class="t">${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div></div>
        <div class="cita-info">
          <div class="who">${esc(nombre)} ${c.origen === "web" ? '<span class="mant-badge soon">Desde la web</span>' : ""} ${etiqueta}</div>
          <div class="meta">${esc(c.motivo || "Sin motivo especificado")} · mecánico: ${esc(c.mecanico)}</div>
        </div>
        <div class="cita-acciones">${acciones}</div>
      </div>`;
  }).join("");

  // "Llegó": abre la orden de servicio ya llena con los datos de la cita
  list.querySelectorAll('[data-action="llego"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await abrirOrdenDesdeCita(Number(btn.dataset.id));
    });
  });

  list.querySelectorAll('[data-action="mover"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await abrirModalMoverCita(Number(btn.dataset.id));
    });
  });

  list.querySelectorAll('[data-action="ausente"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const c = await DB.get("citas", Number(btn.dataset.id));
      await DB.save("citas", { ...c, estado: "ausente", cerradaEn: Date.now() });
      markDirty();
      toast("Cita marcada como no asistida");
      renderCitasList();
      renderDashboard();
    });
  });

  list.querySelectorAll('[data-action="reabrir"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const c = await DB.get("citas", Number(btn.dataset.id));
      delete c.estado; delete c.cerradaEn;
      await DB.save("citas", c);
      markDirty();
      toast("Cita reabierta");
      renderCitasList();
      renderDashboard();
    });
  });

  list.querySelectorAll('[data-action="ver-orden"]').forEach(btn => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); openOrder(Number(btn.dataset.orden)); });
  });

  list.querySelectorAll('[data-action="recordar"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ventanaWA = abrirVentanaWA();
      const id = Number(btn.dataset.id);
      const c = await DB.get("citas", id);
      const { label, dt } = citaWhenInfo(c);
      const texto = `Hola ${btn.dataset.nombre}, te recordamos tu cita en ENTIMOTORS el ${label === "Hoy" || label === "Mañana" ? label.toLowerCase() : dt.toLocaleDateString()} a las ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. ¡Te esperamos!`;
      const sent = navegarWA(ventanaWA, btn.dataset.tel, texto);
      if (!sent) return;
      await DB.save("citas", { ...c, recordatorioEnviado: true });
      markDirty();
      renderCitasList();
    });
  });

  list.querySelectorAll('[data-action="eliminar"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ventanaWA = btn.dataset.tel ? abrirVentanaWA() : null;
      const id = Number(btn.dataset.id);
      const c = await DB.get("citas", id);
      const { label, dt } = citaWhenInfo(c);
      const texto = `Hola ${btn.dataset.nombre}, tu cita en ENTIMOTORS del ${label === "Hoy" || label === "Mañana" ? label.toLowerCase() : dt.toLocaleDateString()} a las ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} fue cancelada. Escríbenos para reprogramarla.`;
      if (btn.dataset.tel) navegarWA(ventanaWA, btn.dataset.tel, texto);
      await DB.delete("citas", id);
      markDirty();
      toast("Cita eliminada" + (btn.dataset.tel ? " y aviso de cancelación abierto en WhatsApp" : ""));
      renderCitasList();
    });
  });

  const dueSoon = abiertas.filter(c => !c.recordatorioEnviado && citaWhenInfo(c).diffDays <= 1 && citaWhenInfo(c).diffDays >= 0).length;
  updateCitasBadge(dueSoon);
}

function updateCitasBadge(n) {
  const b = document.getElementById("citasBadge");
  if (n > 0) { b.style.display = "inline-block"; b.textContent = n; } else { b.style.display = "none"; }
}

let citaClienteSel = null; // clienteId cuando se elige un cliente existente

function renderCitaClienteChip() {
  const wrap = document.getElementById("citaClienteChipWrap");
  wrap.innerHTML = citaClienteSel
    ? `<span class="selected-chip">Cliente existente seleccionado <button type="button" id="btnQuitarCitaClienteSel" title="Quitar selección" aria-label="Quitar cliente seleccionado">✕</button></span>`
    : "";
  document.getElementById("btnQuitarCitaClienteSel")?.addEventListener("click", () => {
    citaClienteSel = null;
    document.getElementById("citaBuscarCliente").value = "";
    renderCitaClienteChip();
  });
}

wireAutocompleteCliente(document.getElementById("citaBuscarCliente"), document.getElementById("citaBuscarClienteList"), (cliente) => {
  citaClienteSel = cliente.id;
  document.getElementById("citaNombre").value = cliente.nombre;
  document.getElementById("citaTelefono").value = cliente.telefono || "";
  renderCitaClienteChip();
});
document.getElementById("citaBuscarCliente").addEventListener("input", () => { citaClienteSel = null; renderCitaClienteChip(); });

async function refreshCitaClienteSelect() {
  document.getElementById("citaMecanico").innerHTML = TEAM.map(t => `<option value="${esc(t.nombre)}">${esc(t.nombre)}</option>`).join("");
}

document.getElementById("btnNuevaCita").addEventListener("click", async () => {
  await refreshCitaClienteSelect();
  citaClienteSel = null;
  document.getElementById("citaBuscarCliente").value = "";
  renderCitaClienteChip();
  ["citaNombre", "citaTelefono", "citaFecha", "citaMotivo"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("citaFecha").min = new Date().toISOString().slice(0, 10); // evita agendar por error en una fecha ya pasada
  await refreshCitaHoraOptions();
  document.getElementById("modalCita").classList.add("active");
});
document.getElementById("btnCancelarCita").addEventListener("click", () => document.getElementById("modalCita").classList.remove("active"));

alHacerClicUnaVez(document.getElementById("btnGuardarCita"), async () => {
  const fecha = document.getElementById("citaFecha").value;
  const hora = document.getElementById("citaHora").value;
  const motivo = document.getElementById("citaMotivo").value.trim();
  const mecanico = document.getElementById("citaMecanico").value;
  if (!fecha) { toast("Elige una fecha", "off"); return; }
  if (!hora) { toast("Elige una hora disponible", "off"); return; }

  let clienteId = null, nombreTmp = "", telefonoTmp = "";
  if (citaClienteSel) {
    clienteId = citaClienteSel;
  } else {
    nombreTmp = document.getElementById("citaNombre").value.trim();
    telefonoTmp = document.getElementById("citaTelefono").value.trim();
    if (!nombreTmp) { toast("Falta el nombre del cliente", "off"); return; }
  }

  // se abre YA, antes del modal de confirmación de choque de horario — ese
  // modal puede tardar segundos en cerrarse (espera a que la persona toque
  // algo), y para cuando eso resuelve, el gesto original ya expiró y
  // window.open() se bloquearía en silencio si se abriera hasta después.
  const mecanicoInfo = TEAM.find(t => t.nombre === mecanico);
  const ventanaWA = mecanicoInfo?.telefono ? abrirVentanaWA() : null;

  if (!(await checkCitaConflicto(fecha, hora, mecanico))) { ventanaWA?.close(); return; }

  const id = await DB.save("citas", { clienteId, nombreTmp, telefonoTmp, fecha, hora, motivo, mecanico, origen: "interna", recordatorioEnviado: false, creadoEn: Date.now() });
  markDirty();
  document.getElementById("modalCita").classList.remove("active");
  toast("Cita guardada");

  const nombreCliente = clienteId ? (await DB.get("clientes", clienteId)).nombre : nombreTmp;
  const texto = `Nueva cita asignada: ${nombreCliente} el ${new Date(`${fecha}T${hora}`).toLocaleDateString()} a las ${hora}. Motivo: ${motivo || "sin especificar"}.`;
  if (mecanicoInfo?.telefono) {
    navegarWA(ventanaWA, mecanicoInfo.telefono, texto);
  } else {
    toast(`${mecanico} no tiene teléfono configurado en TEAM (app.js) — no se pudo abrir el aviso por WhatsApp`, "off");
  }

  renderCitasList();
});

/* ================= CLIENTES ================= */
function mantStatus(moto) {
  if (!moto?.mantenimiento?.fecha) return { cls: "none", label: "Sin programar" };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fecha = new Date(`${moto.mantenimiento.fecha}T00:00:00`);
  const diffDays = Math.round((fecha - today) / 86400000);
  if (diffDays < 0) return { cls: "due", label: `Venció (${fecha.toLocaleDateString()})` };
  if (diffDays === 0) return { cls: "due", label: "Hoy" };
  if (diffDays <= 7) return { cls: "soon", label: `En ${diffDays}d` };
  return { cls: "ok", label: fecha.toLocaleDateString() };
}

/* ---- clientes duplicados: mismo nombre + mismo teléfono ---- */
function dupKey(nombre, telefono) {
  return `${(nombre || "").trim().toLowerCase()}|${(telefono || "").replace(/\D/g, "")}`;
}
function findDuplicateGroups(clientes) {
  const groups = {};
  for (const c of clientes) {
    const k = dupKey(c.nombre, c.telefono);
    if (!k.replace("|", "")) continue;
    (groups[k] = groups[k] || []).push(c);
  }
  return Object.values(groups).filter(g => g.length > 1).map(g => g.sort((a, b) => a.id - b.id));
}
async function checkDuplicateBeforeCreate(nombre, telefono) {
  if (!telefono) return true;
  const clientes = await DB.getAll("clientes");
  const key = dupKey(nombre, telefono);
  const match = clientes.find(c => dupKey(c.nombre, c.telefono) === key);
  if (!match) return true;
  return showConfirm(`Ya existe un cliente "${match.nombre}" con ese mismo nombre y teléfono. ¿Crear un registro nuevo de todas formas? (Cancelar para elegir el existente en su lugar)`, { titulo: "Posible cliente duplicado", textoOk: "Crear de todas formas" });
}
async function mergeClientes(duplicateId, keepId) {
  const [motos, ordenes, citas] = await Promise.all([DB.getAll("motos"), DB.getAll("ordenes"), DB.getAll("citas")]);
  for (const m of motos.filter(x => x.clienteId === duplicateId)) { m.clienteId = keepId; await DB.save("motos", m); }
  for (const o of ordenes.filter(x => x.clienteId === duplicateId)) { o.clienteId = keepId; await DB.save("ordenes", o); }
  for (const c of citas.filter(x => x.clienteId === duplicateId)) { c.clienteId = keepId; await DB.save("citas", c); }
  await DB.delete("clientes", duplicateId);
  markDirty();
}

let clientesFiltro = null; // null | "motos" | "mantenimiento"

async function renderClientes() {
  const [clientesAll, motos] = await Promise.all([DB.getAll("clientes"), DB.getAll("motos")]);
  const dupGroups = findDuplicateGroups(clientesAll);
  const dupOf = {}; // clienteId -> id del registro que se conserva
  dupGroups.forEach(g => g.slice(1).forEach(c => { dupOf[c.id] = g[0].id; }));

  const conMoto = clientesAll.filter(c => motos.some(m => m.clienteId === c.id));
  const conMantenimiento = clientesAll.filter(c => motos.some(m => m.clienteId === c.id && ["due", "soon"].includes(mantStatus(m).cls)));

  renderWidgetRow("clientesWidgetRow", [
    { ic: "👥", val: clientesAll.length, lbl: "Clientes", active: clientesFiltro === null, onClick: () => { clientesFiltro = null; renderClientes(); } },
    { ic: "🏍️", val: motos.length, lbl: "Motos", active: clientesFiltro === "motos", onClick: () => { clientesFiltro = clientesFiltro === "motos" ? null : "motos"; renderClientes(); } },
    { ic: "🛠️", val: countMantenimientos(motos), lbl: "Mantenimiento próximo", active: clientesFiltro === "mantenimiento", onClick: () => { clientesFiltro = clientesFiltro === "mantenimiento" ? null : "mantenimiento"; renderClientes(); } },
  ]);

  let clientes = clientesAll;
  if (clientesFiltro === "motos") clientes = conMoto;
  else if (clientesFiltro === "mantenimiento") clientes = conMantenimiento;

  const body = document.getElementById("clientesBody");
  document.getElementById("clientesEmpty").style.display = clientesAll.length ? "none" : "block";
  if (clientesFiltro && !clientes.length) {
    body.innerHTML = `<tr><td colspan="8" style="color:var(--text-faint); text-align:center; padding:1.5rem 0;">Ningún cliente coincide con este filtro.</td></tr>`;
    return;
  }
  body.innerHTML = clientes.map(c => {
    const m = motos.find(mm => mm.clienteId === c.id);
    const st = mantStatus(m);
    const isDup = dupOf[c.id] != null;
    return `<tr class="cliente-row" data-id="${c.id}" style="cursor:pointer;">
      <td>${m?.foto ? `<img class="thumb-sm" src="${m.foto}">` : ""}</td>
      <td>${esc(c.nombre)} ${isDup ? '<span class="mant-badge due">Posible duplicado</span>' : ""}</td>
      <td>${esc(c.telefono || "—")}</td>
      <td>${m && (m.marca || m.modelo) ? esc((m.marca + " " + m.modelo).trim()) : "—"}</td>
      <td>${esc(m?.placa || "—")}</td>
      <td class="num">${m?.km ?? "—"}</td>
      <td><span class="mant-badge ${st.cls}">${st.label}${m?.mantenimiento?.tipo ? ` · ${esc(m.mantenimiento.tipo)}` : ""}</span></td>
      <td style="display:flex; gap:0.35rem; flex-wrap:wrap;">
        ${m?.mantenimiento?.fecha ? `<button class="btn wa small" data-action="recordar-mant" data-moto="${m.id}" data-cliente="${c.id}">${m.mantenimiento.recordatorioEnviado ? "Enviado ✓" : "Recordar"}</button>` : ""}
        ${isDup ? `<button class="btn small" data-action="unir" data-id="${c.id}" data-keep="${dupOf[c.id]}">Unir</button>` : ""}
        <button type="button" class="btn ghost small danger" data-action="eliminar-cliente" data-id="${c.id}" title="Eliminar cliente" aria-label="Eliminar cliente">🗑</button>
      </td>
    </tr>`;
  }).join("");

  body.querySelectorAll('[data-action="recordar-mant"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ventanaWA = abrirVentanaWA();
      const moto = await DB.get("motos", Number(btn.dataset.moto));
      const cliente = await DB.get("clientes", Number(btn.dataset.cliente));
      const fecha = new Date(`${moto.mantenimiento.fecha}T00:00:00`).toLocaleDateString();
      const texto = `Hola ${cliente.nombre}, tu ${moto.marca} ${moto.modelo} tiene programado "${moto.mantenimiento.tipo || "mantenimiento"}" para el ${fecha}. ¿Agendamos tu cita?`;
      const sent = navegarWA(ventanaWA, cliente.telefono, texto);
      if (!sent) return;
      moto.mantenimiento.recordatorioEnviado = true;
      await DB.save("motos", moto);
      markDirty();
      renderClientes();
    });
  });

  body.querySelectorAll('[data-action="unir"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await mergeClientes(Number(btn.dataset.id), Number(btn.dataset.keep));
      toast("Clientes unidos");
      renderClientes();
    });
  });

  body.querySelectorAll('[data-action="eliminar-cliente"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      const tieneOrdenes = (await DB.getAll("ordenes")).some(o => o.clienteId === id);
      const aviso = tieneOrdenes ? "Este cliente tiene órdenes registradas — se conservarán, pero quedarán sin cliente asociado. " : "";
      if (!(await showConfirm(`${aviso}¿Eliminar este cliente y sus motos?`, { titulo: "Eliminar cliente", textoOk: "Eliminar" }))) return;
      const motosDelCliente = (await DB.getAll("motos")).filter(m => m.clienteId === id);
      for (const m of motosDelCliente) await DB.delete("motos", m.id);
      await DB.delete("clientes", id);
      markDirty();
      toast("Cliente eliminado");
      renderClientes();
    });
  });

  body.querySelectorAll(".cliente-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openClienteDetalle(Number(row.dataset.id));
    });
  });
}

let clienteDetalleId = null; // cliente cuya ficha está abierta, para saber a quién editar

async function openClienteDetalle(id) {
  const cliente = await DB.get("clientes", id);
  if (!cliente) return;
  clienteDetalleId = id;
  const [motos, ordenes, citas] = await Promise.all([DB.getAll("motos"), DB.getAll("ordenes"), DB.getAll("citas")]);
  const susMotos = motos.filter(m => m.clienteId === id);
  const susOrdenes = ordenes.filter(o => o.clienteId === id).sort((a, b) => b.id - a.id);
  const susCitas = citas.filter(c => c.clienteId === id);

  document.getElementById("clienteDetalleTitulo").textContent = cliente.nombre;
  document.getElementById("clienteDetalleSub").textContent = cliente.telefono || "Sin teléfono registrado";

  document.getElementById("clienteDetalleMotos").innerHTML = susMotos.length ? susMotos.map(m => `
    <div class="card" style="margin-bottom:0.6rem; display:flex; gap:0.8rem; align-items:center; flex-wrap:wrap;">
      ${m.foto ? `<img class="thumb-sm" src="${m.foto}" style="width:44px;height:44px;">` : ""}
      <div style="flex:1 1 160px;">
        <b>${esc(m.marca)} ${esc(m.modelo)}</b> · placa ${esc(m.placa || "s/p")} · ${m.km || 0} km
        <div class="mant-badge ${mantStatus(m).cls}" style="display:inline-block; margin-top:0.3rem;">${mantStatus(m).label}</div>
      </div>
      <button type="button" class="btn small seguir-mant-btn" data-moto-id="${m.id}">Dar seguimiento</button>
      <button type="button" class="btn ghost small editar-moto-btn" data-moto-id="${m.id}" title="Editar datos de la moto">✏️</button>
    </div>`).join("") : `<p class="hint" style="margin:0;">Sin motos registradas.</p>`;
  document.querySelectorAll("#clienteDetalleMotos .seguir-mant-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const moto = susMotos.find(m => m.id === Number(btn.dataset.motoId));
      abrirNuevaOrdenParaMoto(cliente, moto);
    });
  });
  document.querySelectorAll("#clienteDetalleMotos .editar-moto-btn").forEach(btn => {
    btn.addEventListener("click", () => abrirModalEditarMoto(Number(btn.dataset.motoId)));
  });

  document.getElementById("clienteDetalleOrdenes").innerHTML = susOrdenes.length ? susOrdenes.map(o => {
    const total = (o.items || []).reduce((s, it) => s + it.cantidad * it.precio, 0);
    return `<div class="order-row" data-id="${o.id}" style="cursor:pointer;">
      <span class="pill ${o.estado}">${STAGES.find(s => s.key === o.estado)?.label ?? o.estado}</span>
      <div class="order-info"><div class="moto">Orden #${o.id}</div><div class="meta">${new Date(o.creadoEn).toLocaleDateString()}</div></div>
      <span class="amount">${money(total)}</span>
    </div>`;
  }).join("") : `<p class="hint" style="margin:0;">Sin órdenes todavía.</p>`;
  document.querySelectorAll("#clienteDetalleOrdenes .order-row").forEach(row => {
    row.addEventListener("click", () => {
      document.getElementById("modalClienteDetalle").classList.remove("active");
      openOrder(Number(row.dataset.id));
      showView("detalle");
    });
  });

  document.getElementById("clienteDetalleCitas").innerHTML = susCitas.length
    ? susCitas.map(c => `<div class="hint cita-mini-row" data-id="${c.id}" style="margin:0 0 0.3rem; cursor:pointer; text-decoration:underline; text-underline-offset:2px;">${c.fecha} ${c.hora} — ${esc(c.motivo || "sin motivo")}</div>`).join("")
    : `<p class="hint" style="margin:0;">Sin citas registradas.</p>`;
  document.querySelectorAll("#clienteDetalleCitas .cita-mini-row").forEach(row => {
    row.addEventListener("click", () => irACitaDesdeClienteDetalle(Number(row.dataset.id)));
  });

  document.getElementById("modalClienteDetalle").classList.add("active");
}

/* ---- editar un cliente ya registrado ----
   El nombre y el teléfono del cliente están copiados dentro de cada crédito y
   de cada venta (para que la factura y el ticket se puedan imprimir sin volver
   a consultar la base). Si solo cambiáramos la ficha del cliente, esos
   documentos seguirían con el dato viejo — y peor: el recordatorio de cobro por
   WhatsApp de un crédito seguiría marcando al teléfono anterior. Por eso al
   guardar se actualizan también esas copias. */
let clienteEnEdicion = null;

async function propagarCambioCliente(clienteId, nombre, telefono) {
  let tocados = 0;
  for (const cred of (await DB.getAll("creditos")).filter(c => c.clienteId === clienteId)) {
    if (cred.clienteNombre === nombre && cred.clienteTelefono === telefono) continue;
    cred.clienteNombre = nombre;
    cred.clienteTelefono = telefono;
    await DB.save("creditos", cred);
    tocados++;
  }
  for (const v of (await DB.getAll("ventas_rapidas")).filter(x => x.clienteId === clienteId)) {
    if (v.clienteNombre === nombre) continue;
    v.clienteNombre = nombre;
    await DB.save("ventas_rapidas", v);
    tocados++;
  }
  return tocados;
}

async function abrirModalEditarCliente(clienteId) {
  const cliente = await DB.get("clientes", clienteId);
  if (!cliente) return;
  clienteEnEdicion = cliente;
  document.getElementById("editClienteNombre").value = cliente.nombre || "";
  document.getElementById("editClienteTelefono").value = cliente.telefono || "";

  const creditosAbiertos = (await DB.getAll("creditos")).filter(c => c.clienteId === clienteId && c.saldo > 0.01).length;
  const aviso = document.getElementById("editClienteAviso");
  if (creditosAbiertos) {
    aviso.textContent = `Este cliente tiene ${creditosAbiertos} crédito${creditosAbiertos === 1 ? "" : "s"} pendiente${creditosAbiertos === 1 ? "" : "s"}: el cambio también se aplicará a esa${creditosAbiertos === 1 ? "" : "s"} factura${creditosAbiertos === 1 ? "" : "s"}.`;
    aviso.style.display = "block";
  } else aviso.style.display = "none";

  document.getElementById("modalEditarCliente").classList.add("active");
  setTimeout(() => document.getElementById("editClienteNombre").focus(), 50);
}

document.getElementById("btnEditarCliente").addEventListener("click", () => {
  if (clienteDetalleId) abrirModalEditarCliente(clienteDetalleId);
});
document.getElementById("btnCancelarEditarCliente").addEventListener("click", () => {
  clienteEnEdicion = null;
  document.getElementById("modalEditarCliente").classList.remove("active");
});

alHacerClicUnaVez(document.getElementById("btnGuardarEditarCliente"), async () => {
  const cliente = clienteEnEdicion;
  if (!cliente) return;
  const nombre = document.getElementById("editClienteNombre").value.trim();
  const telefono = document.getElementById("editClienteTelefono").value.trim();
  if (!nombre) { toast("El nombre no puede quedar vacío", "off"); return; }

  await DB.save("clientes", { ...cliente, nombre, telefono });
  const tocados = await propagarCambioCliente(cliente.id, nombre, telefono);
  markDirty();

  clienteEnEdicion = null;
  document.getElementById("modalEditarCliente").classList.remove("active");
  toast(tocados ? `Datos actualizados (también en ${tocados} documento${tocados === 1 ? "" : "s"})` : "Datos actualizados");
  await renderClientes();
  await openClienteDetalle(cliente.id);
});

/* ---- editar una moto ya registrada ---- */
let motoEnEdicion = null;

async function abrirModalEditarMoto(motoId) {
  const moto = await DB.get("motos", motoId);
  if (!moto) return;
  motoEnEdicion = moto;
  document.getElementById("editMotoMarca").value = moto.marca || "";
  document.getElementById("editMotoModelo").value = moto.modelo || "";
  document.getElementById("editMotoCilindraje").value = moto.cilindraje || "";
  document.getElementById("editMotoPlaca").value = moto.placa || "";
  document.getElementById("editMotoKm").value = moto.km ?? 0;
  document.getElementById("editMotoFoto").value = "";
  document.getElementById("editMotoMantFecha").value = moto.mantenimiento?.fecha || "";
  document.getElementById("editMotoMantTipo").value = moto.mantenimiento?.tipo || "";
  document.getElementById("modalEditarMoto").classList.add("active");
}

document.getElementById("btnCancelarEditarMoto").addEventListener("click", () => {
  motoEnEdicion = null;
  document.getElementById("modalEditarMoto").classList.remove("active");
});

alHacerClicUnaVez(document.getElementById("btnGuardarEditarMoto"), async () => {
  const moto = motoEnEdicion;
  if (!moto) return;
  const fotoFile = document.getElementById("editMotoFoto").files[0];
  const mantFecha = document.getElementById("editMotoMantFecha").value;
  const mantTipo = document.getElementById("editMotoMantTipo").value.trim();

  const actualizada = {
    ...moto,
    marca: document.getElementById("editMotoMarca").value.trim(),
    modelo: document.getElementById("editMotoModelo").value.trim(),
    cilindraje: document.getElementById("editMotoCilindraje").value.trim(),
    placa: document.getElementById("editMotoPlaca").value.trim(),
    km: Number(document.getElementById("editMotoKm").value) || 0,
    // solo se reemplaza la foto si se eligió una nueva
    foto: fotoFile ? await fileToDataUrl(fotoFile) : moto.foto,
    mantenimiento: mantFecha
      // si se cambia la fecha del mantenimiento hay que volver a avisar, así que
      // el recordatorio se reinicia; si la fecha es la misma, se respeta.
      ? { fecha: mantFecha, tipo: mantTipo, recordatorioEnviado: mantFecha === moto.mantenimiento?.fecha ? !!moto.mantenimiento?.recordatorioEnviado : false }
      : null,
  };
  await DB.save("motos", actualizada);
  markDirty();

  motoEnEdicion = null;
  document.getElementById("modalEditarMoto").classList.remove("active");
  toast("Moto actualizada");
  await renderClientes();
  renderDashboard();
  await openClienteDetalle(moto.clienteId);
});

function abrirNuevaOrdenParaMoto(cliente, moto) {
  document.getElementById("modalClienteDetalle").classList.remove("active");
  document.getElementById("btnNuevaOrden").click();
  ordenClienteSel = { clienteId: cliente.id, motoId: moto?.id || null };
  document.getElementById("ordenBuscarCliente").value = cliente.nombre;
  document.getElementById("ordenNombre").value = cliente.nombre;
  document.getElementById("ordenTelefono").value = cliente.telefono || "";
  document.getElementById("ordenPlaca").value = moto?.placa || "";
  document.getElementById("ordenMarca").value = moto?.marca || "";
  document.getElementById("ordenModelo").value = moto?.modelo || "";
  document.getElementById("ordenKm").value = moto?.km || 0;
  renderOrdenClienteChip();
}

async function irACitaDesdeClienteDetalle(citaId) {
  document.getElementById("modalClienteDetalle").classList.remove("active");
  citasFiltro = null;
  showView("citas");
  await renderCitasList();
  const row = document.querySelector(`.cita-row[data-id="${citaId}"]`);
  if (!row) { toast("Esa cita ya no existe", "off"); return; }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("flash-highlight");
  setTimeout(() => row.classList.remove("flash-highlight"), 1800);
}

document.getElementById("btnNuevoCliente").addEventListener("click", () => {
  ["clienteNombre", "clienteTelefono", "clienteMarca", "clienteModelo", "clienteCilindraje", "clientePlaca", "clienteKm", "clienteMantFecha", "clienteMantTipo"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("clienteFoto").value = "";
  document.getElementById("modalCliente").classList.add("active");
});
document.getElementById("btnEmptyNuevoCliente").addEventListener("click", () => document.getElementById("btnNuevoCliente").click());
document.getElementById("btnCancelarCliente").addEventListener("click", () => document.getElementById("modalCliente").classList.remove("active"));
document.getElementById("btnCerrarClienteDetalle").addEventListener("click", () => document.getElementById("modalClienteDetalle").classList.remove("active"));
alHacerClicUnaVez(document.getElementById("btnGuardarCliente"), async () => {
  const nombre = document.getElementById("clienteNombre").value.trim();
  const telefono = document.getElementById("clienteTelefono").value.trim();
  if (!nombre) { toast("Falta el nombre", "off"); return; }
  if (!(await checkDuplicateBeforeCreate(nombre, telefono))) return;
  const clienteId = await DB.save("clientes", { nombre, telefono });
  markDirty();

  const fotoFile = document.getElementById("clienteFoto").files[0];
  const foto = fotoFile ? await fileToDataUrl(fotoFile) : null;
  const mantFecha = document.getElementById("clienteMantFecha").value;

  await DB.save("motos", {
    clienteId,
    marca: document.getElementById("clienteMarca").value.trim(),
    modelo: document.getElementById("clienteModelo").value.trim(),
    cilindraje: document.getElementById("clienteCilindraje").value.trim(),
    placa: document.getElementById("clientePlaca").value.trim(),
    km: Number(document.getElementById("clienteKm").value) || 0,
    foto,
    mantenimiento: mantFecha ? { fecha: mantFecha, tipo: document.getElementById("clienteMantTipo").value.trim(), recordatorioEnviado: false } : null,
  });
  markDirty();
  document.getElementById("modalCliente").classList.remove("active");
  toast("Cliente y moto guardados");
  renderClientes();
});

/* ================= INVENTARIO ================= */
let inventarioFiltro = null; // null | "stockBajo"

async function renderInventario() {
  const invAll = await DB.getAll("inventario");
  const stockBajo = invAll.filter(r => r.cantidad <= (r.stockMinimo ?? 3));
  const valorTotal = invAll.reduce((s, r) => s + r.cantidad * r.precio, 0);

  renderWidgetRow("inventarioWidgetRow", [
    { ic: "📦", val: invAll.length, lbl: "Repuestos", active: inventarioFiltro === null, onClick: () => { inventarioFiltro = null; renderInventario(); } },
    { ic: "⚠️", val: stockBajo.length, lbl: "Stock bajo", active: inventarioFiltro === "stockBajo", onClick: () => { inventarioFiltro = inventarioFiltro === "stockBajo" ? null : "stockBajo"; renderInventario(); } },
    { ic: "💰", val: money(valorTotal), lbl: "Valor en inventario" },
  ]);

  const inv = inventarioFiltro === "stockBajo" ? stockBajo : invAll;

  const body = document.getElementById("inventarioBody");
  document.getElementById("inventarioEmpty").style.display = invAll.length ? "none" : "block";
  if (inventarioFiltro && !inv.length) {
    body.innerHTML = `<tr><td colspan="5" style="color:var(--text-faint); text-align:center; padding:1.5rem 0;">Ningún repuesto coincide con este filtro.</td></tr>`;
    return;
  }
  body.innerHTML = inv.map(r => `
    <tr class="rep-row" data-id="${r.id}">
      <td style="display:flex; align-items:center; gap:0.5rem; cursor:pointer;">${r.foto ? `<img class="thumb-sm" src="${r.foto}">` : ""}${esc(r.nombre)}</td>
      <td style="cursor:pointer;">${esc(r.modelo || "Todos")}</td>
      <td class="num" style="cursor:pointer;">${r.cantidad}</td>
      <td class="num" style="cursor:pointer;">${money(r.precio)}</td>
      <td><label style="display:flex; align-items:center; gap:0.4rem; cursor:pointer; margin:0;"><input type="checkbox" class="chk-publicar" data-id="${r.id}" ${r.publicarEnWeb ? "checked" : ""} style="width:1.05rem; height:1.05rem; margin:0; accent-color:var(--red);"></label></td>
    </tr>`).join("");

  body.querySelectorAll(".rep-row td:not(:last-child)").forEach(td => {
    td.addEventListener("click", () => openRepuestoDetalle(Number(td.closest("tr").dataset.id)));
  });
  body.querySelectorAll(".chk-publicar").forEach(chk => {
    chk.addEventListener("click", (e) => e.stopPropagation());
    chk.addEventListener("change", async () => {
      const r = await DB.get("inventario", Number(chk.dataset.id));
      r.publicarEnWeb = chk.checked;
      await DB.save("inventario", r);
      markDirty();
      toast(chk.checked ? `"${r.nombre}" ahora se muestra en la web` : `"${r.nombre}" ya no se muestra en la web`);
    });
  });
}

async function refreshCategoriaSelect(selected) {
  const cats = await DB.getAll("categorias_inv");
  const sel = document.getElementById("repuestoCategoria");
  sel.innerHTML = `<option value="">Sin categoría</option>` + cats.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join("");
  sel.value = selected ?? "";
}

let repDetalleActualId = null;
async function openRepuestoDetalle(id) {
  const r = await DB.get("inventario", id);
  if (!r) return;
  repDetalleActualId = id;
  document.getElementById("repDetalleNombre").textContent = r.nombre;
  document.getElementById("repDetalleModelo").textContent = `Modelo compatible: ${r.modelo || "Todos"}`;
  document.getElementById("repDetalleCantidad").textContent = r.cantidad;
  document.getElementById("repDetallePrecio").textContent = money(r.precio);
  document.getElementById("repDetalleFotoWrap").innerHTML = r.foto ? `<img src="${r.foto}" style="width:100%; max-height:220px; object-fit:cover; border-radius:0.6rem; border:1px solid var(--border);">` : "";
  document.getElementById("modalRepuestoDetalle").classList.add("active");
}
document.getElementById("btnCerrarRepuestoDetalle").addEventListener("click", () => document.getElementById("modalRepuestoDetalle").classList.remove("active"));
document.getElementById("btnEditarRepuesto").addEventListener("click", async () => {
  const r = await DB.get("inventario", repDetalleActualId);
  if (!r) return;
  repuestoEditId = r.id;
  document.getElementById("repuestoNombre").value = r.nombre || "";
  document.getElementById("repuestoModelo").value = r.modelo || "";
  document.getElementById("repuestoCantidad").value = r.cantidad || 0;
  document.getElementById("repuestoPrecio").value = r.precio || 0;
  document.getElementById("repuestoCosto").value = r.costoCompra || 0;
  document.getElementById("repuestoStockMinimo").value = r.stockMinimo ?? 3;
  document.getElementById("repuestoCodigoBarras").value = r.codigoBarras || "";
  document.getElementById("repuestoPublicarWeb").checked = !!r.publicarEnWeb;
  document.getElementById("repuestoFoto").value = "";
  await refreshCategoriaSelect(r.categoriaId);
  document.getElementById("modalRepuestoDetalle").classList.remove("active");
  document.getElementById("modalRepuesto").classList.add("active");
});

let repuestoEditId = null;
document.getElementById("btnNuevoRepuesto").addEventListener("click", async () => {
  repuestoEditId = null;
  ["repuestoNombre", "repuestoModelo", "repuestoPrecio", "repuestoCodigoBarras"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("repuestoCantidad").value = 1;
  document.getElementById("repuestoCosto").value = 0;
  document.getElementById("repuestoStockMinimo").value = 3;
  document.getElementById("repuestoPublicarWeb").checked = false;
  document.getElementById("repuestoFoto").value = "";
  await refreshCategoriaSelect();
  document.getElementById("modalRepuesto").classList.add("active");
});
document.getElementById("btnEmptyNuevoRepuesto").addEventListener("click", () => document.getElementById("btnNuevoRepuesto").click());
document.getElementById("btnCancelarRepuesto").addEventListener("click", () => document.getElementById("modalRepuesto").classList.remove("active"));

document.getElementById("btnNuevaCategoriaInv").addEventListener("click", async () => {
  const nombre = await showPrompt("Nombre de la categoría", { titulo: "Nueva categoría" });
  if (!nombre) return;
  const id = await DB.save("categorias_inv", { nombre });
  markDirty();
  await refreshCategoriaSelect(id);
});

alHacerClicUnaVez(document.getElementById("btnGuardarRepuesto"), async () => {
  const nombre = document.getElementById("repuestoNombre").value.trim();
  if (!nombre) { toast("Falta el nombre del repuesto", "off"); return; }
  const fotoFile = document.getElementById("repuestoFoto").files[0];
  const foto = fotoFile ? await fileToDataUrl(fotoFile) : (repuestoEditId ? (await DB.get("inventario", repuestoEditId))?.foto : null);
  const precio = Number(document.getElementById("repuestoPrecio").value) || 0;
  const cantidad = Number(document.getElementById("repuestoCantidad").value) || 0;
  const costoCompra = Number(document.getElementById("repuestoCosto").value) || 0;
  const stockMinimo = Number(document.getElementById("repuestoStockMinimo").value) || 0;
  if (precio < 0 || cantidad < 0 || costoCompra < 0 || stockMinimo < 0) {
    toast("El precio, la cantidad, el costo y el stock mínimo no pueden ser negativos", "off");
    return;
  }
  const registro = {
    nombre,
    modelo: document.getElementById("repuestoModelo").value.trim(),
    cantidad,
    precio,
    precioVenta: precio,
    costoCompra,
    stockMinimo,
    codigoBarras: document.getElementById("repuestoCodigoBarras").value.trim(),
    categoriaId: document.getElementById("repuestoCategoria").value ? Number(document.getElementById("repuestoCategoria").value) : null,
    publicarEnWeb: document.getElementById("repuestoPublicarWeb").checked,
    foto,
  };
  if (repuestoEditId) registro.id = repuestoEditId;
  await DB.save("inventario", registro);
  markDirty();
  document.getElementById("modalRepuesto").classList.remove("active");
  toast(repuestoEditId ? "Repuesto actualizado" : "Repuesto agregado");
  repuestoEditId = null;
  renderInventario();
});

document.getElementById("btnExportarCSV").addEventListener("click", async () => {
  const inv = await DB.getAll("inventario");
  if (!inv.length) { toast("El inventario está vacío", "off"); return; }
  const csv = ["nombre,cantidad,precio,modelo", ...inv.map(r => [r.nombre, r.cantidad, r.precio, r.modelo || ""].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inventario_entimotors_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("CSV exportado");
});

document.getElementById("csvInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const rows = text.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  let count = 0;
  for (const row of rows) {
    const [nombre, cantidad, precio, modelo] = row.split(",").map(s => (s || "").trim());
    if (!nombre || nombre.toLowerCase() === "nombre") continue;
    await DB.save("inventario", { nombre, modelo: modelo || "", cantidad: Number(cantidad) || 0, precio: Number(precio) || 0 });
    count++;
  }
  markDirty();
  e.target.value = "";
  toast(`${count} repuestos importados del CSV`);
  renderInventario();
});

/* ================= VENTA RÁPIDA (TPV) ================= */
let posCarrito = []; // { inventarioId|null, nombre, cantidad, precio, stockDisponible }
let posCategoriaFiltro = null;
let posBusqueda = "";

async function refreshPosClienteSelect() {
  const clientes = await DB.getAll("clientes");
  const sel = document.getElementById("posCliente");
  const actual = sel.value;
  sel.innerHTML = `<option value="">Cliente de mostrador</option>` + clientes.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join("");
  sel.value = actual;
}

async function renderPOS() {
  const [inv, cats] = await Promise.all([DB.getAll("inventario"), DB.getAll("categorias_inv")]);
  await refreshPosClienteSelect();

  document.getElementById("posCategorias").innerHTML = [{ id: null, nombre: "Todas" }, ...cats].map(c => `
    <button type="button" class="cat-chip ${posCategoriaFiltro === c.id ? "active" : ""}" data-cat="${c.id ?? ""}">${esc(c.nombre)}</button>
  `).join("");
  document.getElementById("posCategorias").querySelectorAll(".cat-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      posCategoriaFiltro = btn.dataset.cat === "" ? null : Number(btn.dataset.cat);
      renderPOS();
    });
  });

  const q = posBusqueda.trim().toLowerCase();
  const productos = inv.filter(r => {
    if (posCategoriaFiltro !== null && r.categoriaId !== posCategoriaFiltro) return false;
    if (!q) return true;
    return r.nombre.toLowerCase().includes(q) || (r.codigoBarras || "").toLowerCase().includes(q);
  });

  const grid = document.getElementById("posGrid");
  grid.innerHTML = productos.length ? productos.map(r => `
    <button type="button" class="pos-prod" data-id="${r.id}" ${r.cantidad <= 0 ? "disabled" : ""}>
      ${r.foto ? `<img src="${r.foto}">` : `<div style="height:70px; display:flex; align-items:center; justify-content:center; background:var(--panel-strong); border-radius:0.4rem; font-size:1.6rem;">🔧</div>`}
      <span class="nom">${esc(r.nombre)}</span>
      <span class="pr">${money(r.precio)}</span>
      <span class="st">${r.cantidad > 0 ? `${r.cantidad} en stock` : "Sin stock"}</span>
    </button>`).join("") : `<div class="empty">Ningún repuesto coincide con la búsqueda.</div>`;

  grid.querySelectorAll(".pos-prod").forEach(btn => {
    btn.addEventListener("click", () => agregarAlCarritoPOS(Number(btn.dataset.id)));
  });

  renderPosCarrito();
}

async function agregarAlCarritoPOS(inventarioId) {
  const r = await DB.get("inventario", inventarioId);
  if (!r || r.cantidad <= 0) return;
  const existente = posCarrito.find(it => it.inventarioId === inventarioId);
  const enCarrito = existente ? existente.cantidad : 0;
  if (enCarrito + 1 > r.cantidad) { toast(`Solo hay ${r.cantidad} en stock de "${r.nombre}"`, "off"); return; }
  if (existente) existente.cantidad++;
  else posCarrito.push({ inventarioId, nombre: r.nombre, cantidad: 1, precio: r.precio, stockDisponible: r.cantidad });
  renderPosCarrito();
}

function renderPosCarrito() {
  const el = document.getElementById("posCarrito");
  if (!posCarrito.length) {
    el.innerHTML = `<div class="empty" style="padding:1rem 0;">Toca un producto para agregarlo</div>`;
  } else {
    el.innerHTML = posCarrito.map((it, i) => `
      <div class="pos-cart-item">
        <span class="nom">${esc(it.nombre)}</span>
        <div class="pos-qty">
          <button type="button" data-menos="${i}" aria-label="Restar cantidad">−</button>
          <span>${it.cantidad}</span>
          <button type="button" data-mas="${i}" aria-label="Sumar cantidad">+</button>
        </div>
        <span style="width:70px; text-align:right;">${money(it.cantidad * it.precio)}</span>
        <button type="button" class="btn ghost small danger" data-quitar="${i}" title="Quitar" aria-label="Quitar del carrito">🗑</button>
      </div>`).join("");
    el.querySelectorAll("[data-mas]").forEach(b => b.addEventListener("click", () => {
      const it = posCarrito[Number(b.dataset.mas)];
      if (it.inventarioId && it.cantidad + 1 > it.stockDisponible) { toast(`Solo hay ${it.stockDisponible} en stock`, "off"); return; }
      it.cantidad++; renderPosCarrito();
    }));
    el.querySelectorAll("[data-menos]").forEach(b => b.addEventListener("click", () => {
      const it = posCarrito[Number(b.dataset.menos)];
      it.cantidad--; if (it.cantidad <= 0) posCarrito.splice(Number(b.dataset.menos), 1);
      renderPosCarrito();
    }));
    el.querySelectorAll("[data-quitar]").forEach(b => b.addEventListener("click", () => {
      posCarrito.splice(Number(b.dataset.quitar), 1); renderPosCarrito();
    }));
  }

  const total = posCarrito.reduce((s, it) => s + it.cantidad * it.precio, 0);
  document.getElementById("posTotal").textContent = money(total);
  actualizarCambioPOS();
  if (posTipoCobro === "credito") actualizarCajaCreditoPOS();
}

function actualizarCambioPOS() {
  const total = posCarrito.reduce((s, it) => s + it.cantidad * it.precio, 0);
  const metodo = document.getElementById("posMetodo").value;
  document.getElementById("posEfectivoBox").style.display = metodo === "efectivo" ? "block" : "none";
  const recibido = Number(document.getElementById("posEfectivoRecibido").value) || 0;
  document.getElementById("posCambio").textContent = money(Math.max(0, recibido - total));
}

// nombre libre del cliente (para facturas a clientes no registrados) — se llena
// desde el modal "Cobrar servicio" y se usa al cobrar mientras no se elija un
// cliente registrado del <select>.
let posClienteLibre = "";

function abrirModalServicioPOS() {
  document.getElementById("servicioPOSNombre").value = "";
  document.getElementById("servicioPOSCantidad").value = "1";
  document.getElementById("servicioPOSPrecio").value = "";
  document.getElementById("servicioPOSCliente").value = posClienteLibre;
  document.getElementById("servicioPOSMetodo").value = "efectivo";
  document.getElementById("servicioPOSEfectivoRecibido").value = "";
  document.getElementById("servicioPOSAbono").value = "";
  servicioPOSTipo = "contado";
  document.getElementById("servicioPOSTipoCobro").querySelectorAll(".seg-opt")
    .forEach(b => b.classList.toggle("active", b.dataset.tipo === "contado"));
  aplicarTipoCobroServicioPOS();
  document.getElementById("modalServicioPOS").classList.add("active");
  actualizarCambioServicioPOS();
  setTimeout(() => document.getElementById("servicioPOSNombre").focus(), 50);
}
function cerrarModalServicioPOS() { document.getElementById("modalServicioPOS").classList.remove("active"); }

document.getElementById("btnAgregarServicioPOS").addEventListener("click", abrirModalServicioPOS);
document.getElementById("btnCancelarServicioPOS").addEventListener("click", cerrarModalServicioPOS);

function actualizarCambioServicioPOS() {
  const cantidad = Number(document.getElementById("servicioPOSCantidad").value) || 0;
  const precio = Number(document.getElementById("servicioPOSPrecio").value) || 0;
  const total = posCarrito.reduce((s, it) => s + it.cantidad * it.precio, 0) + cantidad * precio;
  const metodo = document.getElementById("servicioPOSMetodo").value;
  document.getElementById("servicioPOSEfectivoBox").style.display = metodo === "efectivo" ? "block" : "none";
  const recibido = Number(document.getElementById("servicioPOSEfectivoRecibido").value) || 0;
  document.getElementById("servicioPOSCambio").textContent = money(Math.max(0, recibido - total));
}
["servicioPOSMetodo", "servicioPOSEfectivoRecibido", "servicioPOSCantidad", "servicioPOSPrecio"].forEach(id => {
  document.getElementById(id).addEventListener("input", actualizarCambioServicioPOS);
  document.getElementById(id).addEventListener("change", actualizarCambioServicioPOS);
});

/* ---- Contado vs Crédito dentro del modal "Cobrar servicio" ---- */
let servicioPOSTipo = "contado";

// total = lo que ya hay en el carrito + el servicio que se está escribiendo
function totalServicioPOS() {
  const cantidad = Number(document.getElementById("servicioPOSCantidad").value) || 0;
  const precio = Number(document.getElementById("servicioPOSPrecio").value) || 0;
  return totalPosCarrito() + cantidad * precio;
}

function actualizarSaldoServicioPOS() {
  const abono = Number(document.getElementById("servicioPOSAbono").value) || 0;
  document.getElementById("servicioPOSSaldo").textContent = money(Math.max(0, totalServicioPOS() - abono));
  document.getElementById("servicioPOSAbonoMetodoBox").style.display = abono > 0 ? "block" : "none";
}

function aplicarTipoCobroServicioPOS() {
  const credito = servicioPOSTipo === "credito";
  document.getElementById("servicioPOSContadoBox").style.display = credito ? "none" : "block";
  document.getElementById("servicioPOSCreditoBox").style.display = credito ? "block" : "none";
  document.getElementById("btnCobrarServicioPOS").textContent = credito ? "💳 Registrar crédito" : "💵 Cobrar ahora";
  if (credito) actualizarSaldoServicioPOS();
}

document.getElementById("servicioPOSTipoCobro").querySelectorAll(".seg-opt").forEach(btn => {
  btn.addEventListener("click", () => {
    servicioPOSTipo = btn.dataset.tipo;
    document.getElementById("servicioPOSTipoCobro").querySelectorAll(".seg-opt").forEach(b => b.classList.toggle("active", b === btn));
    aplicarTipoCobroServicioPOS();
  });
});
["servicioPOSAbono", "servicioPOSCantidad", "servicioPOSPrecio"].forEach(id => {
  document.getElementById(id).addEventListener("input", () => { if (servicioPOSTipo === "credito") actualizarSaldoServicioPOS(); });
});

/* El nombre escrito en el modal es una decisión explícita para ESTA factura,
   así que gana sobre el cliente que hubiera quedado elegido en la lista de una
   venta anterior — si no, el crédito se le cargaba al cliente equivocado. */
function tomarClienteDelModalServicio() {
  const escrito = document.getElementById("servicioPOSCliente").value.trim();
  posClienteLibre = escrito;
  if (escrito) document.getElementById("posCliente").value = "";
}

function validarServicioPOS() {
  const nombre = document.getElementById("servicioPOSNombre").value.trim();
  const cantidad = Number(document.getElementById("servicioPOSCantidad").value) || 1;
  const precio = Number(document.getElementById("servicioPOSPrecio").value);
  if (!nombre) { toast("Escribe el nombre del servicio", "off"); return null; }
  if (cantidad <= 0) { toast("La cantidad debe ser mayor a 0", "off"); return null; }
  if (!(precio >= 0)) { toast("El precio no puede ser negativo", "off"); return null; }
  return { nombre, cantidad, precio };
}

alHacerClicUnaVez(document.getElementById("btnGuardarServicioPOS"), async () => {
  const item = validarServicioPOS();
  if (!item) return;
  // inventarioId: null → registrarVentaRapida lo trata como ítem manual sin tocar stock
  posCarrito.push({ inventarioId: null, ...item });
  tomarClienteDelModalServicio();
  cerrarModalServicioPOS();
  renderPosCarrito();
  toast(`"${item.nombre}" agregado al carrito`);
});

alHacerClicUnaVez(document.getElementById("btnCobrarServicioPOS"), async () => {
  const item = validarServicioPOS();
  if (!item) return;

  if (servicioPOSTipo === "credito") {
    tomarClienteDelModalServicio();
    const sel = document.getElementById("posCliente");
    if (!sel.value && !posClienteLibre) { toast("Escribe el nombre del cliente para el crédito", "off"); return; }
    const abono = Number(document.getElementById("servicioPOSAbono").value) || 0;
    if (abono > totalServicioPOS() + 0.01) { toast("El abono no puede ser mayor al total", "off"); return; }
    // se agrega al carrito solo después de validar, para que un reintento no lo duplique
    posCarrito.push({ inventarioId: null, ...item });
    document.getElementById("posAbonoInicial").value = abono || "";
    document.getElementById("posAbonoMetodo").value = document.getElementById("servicioPOSAbonoMetodo").value;
    const ok = await cobrarCreditoPOS();
    if (ok) cerrarModalServicioPOS();
    else posCarrito.pop(); // no se registró: devolvemos el carrito como estaba
    return;
  }

  const metodoPago = document.getElementById("servicioPOSMetodo").value;
  const efectivoRecibido = Number(document.getElementById("servicioPOSEfectivoRecibido").value) || 0;
  const totalConServicio = posCarrito.reduce((s, it) => s + it.cantidad * it.precio, 0) + item.cantidad * item.precio;
  if (metodoPago === "efectivo" && efectivoRecibido < totalConServicio) { toast("El efectivo recibido es menor que el total", "off"); return; }
  posCarrito.push({ inventarioId: null, ...item });
  tomarClienteDelModalServicio();
  const ok = await cobrarVentaPOS(metodoPago, efectivoRecibido);
  if (ok) cerrarModalServicioPOS();
});

/* ---- Contado vs Crédito en el TPV ---- */
let posTipoCobro = "contado";

function totalPosCarrito() { return posCarrito.reduce((s, it) => s + it.cantidad * it.precio, 0); }

function actualizarCajaCreditoPOS() {
  const total = totalPosCarrito();
  const abono = Number(document.getElementById("posAbonoInicial").value) || 0;
  document.getElementById("posSaldoCredito").textContent = money(Math.max(0, total - abono));
  document.getElementById("posAbonoMetodoBox").style.display = abono > 0 ? "block" : "none";
}

function aplicarTipoCobroPOS() {
  const credito = posTipoCobro === "credito";
  document.getElementById("posContadoBox").style.display = credito ? "none" : "block";
  document.getElementById("posCreditoBox").style.display = credito ? "block" : "none";
  // al crédito hay que saber a quién cobrarle, así que el cliente deja de ser opcional
  document.getElementById("posClienteLabel").textContent = credito ? "Cliente (obligatorio para crédito)" : "Cliente (opcional)";
  document.getElementById("btnCobrar").textContent = credito ? "Registrar crédito" : "Cobrar";
  if (credito) actualizarCajaCreditoPOS();
}

document.getElementById("posTipoCobro").querySelectorAll(".seg-opt").forEach(btn => {
  btn.addEventListener("click", () => {
    posTipoCobro = btn.dataset.tipo;
    document.getElementById("posTipoCobro").querySelectorAll(".seg-opt").forEach(b => b.classList.toggle("active", b === btn));
    aplicarTipoCobroPOS();
  });
});
document.getElementById("posAbonoInicial").addEventListener("input", actualizarCajaCreditoPOS);

document.getElementById("posBuscar").addEventListener("input", (e) => { posBusqueda = e.target.value; renderPOS(); });
document.getElementById("posCliente").addEventListener("change", (e) => {
  if (e.target.value) posClienteLibre = "";
});
document.getElementById("posMetodo").addEventListener("change", actualizarCambioPOS);
document.getElementById("posEfectivoRecibido").addEventListener("input", actualizarCambioPOS);

// lógica compartida por el botón "Cobrar" del carrito y "Cobrar ahora" del modal
// de servicio — cobra TODO lo que haya en posCarrito en ese momento.
// cobra el carrito al crédito: crea la factura pendiente en Créditos con lo
// abonado y lo que resta, en vez de registrar una venta cobrada.
async function cobrarCreditoPOS() {
  if (!posCarrito.length) { toast("El carrito está vacío", "off"); return false; }
  const total = totalPosCarrito();
  const abono = Number(document.getElementById("posAbonoInicial").value) || 0;
  if (abono < 0) { toast("El abono no puede ser negativo", "off"); return false; }
  if (abono > total + 0.01) { toast(`El abono no puede ser mayor al total (${money(total)})`, "off"); return false; }

  const sel = document.getElementById("posCliente");
  const cli = await resolverClienteCredito(sel.value ? Number(sel.value) : null, posClienteLibre);
  if (!cli) { toast("Para vender al crédito elige un cliente o escribe su nombre", "off"); return false; }

  try {
    const { id, credito } = await cobrarAlCredito({
      ...cli,
      items: posCarrito.map(it => ({ inventarioId: it.inventarioId, nombre: it.nombre, cantidad: it.cantidad, precio: it.precio })),
      abono, abonoMetodo: document.getElementById("posAbonoMetodo").value,
      nota: "Venta al crédito desde el TPV", origen: "pos",
    });
    ultimoCreditoPOS = credito;
    imprimirFacturaCredito(credito, abrirVentanaImpresion());
    toast(abono > 0
      ? `Crédito #${id} registrado — abonó ${money(abono)}, queda debiendo ${money(credito.saldo)}`
      : `Crédito #${id} registrado — queda debiendo ${money(credito.saldo)}`);
    posCarrito = [];
    posClienteLibre = "";
    document.getElementById("posAbonoInicial").value = "";
    renderPOS();
    renderDashboard();
    aplicarTipoCobroPOS();
    return true;
  } catch (err) {
    toast("No se pudo registrar el crédito: " + err.message, "off");
    return false;
  }
}
let ultimoCreditoPOS = null;

async function cobrarVentaPOS(metodoPago, efectivoRecibido) {
  if (!posCarrito.length) { toast("El carrito está vacío", "off"); return false; }
  const total = posCarrito.reduce((s, it) => s + it.cantidad * it.precio, 0);
  if (metodoPago === "efectivo" && efectivoRecibido < total) { toast("El efectivo recibido es menor que el total", "off"); return false; }
  const posClienteSelect = document.getElementById("posCliente");
  const clienteId = posClienteSelect.value ? Number(posClienteSelect.value) : null;
  // el nombre se resuelve aquí (del <select> ya cargado o del nombre libre capturado
  // en el modal "Cobrar servicio") y se guarda tal cual en la venta, para que el
  // ticket lo muestre sin tener que consultar la BD de nuevo en imprimirTicketPOS
  // — eso mantendría el segundo clic 100% sincrónico.
  const clienteNombre = clienteId
    ? posClienteSelect.options[posClienteSelect.selectedIndex].textContent
    : (posClienteLibre || null);

  try {
    const { id, venta } = await registrarVentaRapida({
      items: posCarrito.map(it => ({ inventarioId: it.inventarioId, nombre: it.nombre, cantidad: it.cantidad, precio: it.precio })),
      clienteId, clienteNombre, metodoPago, efectivoRecibido,
    });
    markDirty();
    ultimoTicket = { id, venta };
    document.getElementById("btnReimprimirTicket").style.display = "block";
    imprimirTicketPOS(id, venta, abrirVentanaImpresion());
    toast(`Venta #${id} registrada por ${money(total)}`);
    posCarrito = [];
    posClienteLibre = "";
    document.getElementById("posEfectivoRecibido").value = "";
    renderPOS();
    renderDashboard();
    return true;
  } catch (err) {
    toast("No se pudo registrar la venta: " + err.message, "off");
    return false;
  }
}

alHacerClicUnaVez(document.getElementById("btnCobrar"), async () => {
  if (posTipoCobro === "credito") { await cobrarCreditoPOS(); return; }
  const metodoPago = document.getElementById("posMetodo").value;
  const efectivoRecibido = Number(document.getElementById("posEfectivoRecibido").value) || 0;
  await cobrarVentaPOS(metodoPago, efectivoRecibido);
});

let ultimoTicket = null; // { id, venta } — para el botón "Reimprimir último ticket"
document.getElementById("btnReimprimirTicket").addEventListener("click", () => {
  // clic nuevo y 100% sincrónico: si el print automático de después de cobrar
  // no se disparó en el celular (por el gesto ya vencido), este sí funciona,
  // porque no espera ningún await antes de llamar a window.print().
  if (!ultimoTicket) return;
  imprimirTicketPOS(ultimoTicket.id, ultimoTicket.venta, abrirVentanaImpresion());
});

function imprimirTicketPOS(ventaId, venta, ventana) {
  document.getElementById("ticketFecha").textContent = new Date(venta.fechaISO).toLocaleString("es-HN");
  const clienteRow = document.getElementById("ticketClienteRow");
  if (venta.clienteNombre) {
    document.getElementById("ticketCliente").textContent = venta.clienteNombre;
    clienteRow.style.display = "block";
  } else {
    clienteRow.style.display = "none";
  }
  document.getElementById("ticketItems").innerHTML = venta.items.map(it => `
    <div class="ticket-item-row"><span>${esc(it.nombre)} x${it.cantidad}</span><span>${money(it.cantidad * it.precio)}</span></div>
  `).join("");
  document.getElementById("ticketTotal").textContent = money(venta.total);
  document.getElementById("ticketMetodo").textContent = { efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta" }[venta.metodoPago] || venta.metodoPago;
  document.getElementById("ticketCambioRow").style.display = venta.metodoPago === "efectivo" ? "flex" : "none";
  document.getElementById("ticketCambio").textContent = money(venta.cambio || 0);
  imprimirPlantilla("ticketPrint", "print-ticket", ventana);
}

/* ================= FINANZAS Y CAJA CHICA ================= */
async function renderFinanzas() {
  const movs = await DB.getAll("caja_movimientos");
  const desdeEl = document.getElementById("finDesde");
  const hastaEl = document.getElementById("finHasta");
  if (!desdeEl.value) {
    const d = new Date(); d.setDate(d.getDate() - 30);
    desdeEl.value = d.toISOString().slice(0, 10);
  }
  if (!hastaEl.value) hastaEl.value = new Date().toISOString().slice(0, 10);

  const desde = desdeEl.value, hasta = hastaEl.value, tipoFiltro = document.getElementById("finTipoFiltro").value;
  const filtrados = movs.filter(m => {
    const dia = m.fechaISO.slice(0, 10);
    if (dia < desde || dia > hasta) return false;
    if (tipoFiltro && m.tipo !== tipoFiltro) return false;
    return true;
  }).sort((a, b) => b.fechaISO.localeCompare(a.fechaISO));

  const ingresos = filtrados.filter(m => m.tipo === "ingreso").reduce((s, m) => s + m.monto, 0);
  const egresos = filtrados.filter(m => m.tipo === "egreso").reduce((s, m) => s + m.monto, 0);

  // Costo estimado: costoCompra de los repuestos vendidos por TPV en el rango filtrado.
  const ventas = (await DB.getAll("ventas_rapidas")).filter(v => { const d = v.fechaISO.slice(0, 10); return d >= desde && d <= hasta; });
  let costoVentas = 0;
  const inv = await DB.getAll("inventario");
  ventas.forEach(v => v.items.forEach(it => {
    if (!it.inventarioId) return;
    const rep = inv.find(r => r.id === it.inventarioId);
    if (rep) costoVentas += (rep.costoCompra || 0) * it.cantidad;
  }));
  const costosTotal = egresos + costoVentas;
  const utilidad = ingresos - costosTotal;
  const margen = ingresos > 0 ? (utilidad / ingresos) * 100 : 0;

  // saldo pendiente de créditos: es un saldo vivo, no depende del rango de
  // fechas filtrado — por eso se calcula aparte de "filtrados".
  const creditos = await DB.getAll("creditos");
  const creditosPendientes = creditos.filter(c => c.estado !== "pagado");
  const cuentasPorCobrar = creditosPendientes.reduce((s, c) => s + c.saldo, 0);

  document.getElementById("finanzasResumen").innerHTML = `
    <div class="widget-card tint-green"><span class="eyebrow">Ingresos totales</span><span class="big">${money(ingresos)}</span><span class="sub">En el rango filtrado</span></div>
    <div class="widget-card tint-red"><span class="eyebrow">Costos</span><span class="big">${money(costosTotal)}</span><span class="sub">Egresos + costo de repuestos vendidos</span></div>
    <div class="widget-card ${utilidad >= 0 ? "tint-green" : "tint-red"}"><span class="eyebrow">Utilidad neta</span><span class="big">${money(utilidad)}</span><span class="sub">Ingresos − costos</span></div>
    <div class="widget-card"><span class="eyebrow" style="color:var(--text-faint);">Margen promedio</span><span class="big">${margen.toFixed(1)}%</span><span class="sub">Utilidad / ingresos</span></div>
    <button type="button" class="widget-card ${cuentasPorCobrar > 0 ? "tint-amber" : ""}" id="cardCuentasPorCobrar" style="text-align:left; font-family:inherit; cursor:pointer;">
      <span class="eyebrow">Cuentas por cobrar</span><span class="big">${money(cuentasPorCobrar)}</span><span class="sub">Saldo pendiente en créditos activos</span>
    </button>
    <button type="button" class="widget-card" id="cardCreditosActivos" style="text-align:left; font-family:inherit; cursor:pointer;">
      <span class="eyebrow" style="color:var(--text-faint);">Créditos activos</span><span class="big">${creditosPendientes.length}</span><span class="sub">Clientes con saldo pendiente</span>
    </button>
  `;
  ["cardCuentasPorCobrar", "cardCreditosActivos"].forEach(id => {
    document.getElementById(id).addEventListener("click", () => {
      showView("creditos");
      document.querySelectorAll(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === "creditos"));
      renderCreditos();
    });
  });

  const body = document.getElementById("movimientosBody");
  document.getElementById("movimientosEmpty").style.display = filtrados.length ? "none" : "block";
  const metodoLabel = { efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta" };
  body.innerHTML = filtrados.map(m => `
    <tr>
      <td>${new Date(m.fechaISO).toLocaleDateString("es-HN")}</td>
      <td><span class="pill ${m.tipo === "ingreso" ? "entregado" : "reparacion"}">${m.tipo === "ingreso" ? "Ingreso" : "Egreso"}</span></td>
      <td>${esc(m.categoria)}</td>
      <td>${esc(metodoLabel[m.metodoPago] || "—")}</td>
      <td>${esc(m.descripcion || "")}</td>
      <td class="num">${money(m.monto)}</td>
      <td class="num"><button type="button" class="btn ghost small danger" data-eliminar-movi="${m.id}" title="Eliminar" aria-label="Eliminar movimiento">🗑</button></td>
    </tr>`).join("");
  body.querySelectorAll("[data-eliminar-movi]").forEach(btn => {
    btn.addEventListener("click", () => {
      requestAdminCode(async () => {
        await DB.delete("caja_movimientos", Number(btn.dataset.eliminarMovi));
        markDirty();
        toast("Movimiento eliminado");
        renderFinanzas();
        renderDashboard();
      });
    });
  });

  await renderFinanzasCharts();
}

document.getElementById("btnFiltrarFinanzas").addEventListener("click", renderFinanzas);
alHacerClicUnaVez(document.getElementById("btnGuardarMovimiento"), async () => {
  const monto = Number(document.getElementById("moviMonto").value) || 0;
  if (monto <= 0) { toast("El monto debe ser mayor a cero", "off"); return; }
  await DB.save("caja_movimientos", {
    tipo: document.getElementById("moviTipo").value,
    categoria: document.getElementById("moviCategoria").value,
    monto,
    metodoPago: document.getElementById("moviMetodo").value,
    descripcion: document.getElementById("moviDescripcion").value.trim(),
    fechaISO: new Date().toISOString(), creadoEn: Date.now(),
  });
  markDirty();
  document.getElementById("moviMonto").value = "";
  document.getElementById("moviDescripcion").value = "";
  toast("Movimiento registrado");
  renderFinanzas();
  renderDashboard();
});

document.getElementById("btnImprimirCierre").addEventListener("click", async () => {
  const ventana = abrirVentanaImpresion(); // sincrónico, antes del await de abajo
  const hoyStr = new Date().toISOString().slice(0, 10);
  const movsHoy = (await DB.getAll("caja_movimientos")).filter(m => m.fechaISO.slice(0, 10) === hoyStr).sort((a, b) => a.fechaISO.localeCompare(b.fechaISO));

  if (!movsHoy.length) { ventana?.close(); toast("No hay movimientos registrados hoy todavía", "off"); return; }

  document.getElementById("cierreFecha").textContent = new Date().toLocaleDateString("es-HN", { day: "2-digit", month: "long", year: "numeric" });
  document.getElementById("cierreItems").innerHTML = movsHoy.map(m => `
    <tr>
      <td>${new Date(m.fechaISO).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
      <td>${m.tipo === "ingreso" ? "Ingreso" : "Egreso"}</td>
      <td>${esc(m.categoria)}</td>
      <td class="num">${money(m.monto)}</td>
    </tr>`).join("");

  const ingresos = movsHoy.filter(m => m.tipo === "ingreso").reduce((s, m) => s + m.monto, 0);
  const egresos = movsHoy.filter(m => m.tipo === "egreso").reduce((s, m) => s + m.monto, 0);
  document.getElementById("cierreIngresos").textContent = money(ingresos);
  document.getElementById("cierreEgresos").textContent = money(egresos);
  document.getElementById("cierreNeto").textContent = money(ingresos - egresos);

  const metodos = ["efectivo", "transferencia", "tarjeta"];
  document.getElementById("cierrePorMetodo").innerHTML = metodos.map(met => {
    const total = movsHoy.filter(m => m.tipo === "ingreso" && m.metodoPago === met).reduce((s, m) => s + m.monto, 0);
    return `<div style="display:flex; justify-content:space-between; font-size:0.9rem;"><span>${met[0].toUpperCase() + met.slice(1)}</span><span>${money(total)}</span></div>`;
  }).join("");

  imprimirPlantilla("cierreCajaPrint", "print-cierre", ventana);
});

/* ================= CREDITOS ================= */
let creditosFiltroEstado = ""; // "" | "pendiente" (incluye parcial) | "pagado"
let creditosCache = {}; // id -> crédito, se llena en cada renderCreditos() para que
                         // imprimir/recordar no necesiten un await antes de actuar
                         // sobre el clic (mismo motivo que currentOrderCache/ultimoTicket).
let creditosPorCliente = {}; // clave de cliente -> { nombre, telefono, creditos[], total, abonado, saldo, estado }

// Un mismo cliente puede llevar varias veces al crédito, y cada vez genera su
// propia factura. En la lista queremos verlo UNA sola vez con su saldo junto,
// así que agrupamos por cliente: por id cuando lo tiene (que es siempre en los
// créditos nuevos, porque al registrarlos se crea el cliente si no existía) y
// por nombre como respaldo para registros viejos. Sin nombre ni id, cada
// crédito queda solo en su propio grupo para no mezclar clientes distintos.
function claveCliente(cred) {
  if (cred.clienteId) return `id:${cred.clienteId}`;
  const nombre = (cred.clienteNombre || "").trim().toLowerCase();
  return nombre ? `n:${nombre}` : `s:${cred.id}`;
}

function agruparCreditosPorCliente(creditos) {
  const grupos = {};
  creditos.forEach(c => {
    const clave = claveCliente(c);
    if (!grupos[clave]) {
      grupos[clave] = {
        clave,
        nombre: c.clienteNombre || "Cliente de mostrador",
        telefono: c.clienteTelefono || "",
        creditos: [], total: 0, abonado: 0, saldo: 0,
      };
    }
    const g = grupos[clave];
    g.creditos.push(c);
    g.total += c.total;
    g.abonado += c.abonado;
    g.saldo += c.saldo;
    // el teléfono más reciente que tengamos gana, por si lo actualizó después
    if (!g.telefono && c.clienteTelefono) g.telefono = c.clienteTelefono;
  });
  Object.values(grupos).forEach(g => {
    g.creditos.sort((a, b) => b.fechaISO.localeCompare(a.fechaISO));
    g.ultimaFecha = g.creditos[0].fechaISO;
    g.estado = g.saldo <= 0.01 ? "pagado" : (g.abonado > 0 ? "parcial" : "pendiente");
  });
  return Object.values(grupos).sort((a, b) => b.ultimaFecha.localeCompare(a.ultimaFecha));
}

async function renderCreditos() {
  const creditos = (await DB.getAll("creditos")).sort((a, b) => b.fechaISO.localeCompare(a.fechaISO));
  creditosCache = {};
  creditos.forEach(c => { creditosCache[c.id] = c; });

  const pendientes = creditos.filter(c => c.estado !== "pagado");
  const cuentasPorCobrar = pendientes.reduce((s, c) => s + c.saldo, 0);
  const hoyMes = new Date();
  const cobradoMes = creditos.reduce((s, c) => s + (c.historialAbonos || [])
    .filter(a => sameMonth(new Date(a.fechaISO), hoyMes))
    .reduce((ss, a) => ss + a.monto, 0), 0);

  document.getElementById("creditosResumen").innerHTML = `
    <div class="widget-card ${cuentasPorCobrar > 0 ? "tint-amber" : ""}"><span class="eyebrow">Cuentas por cobrar</span><span class="big">${money(cuentasPorCobrar)}</span><span class="sub">${pendientes.length} crédito${pendientes.length === 1 ? "" : "s"} pendiente${pendientes.length === 1 ? "" : "s"}</span></div>
    <div class="widget-card tint-green"><span class="eyebrow">Cobrado este mes</span><span class="big">${money(cobradoMes)}</span><span class="sub">Abonos recibidos en ${esc(hoyMes.toLocaleDateString("es-HN", { month: "long" }))}</span></div>
    <div class="widget-card"><span class="eyebrow" style="color:var(--text-faint);">Créditos totales</span><span class="big">${creditos.length}</span><span class="sub">Histórico</span></div>
  `;

  const grupos = agruparCreditosPorCliente(creditos);
  creditosPorCliente = {};
  grupos.forEach(g => { creditosPorCliente[g.clave] = g; });

  const filtrados = grupos.filter(g => {
    if (!creditosFiltroEstado) return true;
    if (creditosFiltroEstado === "pendiente") return g.estado !== "pagado";
    return g.estado === creditosFiltroEstado;
  });

  const estadoLabel = { pendiente: "Pendiente", parcial: "Parcial", pagado: "Pagado" };
  const body = document.getElementById("creditosBody");
  document.getElementById("creditosEmpty").style.display = filtrados.length ? "none" : "block";
  // una fila por cliente, no por factura: al tocarla se abre su historial
  // completo con cada factura por separado y sus propios botones.
  body.innerHTML = filtrados.map(g => `
    <tr class="credito-row" data-clave="${esc(g.clave)}" style="cursor:pointer;">
      <td>${esc(g.nombre)}</td>
      <td class="num">${g.creditos.length}</td>
      <td>${new Date(g.ultimaFecha).toLocaleDateString("es-HN")}</td>
      <td class="num">${money(g.total)}</td>
      <td class="num">${money(g.abonado)}</td>
      <td class="num">${money(g.saldo)}</td>
      <td><span class="pill ${g.estado}">${estadoLabel[g.estado]}</span></td>
      <td class="num" style="color:var(--text-faint);">›</td>
    </tr>`).join("");

  body.querySelectorAll(".credito-row").forEach(tr => {
    tr.addEventListener("click", () => abrirCreditoDetalle(tr.dataset.clave));
  });

  // si el detalle está abierto, lo refrescamos para que un abono o un borrado
  // se vea de inmediato sin tener que cerrarlo y volverlo a abrir
  if (creditoDetalleClave && document.getElementById("modalCreditoDetalle").classList.contains("active")) {
    abrirCreditoDetalle(creditoDetalleClave);
  }
}

document.getElementById("creditosFiltro").querySelectorAll(".cat-chip").forEach(btn => {
  btn.addEventListener("click", () => {
    creditosFiltroEstado = btn.dataset.estado;
    document.getElementById("creditosFiltro").querySelectorAll(".cat-chip").forEach(b => b.classList.toggle("active", b === btn));
    renderCreditos();
  });
});

function imprimirFacturaCredito(cred, ventana) {
  if (!cred) { ventana?.close(); return; }
  document.getElementById("credFacId").textContent = cred.id;
  document.getElementById("credFacFecha").textContent = new Date(cred.fechaISO).toLocaleDateString("es-HN");
  document.getElementById("credFacCliente").textContent = cred.clienteNombre || "Cliente de mostrador";
  document.getElementById("credFacTelefono").textContent = cred.clienteTelefono || "";
  document.getElementById("credFacItems").innerHTML = cred.items.map(it => `
    <tr><td>${esc(it.nombre)}</td><td class="num">${it.cantidad}</td><td class="num">${money(it.precio)}</td><td class="num">${money(it.cantidad * it.precio)}</td></tr>
  `).join("");
  document.getElementById("credFacTotal").textContent = money(cred.total);
  document.getElementById("credFacAbonado").textContent = money(cred.abonado);
  document.getElementById("credFacSaldo").textContent = money(cred.saldo);
  imprimirPlantilla("creditoPrint", "print-credito", ventana);
}

/* ---- detalle de un cliente: su saldo consolidado y TODAS sus facturas a
   crédito en un solo historial, cada una con su fecha y sus propios botones
   (abonar / imprimir esa factura / eliminarla) ---- */
let creditoDetalleClave = null;
const estadoLabelDetalle = { pendiente: "Pendiente", parcial: "Parcial", pagado: "Pagado" };

function abrirCreditoDetalle(clave) {
  const g = creditosPorCliente[clave];
  if (!g) return;
  creditoDetalleClave = clave;

  document.getElementById("credDetTitulo").textContent = g.nombre;
  document.getElementById("credDetSub").innerHTML =
    `${esc(g.telefono || "sin teléfono")} · ${g.creditos.length} factura${g.creditos.length === 1 ? "" : "s"} a crédito · <span class="pill ${g.estado}">${estadoLabelDetalle[g.estado]}</span>`;
  document.getElementById("credDetTotal").textContent = money(g.total);
  document.getElementById("credDetAbonado").textContent = money(g.abonado);
  document.getElementById("credDetSaldo").textContent = money(g.saldo);
  document.getElementById("credDetListaLabel").textContent =
    g.creditos.length === 1 ? "Factura" : `Historial de facturas (${g.creditos.length})`;

  document.getElementById("credDetLista").innerHTML = g.creditos.map(c => `
    <div class="cred-factura" data-id="${c.id}">
      <div class="cred-factura-head">
        <div><span class="quien">Crédito #${c.id}</span> <span class="cuando">${new Date(c.fechaISO).toLocaleDateString("es-HN")}</span></div>
        <span class="pill ${c.estado}">${estadoLabelDetalle[c.estado]}</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Ítem</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Subtotal</th></tr></thead>
          <tbody>${c.items.map(it => `
            <tr><td>${esc(it.nombre)}</td><td class="num">${it.cantidad}</td><td class="num">${money(it.precio)}</td><td class="num">${money(it.cantidad * it.precio)}</td></tr>
          `).join("")}</tbody>
        </table>
      </div>
      <div class="cred-factura-tot">
        <span>Total <b>${money(c.total)}</b></span>
        <span>Abonado <b>${money(c.abonado)}</b></span>
        <span>Saldo <b class="saldo">${money(c.saldo)}</b></span>
      </div>
      ${c.nota ? `<p class="hint" style="margin:0.4rem 0 0;">Nota: ${esc(c.nota)}</p>` : ""}
      <div class="cred-factura-acciones">
        ${c.estado !== "pagado" ? `<button type="button" class="btn small" data-act="abonar">Abonar</button>` : ""}
        <button type="button" class="btn ghost small" data-act="imprimir">🖨️ Factura</button>
        ${c.abonado === 0 ? `<button type="button" class="btn ghost small danger" data-act="eliminar">🗑</button>` : ""}
      </div>
    </div>
  `).join("");

  document.getElementById("btnDetRecordar").style.display = (g.telefono && g.saldo > 0.01) ? "inline-flex" : "none";
  document.getElementById("modalCreditoDetalle").classList.add("active");
}
document.getElementById("btnCerrarCreditoDetalle").addEventListener("click", () => {
  document.getElementById("modalCreditoDetalle").classList.remove("active");
  creditoDetalleClave = null;
});

// delegación: los botones de cada factura se generan en cada render, así que
// escuchamos en el contenedor en vez de re-enganchar listeners uno por uno.
document.getElementById("credDetLista").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = Number(btn.closest(".cred-factura").dataset.id);
  const act = btn.dataset.act;

  if (act === "imprimir") { imprimirFacturaCredito(creditosCache[id], abrirVentanaImpresion()); return; }
  if (act === "abonar") {
    document.getElementById("modalCreditoDetalle").classList.remove("active");
    abrirModalAbonoCredito(id);
    return;
  }
  if (act === "eliminar") {
    requestAdminCode(async () => {
      await eliminarCredito(id);
      toast("Crédito eliminado");
      await renderCreditos();
      // si al cliente ya no le queda ninguna factura, el grupo desaparece
      if (!creditosPorCliente[creditoDetalleClave]) {
        document.getElementById("modalCreditoDetalle").classList.remove("active");
        creditoDetalleClave = null;
      }
    });
  }
});

document.getElementById("btnDetRecordar").addEventListener("click", () => {
  const ventana = abrirVentanaWA(); // sincrónico, antes de cualquier await — ver nota en abrirVentanaWA()
  const g = creditosPorCliente[creditoDetalleClave];
  const pendientes = g.creditos.filter(c => c.saldo > 0.01);
  const detalle = pendientes
    .map(c => `• Crédito #${c.id} del ${new Date(c.fechaISO).toLocaleDateString("es-HN")}: ${money(c.saldo)}`)
    .join("\n");
  const texto = pendientes.length === 1
    ? `Hola ${g.nombre}, te recordamos que tienes un saldo pendiente de ${money(g.saldo)} con ENTIMOTORS por el crédito #${pendientes[0].id}. ¡Gracias!`
    : `Hola ${g.nombre}, te recordamos que tienes un saldo pendiente de ${money(g.saldo)} con ENTIMOTORS:\n${detalle}\n¡Gracias!`;
  navegarWA(ventana, g.telefono, texto);
});

// estado de cuenta: todas las facturas del cliente en un solo documento
document.getElementById("btnDetEstadoCuenta").addEventListener("click", () => {
  const ventana = abrirVentanaImpresion(); // sincrónico, antes que nada
  const g = creditosPorCliente[creditoDetalleClave];
  if (!g) { ventana?.close(); return; }
  document.getElementById("edcFecha").textContent = new Date().toLocaleDateString("es-HN");
  document.getElementById("edcCliente").textContent = g.nombre;
  document.getElementById("edcTelefono").textContent = g.telefono || "";
  document.getElementById("edcFacturas").innerHTML = g.creditos.map(c => `
    <div class="edc-factura">
      <div class="edc-factura-head">Crédito #${c.id} — ${new Date(c.fechaISO).toLocaleDateString("es-HN")}</div>
      <table>
        <thead><tr><th>Ítem</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Subtotal</th></tr></thead>
        <tbody>${c.items.map(it => `
          <tr><td>${esc(it.nombre)}</td><td class="num">${it.cantidad}</td><td class="num">${money(it.precio)}</td><td class="num">${money(it.cantidad * it.precio)}</td></tr>
        `).join("")}</tbody>
      </table>
      <div class="edc-factura-tot">Total ${money(c.total)} · Abonado ${money(c.abonado)} · Saldo ${money(c.saldo)}</div>
    </div>
  `).join("");
  document.getElementById("edcTotal").textContent = money(g.total);
  document.getElementById("edcAbonado").textContent = money(g.abonado);
  document.getElementById("edcSaldo").textContent = money(g.saldo);
  imprimirPlantilla("estadoCuentaPrint", "print-estado", ventana);
});

/* ---- registrar abono ---- */
let abonoCreditoActualId = null;
function abrirModalAbonoCredito(id) {
  const cred = creditosCache[id];
  if (!cred) return;
  abonoCreditoActualId = id;
  document.getElementById("abonoCreditoResumen").innerHTML =
    `<b>${esc(cred.clienteNombre)}</b> — Total ${money(cred.total)} · Abonado ${money(cred.abonado)} · Saldo <b>${money(cred.saldo)}</b>`;
  document.getElementById("abonoMonto").value = "";
  document.getElementById("abonoMetodo").value = "efectivo";
  document.getElementById("modalAbonoCredito").classList.add("active");
  setTimeout(() => document.getElementById("abonoMonto").focus(), 50);
}
document.getElementById("btnCancelarAbono").addEventListener("click", () => document.getElementById("modalAbonoCredito").classList.remove("active"));

alHacerClicUnaVez(document.getElementById("btnGuardarAbono"), async () => {
  const cred = creditosCache[abonoCreditoActualId];
  if (!cred) return;
  const monto = Number(document.getElementById("abonoMonto").value) || 0;
  if (monto <= 0) { toast("El monto debe ser mayor a cero", "off"); return; }
  if (monto > cred.saldo + 0.01) { toast(`El abono no puede ser mayor al saldo pendiente (${money(cred.saldo)})`, "off"); return; }
  const metodoPago = document.getElementById("abonoMetodo").value;
  await registrarAbonoCredito(abonoCreditoActualId, monto, metodoPago);
  toast(`Abono de ${money(monto)} registrado`);
  document.getElementById("modalAbonoCredito").classList.remove("active");
  await renderCreditos();
  // volvemos al historial del cliente para ver el abono aplicado, en vez de
  // dejar a la persona en la tabla teniendo que buscarlo otra vez
  if (creditoDetalleClave && creditosPorCliente[creditoDetalleClave]) abrirCreditoDetalle(creditoDetalleClave);
});

/* ---- nuevo crédito ---- */
let creditoClienteSel = null; // { clienteId } cuando se elige un cliente existente
let creditoCarrito = []; // { inventarioId|null, nombre, cantidad, precio, stockDisponible }

function renderCreditoClienteChip() {
  const wrap = document.getElementById("creditoClienteChipWrap");
  wrap.innerHTML = creditoClienteSel
    ? `<span class="selected-chip">Cliente existente seleccionado <button type="button" id="btnQuitarCreditoClienteSel" title="Quitar selección" aria-label="Quitar cliente seleccionado">✕</button></span>`
    : "";
  document.getElementById("btnQuitarCreditoClienteSel")?.addEventListener("click", () => {
    creditoClienteSel = null;
    document.getElementById("creditoBuscarCliente").value = "";
    renderCreditoClienteChip();
  });
}
wireAutocompleteCliente(document.getElementById("creditoBuscarCliente"), document.getElementById("creditoBuscarClienteList"), (cliente) => {
  creditoClienteSel = { clienteId: cliente.id };
  document.getElementById("creditoNombre").value = cliente.nombre;
  document.getElementById("creditoTelefono").value = cliente.telefono || "";
  renderCreditoClienteChip();
});
document.getElementById("creditoBuscarCliente").addEventListener("input", () => { creditoClienteSel = null; renderCreditoClienteChip(); });

let creditoInventarioCache = {}; // id -> repuesto, para no volver a consultar la BD al agregar el ítem
async function refreshCreditoInventarioSelect() {
  const inv = (await DB.getAll("inventario")).filter(r => r.cantidad > 0);
  creditoInventarioCache = {};
  inv.forEach(r => { creditoInventarioCache[r.id] = r; });
  document.getElementById("creditoItemInventarioSelect").innerHTML = inv.length
    ? inv.map(r => `<option value="${r.id}" data-precio="${r.precio}">${esc(r.nombre)} (quedan ${r.cantidad})</option>`).join("")
    : `<option value="">Sin repuestos disponibles</option>`;
}
function toggleCreditoItemOrigen() {
  const fromInv = document.getElementById("creditoItemOrigen").value === "inventario";
  document.getElementById("creditoItemInventarioFields").style.display = fromInv ? "block" : "none";
  document.getElementById("creditoItemManualFields").style.display = fromInv ? "none" : "block";
}
document.getElementById("creditoItemOrigen").addEventListener("change", toggleCreditoItemOrigen);
document.getElementById("creditoItemInventarioSelect").addEventListener("change", (e) => {
  const precio = e.target.selectedOptions[0]?.dataset.precio;
  if (precio) document.getElementById("creditoItemPrecio").value = precio;
});

function renderCreditoCarrito() {
  const el = document.getElementById("creditoCarritoList");
  el.innerHTML = creditoCarrito.length
    ? creditoCarrito.map((it, i) => `
      <div class="pos-cart-item">
        <span class="nom">${esc(it.nombre)} ×${it.cantidad}</span>
        <span style="width:80px; text-align:right;">${money(it.cantidad * it.precio)}</span>
        <button type="button" class="btn ghost small danger" data-quitar-credito-item="${i}" title="Quitar" aria-label="Quitar de la factura">🗑</button>
      </div>`).join("")
    : `<div class="empty" style="padding:1rem 0;">Agrega repuestos o servicios arriba</div>`;
  el.querySelectorAll("[data-quitar-credito-item]").forEach(btn => {
    btn.addEventListener("click", () => { creditoCarrito.splice(Number(btn.dataset.quitarCreditoItem), 1); renderCreditoCarrito(); });
  });
  const total = creditoCarrito.reduce((s, it) => s + it.cantidad * it.precio, 0);
  document.getElementById("creditoTotal").textContent = money(total);
}

document.getElementById("btnAgregarItemCredito").addEventListener("click", () => {
  const cantidad = Number(document.getElementById("creditoItemCantidad").value) || 1;
  const precio = Number(document.getElementById("creditoItemPrecio").value);
  const fromInv = document.getElementById("creditoItemOrigen").value === "inventario";
  if (cantidad <= 0) { toast("La cantidad debe ser mayor a cero", "off"); return; }
  if (!(precio >= 0)) { toast("El precio no puede ser negativo", "off"); return; }

  if (fromInv) {
    const repId = Number(document.getElementById("creditoItemInventarioSelect").value);
    const rep = creditoInventarioCache[repId];
    if (!rep) { toast("Elige un repuesto", "off"); return; }
    const enCarrito = creditoCarrito.filter(it => it.inventarioId === repId).reduce((s, it) => s + it.cantidad, 0);
    if (enCarrito + cantidad > rep.cantidad) { toast(`Solo quedan ${rep.cantidad} en inventario`, "off"); return; }
    creditoCarrito.push({ inventarioId: repId, nombre: rep.nombre, cantidad, precio, stockDisponible: rep.cantidad });
  } else {
    const nombre = document.getElementById("creditoItemNombre").value.trim();
    if (!nombre) { toast("Falta el nombre del repuesto o servicio", "off"); return; }
    creditoCarrito.push({ inventarioId: null, nombre, cantidad, precio });
  }
  document.getElementById("creditoItemNombre").value = "";
  document.getElementById("creditoItemCantidad").value = "1";
  document.getElementById("creditoItemPrecio").value = "";
  renderCreditoCarrito();
});

document.getElementById("btnNuevoCredito").addEventListener("click", async () => {
  creditoClienteSel = null;
  creditoCarrito = [];
  document.getElementById("creditoBuscarCliente").value = "";
  renderCreditoClienteChip();
  ["creditoNombre", "creditoTelefono", "creditoItemNombre", "creditoVencimiento", "creditoNota"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("creditoItemOrigen").value = "inventario";
  document.getElementById("creditoItemCantidad").value = "1";
  document.getElementById("creditoItemPrecio").value = "";
  toggleCreditoItemOrigen();
  await refreshCreditoInventarioSelect();
  renderCreditoCarrito();
  document.getElementById("modalCredito").classList.add("active");
});
document.getElementById("btnCancelarCredito").addEventListener("click", () => document.getElementById("modalCredito").classList.remove("active"));

alHacerClicUnaVez(document.getElementById("btnGuardarCredito"), async () => {
  if (!creditoCarrito.length) { toast("Agrega al menos un repuesto o servicio", "off"); return; }

  let clienteId = null, clienteNombre, clienteTelefono;
  if (creditoClienteSel?.clienteId) {
    clienteId = creditoClienteSel.clienteId;
    clienteNombre = document.getElementById("creditoNombre").value.trim() || document.getElementById("creditoBuscarCliente").value.trim();
    clienteTelefono = document.getElementById("creditoTelefono").value.trim();
  } else {
    const nombre = document.getElementById("creditoNombre").value.trim();
    const telefono = document.getElementById("creditoTelefono").value.trim();
    if (!nombre) { toast("Falta el nombre del cliente", "off"); return; }
    if (!(await checkDuplicateBeforeCreate(nombre, telefono))) return;
    clienteId = await DB.save("clientes", { nombre, telefono });
    markDirty();
    clienteNombre = nombre;
    clienteTelefono = telefono;
  }

  try {
    await registrarCredito({
      clienteId, clienteNombre, clienteTelefono,
      items: creditoCarrito.map(it => ({ inventarioId: it.inventarioId, nombre: it.nombre, cantidad: it.cantidad, precio: it.precio })),
      vencimiento: document.getElementById("creditoVencimiento").value || null,
      nota: document.getElementById("creditoNota").value.trim(),
    });
    markDirty();
    document.getElementById("modalCredito").classList.remove("active");
    creditoCarrito = [];
    toast("Crédito registrado — toca 🖨️ en la lista para ver o imprimir la factura");
    renderCreditos();
  } catch (err) {
    toast("No se pudo registrar el crédito: " + err.message, "off");
  }
});

/* ================= GESTOR DE LA WEB (CMS local) ================= */
async function renderWebCMS() {
  const [hero, promos, servicios, citasAll, clientes] = await Promise.all([
    DB.get("web_cms", "landing_hero"), DB.get("web_cms", "promociones"), DB.get("web_cms", "servicios_catalogo"),
    DB.getAll("citas"), DB.getAll("clientes"),
  ]);
  document.getElementById("cmsHeroTitulo").value = hero?.titulo || "";
  document.getElementById("cmsHeroSubtitulo").value = hero?.subtitulo || "";
  document.getElementById("cmsPromos").value = (promos?.items || []).join("\n");
  document.getElementById("cmsServicios").value = (servicios?.items || []).join("\n");

  const citasWeb = citasAll.filter(c => c.origen === "web");
  const list = document.getElementById("citasWebList");
  if (!citasWeb.length) {
    list.innerHTML = `<div class="empty">No hay citas agendadas desde la página web todavía.</div>`;
  } else {
    citasWeb.sort((a, b) => `${a.fecha}${a.hora}`.localeCompare(`${b.fecha}${b.hora}`));
    list.innerHTML = citasWeb.map(c => {
      const cliente = clientes.find(cl => cl.id === c.clienteId);
      const nombre = cliente?.nombre || c.nombreTmp || "Cliente web";
      const telefono = cliente?.telefono || c.telefonoTmp || "";
      const { label, dt } = citaWhenInfo(c);
      return `
        <div class="cms-row">
          <div class="who">
            <b>${esc(nombre)}</b> · ${label}, ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            <div class="hint" style="margin:0;">${esc(c.motivo || "Sin motivo especificado")}</div>
          </div>
          ${c.confirmada ? `<span class="mant-badge ok">Confirmada</span>` : `<button class="btn wa small" data-confirmar="${c.id}" data-tel="${esc(telefono)}" data-nombre="${esc(nombre)}">Confirmar por WhatsApp</button>`}
        </div>`;
    }).join("");
    list.querySelectorAll("[data-confirmar]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const ventanaWA = abrirVentanaWA();
        const c = await DB.get("citas", Number(btn.dataset.confirmar));
        const { label, dt } = citaWhenInfo(c);
        const texto = `Hola ${btn.dataset.nombre}, confirmamos tu cita en ENTIMOTORS el ${label === "Hoy" || label === "Mañana" ? label.toLowerCase() : dt.toLocaleDateString()} a las ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. ¡Te esperamos!`;
        const sent = navegarWA(ventanaWA, btn.dataset.tel, texto);
        if (!sent) return;
        await DB.save("citas", { ...c, confirmada: true });
        markDirty();
        renderWebCMS();
      });
    });
  }
  updateCitasWebBadge(citasWeb.filter(c => !c.confirmada).length);
}

function updateCitasWebBadge(n) {
  const b = document.getElementById("citasWebBadge");
  if (n > 0) { b.style.display = "inline-block"; b.textContent = n; } else { b.style.display = "none"; }
}

document.getElementById("btnGuardarCMS").addEventListener("click", async () => {
  await DB.save("web_cms", { key: "landing_hero", titulo: document.getElementById("cmsHeroTitulo").value.trim(), subtitulo: document.getElementById("cmsHeroSubtitulo").value.trim() });
  await DB.save("web_cms", { key: "promociones", items: document.getElementById("cmsPromos").value.split("\n").map(s => s.trim()).filter(Boolean) });
  await DB.save("web_cms", { key: "servicios_catalogo", items: document.getElementById("cmsServicios").value.split("\n").map(s => s.trim()).filter(Boolean) });
  markDirty();
  toast("Contenido guardado (local — publicarlo en entimotors.com real requiere el backend del sitio)");
});

/* ================= AJUSTES: respaldo, restauración, reset, permisos ================= */
function aplicarPermisosPorRol() {
  const esAdmin = currentUser?.rol === "admin";
  document.querySelectorAll(".nav-item[data-view]").forEach(btn => {
    if (VISTAS_SOLO_ADMIN.includes(btn.dataset.view)) btn.style.display = esAdmin ? "" : "none";
  });
  // si un mecánico quedó parado en una vista restringida (por ejemplo, sesión
  // anterior era de admin en este mismo dispositivo), lo regresamos al dashboard
  if (!esAdmin && VISTAS_SOLO_ADMIN.some(v => document.getElementById(`view-${v}`)?.classList.contains("active"))) {
    showView("dashboard");
    renderDashboard();
  }
}

async function renderAjustes() {
  const modo = localStorage.getItem("enti_modo_datos") === "demo" ? "con datos de ejemplo" : "en blanco";
  const conteos = await Promise.all(ALL_STORES.map(s => DB.getAll(s).then(r => r.length)));
  const totalRegistros = conteos.reduce((a, b) => a + b, 0);
  document.getElementById("ajustesInfo").innerHTML = `
    Usuario: <b>${esc(currentUser?.nombre || "—")}</b> (${currentUser?.rol === "admin" ? "administrador" : "mecánico"})<br>
    Este dispositivo arrancó ${modo} · ${totalRegistros} registros guardados en total.
  `;

  // Lee la versión directo del nombre de la caché activa (la pone sw.js al
  // instalarse) en vez de duplicar el número aquí — así esto SIEMPRE refleja
  // la versión real que quedó corriendo en este dispositivo, aunque se haya
  // atascado en una vieja por el navegador.
  if ("caches" in window) {
    const keys = await caches.keys();
    const activa = keys.find((k) => k.startsWith("entimotors-v"));
    document.getElementById("ajustesVersion").textContent = activa ? activa.replace("entimotors-v", "") : "sin Service Worker";
  }
}

document.getElementById("btnForzarActualizacion").addEventListener("click", async () => {
  toast("Buscando la última versión…");
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) {}
  // ?_= con la hora actual evita que el propio navegador (no el Service
  // Worker, que ya se acaba de borrar) conteste esto con algo guardado en su
  // caché HTTP normal.
  location.href = location.pathname + "?_=" + Date.now();
});

document.getElementById("btnRespaldarDatos").addEventListener("click", async () => {
  const data = {};
  for (const store of ALL_STORES) data[store] = await DB.getAll(store);
  const respaldo = { version: 1, exportadoEn: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(respaldo, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `entimotors_respaldo_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Respaldo descargado");
});

document.getElementById("inputRestaurar").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let respaldo;
  try {
    respaldo = JSON.parse(await file.text());
  } catch {
    toast("Ese archivo no es un respaldo válido", "off");
    return;
  }
  if (!respaldo?.data) { toast("Ese archivo no es un respaldo válido", "off"); return; }

  const ok = await showConfirm(
    "Esto reemplaza TODOS los datos actuales de este dispositivo por los del archivo. Lo que tengas ahora que no esté en el respaldo se perderá.",
    { titulo: "Restaurar respaldo", textoOk: "Restaurar" }
  );
  if (!ok) return;

  requestAdminCode(async () => {
    for (const store of ALL_STORES) {
      await DB.clear(store);
      for (const registro of respaldo.data[store] || []) await DB.save(store, registro);
    }
    markDirty();
    localStorage.setItem("enti_modo_datos", "blanco"); // ya hay datos reales del respaldo, no debe volver a sembrar demo
    toast("Datos restaurados");
    await continuarArranque(null);
  });
});

document.getElementById("btnEmpezarDeCero").addEventListener("click", async () => {
  const ok = await showConfirm(
    "Esto borra TODA la información guardada en este dispositivo: clientes, órdenes, ventas, caja, inventario, todo. No se puede deshacer.",
    { titulo: "Borrar todo y empezar de cero", textoOk: "Borrar todo" }
  );
  if (!ok) return;

  requestAdminCode(async () => {
    for (const store of ALL_STORES) await DB.clear(store);
    localStorage.removeItem("enti_modo_datos");
    markDirty();
    toast("Todo borrado — elige cómo quieres empezar");
    document.getElementById("shell").classList.remove("active");
    document.getElementById("gateModo").classList.add("active");
  });
});

/* ================= datos de prueba adicionales (inventario, clientes, citas) =================
   No hay botón visible en Ajustes a propósito — esto es solo para la cuenta
   "prueba" (ver TEAM), que abre únicamente Wilkin, no el cliente. Se ejecuta
   sola en continuarArranque() cada vez que se entra con esa cuenta. Es aditivo
   y revisa por nombre antes de crear, así que entrar varias veces no duplica
   nada. Solo agrega datos EN ESTE dispositivo — no hay sincronización entre
   dispositivos, así que en cada celular donde se use "prueba" se siembra sola
   la primera vez que se entra ahí. */
async function sembrarDatosPrueba() {
  const catsExistentes = await DB.getAll("categorias_inv");
  async function idDeCategoria(nombre) {
    const encontrada = catsExistentes.find(c => c.nombre === nombre);
    if (encontrada) return encontrada.id;
    const id = await DB.save("categorias_inv", { nombre });
    catsExistentes.push({ nombre, id });
    return id;
  }
  const idFrenos = await idDeCategoria("Frenos");
  const idAceites = await idDeCategoria("Aceites y lubricantes");
  const idElectrico = await idDeCategoria("Eléctrico");
  const idLlantas = await idDeCategoria("Llantas");
  const idTransmision = await idDeCategoria("Transmisión");
  const idAccesorios = await idDeCategoria("Accesorios");

  const inventarioExistente = await DB.getAll("inventario");
  const nombresInventario = new Set(inventarioExistente.map(r => r.nombre));
  const nuevosRepuestos = [
    { nombre: "Pastillas de freno traseras", cantidad: 10, precio: 280, costoCompra: 170, stockMinimo: 3, categoriaId: idFrenos },
    { nombre: "Líquido de frenos DOT 4", cantidad: 12, precio: 140, costoCompra: 85, stockMinimo: 4, categoriaId: idFrenos },
    { nombre: "Bujía NGK", cantidad: 25, precio: 95, costoCompra: 55, stockMinimo: 8, categoriaId: idAceites },
    { nombre: "Filtro de aceite", cantidad: 20, precio: 90, costoCompra: 50, stockMinimo: 6, categoriaId: idAceites },
    { nombre: "Filtro de aire", cantidad: 15, precio: 150, costoCompra: 90, stockMinimo: 5, categoriaId: idAceites },
    { nombre: "Batería 12V 4Ah", cantidad: 6, precio: 850, costoCompra: 600, stockMinimo: 2, categoriaId: idElectrico },
    { nombre: "Foco delantero H4", cantidad: 14, precio: 120, costoCompra: 70, stockMinimo: 4, categoriaId: idElectrico },
    { nombre: "Bocina 12V", cantidad: 10, precio: 130, costoCompra: 75, stockMinimo: 3, categoriaId: idElectrico },
    { nombre: "Llanta trasera 90/90-18", cantidad: 8, precio: 1450, costoCompra: 1050, stockMinimo: 2, categoriaId: idLlantas },
    { nombre: "Llanta delantera 80/90-17", cantidad: 8, precio: 1200, costoCompra: 850, stockMinimo: 2, categoriaId: idLlantas },
    { nombre: "Cámara de aire rin 18", cantidad: 12, precio: 180, costoCompra: 100, stockMinimo: 4, categoriaId: idLlantas },
    { nombre: "Cadena 428H", cantidad: 9, precio: 650, costoCompra: 450, stockMinimo: 2, categoriaId: idTransmision },
    { nombre: "Kit piñón y catalina", cantidad: 7, precio: 950, costoCompra: 680, stockMinimo: 2, categoriaId: idTransmision },
    { nombre: "Cable de embrague", cantidad: 15, precio: 180, costoCompra: 100, stockMinimo: 5, categoriaId: idTransmision },
    { nombre: "Cable de acelerador", cantidad: 15, precio: 160, costoCompra: 90, stockMinimo: 5, categoriaId: idTransmision },
    { nombre: "Espejo retrovisor (par)", cantidad: 10, precio: 240, costoCompra: 140, stockMinimo: 3, categoriaId: idAccesorios },
    { nombre: "Manigueta de freno", cantidad: 12, precio: 190, costoCompra: 110, stockMinimo: 4, categoriaId: idAccesorios },
  ];
  let repuestosAgregados = 0;
  for (const r of nuevosRepuestos) {
    if (nombresInventario.has(r.nombre)) continue;
    await DB.save("inventario", { ...r, modelo: "Universal", precioVenta: r.precio, codigoBarras: "", publicarEnWeb: false, foto: null });
    repuestosAgregados++;
  }

  const clientesExistentes = await DB.getAll("clientes");
  const nombresClientes = new Set(clientesExistentes.map(c => c.nombre));
  const nuevosClientes = [
    { cliente: { nombre: "Ana Gómez", telefono: "9911-2233" }, moto: { marca: "Bajaj", modelo: "Pulsar 180", cilindraje: "180cc", placa: "HAM-2210", km: 8200 } },
    { cliente: { nombre: "Roberto Cruz", telefono: "9822-4455" }, moto: { marca: "Suzuki", modelo: "AX100", cilindraje: "100cc", placa: "PAG-1187", km: 15300 } },
    { cliente: { nombre: "Fernanda López", telefono: "9733-6677" }, moto: { marca: "Honda", modelo: "XR150L", cilindraje: "150cc", placa: "HAX-9042", km: 4100 } },
  ];
  let clientesAgregados = 0;
  for (const item of nuevosClientes) {
    if (nombresClientes.has(item.cliente.nombre)) continue;
    const clienteId = await DB.save("clientes", item.cliente);
    await DB.save("motos", { clienteId, ...item.moto, foto: null, mantenimiento: null });
    clientesAgregados++;
  }

  const citasExistentes = await DB.getAll("citas");
  let citasAgregadas = 0;
  if (!citasExistentes.some(c => c.motivo === "Revisión general (prueba)")) {
    const en3dias = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const en5dias = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await DB.save("citas", { clienteId: null, nombreTmp: "Ana Gómez", telefonoTmp: "9911-2233", fecha: en3dias, hora: "09:00", motivo: "Revisión general (prueba)", mecanico: "Wilkin", origen: "interna", recordatorioEnviado: false, creadoEn: Date.now() });
    await DB.save("citas", { clienteId: null, nombreTmp: "Roberto Cruz", telefonoTmp: "9822-4455", fecha: en5dias, hora: "10:30", motivo: "Cambio de aceite (prueba)", mecanico: "Mecánico 1", origen: "interna", recordatorioEnviado: false, creadoEn: Date.now() });
    citasAgregadas = 2;
  }

  // continuarArranque() ya renderiza todas las vistas justo después de llamar
  // esto, así que aquí no hace falta re-renderizar nada — solo dejar los datos
  // guardados antes de que ese primer render ocurra.
  if (repuestosAgregados || clientesAgregados || citasAgregadas) {
    markDirty();
    toast(`Datos de prueba listos: ${repuestosAgregados} repuestos, ${clientesAgregados} clientes y ${citasAgregadas} citas`);
  }
}

/* ================= conexión: real + simulada ================= */
document.getElementById("offlineToggle").addEventListener("click", () => {
  forcedOffline = !forcedOffline;
  document.getElementById("offlineToggle").textContent = forcedOffline ? "Volver a estar en línea" : "Simular sin conexión";
  renderSyncChip();
  toast(forcedOffline ? "Modo sin conexión activado" : "Conexión restaurada — sincronizando cambios pendientes");
  if (!forcedOffline && pending > 0) setTimeout(() => { pending = 0; renderSyncChip(); toast("Todo sincronizado"); }, 1200);
});
window.addEventListener("online", renderSyncChip);
window.addEventListener("offline", renderSyncChip);

/* ================= datos de ejemplo (solo la primera vez) ================= */
async function seedIfEmpty() {
  const clientes = await DB.getAll("clientes");
  if (clientes.length) return;
  const c1 = await DB.save("clientes", { nombre: "Carlos Reyes", telefono: "9704-1122" });
  const prontoMant = new Date(); prontoMant.setDate(prontoMant.getDate() + 3);
  await DB.save("motos", {
    clienteId: c1, marca: "Honda", modelo: "CB190R", cilindraje: "190cc", placa: "HAX-4471", km: 8200, foto: null,
    mantenimiento: { fecha: prontoMant.toISOString().slice(0, 10), tipo: "Cambio de aceite", recordatorioEnviado: false },
  });
  const c2 = await DB.save("clientes", { nombre: "Marlon Zúniga", telefono: "9988-3344" });
  await DB.save("motos", { clienteId: c2, marca: "Suzuki", modelo: "GN125", cilindraje: "125cc", placa: "PAO-0912", km: 21500, foto: null, mantenimiento: null });

  const catRepuestos = await DB.save("categorias_inv", { nombre: "Repuestos" });
  const catAceites = await DB.save("categorias_inv", { nombre: "Aceites y lubricantes" });
  const catFrenos = await DB.save("categorias_inv", { nombre: "Frenos" });
  await DB.save("categorias_inv", { nombre: "Accesorios" });

  await DB.save("inventario", { nombre: "Kit de arrastre", modelo: "CB190R", cantidad: 4, precio: 1450, precioVenta: 1450, costoCompra: 950, stockMinimo: 2, codigoBarras: "750100000012", categoriaId: catRepuestos, publicarEnWeb: true });
  await DB.save("inventario", { nombre: "Aceite 20W-50 (litro)", modelo: "Todos", cantidad: 30, precio: 180, precioVenta: 180, costoCompra: 110, stockMinimo: 8, codigoBarras: "750100000029", categoriaId: catAceites, publicarEnWeb: true });
  await DB.save("inventario", { nombre: "Pastillas de freno delanteras", modelo: "GN125", cantidad: 6, precio: 320, precioVenta: 320, costoCompra: 190, stockMinimo: 3, codigoBarras: "750100000036", categoriaId: catFrenos, publicarEnWeb: false });

  const motos = await DB.getAll("motos");
  await DB.save("ordenes", {
    clienteId: c1, motoId: motos.find(m => m.clienteId === c1).id, estado: "presupuesto",
    falla: "Ruido metálico en la cadena y cuesta que agarre marcha.",
    items: [{ nombre: "Kit de arrastre", cantidad: 1, precio: 1450 }, { nombre: "Mano de obra", cantidad: 1, precio: 350 }],
    fotos: [], aprobacion: null, diagnostico: { notas: "Kit de arrastre desgastado, cambio recomendado.", horas: 2 },
    reparacionNotas: "", calidadChecklist: null, mecanico: "Wilkin", creadoEn: Date.now(),
  });
  await DB.save("ordenes", {
    clienteId: c2, motoId: motos.find(m => m.clienteId === c2).id, estado: "recibido",
    falla: "Frenos chillan al frenar.",
    items: [], fotos: [], aprobacion: null, diagnostico: null, reparacionNotas: "", calidadChecklist: null,
    mecanico: "Mecánico 1", creadoEn: Date.now(),
  });

  const c3 = await DB.save("clientes", { nombre: "Deysi Martínez", telefono: "9811-5566" });
  await DB.save("motos", { clienteId: c3, marca: "Yamaha", modelo: "FZ150", cilindraje: "150cc", placa: "MDC-2201", km: 5400, foto: null, mantenimiento: null });
  const motoC3 = await DB.get("motos", (await DB.getAll("motos")).find(m => m.clienteId === c3).id);
  await DB.save("ordenes", {
    clienteId: c3, motoId: motoC3.id, estado: "entregado",
    falla: "Mantenimiento de rutina.",
    items: [{ nombre: "Aceite 20W-50 (litro)", cantidad: 1, precio: 180 }, { nombre: "Mano de obra", cantidad: 1, precio: 150 }],
    fotos: [], aprobacion: { via: "local", en: Date.now() }, diagnostico: { notas: "Todo en orden.", horas: 1 },
    reparacionNotas: "Cambio de aceite realizado.", calidadChecklist: { pruebaManejo: true, fugas: true, torque: true, limpieza: true },
    mecanico: "Wilkin", creadoEn: Date.now(), entregadoEn: Date.now(),
  });

  const pasado = new Date(); pasado.setDate(pasado.getDate() + 1);
  await DB.save("citas", { clienteId: c2, nombreTmp: "", telefonoTmp: "", fecha: pasado.toISOString().slice(0, 10), hora: "10:00", motivo: "Revisión de frenos", mecanico: "Wilkin", origen: "interna", recordatorioEnviado: false, creadoEn: Date.now() });

  // Ejemplo de cómo se vería una cita agendada por un visitante desde la página
  // pública — hoy no existe ese formulario en entimotors.com, esto es solo para
  // mostrar la etiqueta "Desde la web". Conectarlo de verdad requiere un
  // formulario público + una tabla compartida en el backend, no solo este demo.
  const enTresDias = new Date(); enTresDias.setDate(enTresDias.getDate() + 3);
  await DB.save("citas", { clienteId: null, nombreTmp: "Héctor Padilla", telefonoTmp: "9600-7788", fecha: enTresDias.toISOString().slice(0, 10), hora: "14:30", motivo: "Cotización de kit de arrastre", mecanico: "Wilkin", origen: "web", recordatorioEnviado: false, creadoEn: Date.now() });

  // Movimientos de caja y una venta de mostrador de ejemplo, para que el
  // dashboard y Finanzas no arranquen en cero — así se ve cómo se llenan los
  // gráficos apenas hay actividad real.
  const inv = await DB.getAll("inventario");
  const aceite = inv.find(r => r.nombre.startsWith("Aceite"));
  const haceDos = new Date(); haceDos.setDate(haceDos.getDate() - 2);
  await DB.save("caja_movimientos", { tipo: "ingreso", categoria: "Servicio taller", monto: 330, metodoPago: "efectivo", descripcion: "Orden de taller #entregada", fechaISO: haceDos.toISOString(), creadoEn: haceDos.getTime() });
  await DB.save("caja_movimientos", { tipo: "egreso", categoria: "Compra de repuestos", monto: 900, metodoPago: "efectivo", descripcion: "Reposición de aceite y pastillas", fechaISO: haceDos.toISOString(), creadoEn: haceDos.getTime() });
  if (aceite) {
    const ventaDemo = { items: [{ inventarioId: aceite.id, nombre: aceite.nombre, cantidad: 2, precio: aceite.precio }], clienteId: null, metodoPago: "efectivo", total: aceite.precio * 2, efectivoRecibido: aceite.precio * 2, cambio: 0, fechaISO: new Date().toISOString(), creadoEn: Date.now(), mecanico: "Wilkin" };
    const ventaId = await DB.save("ventas_rapidas", ventaDemo);
    await DB.save("caja_movimientos", { tipo: "ingreso", categoria: "Venta mostrador", monto: ventaDemo.total, metodoPago: "efectivo", descripcion: `Venta rápida #${ventaId}`, ventaId, fechaISO: ventaDemo.fechaISO, creadoEn: Date.now() });
  }

  await DB.save("web_cms", { key: "landing_hero", titulo: "Tu moto en las mejores manos", subtitulo: "Repuestos, mantenimiento y reparación de motocicletas en Honduras" });
  await DB.save("web_cms", { key: "promociones", items: ["10% de descuento en cambio de aceite este mes"] });
  await DB.save("web_cms", { key: "servicios_catalogo", items: ["Diagnóstico general", "Cambio de aceite", "Frenos", "Kit de arrastre"] });
}

/* ================= arranque de la app (tras pasar los dos gates) ================= */
async function startApp(session) {
  currentUser = session;
  document.getElementById("loggedUserName").textContent = session.nombre;
  document.getElementById("loggedUserRole").textContent = session.user;

  db = await openDb();

  const clientesExistentes = await DB.getAll("clientes");
  const modo = localStorage.getItem("enti_modo_datos");
  if (!clientesExistentes.length && !modo) {
    // base vacía y todavía no se eligió cómo arrancar: preguntamos antes de mostrar nada del sistema
    document.getElementById("gateModo").classList.add("active");
    return;
  }

  document.getElementById("shell").classList.add("active");
  await continuarArranque(modo);
}

async function elegirModoDatos(modo) {
  localStorage.setItem("enti_modo_datos", modo);
  document.getElementById("gateModo").classList.remove("active");
  document.getElementById("shell").classList.add("active");
  await continuarArranque(modo);
}
document.getElementById("btnModoDemo").addEventListener("click", () => elegirModoDatos("demo"));
document.getElementById("btnModoBlanco").addEventListener("click", () => elegirModoDatos("blanco"));

async function continuarArranque(modo) {
  if (modo === "demo") await seedIfEmpty();
  if (currentUser?.user === "prueba") await sembrarDatosPrueba();
  aplicarPermisosPorRol();
  await renderOrdersList();
  await renderClientes();
  await renderInventario();
  await renderCitasList();
  await renderPOS();
  await renderFinanzas();
  await renderWebCMS();
  await renderAjustes();
  await renderDashboard();
  await renderNotificaciones();
  renderSyncChip();
  document.getElementById("fabHome").classList.add("fab-hidden"); // arranca siempre en la página principal

  wireServiceWorkerUpdates();
}

/* ================= actualización del Service Worker ================= */
function wireServiceWorkerUpdates() {
  if (!("serviceWorker" in navigator)) return;

  // sw.js llama a skipWaiting()/clients.claim() sin pedir permiso, así que en
  // cuanto el nuevo Service Worker toma control recargamos solo — nadie tiene
  // que darle a "Actualizar" ni refrescar la página a mano.
  let recargando = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (recargando) return;
    recargando = true;
    location.reload();
  });

  // updateViaCache:"none" evita que el propio navegador (no el Service Worker)
  // conteste con una copia guardada de sw.js cuando el navegador va a revisar
  // si cambió — sin esto, algunos navegadores pueden tardar en darse cuenta
  // de que hay una versión nueva aunque forcemos reg.update() más abajo.
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((reg) => {
    reg.addEventListener("updatefound", () => {
      const nuevo = reg.installing;
      if (!nuevo) return;
      nuevo.addEventListener("statechange", () => {
        // "installed" + ya había un controller = hay una versión nueva esperando,
        // no es la primera instalación del Service Worker.
        if (nuevo.state === "installed" && navigator.serviceWorker.controller) {
          document.getElementById("updateBanner").style.display = "flex";
        }
      });
    });

    // Por spec, el navegador solo revisa si sw.js cambió una vez cada 24h por su
    // cuenta — con la app cambiando varias veces al día eso deja a la gente
    // atascada en una versión vieja aunque el auto-reload de arriba esté bien.
    // Forzamos la revisión nosotros: al abrir la app y cada vez que vuelve a
    // primer plano (típico en celular: la app queda abierta de fondo días).
    reg.update();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update();
    });
  }).catch(() => {});
}

/* ================= boot: gate de instalación -> gate de login -> app ================= */
(function boot() {
  if (!isStandalone() && !devBypassed()) {
    wireInstallGate();
    return; // se queda mostrando #gateInstall (ya viene "active" en el HTML)
  }
  document.getElementById("gateInstall").classList.remove("active");

  const session = readSession();
  if (!session) {
    wireLoginGate();
    document.getElementById("gateLogin").classList.add("active");
    return;
  }
  startApp(session);
})();
