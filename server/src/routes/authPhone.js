"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const { validatePhoneOnly } = require("../lib/validate");
const { findUserByPhone, createUser, toPublicUser } = require("../lib/users");
const { createSession } = require("../lib/session");
const { setSessionCookie } = require("../lib/cookies");
const {
  createPhoneVerificationCode,
  findValidCode,
  markCodeUsed,
} = require("../lib/phoneVerification");
const { sendVerificationSms } = require("../lib/sms");
const { isMethodEnabled } = require("../lib/authMethods");

const router = express.Router();

const CODE_RE = /^\d{6}$/;

// Rate limit de /phone/request-code por IP -- mismo umbral que
// /password/forgot (5 cada 15 minutos): cubre el caso de un atacante único
// detrás de una sola IP pidiendo códigos en loop.
const requestCodeIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: "too_many_attempts" }),
});

// Rate limit de /phone/request-code por teléfono, ADEMÁS del de IP --
// /password/forgot no lo necesita porque un email no se puede "spamear"
// desde varias IPs distintas sin que sea notorio, pero un número de
// teléfono sí (rotar de IP es trivial). Sin este segundo límite, alguien
// podría bombardear de SMS a un tercero cambiando de IP en cada intento.
const requestCodePhoneLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String((req.body && req.body.phone) || "unknown").trim(),
  handler: (req, res) => res.status(429).json({ error: "too_many_attempts" }),
});

// Rate limit de /phone/verify-code -- protege contra fuerza bruta del
// código de 6 dígitos (1 millón de combinaciones es poco para online
// brute-force sin límite; con 10 intentos/15min por IP, probar todo el
// espacio tomaría años). Mismo umbral que /password/reset.
const verifyCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: "too_many_attempts" }),
});

// ---------------------------------------------------------------------------
// POST /phone/request-code -- pide un código de verificación por SMS.
// ---------------------------------------------------------------------------
// SIEMPRE devuelve 200 { ok: true }, tenga o no ese teléfono un usuario
// asociado -- mismo criterio anti-enumeración que /password/forgot: pedir
// un código es el primer paso tanto para loguearse como para registrarse
// por primera vez, así que la respuesta no puede delatar cuál de los dos
// va a terminar siendo.
router.post("/request-code", requestCodeIpLimiter, requestCodePhoneLimiter, async (req, res, next) => {
  try {
    // Gating de producto (no anti-enumeración, ver lib/authMethods.js): si
    // "phone" está apagado, se corta ANTES de generar/enviar un código --
    // dejarlo pasar habilitaría igual /verify-code aunque el método esté
    // apagado ahí.
    if (!isMethodEnabled("phone")) {
      return res.status(403).json({ error: "method_disabled" });
    }

    const { phone } = req.body || {};

    // Esto SÍ es un 400: valida formato (E.164), no si ese teléfono ya
    // tiene cuenta -- no filtra nada sobre qué teléfonos están registrados.
    const check = validatePhoneOnly(phone);
    if (!check.valid) {
      return res.status(400).json({ error: "invalid_input", fields: check.fields });
    }

    const normalizedPhone = phone.trim();
    const { code } = createPhoneVerificationCode(normalizedPhone);
    // sendVerificationSms nunca lanza (ver lib/sms.js): si no hay proveedor
    // configurado, o si el envío real falla, loguea el código en consola en
    // vez de propagar un error -- el contrato 200 no puede depender de si
    // el SMS salió o no.
    await sendVerificationSms({ to: normalizedPhone, code });

    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /phone/verify-code -- confirma el código y loguea o registra.
// ---------------------------------------------------------------------------
// Login por teléfono sirve tanto para entrar como para registrarse la
// primera vez -- si el código es válido y no existe un usuario con ese
// teléfono, se crea uno nuevo acá mismo (no hay un paso de "registro"
// separado, a diferencia de email/contraseña). 201 si se creó la cuenta en
// este request, 200 si ya existía -- mismo criterio de status codes que
// register (201) vs. login (200) por email.
router.post("/verify-code", verifyCodeLimiter, async (req, res, next) => {
  try {
    // Ver comentario en /request-code -- mismo gating, y necesario acá
    // también: alguien podría tener un código ya pedido de antes de que se
    // apagara el método y usarlo igual para loguearse si no se corta acá.
    if (!isMethodEnabled("phone")) {
      return res.status(403).json({ error: "method_disabled" });
    }

    const { phone, code } = req.body || {};

    const phoneCheck = validatePhoneOnly(phone);
    if (!phoneCheck.valid) {
      return res.status(400).json({ error: "invalid_input", fields: phoneCheck.fields });
    }

    // Formato del código primero (barato, no toca la base); el motivo real
    // de rechazo (no existe / ya usado / expirado / no coincide) nunca se
    // distingue en la respuesta -- mismo criterio que
    // POST /password/reset con "invalid_or_expired_token".
    if (typeof code !== "string" || !CODE_RE.test(code.trim())) {
      return res.status(400).json({ error: "invalid_or_expired_code" });
    }

    const normalizedPhone = phone.trim();
    const normalizedCode = code.trim();

    const codeRow = findValidCode(normalizedPhone, normalizedCode);
    if (!codeRow) {
      return res.status(400).json({ error: "invalid_or_expired_code" });
    }
    markCodeUsed(codeRow.id);

    let user = findUserByPhone(normalizedPhone);
    let created = false;
    if (!user) {
      user = createUser({ phone: normalizedPhone });
      created = true;
    }

    const { token } = createSession(user.id, {
      userAgent: req.get("user-agent"),
      ip: req.ip,
    });
    setSessionCookie(res, token);

    return res.status(created ? 201 : 200).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
