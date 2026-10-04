/* ============================================================================
 * ENTIMOTORS OS · sync-realtime.js  (3.15.0 · Bloque 3)
 * ----------------------------------------------------------------------------
 * Avisos en tiempo real desde Supabase Realtime (Broadcast PRIVADO), sin
 * dependencias: el protocolo Phoenix v1 (JSON) sobre un WebSocket.
 *
 * QUÉ LLEGA: solo avisos mínimos {e: entidad, id?: uuid, rev?} que manda la base
 * (sync-15c-mensajes-realtime.sql). Nunca datos: al recibir uno, la app vuelve a
 * pedir ESE registro por REST con su token y bajo RLS (SyncEngine.pullUno). Así,
 * un aviso duplicado, atrasado o fuera de orden no puede dejar nada mal: manda lo
 * que el servidor tiene ahora.
 *
 * QUIÉN ESCUCHA QUÉ lo decide el servidor (RLS de realtime.messages): «mt:<perfil>»
 * solo su mecánico activo, «taller» admin y cajero, «admin» solo el admin. El token
 * viaja dentro del mensaje de unión (no en la URL) y se renueva en el canal cuando
 * la sesión se refresca. Canal rechazado o token caducado → no se insiste en bucle:
 * se espera a que cambie el token (nuevo inicio de sesión / refresco).
 *
 * COSTE: una conexión por dispositivo; un latido cada 25 s (un marco del socket,
 * no una petición HTTP); 0 consultas mientras no pase nada. Sin red o sin avisos,
 * la app sigue con su sincronización de siempre (red de seguridad en sync-engine).
 * ==========================================================================*/
