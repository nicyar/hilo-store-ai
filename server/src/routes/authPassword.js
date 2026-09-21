"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");

const { validateCredentials, validateEmailOnly, validatePasswordOnly } = require("../lib/validate");
const { findUserByEmail, createUser, toPublicUser, updatePasswordHash } = require("../lib/users");
const {
  createSession,
  destroySessionByToken,
  destroySessionsByUserId,
  getUserBySessionToken,
} = require("../lib/session");
const {
  buildResetLink,
  createPasswordResetToken,
  findValidResetToken,
  markResetTokenUsed,
} = require("../lib/passwordReset");
const { sendPasswordResetEmail } = require("../lib/mailer");
const {
  setSessionCookie,
  clearSessionCookie,
  getSessionTokenFromRequest,
} = require("../lib/cookies");
const { requireSession } = require("../lib/middleware");
const { isMethodEnabled } = require("../lib/authMethods");

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// Hash dummy fijo (generado una vez al levantar el proceso) contra el que
// comparar cuando el email no existe o el usuario no tiene password_hash
// (solo passkey) -- así bcrypt.compare siempre corre y el tiempo de
// respuesta no delata si el email está registrado.
const DUMMY_HASH = bcrypt.hashSync("timing-attack-mitigation", BCRYPT_ROUNDS);

// Rate limiting básico contra fuerza bruta en login: 10 intentos cada 15
// minutos por IP. No es una solución completa (no distingue por email, no
// hay backoff progresivo, no hay captcha) pero cubre el caso de ataque
// automatizado más común para esta etapa. `standardHeaders` expone
// RateLimit-* headers; `legacyHeaders` desactivado porque están deprecados.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

// Rate limit de /password/forgot: 5 intentos cada 15 minutos por IP. Sin
// esto, cualquiera podría usar el endpoint para spamear de emails de reset
// a una casilla ajena (no hace falta estar logueado ni saber la contraseña
// para dispararlo).
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

// Rate limit de /password/reset: protege contra fuerza bruta del token (32
// bytes de entropía hacen esto impracticable igual, pero es la misma
// defensa en profundidad barata que ya se aplica en /login).
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

