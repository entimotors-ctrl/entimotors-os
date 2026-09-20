/* ============================================================================
 * ENTIMOTORS OS · recovery.js — pantalla «Establecer contraseña»
 * ----------------------------------------------------------------------------
 * Recibe el retorno del enlace de recuperación de Supabase y deja que la
 * persona elija su propia contraseña. Es el único punto del sistema donde
 * alguien escribe una contraseña que no es la suya de siempre.
 *
 * DE DÓNDE SALE ESTA PANTALLA
 *   Siempre de un enlace de un solo uso que el ADMINISTRADOR le pasa a la persona
 *   desde «Usuarios y equipo»: al CREAR la cuenta (el servidor genera una
 *   contraseña aleatoria que nadie llega a ver) o con «Generar enlace» cuando
 *   alguien perdió su contraseña. Los dos son enlaces de tipo `recovery`. No se
 *   envía correo. La persona abre el enlace y aterriza aquí.
 *
 * LO QUE NO HACE, A PROPÓSITO
 *   · No guarda la contraseña en ningún sitio. Se escribe, se manda a Supabase
 *     y se suelta.
 *   · No guarda el token de recuperación. Vive en memoria dentro de auth.js y
 *     se pierde al recargar — que es lo correcto para un enlace de un solo uso.
 *   · No manda nada al api-server de ENTIMOTORS. La contraseña va directa a
 *     Supabase, con la sesión de recuperación, desde el navegador.
 *   · No inicia sesión sola. Al terminar se vuelve al login normal.
 * ==========================================================================*/
