"use strict";

// Manejo de tokens de recuperación de contraseña, respaldados por la tabla
// `password_reset_tokens` (db/migrations/0003_password_reset.sql).
//
// Mismo criterio que session.js para el token: el valor que viaja en el
// link del email es un token opaco de alta entropía (32 bytes de
// crypto.randomBytes, codificado en base64url -- 256 bits de entropía, no
// adivinable). En la base NUNCA se guarda ese token: se guarda sha256(token)
// en `token_hash`. Así, si alguien lee la base, no puede reconstruir un
// link de reset válido.

const crypto = require("crypto");
const db = require("./db");

const RESET_TOKEN_TTL_MS = 45 * 60 * 1000; // 45 minutos -- ventana corta a propósito

// Origen del SITIO (no del dev server de Vite): la app de login vive
// same-origin bajo /login (ver server/src/index.js), así que en dev es el
// mismo :4000 que sirve home y checkout. APP_BASE_URL también lo usa
// routes/orders.js para las back_urls de Mercado Pago (/checkout.html).
const APP_BASE_URL = (process.env.APP_BASE_URL || "http://localhost:4000").replace(/\/+$/, "");

/**
 * Arma el link que va en el email de reset. Vive acá y no inline en la ruta
 * para que la ruta y el script de dev (scripts/reset-link.js) generen
 * exactamente el mismo link. Apunta a /login/ (donde está montado
 * frontend/dist), no a la raíz: la raíz es la home vanilla, que no sabe nada
 * de ?view=reset-password -- ese era el bug por el que el link no abría el
 * formulario de nueva contraseña.
 */
function buildResetLink(token) {
  return `${APP_BASE_URL}/login/?view=reset-password&token=${encodeURIComponent(token)}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Crea un token de reset nuevo para userId y devuelve el token en crudo (el
 * único momento en que existe en texto plano fuera de la memoria del
 * proceso: se usa para armar el link del email y después se descarta -- no
 * se retiene).
 */
function createPasswordResetToken(userId) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES (?, ?, ?)`
  ).run(userId, tokenHash, expiresAt);

  return { token, expiresAt };
}

/**
 * Busca un token válido (existe, no fue usado todavía, no expiró) por su
 * hash. Devuelve la fila (con user_id) si es válido, o null si cualquiera
 * de esas tres condiciones falla.
 *
 * A propósito NO distingue "no existe" de "ya usado" de "expirado": el
 * caller (POST /api/auth/password/reset) siempre debe responder el mismo
 * error genérico "invalid_or_expired_token" sin importar cuál fue -- no
 * hay que darle esa información a quien está probando tokens al azar.
 */
function findValidResetToken(token) {
  if (!token || typeof token !== "string") return null;
  const tokenHash = hashToken(token);

  const row = db
    .prepare(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens
       WHERE token_hash = ?`
    )
    .get(tokenHash);

  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  return row;
}

/**
 * Marca el token como usado (de un solo uso). Se llama solo después de
 * actualizar exitosamente el password_hash del usuario.
 */
function markResetTokenUsed(id) {
  db.prepare(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?`).run(id);
}

module.exports = {
  RESET_TOKEN_TTL_MS,
  buildResetLink,
  createPasswordResetToken,
  findValidResetToken,
  markResetTokenUsed,
};
