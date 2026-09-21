"use strict";

// Autenticación mínima para la pantalla de revisión de comprobantes
// (admin/comprobantes.html) y sus endpoints (/api/admin/orders/*). NO es un
// sistema de usuarios/roles -- es una API key única compartida (header
// `x-admin-key`), a propósito: no hay panel de admin completo en esta
// etapa, solo esta pantalla puntual (ver CLAUDE.md).

const crypto = require("crypto");

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Compara dos strings en tiempo constante SIN filtrar su longitud por
 * timing -- `crypto.timingSafeEqual` exige buffers del mismo tamaño, así
 * que se compara el hash SHA-256 de cada string (largo fijo) en vez de los
 * strings crudos (que podrían tener longitudes distintas y así perder la
 * garantía de tiempo constante).
 */
function timingSafeEqualStrings(a, b) {
  const hashA = crypto.createHash("sha256").update(String(a)).digest();
  const hashB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Middleware: exige que el header `x-admin-key` matchee `ADMIN_API_KEY`.
 * Sin la env var configurada, se rechaza TODO acceso con 501 (mismo
 * criterio que el resto del proyecto para "falta configurar" -- ver
 * checkoutConfig.js) en vez de, por ejemplo, aceptar cualquier key o
 * ninguna -- nunca hay una puerta trasera "sin key configurada = pasa
 * igual".
 */
function requireAdminKey(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!isNonEmpty(expected)) {
    console.error("[admin] ADMIN_API_KEY no configurado -- acceso a /api/admin rechazado.");
    return res.status(501).json({ error: "admin_no_configurado" });
  }

  const provided = req.headers["x-admin-key"];
  if (typeof provided !== "string" || provided.length === 0 || !timingSafeEqualStrings(provided, expected.trim())) {
    return res.status(401).json({ error: "unauthorized" });
  }

  next();
}

/**
 * Igual chequeo que hace `requireAdminKey`, pero como función pura que
 * devuelve boolean en vez de responder la request -- usado donde la key de
 * admin es solo UNA de varias formas válidas de autorizarse (ej.
 * GET /api/orders/:public_code/comprobante, dueño del pedido O admin, ver
 * server/src/routes/orders.js).
 */
function isValidAdminKey(provided) {
  const expected = process.env.ADMIN_API_KEY;
  if (!isNonEmpty(expected)) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqualStrings(provided, expected.trim());
}

module.exports = { requireAdminKey, isValidAdminKey };
