"use strict";

// Genera un link de "restablecer contraseña" para un usuario existente, sin
// pasar por el email. Uso (desde server/):
//
//   npm run reset-link -- usuario@example.com
//
// Existe porque en dev no hay proveedor de email configurado (EMAIL_PROVIDER
// vacío, ver lib/mailer.js): el flujo real de "¿Olvidaste tu contraseña?" solo
// loguea el link en la consola del server, que es fácil de perder de vista.
// Este script emite el mismo token, con el mismo TTL y el mismo formato de
// link (buildResetLink) que POST /api/auth/password/forgot -- la persona
// elige su contraseña nueva en el formulario normal, acá nunca se maneja una
// contraseña.
//
// Es un comando local, no un endpoint: exponer el link por HTTP permitiría
// tomar cualquier cuenta con solo saber el email. Se niega a correr con
// NODE_ENV=production por el mismo motivo.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const { isProd } = require("../src/lib/cookies");

if (isProd()) {
  console.error("reset-link no se puede usar con NODE_ENV=production.");
  process.exit(1);
}

const email = process.argv[2];
if (!email) {
  console.error("Uso: npm run reset-link -- usuario@example.com");
  process.exit(1);
}

// Se requieren después del dotenv a propósito: lib/passwordReset.js lee
// APP_BASE_URL y lib/db.js lee DB_PATH al cargarse.
const { findUserByEmail } = require("../src/lib/users");
const { buildResetLink, createPasswordResetToken, RESET_TOKEN_TTL_MS } = require("../src/lib/passwordReset");

const user = findUserByEmail(email);
if (!user) {
  console.error(`No hay ningún usuario con el email "${email}".`);
  process.exit(1);
}

const { token } = createPasswordResetToken(user.id);
console.log(`Link de reset para ${user.email} (vale ${RESET_TOKEN_TTL_MS / 60000} minutos, un solo uso):\n`);
console.log(buildResetLink(token));
