/* ============================================================================
 * ENTIMOTORS OS · fecha-negocio.js  (3.15.0 · Bloque 3)
 * ----------------------------------------------------------------------------
 * El DÍA EMPRESARIAL del taller es el de America/Tegucigalpa, no el UTC ni el
 * del reloj del teléfono.
 *
 * El error que corrige: `new Date().toISOString().slice(0, 10)` es la fecha en
 * UTC. Honduras va 6 horas detrás (UTC−06:00), así que desde las 18:00 hora
 * local «hoy» ya era MAÑANA: las citas de hoy, la caja del día y los filtros
 * diarios saltaban al día siguiente cada tarde.
 *
 * PRINCIPIO
 *   · Se guardan instantes absolutos (ms / ISO con Z), como siempre.
 *   · Los LÍMITES de día/mes se calculan en la zona IANA del negocio con Intl
 *     (no un −06:00 fijo): si Honduras volviera a usar horario de verano, esto
 *     seguiría bien sin tocar nada. Solo si la plataforma no soportara zonas
 *     IANA (no ocurre en Chrome/Firefox/Safari actuales) se cae a −06:00.
 *   · Una FECHA de calendario ("2026-09-29", p. ej. cita.fecha) no es un
 *     instante: se compara y se suma como texto, nunca pasa por la zona del
 *     dispositivo.
 * ==========================================================================*/
