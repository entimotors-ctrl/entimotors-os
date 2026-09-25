/* ============================================================================
 * ENTIMOTORS OS · pin-ui.js  (3.14.0 · SYNC-7)
 * ----------------------------------------------------------------------------
 * Autorización con PIN administrativo (D-7). El backend YA existe y ya está probado
 * (api-server/src/routes/pin.ts + src/lib/pin.ts, taller-demo/supabase/sync/sync-3p-pin.sql):
 * límite de intentos persistente, hash scrypt+pepper del lado del servidor, autorización de un
 * solo uso ligada a solicitante+acción+entidad+registro+dispositivo+versión del PIN (+ hash del
 * monto). Esta hoja es SOLO el cliente: pide el PIN, habla con POST /api/autorizaciones, traduce
 * la respuesta. Nunca habla con Supabase directo para esto — solo con el api-server.
 *
 * DISEÑO: fábrica pura + inyección de dependencias (mismo patrón que SyncRest.crear/api-server
 * lib/pin.ts crearServicioPin), para que `pedirAutorizacion` se pueda probar en Node sin DOM:
 * quien la crea inyecta `pedirPin` (cómo se obtiene el PIN del admin — en la app real, el modal
 * de abajo; en las pruebas, una función falsa). PinUI.crear() en sí NUNCA toca `document`.
 *
 * ACCIONES_CON_PIN — mismo catálogo que api-server/src/lib/pin.ts y sync-engine.js (ACCIONES_CON_PIN):
 *   ajustar_stock · reversar_venta · registrar_devolucion · reversar_abono ·
 *   reversar_credito · reversar_caja · anular_orden
 * El admin NUNCA pasa por aquí (el backend rechaza con ADMIN_NO_NECESITA_PIN si se le pide):
 * quien llama debe comprobar el rol ANTES de invocar pedirAutorizacion (ver `admin` abajo).
 *
 * SYNC-7 sección 15 (offline): antes de pedir el PIN se comprueba conexión — sin red, se avisa
 * "esta operación requiere conexión…" y se corta ahí. Nunca se encola (sync-engine.js igual lo
 * rechazaría: verificarSinPin no deja poner en la cola ninguna de estas acciones).
 *
 * NUNCA SE GUARDA EL PIN: vive solo en el <input> del modal y en la variable local de la promesa
 * mientras viaja al servidor; se borra del campo y de la variable en cuanto se usa o se cancela.
 * Jamás entra a localStorage, sessionStorage, IndexedDB, la cola de sync ni ningún console.log.
 * ==========================================================================*/
