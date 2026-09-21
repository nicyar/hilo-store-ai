"use strict";

const db = require("./db");

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

// El teléfono no se pasa a minúsculas (no tiene sentido para un E.164) --
// solo se recorta espacios. La validación de formato real vive en
// validate.js (validatePhoneOnly); esta función asume que ya se validó.
function normalizePhone(phone) {
  return String(phone).trim();
}

function findUserByEmail(email) {
  return db
    .prepare(`SELECT id, email, password_hash, phone, google_sub FROM users WHERE email = ?`)
    .get(normalizeEmail(email));
}

function findUserByPhone(phone) {
  return db
    .prepare(`SELECT id, email, password_hash, phone, google_sub FROM users WHERE phone = ?`)
    .get(normalizePhone(phone));
}

function findUserById(id) {
  return db
    .prepare(`SELECT id, email, phone, google_sub FROM users WHERE id = ?`)
    .get(id);
}

// Alta de usuario genérica: soporta los tres métodos de alta independiente
// que existen hoy (email/contraseña, teléfono; Google cuando se active) sin
// que cada ruta tenga que armar el INSERT a mano. Ningún caller pasa los
// tres a la vez en la práctica, pero la migración 0005 solo exige que al
// menos uno de los tres esté presente (CHECK constraint) -- si ninguno
// viene, el INSERT falla ahí y no acá, para no duplicar esa regla.
function createUser({ email, passwordHash, phone, googleSub } = {}) {
  const normalizedEmail = email ? normalizeEmail(email) : null;
  const normalizedPhone = phone ? normalizePhone(phone) : null;
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, phone, google_sub) VALUES (?, ?, ?, ?)`
    )
    .run(normalizedEmail, passwordHash || null, normalizedPhone, googleSub || null);
  return {
    id: info.lastInsertRowid,
    email: normalizedEmail,
    phone: normalizedPhone,
    google_sub: googleSub || null,
  };
}

function toPublicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email ?? null, phone: user.phone ?? null };
}

/**
 * Actualiza el password_hash de un usuario (usado por el reset de
 * contraseña). El hash ya viene calculado (bcrypt, mismo costo que
 * register/login) -- esta función solo persiste, no hashea.
 */
function updatePasswordHash(userId, passwordHash) {
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(
    passwordHash,
    userId
  );
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  findUserByEmail,
  findUserByPhone,
  findUserById,
  createUser,
  toPublicUser,
  updatePasswordHash,
};
