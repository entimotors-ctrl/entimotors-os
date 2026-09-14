/* ============================================================================
 * ENTIMOTORS OS · supabase-client.js
 * ----------------------------------------------------------------------------
 * RESPONSABILIDAD ÚNICA: crear el cliente de Supabase y exponerlo.
 *
 * Este archivo NO sabe nada de ventas, caja, créditos, inventario ni órdenes.
 * Es solo la tubería. La lógica del taller vive en app.js y sigue guardando
 * TODO en IndexedDB.
 *
 * REGLAS QUE CUMPLE
 *   · Si no hay configuración, no hace absolutamente nada. Cero peticiones,
 *     cero errores en consola, cero cambios en el comportamiento de la app.
 *   · Si no hay internet, responde {ok:false, motivo:"sin-conexion"} en vez de
 *     lanzar excepciones. Supabase es un complemento, no el sistema.
 *   · Si le pasan una service_role, SE NIEGA A ARRANCAR.
 *   · Se apaga entero poniendo habilitado:false en supabase-config.js, o
 *     borrando ese archivo. IndexedDB no se entera.
 *
 * Estado hoy: PREPARADO, SIN CONECTAR. index.html todavía no lo carga.
 * Ver SUPABASE-INTEGRACION.md para los pasos exactos de activación.
 * ==========================================================================*/
