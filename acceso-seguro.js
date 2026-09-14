/* ============================================================================
 * ENTIMOTORS OS · acceso-seguro.js
 * ----------------------------------------------------------------------------
 * Verifica una identidad contra Supabase Auth. La contraseña la compara el
 * SERVIDOR: aquí no hay ninguna contraseña, ningún código y ningún secreto.
 *
 * Lo que hace, siempre en este orden:
 *   1. pide un token a Supabase con correo + contraseña;
 *   2. con ese token lee SOLO la fila propia de `perfiles` (rol, activo);
 *   3. revoca ese token en el servidor y lo borra del dispositivo.
 *
 * No se guarda nada: ni la contraseña, ni el token. El resultado es solo "sí,
 * esta persona es quien dice y tiene este rol". Con eso app.js decide.
 *
 * Sin configuración de Supabase, sin red o sin respuesta del servidor, devuelve
 * {ok:false} con un motivo. Nunca lanza, y nunca da por buena una identidad que
 * no haya confirmado el servidor.
 * ==========================================================================*/
(function (global) {
  "use strict";

  /* Roles que pueden usar la aplicación del taller. El mecánico tiene su propia
     app («Mi Trabajo»); el desarrollador no entra a ver clientes. */
  var ROLES_TALLER = ["admin", "cajero"];

  var MENSAJES = {
    "credenciales": "Correo o contraseña incorrectos.",
    "sin-conexion": "Sin conexión. Para verificar tu identidad hace falta internet.",
    "demasiados-intentos": "Demasiados intentos. Espera unos minutos y vuelve a probar.",
    "no-disponible": "La verificación en línea no está disponible en este dispositivo.",
    "sin-perfil": "Esta cuenta no tiene acceso a ENTIMOTORS.",
    "datos-incompletos": "Escribe tu correo y tu contraseña.",
    "no-verificado": "No se pudo verificar tu identidad. Inténtalo de nuevo."
  };
  function mal(motivo) { return { ok: false, motivo: motivo, mensaje: MENSAJES[motivo] || MENSAJES["no-verificado"] }; }

  function cliente() { return global.SupabaseCliente || null; }

  /* ¿Hay un camino real para verificar una identidad ahora mismo? */
  function disponible() {
    var c = cliente();
    if (!c) return mal("no-disponible");
    if (!c.estado().activo) return mal("no-disponible");
    if (global.navigator && navigator.onLine === false) return mal("sin-conexion");
    return { ok: true };
  }

  /* Traduce el error del cliente a un motivo. Para credenciales incorrectas
     Supabase responde igual exista o no el correo: no se revela cuál falló. */
  function motivoDeError(r) {
    if (!r) return "no-verificado";
    if (r.motivo === "sin-conexion" || r.motivo === "tiempo-agotado") return "sin-conexion";
    if (r.http === 429) return "demasiados-intentos";
    if (r.http === 400 || r.http === 401 || r.http === 403) return "credenciales";
    if (r.motivo === "desactivado") return "no-disponible";
    return "no-verificado";
  }

  function verificar(correo, clave) {
    correo = typeof correo === "string" ? correo.trim().toLowerCase() : "";
    if (!correo || typeof clave !== "string" || !clave) return Promise.resolve(mal("datos-incompletos"));
    var d = disponible();
    if (!d.ok) return Promise.resolve(d);
    var c = cliente();

    return c.iniciarSesion(correo, clave).then(function (r) {
      if (!r.ok) return mal(motivoDeError(r));
      var uid = r.datos && r.datos.id;
      if (!uid) return c.cerrarSesion().then(function () { return mal("no-verificado"); });

      return c.tabla("perfiles")
        .leer("select=id,nombre,telefono,rol,activo&id=eq." + encodeURIComponent(uid))
        .then(function (p) {
          var fila = p.ok && Array.isArray(p.datos) && p.datos.length === 1 ? p.datos[0] : null;
          return fila ? { ok: true, perfil: fila, correo: correo } : mal(p.ok ? "sin-perfil" : motivoDeError(p));
        }, function () { return mal("no-verificado"); })
        .then(function (resultado) {
          // el token solo servía para esta comprobación: se revoca y se borra, pase lo que pase
          return c.cerrarSesion().then(function () { return resultado; }, function () { return resultado; });
        });
    }, function () { return mal("no-verificado"); });
  }

  /* ¿Puede esta cuenta usar la aplicación del taller? */
  function permiteTaller(perfil) {
    if (!perfil) return { ok: false, mensaje: MENSAJES["sin-perfil"] };
    if (perfil.activo === false) return { ok: false, mensaje: "Esta cuenta está dada de baja. Habla con el administrador." };
    if (perfil.rol === "mecanico") return { ok: false, mensaje: "Esta cuenta se usa desde ENTIMOTORS Mi Trabajo." };
    if (ROLES_TALLER.indexOf(perfil.rol) === -1) return { ok: false, mensaje: MENSAJES["sin-perfil"] };
    return { ok: true };
  }

  function esAdmin(perfil) {
    return !!(perfil && perfil.rol === "admin" && perfil.activo !== false);
  }

  /* La sesión que guarda app.js. Mismos campos que la del login local, más
     origen y perfilId. Ningún token, ninguna contraseña. */
  function sesionDesdePerfil(correo, perfil) {
    return {
      user: correo,
      nombre: perfil.nombre || correo,
      telefono: perfil.telefono || "",
      rol: perfil.rol,
      origen: "supabase",
      perfilId: perfil.id
    };
  }

  global.AccesoSeguro = {
    disponible: disponible,
    verificar: verificar,
    permiteTaller: permiteTaller,
    esAdmin: esAdmin,
    sesionDesdePerfil: sesionDesdePerfil
  };
})(typeof window !== "undefined" ? window : this);
