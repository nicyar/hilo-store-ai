"use strict";

const { getSessionTokenFromRequest } = require("./cookies");
const { getUserBySessionToken } = require("./session");

/**
 * Exige una sesión válida (cookie hilo_session -> fila viva en `sessions`).
 * Usado por los endpoints de registro de passkey (agregar una passkey
 * requiere estar logueado por email/password primero, según el alcance
 * actual) y por cualquier otra ruta protegida futura.
 */
function requireSession(req, res, next) {
  const token = getSessionTokenFromRequest(req);
  const user = getUserBySessionToken(token);
  if (!user) {
    return res.status(401).json({ error: "no_session" });
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

module.exports = { requireSession };
