"use strict";

const { SESSION_TTL_MS } = require("./session");

const COOKIE_NAME = "hilo_session";

// isProd controla el flag `Secure` de la cookie.
//
// DECISIÓN DE DISEÑO: `Secure` exige HTTPS -- el browser directamente
// ignora la cookie si se intenta setear sin HTTPS. En desarrollo local,
// Vite sirve el front por HTTP (http://localhost:5173) y este server
// también corre por HTTP, así que si dejáramos `Secure` fijo en true la
// cookie de sesión JAMÁS se guardaría en dev y nada funcionaría.
//
// Por eso `Secure` se deriva de NODE_ENV. Pero esto NO puede quedar como
// algo que alguien tiene que acordarse de cambiar a mano en producción:
// - Acá se lee de una sola variable de entorno (NODE_ENV), no hay un
//   segundo flag separado que alguien pueda olvidarse de togglear.
// - El index.js del server loguea explícitamente al arrancar si está
//   corriendo en modo "development" (o sea, con Secure desactivado), para
//   que sea imposible no darse cuenta si eso llega a pasar en un deploy.
// - Ver server/README.md: production DEBE correr detrás de HTTPS real
//   (terminación TLS en el proxy/plataforma) con NODE_ENV=production.
function isProd() {
  return process.env.NODE_ENV === "production";
}

function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, baseCookieOptions());
}

function clearSessionCookie(res) {
  // Para borrar una cookie hay que repetir las mismas opciones de atributos
  // (path/sameSite/secure) con las que se seteó, si no algunos browsers no
  // la limpian.
  const opts = baseCookieOptions();
  delete opts.maxAge;
  res.clearCookie(COOKIE_NAME, opts);
}

function getSessionTokenFromRequest(req) {
  return (req.cookies && req.cookies[COOKIE_NAME]) || null;
}

module.exports = {
  COOKIE_NAME,
  isProd,
  setSessionCookie,
  clearSessionCookie,
  getSessionTokenFromRequest,
};