(function (global) {
  "use strict";

  var ZONA = "America/Tegucigalpa";
  var LOCALE = "es-HN";
  var DIA_MS = 86400000;
  var RESPALDO_MIN = -360;   // −06:00, solo si Intl no conoce la zona

  var partesFmt = null, zonaOk = true;
  try {
    partesFmt = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  } catch (e) { zonaOk = false; }

  function aMs(t) {
    if (t === null || t === undefined || t === "") return NaN;
    if (t instanceof Date) return t.getTime();
    if (typeof t === "number") return t;
    return new Date(String(t)).getTime();
  }
  function dos(n) { return (n < 10 ? "0" : "") + n; }

  /** {y, m, d, h, mi, s} de un instante, en la zona del negocio. */
  function partes(ms) {
    if (!zonaOk) {
      var x = new Date(ms + RESPALDO_MIN * 60000);
      return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), s: x.getUTCSeconds() };
    }
    var o = {};
    partesFmt.formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== "literal") o[p.type] = Number(p.value); });
    return { y: o.year, m: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
  }
  /** Minutos de diferencia de la zona respecto de UTC en ese instante (Honduras: −360). */
  function desfaseMin(ms) {
    if (!zonaOk) return RESPALDO_MIN;
    var p = partes(ms);
    return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
  }

  /* 3.15 (Bloque 5) · RENDIMIENTO: diaDe() corre por cada fila de caja/créditos/órdenes, y cada llamada a Intl.formatToParts cuesta
     microsegundos que con miles de filas se notan. El desfase de la zona solo cambia en una transición de horario, y nunca hay dos en
     un mismo día UTC: se calcula en el primer y el último milisegundo de ese día UTC y, si coinciden, vale para todo el día (2 llamadas
     a Intl por día UTC en lugar de una por fila). Si no coinciden (el día de una transición), se usa el cálculo exacto de siempre. */
  var desfasePorDiaUtc = {}, desfasesGuardados = 0;
  function desfaseDelDia(ms) {
    var k = Math.floor(ms / DIA_MS);
    var v = desfasePorDiaUtc[k];
    if (v === undefined) {
      var a = desfaseMin(k * DIA_MS), b = desfaseMin((k + 1) * DIA_MS - 1);
      v = a === b ? a : null;
      if (++desfasesGuardados > 20000) { desfasePorDiaUtc = {}; desfasesGuardados = 0; }
      desfasePorDiaUtc[k] = v;
    }
    return v;
  }
  /** "YYYY-MM-DD" del día empresarial al que pertenece un instante (ms, Date o ISO). null si no es una fecha. */
  function diaDe(t) {
    var ms = aMs(t);
    if (!isFinite(ms)) return null;
    var off = desfaseDelDia(ms);
    if (off !== null) { var x = new Date(ms + off * 60000); return x.getUTCFullYear() + "-" + dos(x.getUTCMonth() + 1) + "-" + dos(x.getUTCDate()); }
    var p = partes(ms);
    return p.y + "-" + dos(p.m) + "-" + dos(p.d);
  }
  /** Día empresarial de hoy ("YYYY-MM-DD"). `ahora` opcional (pruebas). */
  function hoy(ahora) { return diaDe(ahora === undefined ? Date.now() : ahora); }
  /** "YYYY-MM" del mes empresarial de un instante. */
  function mesDe(t) { var d = diaDe(t); return d ? d.slice(0, 7) : null; }
  function mismoMes(a, b) { var x = mesDe(a); return !!x && x === mesDe(b); }

  function esDia(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function descomponer(dia) { return { y: Number(dia.slice(0, 4)), m: Number(dia.slice(5, 7)), d: Number(dia.slice(8, 10)) }; }
  /** Suma n días de CALENDARIO a una fecha "YYYY-MM-DD" (sin zonas de por medio). */
  function sumarDias(dia, n) {
    var p = descomponer(dia), x = new Date(Date.UTC(p.y, p.m - 1, p.d) + Math.round(n) * DIA_MS);
    return x.getUTCFullYear() + "-" + dos(x.getUTCMonth() + 1) + "-" + dos(x.getUTCDate());
  }
  /** Días de calendario de `desde` a `hasta` (ambos "YYYY-MM-DD"): 0 = el mismo día, 1 = mañana, −1 = ayer. */
  function diferenciaDias(desde, hasta) {
    var a = descomponer(desde), b = descomponer(hasta);
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DIA_MS);
  }
  /** Instante (ms) de una hora local del negocio: fecha "YYYY-MM-DD" + "HH:MM". */
  function instante(dia, hora) {
    var p = descomponer(dia), h = 0, mi = 0;
    if (typeof hora === "string" && /^\d{1,2}:\d{2}/.test(hora)) { h = Number(hora.split(":")[0]); mi = Number(hora.split(":")[1].slice(0, 2)); }
    var local = Date.UTC(p.y, p.m - 1, p.d, h, mi);
    // dos pasadas: la segunda corrige si justo hubiera un cambio de horario entre la estimación y el resultado
    var ms = local - desfaseMin(local) * 60000;
    return local - desfaseMin(ms) * 60000;
  }
  /** Inicio (00:00:00.000) y fin (23:59:59.999) del día empresarial, en ms. */
  function inicioDia(dia) { return instante(dia, "00:00"); }
  function finDia(dia) { return inicioDia(sumarDias(dia, 1)) - 1; }
  /** ¿El instante cae entre los días empresariales `desde` y `hasta` (inclusive)? */
  function enRango(t, desde, hasta) { var d = diaDe(t); return !!d && (!desde || d >= desde) && (!hasta || d <= hasta); }
  /** Primer día del mes empresarial de un instante. */
  function inicioMes(t) { var m = mesDe(t === undefined ? Date.now() : t); return m ? m + "-01" : null; }

  function conZona(o) { var r = {}; Object.keys(o || {}).forEach(function (k) { r[k] = o[k]; }); if (zonaOk) r.timeZone = ZONA; return r; }
  /* 3.15 (Bloque 5): un Intl.DateTimeFormat por combinación de opciones, reutilizado (toLocale*String crea uno nuevo en cada llamada).
     Mismo resultado: toLocaleDateString/TimeString/String son format() con los mismos valores por defecto de fecha/hora. */
  var formatos = {};
  function formato(tipo, opciones) {
    var o = conZona(opciones), clave = tipo + JSON.stringify(o);
    if (!formatos[clave]) {
      // mismos valores por defecto que ECMA-402 (ToDateTimeOptions): toLocaleDateString mira SOLO campos de fecha, toLocaleTimeString
      // SOLO de hora, toLocaleString ambos; con dateStyle/timeStyle no se agrega nada
      var estilo = o.dateStyle !== undefined || o.timeStyle !== undefined;
      var tieneFecha = ["weekday", "year", "month", "day"].some(function (k) { return o[k] !== undefined; });
      var tieneHora = ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits"].some(function (k) { return o[k] !== undefined; });
      var fechaPorDefecto = !estilo && (tipo === "fecha" ? !tieneFecha : tipo === "fechaHora" ? !tieneFecha && !tieneHora : false);
      var horaPorDefecto = !estilo && (tipo === "hora" ? !tieneHora : tipo === "fechaHora" ? !tieneFecha && !tieneHora : false);
      if (fechaPorDefecto) { o.year = "numeric"; o.month = "numeric"; o.day = "numeric"; }
      if (horaPorDefecto) { o.hour = "numeric"; o.minute = "numeric"; o.second = "numeric"; }
      formatos[clave] = new Intl.DateTimeFormat(LOCALE, o);
    }
    return formatos[clave];
  }
  /** Fecha legible de un INSTANTE, en la zona del negocio. */
  function fecha(t, opciones) { var ms = aMs(t); return isFinite(ms) ? formato("fecha", opciones).format(new Date(ms)) : ""; }
  /** Hora legible (HH:MM) de un instante, en la zona del negocio. */
  function hora(t) { var ms = aMs(t); return isFinite(ms) ? formato("hora", { hour: "2-digit", minute: "2-digit" }).format(new Date(ms)) : ""; }
  function fechaHora(t) { var ms = aMs(t); return isFinite(ms) ? formato("fechaHora", { dateStyle: "short", timeStyle: "short" }).format(new Date(ms)) : ""; }
  /** Fecha legible de una fecha de CALENDARIO "YYYY-MM-DD" (no se corre de día en ninguna zona). */
  function dia(diaStr, opciones) {
    if (!esDia(diaStr)) return "";
    var p = descomponer(diaStr), o = {};
    Object.keys(opciones || {}).forEach(function (k) { o[k] = opciones[k]; });
    o.timeZone = "UTC";
    return new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).toLocaleDateString(LOCALE, o);
  }

  global.FechaNegocio = {
    ZONA: ZONA, zonaSoportada: zonaOk,
    partes: partes, desfaseMin: desfaseMin, diaDe: diaDe, hoy: hoy, mesDe: mesDe, mismoMes: mismoMes, esDia: esDia,
    sumarDias: sumarDias, diferenciaDias: diferenciaDias, instante: instante, inicioDia: inicioDia, finDia: finDia,
    enRango: enRango, inicioMes: inicioMes, fecha: fecha, hora: hora, fechaHora: fechaHora, dia: dia,
  };
})(typeof window !== "undefined" ? window : this);
