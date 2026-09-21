"use strict";

const express = require("express");
const { OAuth2Client } = require("google-auth-library");

const { findUserByEmail, createUser, toPublicUser } = require("../lib/users");
const { createSession } = require("../lib/session");
const { setSessionCookie } = require("../lib/cookies");
const { isMethodEnabled } = require("../lib/authMethods");
const db = require("../lib/db");

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/auth/google -- login/registro con Google Identity Services.
// ---------------------------------------------------------------------------
// El frontend (botón "Sign in with Google" de Google Identity Services)
// entrega un ID token (JWT) en el body como `credential`. Ese JWT viaja
// firmado por Google pero NUNCA hay que confiar en su contenido sin
// verificar la firma primero -- `verifyIdToken` valida la firma contra las
// claves públicas de Google (las cachea y refresca sola) y que el `aud`
// (audience) coincida con nuestro Client ID, para que un ID token emitido
// para otra app no sirva acá.
//
// Solo hace falta GOOGLE_CLIENT_ID, NO GOOGLE_CLIENT_SECRET: este es el
// flujo "ID token" de Google Identity Services (GIS), no un intercambio de
// código de autorización (authorization code flow) -- el secret solo sería
// necesario si el server tuviera que llamar a Google por su cuenta (ej.
// para pedir un access token), y acá no lo hace.
function isConfigured() {
  return Boolean(String(process.env.GOOGLE_CLIENT_ID || "").trim());
}

// El cliente se crea una sola vez a nivel módulo (no por request) -- es
// stateless salvo por el cache interno de claves públicas de Google, que
// conviene compartir entre requests en vez de descartar.
function getClient() {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
}

function findUserByGoogleSub(googleSub) {
  return db
    .prepare(`SELECT id, email, password_hash, phone, google_sub FROM users WHERE google_sub = ?`)
    .get(googleSub);
}

function linkGoogleSubToUser(userId, googleSub) {
  db.prepare(`UPDATE users SET google_sub = ?, updated_at = datetime('now') WHERE id = ?`).run(
    googleSub,
    userId
  );
}

router.post("/", async (req, res, next) => {
  try {
    if (!isMethodEnabled("google")) {
      return res.status(403).json({ error: "method_disabled" });
    }

    if (!isConfigured()) {
      return res.status(501).json({
        error: "not_configured",
        message: "Ingresar con Google todavía no está disponible.",
      });
    }

    const { credential } = req.body || {};
    if (typeof credential !== "string" || credential.trim().length === 0) {
      return res.status(400).json({ error: "invalid_input", fields: { credential: "required" } });
    }

    let payload;
    try {
      const ticket = await getClient().verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (err) {
      // Firma inválida, token expirado, audience que no coincide, etc. --
      // nunca es un 500: es un input del cliente que no pasó la
      // verificación, mismo criterio que invalid_or_expired_token en
      // password/reset.
      return res.status(401).json({ error: "invalid_credential" });
    }

    if (!payload || !payload.sub) {
      return res.status(401).json({ error: "invalid_credential" });
    }

    const googleSub = payload.sub;
    const email = payload.email ? String(payload.email).trim().toLowerCase() : null;
    // Google solo garantiza que el email es el que el usuario controla en su
    // cuenta de Google si email_verified viene true -- si viniera false, no
    // lo tratamos como email de contacto confiable para linkear con una
    // cuenta preexistente por email.
    const emailVerified = payload.email_verified === true;

    let user = findUserByGoogleSub(googleSub);

    if (!user && email) {
      const existingByEmail = findUserByEmail(email);
      if (existingByEmail && emailVerified) {
        // Ya existe una cuenta con ese email (ej. se registró antes por
        // password) y Google confirma que el usuario lo controla -- la
        // vinculamos en vez de crear un usuario duplicado.
        linkGoogleSubToUser(existingByEmail.id, googleSub);
        user = { ...existingByEmail, google_sub: googleSub };
      } else if (existingByEmail && !emailVerified) {
        // Ajuste de gige (2026-09-17): un email SIN verificar nunca se usa
        // para linkear automáticamente -- Google no garantiza que quien está
        // logueado ahora sea el dueño real de esa casilla, y linkear a
        // ciegas permitiría a cualquiera con acceso a esa cuenta de Google
        // (aunque no controle el email) tomar una cuenta ajena existente.
        // Pero tampoco se bloquea el login: se deja que caiga al alta de
        // usuario nuevo de abajo (identidad separada, sin `email` propio,
        // solo `google_sub`) y se loguea el posible conflicto para que
        // alguien lo revise a mano si hace falta.
        console.warn(
          `[auth/google] email no verificado "${email}" (google_sub=${googleSub}) ` +
            `coincide con el usuario existente id=${existingByEmail.id} -- no se ` +
            `linkeo automáticamente, revisar manualmente si corresponde.`
        );
      }
    }

    let created = false;
    if (!user) {
      user = createUser({ email: emailVerified ? email : null, googleSub });
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
