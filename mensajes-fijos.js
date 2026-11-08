/* ============================================================================
 * ENTIMOTORS OS · mensajes-fijos.js  (3.16 · cambio 6)
 * ----------------------------------------------------------------------------
 * Qué mensajes del administrador se quedan FIJOS arriba en Mi Trabajo:
 *   · los de las últimas HORAS_FIJO horas, aunque ya se hayan leído;
 *   · los que siguen sin leer, tengan la edad que tengan.
 * El resto baja al historial (que se sigue viendo). Antes el único aviso era
 * un toast de 3,4 s y la lista quedaba abajo de la pantalla sin destacar.
 * Pura: sin DOM ni red; recibe la hora para poder probarla.
 * ==========================================================================*/
(function (global) {
  "use strict";
  var HORAS_FIJO = 36;

  function porFechaDesc(a, b) { return (b.creadoEn || 0) - (a.creadoEn || 0); }

  /** separar(mensajes, ahoraMs, esNoLeido) → { fijos, historial }, cada lista del más nuevo al más viejo (sin fecha al final). */
  function separar(mensajes, ahoraMs, esNoLeido) {
    var limite = ahoraMs - HORAS_FIJO * 3600 * 1000;
    var fijos = [], historial = [];
    (mensajes || []).forEach(function (m) {
      var reciente = typeof m.creadoEn === "number" && m.creadoEn >= limite;
      (reciente || esNoLeido(m) ? fijos : historial).push(m);
    });
    return { fijos: fijos.sort(porFechaDesc), historial: historial.sort(porFechaDesc) };
  }

  global.MensajesFijos = { HORAS_FIJO: HORAS_FIJO, separar: separar };
})(typeof window !== "undefined" ? window : this);