(function (global) {
  "use strict";

  var CLAVE_SESION = "entimotors_sb_sesion";
  var TIMEOUT_MS = 12000;

  // -- 1 - Leer la configuracion, si existe ---------------------------------
  var cfg = global.ENTIMOTORS_SUPABASE || null;
  var activo = false;
  var motivo = "sin-configuracion";
  var URL_BASE = "";
  var ANON = "";

  function vacio(v) { return typeof v !== "string" || v.trim() === ""; }

  /* Distingue una clave publica de una de servidor. Las claves clasicas son un
     JWT con {"role":"anon"} o {"role":"service_role"} en la carga util; las
     nuevas empiezan por sb_publishable_ / sb_secret_. */
  function esClaveDeServidor(k) {
    if (/^sb_secret_/.test(k)) return true;
    if (/^sb_publishable_/.test(k)) return false;
    var partes = k.split(".");
    if (partes.length !== 3) return false;
    try {
      var b64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      return JSON.parse(atob(b64)).role === "service_role";
    } catch (e) { return false; }
  }

  if (!cfg) {
    motivo = "sin-configuracion";
  } else if (cfg.habilitado === false) {
    motivo = "apagado-a-proposito";
  } else if (vacio(cfg.url) || vacio(cfg.anonKey)) {
    motivo = "faltan-url-o-anonkey";
  } else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(cfg.url.trim().replace(/\/+$/, ""))) {
    motivo = "url-con-forma-invalida";
  } else if (esClaveDeServidor(cfg.anonKey.trim())) {
    /* Cortafuegos. Nunca deberia pasar, pero si pasa el sistema se apaga en vez
       de publicar una llave que salta todas las politicas de seguridad. */
    motivo = "clave-de-servidor-rechazada";
    console.error(
      "[Supabase] Se ha configurado una clave de SERVIDOR (service_role) en el " +
      "navegador. Supabase queda DESACTIVADO. Sustituirla por la clave anon " +
      "(publica) en supabase-config.js. Ver SUPABASE-CONFIG.md."
    );
  } else {
    URL_BASE = cfg.url.trim().replace(/\/+$/, "");
    ANON = cfg.anonKey.trim();
    activo = true;
    motivo = "listo";
  }

  // -- 2 - Sesion guardada --------------------------------------------------
  var sesion = null;
  try {
    var crudo = localStorage.getItem(CLAVE_SESION);
    if (crudo) sesion = JSON.parse(crudo);
  } catch (e) { sesion = null; }

  function guardarSesion(s) {
    sesion = s;
    try {
      if (s) localStorage.setItem(CLAVE_SESION, JSON.stringify(s));
      else localStorage.removeItem(CLAVE_SESION);
    } catch (e) { /* modo privado: la sesion vive solo en memoria */ }
  }

  function sesionVigente() {
    return !!(sesion && sesion.access_token &&
              (!sesion.expires_at || sesion.expires_at * 1000 > Date.now() + 30000));
  }

  // -- 3 - Peticion HTTP, siempre con la red envuelta -----------------------
  function bien(datos, extra) {
    var r = { ok: true, datos: datos };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }
  function mal(motivoErr, detalle, http) {
    return { ok: false, motivo: motivoErr, detalle: detalle || "", http: http || 0 };
  }

  function pedir(ruta, opciones) {
    opciones = opciones || {};
    if (!activo) return Promise.resolve(mal("desactivado", motivo));
    if (global.navigator && navigator.onLine === false) {
      return Promise.resolve(mal("sin-conexion", "el dispositivo esta sin red"));
    }

    var cabeceras = { apikey: ANON };
    if (opciones.cuerpo !== undefined) cabeceras["Content-Type"] = "application/json";
    /* Un token explícito manda sobre la sesión guardada. Lo usa el flujo de
       recuperación, cuya sesión vive SOLO en memoria: nunca pasa por
       guardarSesion() y por tanto nunca llega a localStorage. */
    if (opciones.token) {
      cabeceras.Authorization = "Bearer " + opciones.token;
    } else if (opciones.conSesion !== false && sesionVigente()) {
      cabeceras.Authorization = "Bearer " + sesion.access_token;
    } else if (opciones.conSesion !== false) {
      cabeceras.Authorization = "Bearer " + ANON;
    }
    if (opciones.cabeceras) {
      for (var h in opciones.cabeceras) cabeceras[h] = opciones.cabeceras[h];
    }

    var corta = null, temporizador = null;
    if (global.AbortController) {
      corta = new AbortController();
      temporizador = setTimeout(function () { corta.abort(); }, opciones.timeout || TIMEOUT_MS);
    }

    return fetch(URL_BASE + ruta, {
      method: opciones.metodo || "GET",
      headers: cabeceras,
      body: opciones.cuerpo !== undefined ? JSON.stringify(opciones.cuerpo) : undefined,
      signal: corta ? corta.signal : undefined
    }).then(function (res) {
      if (temporizador) clearTimeout(temporizador);
      var rango = res.headers.get("content-range");
      return res.text().then(function (txt) {
        var cuerpo = null;
        if (txt) { try { cuerpo = JSON.parse(txt); } catch (e) { cuerpo = txt; } }
        if (!res.ok) {
          var msg = (cuerpo && (cuerpo.message || cuerpo.error_description || cuerpo.error)) || res.statusText;
          return mal(res.status === 401 || res.status === 403 ? "sin-permiso" : "error-servidor", msg, res.status);
        }
        return bien(cuerpo, rango ? { rango: rango } : null);
      });
    }).catch(function (err) {
      if (temporizador) clearTimeout(temporizador);
      var esCorte = err && (err.name === "AbortError");
      return mal(esCorte ? "tiempo-agotado" : "sin-conexion", err && err.message ? err.message : String(err));
    });
  }

  // -- 4 - Lo que se expone -------------------------------------------------
  var API = {

    /* Como esta el cliente. Nunca lanza. */
    estado: function () {
      return {
        activo: activo,
        motivo: motivo,
        url: activo ? URL_BASE : null,
        conSesion: sesionVigente(),
        usuario: sesionVigente() && sesion.user ? sesion.user.email : null
      };
    },

    /* TEST A - responde el proyecto? No necesita sesion. */
    probarConexion: function () {
      return pedir("/auth/v1/health", { conSesion: false });
    },

    /* TEST B - entrar con correo y contrasena. */
    iniciarSesion: function (correo, clave) {
      return pedir("/auth/v1/token?grant_type=password", {
        metodo: "POST", conSesion: false, cuerpo: { email: correo, password: clave }
      }).then(function (r) {
        if (!r.ok) return r;
        var d = r.datos || {};
        guardarSesion({
          access_token: d.access_token,
          refresh_token: d.refresh_token,
          expires_at: d.expires_at || (Math.floor(Date.now() / 1000) + (d.expires_in || 3600)),
          user: d.user ? { id: d.user.id, email: d.user.email } : null
        });
        return bien(sesion.user);
      });
    },

    refrescarSesion: function () {
      if (!sesion || !sesion.refresh_token) return Promise.resolve(mal("sin-sesion"));
      return pedir("/auth/v1/token?grant_type=refresh_token", {
        metodo: "POST", conSesion: false, cuerpo: { refresh_token: sesion.refresh_token }
      }).then(function (r) {
        if (!r.ok) return r;
        var d = r.datos || {};
        guardarSesion({
          access_token: d.access_token,
          refresh_token: d.refresh_token,
          expires_at: d.expires_at || (Math.floor(Date.now() / 1000) + (d.expires_in || 3600)),
          user: d.user ? { id: d.user.id, email: d.user.email } : (sesion ? sesion.user : null)
        });
        return bien(sesion.user);
      });
    },

    cerrarSesion: function () {
      var p = sesionVigente()
        ? pedir("/auth/v1/logout", { metodo: "POST" })
        : Promise.resolve(bien(null));
      return p.then(function () { guardarSesion(null); return bien(null); });
    },

    sesion: function () { return sesionVigente() ? sesion : null; },

    /* El rol del usuario, tal y como lo ve la base de datos. */
    rol: function () {
      return API.rpc("rol_actual");
    },

    /* Llamar a una funcion de la base. Quien decide si puede ejecutarla es el
       propio servidor: aqui no hay ninguna comprobacion de rol. */
    rpc: function (nombre, parametros) {
      return pedir("/rest/v1/rpc/" + encodeURIComponent(nombre), {
        metodo: "POST", cuerpo: parametros || {}
      });
    },

    /* ── recuperación de contraseña ──────────────────────────────────────
       Estas tres no tocan `sesion` ni localStorage. El token de recuperación
       se recibe por parámetro y se devuelve el resultado; quien lo tenga en
       memoria decide cuánto vive. Son las mismas llamadas HTTP que hace
       supabase-js: verifyOtp() -> POST /auth/v1/verify,
       getUser() -> GET /auth/v1/user, updateUser() -> PUT /auth/v1/user. */

    /* Canjea un token_hash por una sesión. Para los enlaces que llegan con
       ?token_hash=...&type=recovery en vez del fragmento con la sesión ya hecha. */
    canjearToken: function (tipo, tokenHash) {
      return pedir("/auth/v1/verify", {
        metodo: "POST", conSesion: false,
        cuerpo: { type: tipo, token_hash: tokenHash }
      });
    },

    /* ¿Sirve este token? Confirma contra el servidor antes de enseñar el
       formulario: así un enlace ya gastado no llega a pedir contraseña. */
    comprobarToken: function (token) {
      return pedir("/auth/v1/user", { token: token });
    },

    /* Lo que hace supabase.auth.updateUser({ password }). La contraseña viaja
       en el cuerpo y no se guarda en ningún sitio, ni aquí ni en el servidor
       de ENTIMOTORS: va directa a Supabase. */
    actualizarUsuario: function (cambios, token) {
      return pedir("/auth/v1/user", { metodo: "PUT", token: token, cuerpo: cambios });
    },

    /* Acceso generico a una tabla. Tuberia, no logica de negocio: quien decide
       que se puede leer o escribir son las politicas RLS del servidor. */
    tabla: function (nombre) {
      var base = "/rest/v1/" + encodeURIComponent(nombre);
      return {
        leer: function (consulta) {
          return pedir(base + "?" + (consulta || "select=*"), {
            cabeceras: { Prefer: "count=exact", Range: "0-99" }
          });
        },
        insertar: function (filas) {
          return pedir(base, {
            metodo: "POST", cuerpo: filas,
            cabeceras: { Prefer: "return=representation" }
          });
        },
        borrar: function (filtro) {
          return pedir(base + "?" + filtro, { metodo: "DELETE" });
        }
      };
    }
  };

  global.SupabaseCliente = API;

  if (!activo && motivo !== "sin-configuracion") {
    console.info("[Supabase] desactivado (" + motivo + "). La app sigue funcionando con IndexedDB.");
  }
})(typeof window !== "undefined" ? window : this);
