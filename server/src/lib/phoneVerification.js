"use strict";

// Manejo de códigos de verificación de teléfono, respaldados por la tabla
// `phone_verification_codes` (db/migrations/0005_google_phone_auth.sql).
// Mismo espíritu que passwordReset.js (token opaco, hasheado, de un solo
// uso, con expiración corta) pero adaptado a un código corto de 6 dígitos
// pensado para mandarse por SMS -- ver el comentario extenso en la
// migración sobre por qué hashear un PIN de 6 dígitos no da la misma
// garantía que hashear un token de 256 bits, y por qué la protección real
// acá es la ventana corta + un solo uso + rate limiting, no el hash en sí.

const crypto = require("crypto");
const db = require("./db");

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const CODE_LENGTH = 6;

// El hash incluye el teléfono como contexto (sha256(phone + ':' + code) en
// vez de sha256(code) solo) -- no lo hace "seguro" contra fuerza bruta con
// acceso a la base (ver comentario en la migración), pero evita que una
// única tabla arcoíris de 1M de hashes sirva para revertir el código de
// CUALQUIER teléfono de una sola vez; un atacante tendría que rehacer el
// cálculo (barato, pero no gratis) por cada teléfono que le interese.
function hashCode(phone, code) {
  return crypto.createHash("sha256").update(`${phone}:${code}`, "utf8").digest("hex");
}

function generateCode() {
  // crypto.randomInt es CSPRNG (a diferencia de Math.random) -- igual de
  // importante acá que en session.js/passwordReset.js aunque el espacio de
  // valores sea chico, porque un código de login predecible es tan malo
  // como un token de sesión predecible.
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(CODE_LENGTH, "0");
}

/**
 * Crea un código de verificación nuevo para `phone` y devuelve el código en
 * crudo (el único momento en que existe en texto plano fuera de la consola
 * de dev / el SMS real: se usa para mandarlo y después se descarta, no se
 * retiene en memoria del proceso).
 *
 * A propósito NO invalida códigos previos sin usar del mismo teléfono --
 * mismo criterio que createPasswordResetToken con tokens de reset viejos:
 * permite reintentar "no me llegó el SMS" pidiendo uno nuevo sin romper el
 * primero, y el rate limiting de /phone/request-code (por IP y por
 * teléfono) es lo que acota cuántos se pueden pedir.
 */
function createPhoneVerificationCode(phone) {
  const code = generateCode();
  const codeHash = hashCode(phone, code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO phone_verification_codes (phone, code_hash, expires_at)
     VALUES (?, ?, ?)`
  ).run(phone, codeHash, expiresAt);

  return { code, expiresAt };
}

/**
 * Busca un código válido (existe para ese teléfono, no fue usado, no
 * expiró) que corresponda exactamente al código recibido. Devuelve la fila
 * si es válido, o null si cualquiera de esas condiciones falla.
 *
 * A propósito NO distingue "no existe"/"ya usado"/"expirado"/"no coincide":
 * el caller (POST /api/auth/phone/verify-code) siempre debe responder el
 * mismo error genérico "invalid_or_expired_code" sin importar cuál fue --
 * mismo criterio anti-enumeración que findValidResetToken.
 */
function findValidCode(phone, code) {
  if (!phone || !code) return null;
  const codeHash = hashCode(phone, code);

  const row = db
    .prepare(
      `SELECT id, expires_at, used_at
       FROM phone_verification_codes
       WHERE phone = ? AND code_hash = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(phone, codeHash);

  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  return row;
}

/**
 * Marca el código como usado (de un solo uso). Se llama solo después de
 * confirmar login/registro exitoso con ese código.
 */
function markCodeUsed(id) {
  db.prepare(`UPDATE phone_verification_codes SET used_at = datetime('now') WHERE id = ?`).run(id);
}

module.exports = {
  CODE_TTL_MS,
  createPhoneVerificationCode,
  findValidCode,
  markCodeUsed,
};
