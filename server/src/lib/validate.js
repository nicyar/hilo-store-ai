"use strict";

// Validación mínima de entrada para register/login. No es un validador de
// RFC 5322 completo (no hace falta para este alcance) pero rechaza los
// casos obviamente inválidos y evita basura en la base.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// E.164 (usado por login por teléfono, ver routes/authPhone.js): "+" seguido
// de 8 a 15 dígitos, el primero distinto de 0 (los códigos de país nunca
// arrancan en 0). No se aceptan espacios, guiones ni paréntesis a propósito
// -- mismo criterio "minimalista pero sin basura" que EMAIL_RE; el
// frontend es responsable de normalizar antes de mandar (ej.
// "+54 9 11 2233-4455" -> "+5491122334455").
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

/**
 * Valida { email, password } para register/login.
 * Devuelve { valid: true } o { valid: false, fields: {...} } con un mensaje
 * por campo inválido, para el 400 { error: "invalid_input", fields } del
 * contrato.
 */
function validateCredentials({ email, password }) {
  const fields = {};

  if (typeof email !== "string" || email.trim().length === 0) {
    fields.email = "required";
  } else if (!EMAIL_RE.test(email.trim())) {
    fields.email = "invalid_format";
  }

  if (typeof password !== "string" || password.length === 0) {
    fields.password = "required";
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    fields.password = `min_length_${MIN_PASSWORD_LENGTH}`;
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }
  return { valid: true };
}

/**
 * Valida solo el email (usado por POST /api/auth/password/forgot, que no
 * recibe password). Mismo criterio que el campo email de
 * validateCredentials: esto NO filtra si el email existe en el sistema,
 * solo si tiene forma de email -- eso es intencional, ver el endpoint.
 */
function validateEmailOnly(email) {
  const fields = {};

  if (typeof email !== "string" || email.trim().length === 0) {
    fields.email = "required";
  } else if (!EMAIL_RE.test(email.trim())) {
    fields.email = "invalid_format";
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }
  return { valid: true };
}

/**
 * Valida solo la contraseña nueva (usado por POST /api/auth/password/reset,
 * que no recibe email sino un token). Mismas reglas que el campo password
 * de validateCredentials.
 */
function validatePasswordOnly(password) {
  const fields = {};

  if (typeof password !== "string" || password.length === 0) {
    fields.password = "required";
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    fields.password = `min_length_${MIN_PASSWORD_LENGTH}`;
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }
  return { valid: true };
}

/**
 * Valida solo el teléfono (usado por POST /api/auth/phone/request-code y
 * /verify-code). Mismo criterio anti-enumeración que validateEmailOnly:
 * esto NO filtra si el teléfono ya está registrado, solo si tiene forma de
 * E.164 válida.
 */
function validatePhoneOnly(phone) {
  const fields = {};

  if (typeof phone !== "string" || phone.trim().length === 0) {
    fields.phone = "required";
  } else if (!PHONE_RE.test(phone.trim())) {
    fields.phone = "invalid_format";
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }
  return { valid: true };
}

module.exports = {
  validateCredentials,
  validateEmailOnly,
  validatePasswordOnly,
  validatePhoneOnly,
  MIN_PASSWORD_LENGTH,
  EMAIL_RE,
  PHONE_RE,
};
