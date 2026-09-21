"use strict";

// Conexión a la MISMA base SQLite que usa el catálogo (Lyon/Door).
// Esta capa de auth solo hace SELECT/INSERT/UPDATE/DELETE sobre sus propias
// tablas: users y sessions (0002), password_reset_tokens (0003),
// phone_verification_codes (0005, login/registro por teléfono). Las tablas
// webauthn_credentials y apple_identities (0002) siguen existiendo en el
// esquema pero ya no se usan -- WebAuthn/Passkeys y Apple Sign-In se
// revirtieron a favor de Google OAuth + teléfono (ver CLAUDE.md).
//
// La capa de pedidos (orders / order_items, migración 0006, ver
// lib/orders.js y routes/orders.js) SOLO lee `products` -- para recalcular
// precio/stock server-side en el momento de confirmar un pedido, nunca
// confiando en lo que mande el cliente (ver lib/products.js). Nunca le
// ESCRIBE: cargar/actualizar precio, stock o catálogo sigue siendo
// territorio exclusivo de lyon/door vía los scripts de db/scripts/
// (seed_precios_prueba.py, export_catalogo_con_precios.py, etc.), nunca
// desde una ruta HTTP de este server. Esta conexión nunca toca
// product_variants ni schema_migrations.

const path = require("path");
const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = path.resolve(__dirname, "..", "..", "..", "db", "lyondor.sqlite3");
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

module.exports = db;
module.exports.DB_PATH = DB_PATH;