router.post("/register", async (req, res, next) => {
  try {
    if (!isMethodEnabled("password")) {
      return res.status(403).json({ error: "method_disabled" });
    }

    const { email, password } = req.body || {};
    const check = validateCredentials({ email, password });
    if (!check.valid) {
      return res.status(400).json({ error: "invalid_input", fields: check.fields });
    }

    const existing = findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "email_taken" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = createUser({ email, passwordHash });

    const { token } = createSession(user.id, {
      userAgent: req.get("user-agent"),
      ip: req.ip,
    });
    setSessionCookie(res, token);

    return res.status(201).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    if (!isMethodEnabled("password")) {
      return res.status(403).json({ error: "method_disabled" });
    }

    const { email, password } = req.body || {};
    const check = validateCredentials({ email, password });
    if (!check.valid) {
      return res.status(400).json({ error: "invalid_input", fields: check.fields });
    }

    const user = findUserByEmail(email);

    // Mensaje genérico "invalid_credentials" tanto si el email no existe
    // como si la contraseña está mal -- no filtrar cuáles emails están
    // registrados (enumeration attack). Por eso, si no hay usuario o el
    // usuario no tiene password (solo passkey), igual se corre un
    // bcrypt.compare contra un hash dummy: así el tiempo de respuesta no
    // delata si el email existe o no (mitigación de timing attack barata).
    const hashToCompare = user && user.password_hash ? user.password_hash : DUMMY_HASH;
    const passwordOk = await bcrypt.compare(password, hashToCompare);

    if (!user || !user.password_hash || !passwordOk) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const { token } = createSession(user.id, {
      userAgent: req.get("user-agent"),
      ip: req.ip,
    });
    setSessionCookie(res, token);

    return res.status(200).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", (req, res) => {
  const token = getSessionTokenFromRequest(req);
  // Invalida en la tabla `sessions` -- no alcanza con borrar la cookie del
  // browser, si no un token ya emitido (ej. copiado/robado antes del
  // logout) seguiría sirviendo hasta expirar.
  destroySessionByToken(token);
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
});

router.get("/session", (req, res) => {
  const token = getSessionTokenFromRequest(req);
  const user = getUserBySessionToken(token);
  if (!user) {
    return res.status(401).json({ error: "no_session" });
  }
  return res.status(200).json({ user: { id: user.id, email: user.email, phone: user.phone ?? null } });
});

// ---------------------------------------------------------------------------
// POST /password/forgot -- "olvidé mi contraseña"
// ---------------------------------------------------------------------------
// SIEMPRE devuelve 200 { ok: true }, exista o no ese email en el sistema.
// Esto es intencional (no un detalle menor): si la respuesta fuera distinta
// según si el email existe, cualquiera podría usar este endpoint para
// enumerar qué emails están registrados -- mismo criterio anti-enumeración
// que ya se aplica en /login con el hash dummy.
router.post("/password/forgot", forgotPasswordLimiter, async (req, res, next) => {
  try {
    // Gating de producto, no anti-enumeración: si el método "password" está
    // apagado, este endpoint sería una puerta trasera para seguir entrando
    // por contraseña (vía reset) aunque /login lo rechace -- por eso se
    // corta acá ANTES de tocar el email, a diferencia del criterio de abajo
    // de "siempre 200" que sí aplica una vez que el método está habilitado.
    if (!isMethodEnabled("password")) {
      return res.status(403).json({ error: "method_disabled" });
    }

    const { email } = req.body || {};

    // Esto SÍ es un 400: valida formato, no existencia -- no filtra nada
    // sobre qué emails están registrados.
    const check = validateEmailOnly(email);
    if (!check.valid) {
      return res.status(400).json({ error: "invalid_input", fields: check.fields });
    }

    const user = findUserByEmail(email);

    // Si el email existe: generar token + mandar el mail. Si NO existe: no
    // hacer nada más (ni token ni mailer), pero de cualquier forma seguir
    // hasta la misma respuesta 200 de abajo -- ni un `return` temprano ni
    // ninguna rama que sea observable desde afuera.
    if (user) {
      const { token } = createPasswordResetToken(user.id);
      // Formato del link (path + query) definido en lib/passwordReset.js;
      // el frontend lo lee en App.jsx (?view=reset-password&token=...).
      const resetLink = buildResetLink(token);
      // sendPasswordResetEmail nunca lanza (ver lib/mailer.js): si no hay
      // proveedor configurado, o si el envío real falla, loguea el link en
      // consola en vez de propagar un error -- el contrato 200 no puede
      // depender de si el mail salió o no.
      await sendPasswordResetEmail({ to: user.email, resetLink });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /password/reset -- define la nueva contraseña con el token del email
// ---------------------------------------------------------------------------
router.post("/password/reset", resetPasswordLimiter, async (req, res, next) => {
  try {
    // Mismo motivo que en /password/forgot: si "password" está apagado,
    // dejar este endpoint abierto sería una puerta trasera para terminar de
    // fijar una contraseña nueva (con un token ya emitido antes del apagado)
    // y loguearse igual pese a que /login lo rechaza.
    if (!isMethodEnabled("password")) {
      return res.status(403).json({ error: "method_disabled" });
    }

    const { token, password } = req.body || {};

    if (typeof token !== "string" || token.trim().length === 0) {
      return res.status(400).json({ error: "invalid_or_expired_token" });
    }

    const passwordCheck = validatePasswordOnly(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: "invalid_input", fields: passwordCheck.fields });
    }

    // Mismo error genérico sin importar el motivo (no existe / ya usado /
    // expirado) -- no darle esa información a quien está probando tokens.
    const resetRow = findValidResetToken(token);
    if (!resetRow) {
      return res.status(400).json({ error: "invalid_or_expired_token" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    updatePasswordHash(resetRow.user_id, passwordHash);
    markResetTokenUsed(resetRow.id);
    // Corta cualquier sesión abierta con la contraseña vieja -- importante
    // si el reset ocurre porque la cuenta fue comprometida.
    destroySessionsByUserId(resetRow.user_id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, requireSession };