(function (global) {
  "use strict";

  /* accion -> entidad esperada por el backend (api-server/src/lib/pin.ts ACCIONES_CON_PIN) */
  var ACCIONES_CON_PIN = {
    ajustar_stock: "inventario",
    reversar_venta: "ventas",
    registrar_devolucion: "ventas",
    reversar_abono: "abonos",
    reversar_credito: "creditos",
    reversar_caja: "caja_movimientos",
    anular_orden: "ordenes",
  };

  function redondear2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  /** Traduce el código de error del servidor a un mensaje para el cajero. Pura, sin DOM. */
  function mensajeParaCodigo(codigo, datos) {
    switch (codigo) {
      case "PIN_INCORRECTO":
        return "PIN incorrecto." + (datos && datos.intentos_restantes !== undefined ? " Intentos restantes: " + datos.intentos_restantes + "." : "");
      case "SIN_PIN": return "El administrador todavía no configuró el PIN de autorización.";
      case "CUENTA_INACTIVA": return "La cuenta del administrador no está activa.";
      case "BLOQUEADO_ADMIN": return "Las autorizaciones están bloqueadas. El administrador debe desbloquearlas desde Ajustes.";
      case "BLOQUEADO_GLOBAL": case "BLOQUEADO_SOLICITANTE": {
        var min = Math.ceil((datos && Number(datos.reintentar_en_s)) / 60) || 1;
        return "Demasiados intentos. Espera " + min + " minuto" + (min === 1 ? "" : "s") + ".";
      }
      case "PIN_CAMBIADO": return "El PIN cambió mientras se verificaba. Inténtalo de nuevo.";
      case "PIN_INVALIDO": return "El PIN son 6 dígitos.";
      case "ACCION_DESCONOCIDA": return "Acción no reconocida.";
      case "ENTIDAD_INVALIDA": case "REGISTRO_INVALIDO": case "DISPOSITIVO_INVALIDO": case "MONTO_INVALIDO":
        return "No se pudo armar la solicitud de autorización.";
      case "NO_PERMITIDO": return "Tu rol no puede pedir esta autorización.";
      case "ADMIN_NO_NECESITA_PIN": return "El administrador no necesita autorización.";
      case "SIN_SESION": case "SESION_INVALIDA": return "Inicia sesión de nuevo.";
      case "PIN_NO_CONFIGURADO_EN_SERVIDOR": return "Las autorizaciones con PIN no están configuradas en el servidor.";
      default: return (datos && typeof datos.error === "string" && datos.error) || "No se pudo obtener la autorización.";
    }
  }

  /** cfg: { fetch, baseApi(), obtenerToken(), enLinea(), pedirPin({accion,entidad,registroId,monto}) -> Promise<string|null> } */
  function crear(cfg) {
    cfg = cfg || {};
    var f = cfg.fetch || (typeof fetch === "function" ? fetch.bind(global) : null);
    var baseApi = cfg.baseApi || function () { return ""; };
    var obtenerToken = cfg.obtenerToken || function () { return null; };
    var enLinea = cfg.enLinea || function () { return typeof navigator === "undefined" || navigator.onLine !== false; };
    var pedirPin = cfg.pedirPin || function () { return Promise.resolve(null); };
    var timeoutMs = cfg.timeoutMs || 20000;

    /** rol: el de quien pide (currentUser.rol). admin nunca llega al servidor (no lo necesita: sync_autorizar lo
        detecta por su cuenta con p_autorizacion=null). mecanico/otros: rechazo local inmediato, sin red. */
    async function pedirAutorizacion(o) {
      o = o || {};
      var accion = o.accion, rol = o.rol, registroId = o.registroId, monto = o.monto, deviceId = o.deviceId || null;
      var entidad = ACCIONES_CON_PIN[accion];
      if (!entidad) return { ok: false, motivo: "accion-desconocida", mensaje: "Acción no reconocida." };
      if (rol === "admin") return { ok: true, admin: true, autorizacion_id: null, expira_en: null };
      if (rol !== "cajero") return { ok: false, motivo: "sin-permiso", mensaje: "Tu rol no puede pedir esta autorización." };
      if (!enLinea()) {
        return { ok: false, motivo: "sin-conexion", mensaje: "Esta operación requiere conexión para obtener autorización del administrador." };
      }
      var base = baseApi();
      if (!base) return { ok: false, motivo: "sin-servidor", mensaje: "Falta configurar el servidor (apiUrl)." };
      var token = await Promise.resolve(obtenerToken()).catch(function () { return null; });
      if (!token) return { ok: false, motivo: "sin-sesion", mensaje: "Inicia sesión de nuevo." };
      if (!f) return { ok: false, motivo: "sin-fetch", mensaje: "No se pudo contactar al servidor." };

      var pin = await pedirPin({ accion: accion, entidad: entidad, registroId: registroId, monto: monto });
      if (pin === null || pin === undefined) return { ok: false, motivo: "cancelado", mensaje: "" };
      if (!/^[0-9]{6}$/.test(String(pin))) return { ok: false, motivo: "pin-invalido", mensaje: "El PIN son 6 dígitos." };

      var cuerpo = { accion: accion, entidad: entidad, registro_id: registroId, device_id: deviceId, pin: String(pin) };
      if (monto !== undefined && monto !== null) cuerpo.monto = redondear2(monto);
      pin = null; // no queda ni en esta variable local una vez armado el cuerpo

      var ctl = typeof AbortController === "function" ? new AbortController() : null;
      var t = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs) : null;
      var res, datos;
      try {
        res = await f(base + "/api/autorizaciones", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(cuerpo),
          signal: ctl ? ctl.signal : undefined,
        });
        if (t) clearTimeout(t);
        var txt = await res.text();
        try { datos = txt ? JSON.parse(txt) : null; } catch (e) { datos = null; }
      } catch (e) {
        if (t) clearTimeout(t);
        return { ok: false, motivo: "sin-conexion", mensaje: "No se pudo contactar al servidor." };
      }
      if (res.status === 201 && datos && typeof datos.autorizacion_id === "string") {
        return { ok: true, admin: false, autorizacion_id: datos.autorizacion_id, expira_en: datos.expira_en || null };
      }
      var codigo = (datos && typeof datos.codigo === "string" && datos.codigo) || "";
      return {
        ok: false, motivo: codigo || ("http-" + res.status), mensaje: mensajeParaCodigo(codigo, datos),
        reintentar_en_s: datos && datos.reintentar_en_s, intentos_restantes: datos && datos.intentos_restantes, http: res.status,
      };
    }

    return { pedirAutorizacion: pedirAutorizacion };
  }

  /* ---------------- glue del navegador real: el modal (NUNCA se prueba en Node; ver pruebas/sync/node/pin-ui.test.mjs
     para la parte pura de arriba). Guarda cero estado propio fuera del ciclo de vida de una sola promesa. ---------------- */
  function pedirPinConModal(info) {
    return new Promise(function (resolve) {
      var modal = document.getElementById("modalPinAutorizar");
      var input = document.getElementById("pinAutorizarInput");
      var err = document.getElementById("pinAutorizarError");
      var okBtn = document.getElementById("btnPinAutorizarOk");
      var cancelBtn = document.getElementById("btnPinAutorizarCancelar");
      if (!modal || !input || !okBtn || !cancelBtn) { resolve(null); return; }

      var msg = document.getElementById("pinAutorizarMsg");
      if (msg) msg.textContent = "Esta acción requiere autorización del administrador.";
      if (err) err.textContent = "";
      input.value = "";
      modal.classList.add("active");
      setTimeout(function () { input.focus(); }, 0);

      function terminar(valor) {
        modal.classList.remove("active");
        input.value = "";           // el PIN nunca sobrevive al cierre del modal
        if (err) err.textContent = "";
        okBtn.removeEventListener("click", alConfirmar);
        cancelBtn.removeEventListener("click", alCancelar);
        input.removeEventListener("keydown", alTecla);
        resolve(valor);
      }
      function alConfirmar() {
        var v = input.value.trim();
        if (!/^[0-9]{6}$/.test(v)) { if (err) err.textContent = "El PIN son 6 dígitos."; return; }
        terminar(v);
      }
      function alCancelar() { terminar(null); }
      function alTecla(e) { if (e.key === "Enter") alConfirmar(); else if (e.key === "Escape") alCancelar(); }

      okBtn.addEventListener("click", alConfirmar);
      cancelBtn.addEventListener("click", alCancelar);
      input.addEventListener("keydown", alTecla);
    });
  }

  /** Instancia real de la app (creada en app.js, prepararModoNube): usa fetch/SupabaseCliente/navigator reales
      y el modal de arriba. Null hasta que haya sesión de nube — ver app.js. */
  var instanciaApp = null;
  function prepararInstancia(o) {
    instanciaApp = crear({
      fetch: global.fetch ? global.fetch.bind(global) : null,
      baseApi: function () { var c = global.ENTIMOTORS_SUPABASE || {}; return (c.apiUrl || "").replace(/\/+$/, ""); },
      obtenerToken: function () { var s = o && o.sesion && o.sesion(); return s ? s.access_token : null; },
      enLinea: function () { return navigator.onLine !== false; },
      pedirPin: pedirPinConModal,
    });
    return instanciaApp;
  }

  /** Punto de entrada único para el resto de app.js: pide la autorización (o la resuelve sin red si es admin)
      y avisa el error con `toast` si algo salió mal (salvo cancelación, que es silenciosa). */
  async function autorizarAccion(o) {
    if (!instanciaApp) return { ok: false, motivo: "sin-inicializar", mensaje: "El módulo de autorización no está listo." };
    var r = await instanciaApp.pedirAutorizacion(o);
    if (!r.ok && r.motivo !== "cancelado" && typeof global.toast === "function") global.toast(r.mensaje, "off");
    return r;
  }

  global.PinUI = {
    crear: crear, mensajeParaCodigo: mensajeParaCodigo, ACCIONES_CON_PIN: ACCIONES_CON_PIN,
    prepararInstancia: prepararInstancia, autorizarAccion: autorizarAccion,
  };
})(typeof window !== "undefined" ? window : this);
