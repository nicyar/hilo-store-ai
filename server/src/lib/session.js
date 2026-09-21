"use strict";

// Manejo de sesiones server-side respaldadas por la tabla `sessions`.
//
// El valor que viaja en la cookie es un token opaco aleatorio (32 bytes de
// crypto.randomBytes, codificado en hex -- 256 bits de entropía, nada de
// datos adentro como haría un JWT). En la base NUNCA se guarda ese token:
// se guarda sha256(token) en `token_hash`. Así, si alguien lee la base
// (o un backup, o un dump), no puede reconstruir cookies válidas: sha256
// no es reversible y el atacante necesitaría el token original, que solo
// vivió en la cookie HttpOnly del browser del usuario.

const crypto = require("crypto");
const db = require("./db");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días, ver README de server/

function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Crea una sesión nueva para userId y devuelve el token en crudo (el único
 * momento en que existe en texto plano fuera del browser: se usa para
 * setear la cookie y después se descarta -- no se retiene en memoria).
 */
function createSession(userId, { userAgent, ip } = {}) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, tokenHash, expiresAt, userAgent || null, ip || null);

  return { token, expiresAt };
}

/**
 * Busca la sesión por el token de la cookie. Devuelve el usuario asociado
 * si la sesión existe y no expiró, o null si no hay sesión válida.
 * Si encuentra una sesión vencida, la borra de paso (housekeeping barato).
 */
function getUserBySessionToken(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const row = db
    .prepare(
      `SELECT s.id as session_id, s.expires_at, u.id as user_id, u.email, u.phone
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash);

  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(row.session_id);
    return null;
  }

  return { id: row.user_id, email: row.email, phone: row.phone, sessionId: row.session_id };
}

/**
 * Invalida la sesión en la base (logout real, no solo borrar la cookie
 * del lado del cliente). Es un no-op silencioso si el token ya no existe.
 */
function destroySessionByToken(token) {
  if (!token) return;
  const tokenHash = hashToken(token);
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
}

/**
 * Invalida TODAS las sesiones activas de un usuario. Se usa en el reset de
 * contraseña (POST /api/auth/password/reset): si alguien tenía una sesión
 * abierta con la contraseña vieja -- por ejemplo porque la cuenta fue
 * comprometida y por eso se está reseteando la contraseña -- el reset la
 * corta de inmediato, no espera a que expire sola.
 */
function destroySessionsByUserId(userId) {
  if (!userId) return;
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}

module.exports = {
  SESSION_TTL_MS,
  createSession,
  getUserBySessionToken,
  destroySessionByToken,
  destroySessionsByUserId,
};
