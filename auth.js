/* ============================================================================
 * ENTIMOTORS OS · auth.js
 * ----------------------------------------------------------------------------
 * La capa de sesión. Se apoya en supabase-client.js (que solo sabe hablar HTTP)
 * y le añade lo que el taller necesita: perfil, rol, y avisar cuando la sesión
 * cambia.
 *
 * QUÉ NO HACE, A PROPÓSITO
 *   · No guarda contraseñas. Nunca. Ni en memoria más allá del envío.
 *   · No decide permisos de datos. Eso lo hace RLS en el servidor. Aquí solo
 *     se decide qué botones se enseñan.
 *   · No sustituye al login local todavía: si no hay red o no hay Supabase,
 *     el taller sigue entrando como siempre.
 *
 * LO QUE SÍ GUARDA en localStorage
 *   · el token de sesión, que lo administra supabase-client.js;
 *   · una copia del perfil (uuid, nombre, rol) para poder saludar por su nombre
 *     al abrir sin red. No es una credencial: sin token no sirve para nada.
 * ==========================================================================*/
(function (global) {
  "use strict";

  var CLAVE_PERFIL = "enti_perfil_supabase";
  var MARGEN_REFRESCO_MS = 120000;   // renovar el token 2 min antes de que caduque

  var SB = global.SupabaseCliente || null;
  var perfil = null;        // { uid, nombre, rol, activo }
  var oyentes = [];
  var temporizadorRefresco = null;
  var restaurando = false;  // cortafuegos anti-bucle

  /* La sesión de recuperación vive AQUÍ y solo aquí: en memoria, en una
     variable aparte. No entra en `sesion` de supabase-client.js, así que
     nunca llega a localStorage. Al recargar la página desaparece — que es
     exactamente lo que debe pasar con un enlace de un solo uso. */
  var recuperacion = null;   // { token, correo }

  // ── utilidades ────────────────────────────────────────────────────────────
  function leerPerfilGuardado() {
    try {
      var s = localStorage.getItem(CLAVE_PERFIL);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }
  function guardarPerfil(p) {
    perfil = p;
    try {
      if (p) localStorage.setItem(CLAVE_PERFIL, JSON.stringify(p));
      else localStorage.removeItem(CLAVE_PERFIL);
    } catch (e) { /* modo privado */ }
  }
  function avisar(evento) {
    for (var i = 0; i < oyentes.length; i++) {
      try { oyentes[i](evento, API.estado()); } catch (e) { console.error("[Auth] oyente:", e); }
    }
  }
  function bien(d) { return { ok: true, datos: d }; }
  function mal(m, d) { return { ok: false, motivo: m, detalle: d || "" }; }

  // ── el perfil, leído del servidor ─────────────────────────────────────────
  /* Se pide por el uid de la sesión. Da igual lo que se pida: RLS solo deja ver
     el propio perfil (o todos, si es admin). No se confía en lo que llegue del
     navegador para decidir permisos de datos. */
  function cargarPerfil(uid) {
    if (!SB) return Promise.resolve(mal("sin-cliente"));
    return SB.tabla("perfiles").leer("id=eq." + encodeURIComponent(uid) + "&select=id,nombre,rol,activo")
      .then(function (r) {
        if (!r.ok) return r;
        var fila = Array.isArray(r.datos) ? r.datos[0] : null;
        if (!fila) return mal("sin-perfil", "el usuario existe en Auth pero no tiene fila en perfiles");
        if (fila.activo === false) return mal("cuenta-desactivada", "esta cuenta está dada de baja");
        return bien({ uid: fila.id, nombre: fila.nombre, rol: fila.rol, activo: fila.activo });
      });
  }

  // ── renovación del token ──────────────────────────────────────────────────
  function programarRefresco() {
    if (temporizadorRefresco) { clearTimeout(temporizadorRefresco); temporizadorRefresco = null; }
    if (!SB) return;
    var s = SB.sesion();
    if (!s || !s.expires_at) return;
    var falta = s.expires_at * 1000 - Date.now() - MARGEN_REFRESCO_MS;
    if (falta < 5000) falta = 5000;
    if (falta > 2147483000) return;                 // más allá del máximo de setTimeout
    temporizadorRefresco = setTimeout(function () {
      SB.refrescarSesion().then(function (r) {
        if (r.ok) { avisar("TOKEN_REFRESHED"); programarRefresco(); }
        else { guardarPerfil(null); avisar("SIGNED_OUT"); }
      });
    }, falta);
  }

  // ── API ───────────────────────────────────────────────────────────────────
  var API = {

    /* ¿Se puede usar Supabase ahora mismo? */
    disponible: function () {
      return !!(SB && SB.estado().activo);
    },

    estado: function () {
      var e = SB ? SB.estado() : { activo: false, conSesion: false, usuario: null };
      return {
        disponible: !!e.activo,
        conSesion: !!e.conSesion,
        correo: e.usuario || null,
        perfil: perfil,
        rol: perfil ? perfil.rol : null,
        origen: e.conSesion && perfil ? "supabase" : null
      };
    },

    /* PASO 5 · entrar. Devuelve el perfil, no el token. */
    iniciarSesion: function (correo, clave) {
      if (!SB || !SB.estado().activo) return Promise.resolve(mal("supabase-no-configurado"));
      if (!correo || !clave) return Promise.resolve(mal("faltan-datos"));
      return SB.iniciarSesion(String(correo).trim(), clave).then(function (r) {
        if (!r.ok) {
          // 400 de GoTrue = credenciales malas o usuario inexistente. No se
          // distingue a propósito: decirlo delataría qué correos existen.
          if (r.http === 400) return mal("credenciales-invalidas");
          if (r.motivo === "sin-conexion" || r.motivo === "tiempo-agotado") return mal("sin-conexion");
          return mal(r.motivo || "error", r.detalle);
        }
        var uid = r.datos && r.datos.id;
        return cargarPerfil(uid).then(function (p) {
          if (!p.ok) {
            // sin perfil válido no se entra: se deshace la sesión
            return SB.cerrarSesion().then(function () { guardarPerfil(null); return p; });
          }
          guardarPerfil(p.datos);
          programarRefresco();
          avisar("SIGNED_IN");
          return bien(p.datos);
        });
      });
    },

    /* PASO 8 · salir. No borra ni un dato local. */
    cerrarSesion: function () {
      if (temporizadorRefresco) { clearTimeout(temporizadorRefresco); temporizadorRefresco = null; }
      var p = SB ? SB.cerrarSesion() : Promise.resolve(bien(null));
      return p.then(function () {
        guardarPerfil(null);
        avisar("SIGNED_OUT");
        return bien(null);
      });
    },

    /* PASO 7 · al abrir la app: ¿había sesión? */
    restaurarSesion: function () {
      if (restaurando) return Promise.resolve(mal("en-curso"));
      restaurando = true;
      var terminar = function (r) { restaurando = false; return r; };

      if (!SB || !SB.estado().activo) { return Promise.resolve(terminar(mal("supabase-no-configurado"))); }
      var s = SB.sesion();
      if (!s) {
        guardarPerfil(null);
        avisar("INITIAL_SESSION");
        return Promise.resolve(terminar(mal("sin-sesion")));
      }
      // hay token guardado: se confirma contra el servidor releyendo el perfil
      return cargarPerfil(s.user && s.user.id).then(function (p) {
        if (!p.ok) {
          if (p.motivo === "sin-conexion" || p.motivo === "tiempo-agotado") {
            // sin red no se puede confirmar. Se usa la copia guardada para poder
            // seguir trabajando, y se marca como no confirmada.
            var g = leerPerfilGuardado();
            if (g) { perfil = g; avisar("INITIAL_SESSION"); return terminar(bien(g)); }
          }
          if (p.motivo === "sin-permiso" || p.motivo === "cuenta-desactivada" || p.motivo === "sin-perfil") {
            return API.cerrarSesion().then(function () { return terminar(p); });
          }
          return terminar(p);
        }
        guardarPerfil(p.datos);
        programarRefresco();
        avisar("INITIAL_SESSION");
        return terminar(bien(p.datos));
      });
    },

    // ── consultas ───────────────────────────────────────────────────────────
    usuarioActual: function () {
      var s = SB ? SB.sesion() : null;
      if (!s || !s.user) return null;
      return { id: s.user.id, correo: s.user.email };
    },
    sesionActual: function () {
      var s = SB ? SB.sesion() : null;
      if (!s) return null;
      return { expira: s.expires_at ? new Date(s.expires_at * 1000) : null, usuario: s.user || null };
    },
    perfilActual: function () { return perfil; },
    rolActual: function () { return perfil ? perfil.rol : null; },

    /* El rol según el SERVIDOR, no según lo guardado. Para comprobaciones. */
    rolVerificado: function () {
      if (!SB) return Promise.resolve(mal("sin-cliente"));
      return SB.rpc("rol_actual");
    },

    esAdmin:        function () { return API.rolActual() === "admin"; },
    esMecanico:     function () { return API.rolActual() === "mecanico"; },
    esCajero:       function () { return API.rolActual() === "cajero"; },
    esDesarrollador:function () { return API.rolActual() === "desarrollador"; },
    /* el personal del taller: los mismos tres que es_equipo() en la base */
    esEquipo:       function () { return ["admin", "cajero", "mecanico"].indexOf(API.rolActual()) >= 0; },

    // ── recuperación de contraseña ──────────────────────────────────────────
    /* Entrar en modo recuperación. El token se comprueba contra el servidor
       ANTES de dar el paso: así un enlace ya gastado no llega a enseñar el
       formulario. Emite PASSWORD_RECOVERY por el mismo canal que el resto de
       eventos — no hay un segundo sistema de sesión. */
    entrarEnRecuperacion: function (token) {
      if (!SB || !SB.estado().activo) return Promise.resolve(mal("supabase-no-configurado"));
      if (!token) return Promise.resolve(mal("sin-token"));
      return SB.comprobarToken(token).then(function (r) {
        if (!r.ok) {
          // 401/403 de GoTrue con un token de recuperación = gastado o caducado
          if (r.motivo === "sin-permiso") return mal("enlace-caducado", r.detalle);
          return r;
        }
        recuperacion = { token: token, correo: (r.datos && r.datos.email) || "" };
        avisar("PASSWORD_RECOVERY");
        return bien({ correo: recuperacion.correo });
      });
    },

    /* Salir del modo recuperación y olvidar el token. */
    salirDeRecuperacion: function () {
      var habia = !!recuperacion;
      recuperacion = null;
      if (habia) avisar("SIGNED_OUT");
      return bien(null);
    },

    enRecuperacion: function () { return !!recuperacion; },
    correoEnRecuperacion: function () { return recuperacion ? recuperacion.correo : null; },

    /* Lo que hace supabase.auth.updateUser({ password }), con la sesión de
       recuperación. La contraseña se recibe, se envía y se suelta: esta función
       no la guarda, no la devuelve y no la escribe en ningún registro. */
    establecerClave: function (nueva) {
      if (!recuperacion) return Promise.resolve(mal("sin-recuperacion"));
      if (!SB) return Promise.resolve(mal("sin-cliente"));
      return SB.actualizarUsuario({ password: nueva }, recuperacion.token).then(function (r) {
        if (!r.ok) {
          if (r.motivo === "sin-permiso") return mal("enlace-caducado", r.detalle);
          /* Un fallo de TRANSPORTE no es una respuesta del servidor: no se llegó a
             saber si aplicó la contraseña. Pasa con su motivo (como en
             entrarEnRecuperacion) para que recovery.js diga «sin conexión» en vez
             de enseñar el texto crudo del navegador como si fuera un rechazo. */
          if (r.motivo === "sin-conexion" || r.motivo === "tiempo-agotado") return mal(r.motivo, r.detalle);
          return mal("rechazada-por-el-servidor", r.detalle);
        }
        /* Éxito = HTTP correcto Y la forma mínima del contrato: Supabase Auth
           contesta a este PUT con el usuario, o sea un objeto. Un 200 con HTML,
           texto, null, un arreglo o JSON truncado (lo que contestaría un
           intermediario) NO es éxito: no se da la contraseña por puesta. No es un
           fallo de red ni se sale de la recuperación: se puede reintentar. */
        if (!r.datos || typeof r.datos !== "object" || Array.isArray(r.datos)) return mal("respuesta-invalida");
        // hecho: el token de recuperación ya no vale para nada más
        recuperacion = null;
        avisar("SIGNED_OUT");
        return bien(null);
      });
    },

    /* PASO 7 · SIGNED_IN · SIGNED_OUT · TOKEN_REFRESHED · INITIAL_SESSION
               · PASSWORD_RECOVERY */
    alCambiar: function (fn) {
      if (typeof fn === "function") oyentes.push(fn);
      return function () { oyentes = oyentes.filter(function (x) { return x !== fn; }); };
    }
  };

  // el perfil guardado se carga en memoria, pero NO cuenta como sesión:
  // sin token, estado().conSesion sigue siendo false.
  perfil = leerPerfilGuardado();

  global.Auth = API;
})(typeof window !== "undefined" ? window : this);
