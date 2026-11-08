/* ============================================================================
 * ENTIMOTORS OS · fotos-avance.js  (3.16 · cambio 1)
 * ----------------------------------------------------------------------------
 * Qué fotos de una orden ya se le mandaron al cliente con el avance, para que
 * el siguiente avance lleve solo las NUEVAS (paso 2 sin repetir la del paso 1).
 *
 * Cada foto se reconoce por una clave corta:
 *   · foto del mecánico (ruta de Storage): la ruta misma;
 *   · foto del Taller (data: URL en base64): "d:<largo>:<FNV-1a 32 bits>".
 *     No se guarda la imagen: solo su huella.
 *
 * Dónde se guarda (3.16 parte A): en ESTE dispositivo (localStorage), por
 * orden. Otro teléfono no sabe lo que este ya mandó; guardarlo en la nube
 * queda para la parte B (necesita una columna nueva en la base).
 * ==========================================================================*/
(function (global) {
  "use strict";
  var ALMACEN = "enti_fotos_enviadas";

  function fnv1a(texto) {
    var h = 0x811c9dc5;
    for (var i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function claveFoto(src) {
    var s = String(src || "");
    return /^data:/i.test(s) ? "d:" + s.length + ":" + fnv1a(s) : s;
  }

  /** Las fotos de `fotos` que todavía no se enviaron, en el mismo orden. */
  function pendientes(fotos, enviadas) {
    var ya = {};
    (enviadas || []).forEach(function (k) { ya[k] = true; });
    return (fotos || []).filter(function (f) { return !ya[claveFoto(f)]; });
  }

  /** `enviadas` más las claves de `fotos`, sin repetir. */
  function marcar(enviadas, fotos) {
    var res = (enviadas || []).slice();
    (fotos || []).forEach(function (f) { var k = claveFoto(f); if (res.indexOf(k) < 0) res.push(k); });
    return res;
  }

  // ── almacén del dispositivo: si el navegador no deja usarlo (modo privado, sin espacio) se comporta como vacío ──
  function todo() {
    try { var v = JSON.parse(global.localStorage.getItem(ALMACEN) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
  }
  function enviadasDe(llaveOrden) { var v = todo()[llaveOrden]; return Array.isArray(v) ? v : []; }
  function guardar(llaveOrden, claves) {
    try { var t = todo(); t[llaveOrden] = claves; global.localStorage.setItem(ALMACEN, JSON.stringify(t)); return true; } catch (e) { return false; }
  }

  global.FotosAvance = { claveFoto: claveFoto, pendientes: pendientes, marcar: marcar, enviadasDe: enviadasDe, guardar: guardar };
})(typeof window !== "undefined" ? window : this);
