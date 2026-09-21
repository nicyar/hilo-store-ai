-- 0007_shipping_rates.sql
-- Tarifas de envio por jurisdiccion (provincia), para el checkout. Esta
-- migracion NO reescribe 0001-0006 ni ninguna tabla existente -- solo
-- agrega `shipping_rates`.
--
-- La aplica el mismo runner generico db/scripts/run_migrations.py. La tabla
-- se siembra con valores PROVISORIOS via db/scripts/seed_shipping_rates.py
-- (ver ese script para el detalle y las fuentes de referencia) -- correr la
-- migracion sola deja la tabla vacia, sin filas.

PRAGMA foreign_keys = ON;

-- `country_code`: hoy el checkout es Argentina-only (decision del usuario),
-- pero se deja la columna (en vez de asumir el pais implicitamente) para no
-- tener que agregar una migracion nueva el dia que se sume otro pais -- ver
-- el mismo criterio ya aplicado con `products.proveedor`.
--
-- `provincia`: texto exacto de la jurisdiccion (ej. "Buenos Aires", "Ciudad
-- Autonoma de Buenos Aires"), es la clave que usa GET /api/shipping/rates
-- para que el checkout arme su selector de provincia -- el front NO
-- hardcodea la lista de provincias en ningun lado, sale de esta tabla.
--
-- `zona`: agrupador informativo (ej. "AMBA", "Centro", "Cuyo/NOA/NEA",
-- "Patagonia") usado solo para que sea mas facil auditar/actualizar tarifas
-- en bloque -- nullable porque no es parte de la logica de calculo (el
-- calculo de POST /api/orders busca por `provincia`, nunca por `zona`).
--
-- `price_cents`: INTEGER, mismo criterio de centavos que el resto del
-- proyecto -- nunca floats con dinero.
--
-- `es_prueba`: espeja exactamente `products.precio_es_prueba` (migracion
-- 0004) -- son valores de referencia googleados de tarifas publicas
-- (Correo Argentino / Andreani, 2026), NO una cotizacion real contratada
-- por el negocio. Default 1 porque hoy TODAS las filas sembradas son de
-- prueba; pasa a 0 fila por fila cuando el usuario provea una grilla real
-- (a mano o re-corriendo el seed con --reales, ver ese script).
--
-- `activo`: soft-flag para poder dar de baja una jurisdiccion sin borrar la
-- fila (por ejemplo si el negocio deja de enviar a una provincia
-- puntual) -- GET /api/shipping/rates y el calculo de POST /api/orders
-- solo consideran `activo = 1`.
--
-- UNIQUE(country_code, provincia): no puede haber dos tarifas activas
-- ambiguas para la misma jurisdiccion -- si hiciera falta versionar una
-- tarifa historica se agregaria una columna de vigencia en una migracion
-- aparte, no se necesita hoy.
CREATE TABLE IF NOT EXISTS shipping_rates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code  TEXT NOT NULL DEFAULT 'AR',
  provincia     TEXT NOT NULL,
  zona          TEXT,
  price_cents   INTEGER NOT NULL,
  es_prueba     INTEGER NOT NULL DEFAULT 1,
  activo        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (country_code, provincia)
);

CREATE INDEX IF NOT EXISTS idx_shipping_rates_activo ON shipping_rates (activo);