(function (global) {
  "use strict";

  /* Los dos tipos de enlace que significan «tienes que poner una contraseña».
     `magiclink` no está: ese es un acceso directo, no un alta. */
  var TIPOS = ["recovery", "invite"];

  /* Frase de bienvenida según el tipo de enlace. Un enlace `recovery` (el del alta y el de «Generar enlace») NO es una invitación:
     solo `invite` dice «Has sido invitado». El texto de partida (HTML) ya es el neutro de `recovery`. */
  var TEXTO_INTRO = {
    recovery: "Elige tu contraseña para entrar a ENTIMOTORS OS.",
    invite: "Has sido invitado a ENTIMOTORS OS. Crea tu contraseña para activar tu acceso.",
  };
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var MINIMO = 8;

  var deteccion = null;   // lo que se leyó de la URL, una sola vez

  function params(s) {
    try { return new URLSearchParams(s || ""); } catch (e) { return { get: function () { return null; } }; }
  }

  /* ── PASO 2 · qué trae la URL ────────────────────────────────────────────
     Se contemplan las cuatro formas en que Supabase puede devolver a alguien,
     porque no todas las configuraciones mandan lo mismo. */
  function detectar() {
    if (deteccion) return deteccion;
    var h = params((global.location.hash || "").replace(/^#/, ""));
    var q = params((global.location.search || "").replace(/^\?/, ""));
    var tipo = h.get("type") || q.get("type");

    // (a) Supabase ya dijo que no: enlace gastado, caducado o inválido
    var codigo = h.get("error_code") || q.get("error_code") || h.get("error") || q.get("error");
    if (codigo) {
      deteccion = { que: "error", codigo: codigo,
                    descripcion: h.get("error_description") || q.get("error_description") || "" };
      return deteccion;
    }
    // (b) sesión ya hecha en el fragmento — es lo que produce el enlace del alta
    var token = h.get("access_token");
    if (token && TIPOS.indexOf(tipo) >= 0) {
      deteccion = { que: "sesion", token: token, verificacion: tipo };
      return deteccion;
    }
    // (c) enlace con token por canjear (plantillas de correo con token_hash)
    var hash = q.get("token_hash") || h.get("token_hash");
    if (hash && TIPOS.indexOf(tipo) >= 0) {
      deteccion = { que: "canje", tokenHash: hash, verificacion: tipo };
      return deteccion;
    }
    // (d) flujo PKCE: el código solo lo puede canjear quien pidió el enlace,
    //     y no fuimos nosotros. Se avisa en vez de fallar en silencio.
    var code = q.get("code");
    if (code && UUID.test(code)) { deteccion = { que: "pkce" }; return deteccion; }

    deteccion = { que: "ninguno" };
    return deteccion;
  }

  function hayEnlace() { return detectar().que !== "ninguno"; }

  /* ── PASO 10 · limpiar la URL ────────────────────────────────────────────
     Solo cuando ya no hace falta: el token está en memoria (o muerto) y nadie
     más va a leer la barra de direcciones. */
  function limpiarURL() {
    try {
      if (global.history && history.replaceState) {
        history.replaceState(null, "", global.location.pathname);
      }
    } catch (e) { /* navegador antiguo: se queda como esté */ }
  }

  // ── pintado ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function cuerpo() { return document.getElementById("rcvCuerpo"); }

  function mostrarGate() {
    var g = document.getElementById("gateRecovery");
    if (g) g.classList.add("active");
    ["gateInstall", "gateLogin", "gateModo"].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.classList.remove("active");
    });
  }

  function pintar(html) { var c = cuerpo(); if (c) c.innerHTML = html; }

  function botonVolver(texto) {
    return '<button class="btn primary" id="rcvVolver" style="width:100%; margin-top:0.8rem;">' +
           esc(texto || "Volver al inicio de sesión") + "</button>";
  }
  /* Recargar en vez de enseñar el login a mano: así el arranque normal decide
     lo que toca (instalar, o iniciar sesión) y no queda medio sistema montado. */
  function engancharVolver() {
    var b = document.getElementById("rcvVolver");
    if (b) b.addEventListener("click", function () {
      if (global.Auth && Auth.enRecuperacion()) Auth.salirDeRecuperacion();
      limpiarURL();
      global.location.replace(global.location.pathname);
    });
  }

  function estadoVerificando() {
    pintar('<p class="desc" style="margin:0;">Comprobando el enlace…</p>');
  }
  function estadoInvalido(titulo, explicacion) {
    pintar('<p class="gate-error" style="margin:0 0 0.4rem;"><b>' + esc(titulo) + "</b></p>" +
           '<p class="desc" style="margin:0;">' + esc(explicacion) + "</p>" + botonVolver());
    engancharVolver();
    limpiarURL();   // el token de la URL ya no sirve para nada
  }
  function estadoSinConexion() {
    pintar('<p class="gate-error" style="margin:0 0 0.4rem;"><b>Sin conexión</b></p>' +
           '<p class="desc" style="margin:0;">Para establecer tu contraseña hace falta internet. ' +
           "Conéctate y vuelve a abrir el enlace.</p>" + botonVolver("Reintentar"));
    var b = document.getElementById("rcvVolver");
    if (b) b.addEventListener("click", function () { global.location.reload(); });
  }
  function estadoListo() {
    pintar('<p class="desc" style="margin:0 0 0.4rem;"><b>Contraseña establecida correctamente.</b></p>' +
           '<p class="desc" style="margin:0;">Ya puedes iniciar sesión con tu correo y la nueva contraseña.</p>' +
           botonVolver("Ir a iniciar sesión"));
    engancharVolver();
  }

  function estadoFormulario(correo) {
    pintar(
      (correo ? '<p class="desc" style="margin:0 0 0.6rem;">Cuenta: <b>' + esc(correo) + "</b></p>" : "") +
      '<form id="rcvForm" autocomplete="off">' +
        "<label>Nueva contraseña</label>" +
        '<input type="password" id="rcvClave" autocomplete="new-password">' +
        "<label>Confirmar contraseña</label>" +
        '<input type="password" id="rcvClave2" autocomplete="new-password">' +
        '<p class="desc" style="font-size:.8rem; opacity:.75; margin:0.3rem 0 0;">Al menos ' + MINIMO +
          " caracteres. Nadie más va a conocerla, ni el administrador.</p>" +
        '<p class="gate-error" id="rcvError"></p>' +
        '<button class="btn primary" type="submit" style="width:100%;">Establecer contraseña</button>' +
      "</form>"
    );
    var form = document.getElementById("rcvForm");
    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); enviar(); });
  }

  function error(msg) {
    var e = document.getElementById("rcvError");
    if (e) e.textContent = msg;
  }

  /* ── PASO 4 y 5 · validar y establecer ──────────────────────────────────── */
  function enviar() {
    var c1 = document.getElementById("rcvClave");
    var c2 = document.getElementById("rcvClave2");
    var boton = document.querySelector("#rcvForm button[type=submit]");
    if (!c1 || !c2) return;
    var clave = c1.value, copia = c2.value;

    if (!clave) { error("Escribe una contraseña."); return; }
    if (clave.length < MINIMO) { error("La contraseña debe tener al menos " + MINIMO + " caracteres."); return; }
    if (clave !== copia) { error("Las dos contraseñas no coinciden."); return; }
    error("");

    boton.disabled = true; boton.textContent = "Guardando…";
    global.Auth.establecerClave(clave).then(function (r) {
      // la contraseña se suelta pase lo que pase: ni se reintenta con ella
      // guardada, ni se queda escrita en el formulario
      c1.value = ""; c2.value = "";
      boton.disabled = false; boton.textContent = "Establecer contraseña";
      if (r.ok) { limpiarURL(); estadoListo(); return; }
      if (r.motivo === "enlace-caducado") {
        estadoInvalido("Enlace no válido o expirado",
          "Solicita al administrador que genere un nuevo enlace.");
        return;
      }
      if (r.motivo === "sin-conexion" || r.motivo === "tiempo-agotado") {
        error("Sin conexión con el servidor. Inténtalo otra vez.");
        return;
      }
      // lo que diga Supabase, tal cual: puede ser su propia política de claves
      error(r.detalle || "No se pudo establecer la contraseña.");
    }).catch(function () {
      // nada debería llegar aquí (pedir() no lanza), pero si llegara, el botón
      // no puede quedarse en «Guardando…» para siempre
      c1.value = ""; c2.value = "";
      boton.disabled = false; boton.textContent = "Establecer contraseña";
      error("No se pudo establecer la contraseña. Inténtalo otra vez.");
    });
  }

  /* ── orquestación ───────────────────────────────────────────────────────── */
  function iniciar() {
    var d = detectar();
    if (d.que === "ninguno") return false;

    mostrarGate();
    var intro = document.getElementById("rcvIntro");
    if (intro) intro.textContent = d.verificacion === "invite" ? TEXTO_INTRO.invite : TEXTO_INTRO.recovery;
    estadoVerificando();

    if (d.que === "error") {
      var caducado = /expired|otp_expired|access_denied/i.test(d.codigo || "");
      estadoInvalido(caducado ? "Enlace no válido o expirado" : "Enlace no válido",
        "Solicita al administrador que genere un nuevo enlace. " +
        "Los enlaces son de un solo uso: si ya lo abriste antes, hace falta uno nuevo.");
      return true;
    }
    if (d.que === "pkce") {
      estadoInvalido("Este enlace no se puede completar aquí",
        "Solicita al administrador que genere un nuevo enlace.");
      return true;
    }
    if (global.navigator && navigator.onLine === false) { estadoSinConexion(); return true; }
    if (!global.Auth || !Auth.disponible()) {
      estadoInvalido("No se puede comprobar el enlace",
        "La conexión con el servidor no está configurada en esta aplicación.");
      return true;
    }

    // (c) canjear primero el token_hash por una sesión; (b) ya la trae hecha
    var conSesion = d.que === "canje"
      ? global.SupabaseCliente.canjearToken(d.verificacion, d.tokenHash)
          .then(function (r) { return r.ok && r.datos && r.datos.access_token
              ? { ok: true, token: r.datos.access_token }
              : { ok: false, motivo: r.motivo === "sin-permiso" ? "enlace-caducado" : r.motivo }; })
      : Promise.resolve({ ok: true, token: d.token });

    conSesion.then(function (s) {
      if (!s.ok) {
        if (s.motivo === "sin-conexion" || s.motivo === "tiempo-agotado") { estadoSinConexion(); return; }
        estadoInvalido("Enlace no válido o expirado",
          "Solicita al administrador que genere un nuevo enlace.");
        return;
      }
      // PASO 11 · esto emite PASSWORD_RECOVERY por el canal de siempre
      return Auth.entrarEnRecuperacion(s.token).then(function (r) {
        if (r.ok) { estadoFormulario(r.datos && r.datos.correo); return; }
        if (r.motivo === "sin-conexion" || r.motivo === "tiempo-agotado") { estadoSinConexion(); return; }
        estadoInvalido("Enlace no válido o expirado",
          "Solicita al administrador que genere un nuevo enlace.");
      });
    }).catch(function () {
      estadoInvalido("No se pudo comprobar el enlace",
        "Vuelve a intentarlo, o pide al administrador uno nuevo.");
    });
    return true;
  }

  global.RecuperarClave = {
    hayEnlace: hayEnlace,
    detectar: detectar,
    iniciar: iniciar,
    _limpiarURL: limpiarURL,
    _olvidarDeteccion: function () { deteccion = null; }   // solo para las pruebas
  };
})(typeof window !== "undefined" ? window : this);