(function (global) {
  "use strict";

  var VSN = "1.0.0";

  function urlSocket(baseUrl, apiKey) {
    var u = String(baseUrl || "").replace(/\/+$/, "").replace(/^http/i, "ws");
    return u + "/realtime/v1/websocket?apikey=" + encodeURIComponent(apiKey || "") + "&vsn=" + VSN;
  }
  /** Espera antes de reconectar: 1 s, 2 s, 4 s… tope `tope` ms, con variación (no reconectan todos a la vez). */
  function esperaMs(intentos, tope, aleatorio) {
    var base = Math.min(1000 * Math.pow(2, Math.max(0, intentos - 1)), tope || 30000);
    return Math.round(base * (0.75 + 0.5 * (aleatorio === undefined ? Math.random() : aleatorio)));
  }
  /** exp (ms) de un JWT, o null si no se puede leer. Solo para decidir si un aviso de «token caducado» es de ESTA unión. */
  function expiraEn(token) {
    try {
      var p = String(token || "").split(".")[1];
      if (!p || typeof global.atob !== "function") return null;
      var j = JSON.parse(global.atob(p.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((p.length + 3) % 4)));
      return typeof j.exp === "number" ? j.exp * 1000 : null;
    } catch (e) { return null; }
  }
  /** Motivo de un rechazo del servidor que NO se arregla reintentando con el mismo token. */
  function esRechazoDeAcceso(texto) { return /unauthori[sz]ed|permission|expired|invalid.?jwt|jwt|token/i.test(String(texto || "")); }

  function crear(o) {
    var WS = o.WebSocket || global.WebSocket;
    var reloj = o.ahora || function () { return Date.now(); };
    var azar = function () { return typeof o.aleatorio === "function" ? o.aleatorio() : undefined; };   // pruebas: variación fija
    var temporizar = o.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    var destemporizar = o.clearTimeout || function (t) { clearTimeout(t); };
    var LATIDO_MS = o.latidoMs || 25000, TOPE_MS = o.topeReconexionMs || 30000, ESPERA_ACCESO_MS = o.esperaAccesoMs || 60000;
    var temas = (o.temas || []).slice();
    var ws = null, estado = "apagado", ref = 0, intentos = 0, tReconexion = null, tLatido = null, cerrado = false;
    var canales = {};              // tema → {estado:"uniendo"|"unido"|"rechazado", joinRef, token}
    var vistos = [], vistosSet = {};
    var metricas = { conexiones: 0, reconexiones: 0, avisos: 0, duplicados: 0, bytes: 0, latidos: 0, rechazos: 0, ultimoAviso: null, desde: null };
    var huboConexion = false;

    function fijar(e, detalle) {
      if (estado === e && !detalle) return;
      estado = e;
      if (o.alEstado) { try { o.alEstado(e, detalle || null); } catch (x) { /* un oyente roto no rompe */ } }
    }
    function token() { try { return o.getToken ? o.getToken() : null; } catch (e) { return null; } }
    function enviar(m) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(m)); return true; } catch (e) { return false; } } return false; }
    function sigRef() { ref += 1; return String(ref); }

    function unir(tema) {
      var t = token();
      if (!t) { canales[tema] = { estado: "rechazado", motivo: "sin-sesion", token: null }; return; }
      var jr = sigRef();
      canales[tema] = { estado: "uniendo", joinRef: jr, token: t };
      enviar({ topic: "realtime:" + tema, event: "phx_join", ref: jr, join_ref: jr,
        payload: { config: { broadcast: { self: false, ack: false }, presence: { key: "", enabled: false }, postgres_changes: [], private: true }, access_token: t } });
    }
    function evaluar() {
      var nombres = Object.keys(canales);
      if (!nombres.length) return;
      if (nombres.every(function (n) { return canales[n].estado === "unido"; })) {
        var reconexion = huboConexion; huboConexion = true; intentos = 0;
        fijar("conectado");
        if (o.alConectado) { try { o.alConectado(reconexion); } catch (x) { /* idem */ } }
        return;
      }
      if (nombres.some(function (n) { return canales[n].estado === "rechazado"; }) && !nombres.some(function (n) { return canales[n].estado === "uniendo"; })) {
        var sinSesion = nombres.some(function (n) { return canales[n].motivo === "sin-sesion"; });
        fijar(sinSesion ? "sin-sesion" : "sin-acceso");
      }
    }
    function latido() {
      tLatido = null;
      if (!ws || ws.readyState !== 1) return;
      metricas.latidos++;
      enviar({ topic: "phoenix", event: "heartbeat", payload: {}, ref: sigRef() });
      // sesión refrescada: el canal recibe el token nuevo (sin reconectar); un canal rechazado se vuelve a intentar SOLO si cambió
      var t = token();
      Object.keys(canales).forEach(function (n) {
        var c = canales[n];
        if (c.estado === "unido" && t && t !== c.token) { c.token = t; enviar({ topic: "realtime:" + n, event: "access_token", ref: sigRef(), join_ref: c.joinRef, payload: { access_token: t } }); }
        else if (c.estado === "rechazado" && t && (t !== c.token || reloj() - (c.en || 0) >= ESPERA_ACCESO_MS)) unir(n);
      });
      tLatido = temporizar(latido, LATIDO_MS);
    }
    function yaVisto(id) {
      if (!id) return false;
      if (vistosSet[id]) return true;
      vistosSet[id] = true; vistos.push(id);
      if (vistos.length > 300) delete vistosSet[vistos.shift()];
      return false;
    }
    function alMensaje(ev) {
      var texto = typeof ev.data === "string" ? ev.data : "";
      metricas.bytes += texto.length;
      var m; try { m = JSON.parse(texto); } catch (e) { return; }
      if (!m || typeof m.topic !== "string") return;
      var tema = m.topic.indexOf("realtime:") === 0 ? m.topic.slice(9) : null;
      var c = tema ? canales[tema] : null;
      if (m.event === "phx_reply" && c && m.ref === c.joinRef) {
        var ok = m.payload && m.payload.status === "ok";
        if (ok) c.estado = "unido";
        else {
          var motivo = m.payload && m.payload.response && m.payload.response.reason;
          c.estado = "rechazado"; c.motivo = esRechazoDeAcceso(motivo) ? "acceso" : "error"; c.en = reloj(); c.detalle = String(motivo || "").slice(0, 200);
          metricas.rechazos++;
        }
        evaluar(); return;
      }
      if (m.event === "broadcast" && c && c.estado === "unido") {
        var p = m.payload || {}, aviso = p.payload || {};
        var id = (p.meta && p.meta.id) || aviso.id_aviso || null;
        if (yaVisto(id)) { metricas.duplicados++; return; }
        metricas.avisos++; metricas.ultimoAviso = reloj();
        if (o.alAviso && aviso && typeof aviso.e === "string") { try { o.alAviso(aviso, tema); } catch (x) { /* idem */ } }
        return;
      }
      if (m.event === "system" && c) {
        var st = m.payload && m.payload.status;
        if (st === "error") {                                   // p. ej. «Token has expired»: el servidor cierra el canal
          // el aviso no trae ref: si el token de la unión VIGENTE no está caducado, es un aviso atrasado de la unión anterior
          var exp = expiraEn(c.token);
          if (/expired/i.test(String(m.payload.message || "")) && exp && exp > reloj() + 5000) return;
          c.estado = "rechazado"; c.motivo = esRechazoDeAcceso(m.payload.message) ? "acceso" : "error"; c.en = reloj(); c.detalle = String(m.payload.message || "").slice(0, 200);
          metricas.rechazos++; evaluar();
        }
        return;
      }
      if ((m.event === "phx_error" || m.event === "phx_close") && c) {
        // un cierre ATRASADO de una unión anterior (p. ej. la del token que caducó) no toca la unión vigente
        var refCierre = m.join_ref || m.ref;
        if (refCierre && c.joinRef && refCierre !== c.joinRef) return;
        if (c.estado === "unido" || c.estado === "uniendo") {
          var jr = c.joinRef;
          c.estado = "rechazado"; c.motivo = "error"; c.en = 0; fijar("desconectado");
          temporizar(function () { var x = canales[tema]; if (!cerrado && ws && ws.readyState === 1 && x && x.joinRef === jr && x.estado === "rechazado") unir(tema); }, esperaMs(1, TOPE_MS, azar()));
        }
      }
    }
    function programarReconexion() {
      if (cerrado || tReconexion) return;
      if (global.navigator && global.navigator.onLine === false) { fijar("sin-red"); return; }   // «online» lo reanuda
      intentos++;
      var espera = esperaMs(intentos, TOPE_MS, azar());
      tReconexion = temporizar(function () { tReconexion = null; abrir(); }, espera);
    }
    function abrir() {
      if (cerrado || (ws && (ws.readyState === 0 || ws.readyState === 1))) return;
      if (!WS) { fijar("no-disponible"); return; }
      if (!token()) { fijar("sin-sesion"); return; }
      fijar("conectando");
      var s;
      try { s = new WS(urlSocket(o.url, o.apiKey)); } catch (e) { programarReconexion(); return; }
      ws = s;
      s.onopen = function () {
        if (ws !== s) return;
        metricas.conexiones++; if (metricas.conexiones > 1) metricas.reconexiones++;
        if (!metricas.desde) metricas.desde = reloj();
        canales = {};
        temas.forEach(unir);
        evaluar();
        if (tLatido) destemporizar(tLatido);
        tLatido = temporizar(latido, LATIDO_MS);
      };
      s.onmessage = function (ev) { if (ws === s) alMensaje(ev); };
      s.onerror = function () { /* onclose decide */ };
      s.onclose = function () {
        if (ws !== s) return;
        ws = null; if (tLatido) { destemporizar(tLatido); tLatido = null; }
        Object.keys(canales).forEach(function (n) { if (canales[n].estado !== "rechazado") canales[n].estado = "caido"; });
        if (cerrado) { fijar("apagado"); return; }
        fijar("desconectado");
        programarReconexion();
      };
    }

    return {
      /** Arranca (idempotente). */
      conectar: function () { cerrado = false; abrir(); },
      /** Tras un nuevo inicio de sesión, «online» o volver a la app: reconecta ya si hacía falta (sin esperar la espera larga). */
      reintentar: function () {
        if (cerrado) return;
        if (tReconexion) { destemporizar(tReconexion); tReconexion = null; }
        if (ws && ws.readyState === 1) { Object.keys(canales).forEach(function (n) { if (canales[n].estado === "rechazado" && token() && token() !== canales[n].token) unir(n); }); return; }
        intentos = 0; abrir();
      },
      /** Sin red: se cierra limpio y se queda quieto hasta reintentar(). */
      pausar: function () { if (tReconexion) { destemporizar(tReconexion); tReconexion = null; } if (ws) { try { ws.close(); } catch (e) { /* ya */ } } },
      /** Cierre definitivo (cierre de sesión / cambio de usuario): no reconecta. */
      cerrar: function () {
        cerrado = true;
        if (tReconexion) { destemporizar(tReconexion); tReconexion = null; }
        if (tLatido) { destemporizar(tLatido); tLatido = null; }
        var s = ws; ws = null; canales = {};
        if (s) { try { s.close(); } catch (e) { /* ya */ } }
        fijar("apagado");
      },
      estado: function () { return estado; },
      canales: function (detalle) { var r = {}; Object.keys(canales).forEach(function (n) { var c = canales[n]; r[n] = detalle ? { estado: c.estado, motivo: c.motivo || null, detalle: c.detalle || null, joinRef: c.joinRef || null } : c.estado; }); return r; },
      metricas: function () { var r = {}; Object.keys(metricas).forEach(function (k) { r[k] = metricas[k]; }); return r; },
    };
  }

  global.SyncRealtime = { crear: crear, urlSocket: urlSocket, esperaMs: esperaMs, esRechazoDeAcceso: esRechazoDeAcceso };
})(typeof window !== "undefined" ? window : this);
