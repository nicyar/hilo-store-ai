"use strict";

// Lectura de `shipping_rates` (migracion 0007). El front NO hardcodea la
// lista de provincias en ningun lado -- GET /api/shipping/rates expone
// exactamente lo que devuelve `listActiveRates()`, y POST /api/orders usa
// `findActiveRateByProvincia` para calcular `shipping_cents` server-side
// cuando `shipping_method = 'envio'`.

const db = require("./db");

/**
 * Todas las jurisdicciones activas, para que el checkout arme su selector
 * de provincia. Orden alfabetico por provincia -- no hay un criterio de
 * negocio que justifique otro orden.
 */
function listActiveRates() {
  return db
    .prepare(
      `SELECT id, country_code, provincia, zona, price_cents, es_prueba
         FROM shipping_rates
        WHERE activo = 1
        ORDER BY provincia`
    )
    .all();
}

/**
 * Tarifa activa para una provincia exacta (comparacion case-sensitive a
 * proposito: el checkout arma su selector desde listActiveRates(), asi que
 * el valor que vuelve en POST /api/orders siempre es uno de los que este
 * mismo endpoint ya ofrecio -- no hace falta normalizar mayusculas/acentos
 * de un input libre). `country_code` fijo en 'AR' porque el checkout es
 * Argentina-only hoy (ver CLAUDE.md).
 */
function findActiveRateByProvincia(provincia) {
  const row = db
    .prepare(
      `SELECT id, country_code, provincia, zona, price_cents, es_prueba
         FROM shipping_rates
        WHERE activo = 1 AND country_code = 'AR' AND provincia = ?`
    )
    .get(provincia);
  return row || null;
}

module.exports = { listActiveRates, findActiveRateByProvincia };
