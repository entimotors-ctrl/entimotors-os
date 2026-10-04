/* ============================================================================
 * ENTIMOTORS OS · finanzas-calc.js  (3.15.0 · Bloque 5)
 * ----------------------------------------------------------------------------
 * Indicadores de EFECTIVO calculados con lo que el dispositivo ya tiene (caché
 * de la nube o base local), sin red. Misma regla, línea por línea, que
 * public.finanzas_resumen() de sync-15e (las pruebas exigen que den igual):
 *
 *   COBRADO   = ingresos reales de caja (sin fondo de apertura/cierre)
 *               − devoluciones − compensaciones de ingresos (reversos),
 *               por el DÍA EMPRESARIAL de Honduras del movimiento.
 *               Una orden entregada sin cobrar NO es cobrado; un crédito
 *               solo por sus abonos (nunca su total además de los abonos).
 *   GASTOS    = egresos reales (sin fondo ni devoluciones) − compensaciones
 *               de egresos.
 *   POR COBRAR = saldo vivo de los créditos no anulados.
 *   ENTREGADO SIN COBRAR = órdenes entregadas, sin finalizar, sin anular y
 *               sin crédito: trabajo hecho que no es dinero ni deuda todavía.
 *
 * El costo histórico y la utilidad bruta NO se calculan aquí: necesitan las
 * devoluciones renglón por renglón (tabla reversos), que el dispositivo no
 * tiene. Esos los da el servidor (finanzas_resumen); sin red, la pantalla lo
 * dice en lugar de inventar un número.
 * ==========================================================================*/
(function (global) {
  "use strict";

  var FONDO = ["Apertura de caja", "Cierre de caja"];
  function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  /** Naturaleza de un movimiento de caja: cobro | devolucion | gasto | fondo | cobro_revertido | gasto_revertido. */
  function clase(m, porUid) {
    if (!m.reversoDe) {
      if (FONDO.indexOf(m.categoria) !== -1) return "fondo";
      if (m.tipo === "ingreso") return "cobro";
      if (m.categoria === "Devolución") return "devolucion";
      return "gasto";
    }
    var o = porUid[m.reversoDe];
    if (o && FONDO.indexOf(o.categoria) !== -1) return "fondo";
    return m.tipo === "egreso" ? "cobro_revertido" : "gasto_revertido";
  }

  /**
   * Caja por día empresarial.
   * @param {object} p { movs, desde, hasta ("YYYY-MM-DD"), ahora (ms, opcional), F (FechaNegocio) }
   */
  function caja(p) {
    var F = p.F || global.FechaNegocio;
    var hoy = F.hoy(p.ahora), mes = hoy.slice(0, 7);
    var desde = p.desde || (mes + "-01"), hasta = p.hasta || hoy;
    var porUid = {};
    (p.movs || []).forEach(function (m) { if (m.uid) porUid[m.uid] = m; });
    var t = { cobradoHoy: 0, cobradoMes: 0, cobrado: 0, cobradoBruto: 0, devuelto: 0, gastos: 0, movimientosFondo: 0 };
    (p.movs || []).forEach(function (m) {
      var dia = F.diaDe(m.fechaISO);
      if (!dia) return;
      var c = clase(m, porUid), monto = Number(m.monto) || 0;
      var enRango = dia >= desde && dia <= hasta;
      var signo = c === "cobro" ? 1 : (c === "devolucion" || c === "cobro_revertido") ? -1 : 0;
      if (signo) {
        if (dia === hoy) t.cobradoHoy += signo * monto;
        if (dia.slice(0, 7) === mes) t.cobradoMes += signo * monto;
        if (enRango) { t.cobrado += signo * monto; if (signo > 0) t.cobradoBruto += monto; else t.devuelto += monto; }
      }
      if (enRango && c === "gasto") t.gastos += monto;
      if (enRango && c === "gasto_revertido") t.gastos -= monto;
      if (enRango && c === "fondo") t.movimientosFondo++;
    });
    Object.keys(t).forEach(function (k) { if (k !== "movimientosFondo") t[k] = r2(t[k]); });
    t.hoy = hoy; t.mes = mes; t.desde = desde; t.hasta = hasta;
    return t;
  }

  /** Saldo vivo de los créditos no anulados. */
  function porCobrar(creditos) {
    var s = 0, n = 0;
    (creditos || []).forEach(function (c) { if (!c.anulado && (Number(c.saldo) || 0) > 0.001) { s += Number(c.saldo); n++; } });
    return { saldo: r2(s), creditos: n };
  }

  /** Órdenes entregadas, sin finalizar, sin anular y SIN crédito (el crédito ya es «por cobrar»). */
  function entregadoSinCobrar(ordenes, creditos) {
    var conCredito = {};
    (creditos || []).forEach(function (c) { if (!c.anulado && c.ordenId != null) conCredito[c.ordenId] = true; });
    var total = 0, n = 0;
    (ordenes || []).forEach(function (o) {
      if (o.estado !== "entregado" || o.finalizada || o.anulada || o.deletedAt || o.creditoId != null || conCredito[o.id]) return;
      total += (o.items || []).reduce(function (s, it) { return s + (Number(it.cantidad) || 0) * (Number(it.precio) || 0); }, 0);
      n++;
    });
    return { total: r2(total), ordenes: n };
  }

  /** Todo lo que se puede saber sin red, en un objeto. */
  function resumenLocal(p) {
    var c = caja(p), pc = porCobrar(p.creditos), ep = entregadoSinCobrar(p.ordenes, p.creditos);
    c.porCobrar = pc.saldo; c.creditosConSaldo = pc.creditos;
    c.entregadoSinCobrar = ep.total; c.ordenesEntregadasSinCobrar = ep.ordenes;
    return c;
  }

  global.FinanzasCalc = { FONDO: FONDO, clase: clase, caja: caja, porCobrar: porCobrar, entregadoSinCobrar: entregadoSinCobrar, resumenLocal: resumenLocal };
})(typeof window !== "undefined" ? window : this);
