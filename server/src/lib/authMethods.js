"use strict";

// Gating de métodos de login -- CONCEPTO DISTINTO al de mailer.js/sms.js.
//
// mailer.js y sms.js degradan por *falta de credenciales*: si no hay
// proveedor configurado, igual responden 200 y loguean en consola (para no
// bloquear el desarrollo). Ese criterio es correcto para "todavía no tenemos
// la cuenta del proveedor", pero NO aplica acá.
//
// AUTH_METHODS_ENABLED es un apagado deliberado de producto: el usuario
// puede decidir en cualquier momento que un método de login (aunque esté
// 100% funcional y configurado) no debe estar disponible -- ej. "por ahora
// solo Google" mientras se estabiliza el resto. No es una degradación por
// falta de infraestructura, es una decisión de negocio reversible.
//
// Formato: lista separada por comas en la env var, ej. "google" o
// "password,phone". Si la env var no está seteada, el default es TODOS los
// métodos habilitados -- así ningún deploy existente se rompe por no
// conocer esta variable nueva.
//
// Nombres válidos: "password", "google", "phone" -- deben coincidir
// exactamente con VITE_AUTH_METHODS del frontend (valentina), documentado
// en CLAUDE.md. No agregar un método nuevo acá sin avisar al frontend.
const VALID_METHODS = new Set(["password", "google", "phone"]);
const DEFAULT_METHODS = "password,google,phone";

function getEnabledMethods() {
  const raw = String(process.env.AUTH_METHODS_ENABLED || DEFAULT_METHODS).trim();
  return new Set(
    raw
      .split(",")
      .map((m) => m.trim().toLowerCase())
      .filter((m) => m.length > 0)
  );
}

/**
 * true si `method` ("password" | "google" | "phone") está habilitado por
 * AUTH_METHODS_ENABLED. Un nombre de método desconocido (typo en la env var,
 * o un caller que pasa algo que no es de VALID_METHODS) nunca se considera
 * habilitado -- fail closed, no fail open.
 */
function isMethodEnabled(method) {
  if (!VALID_METHODS.has(method)) return false;
  return getEnabledMethods().has(method);
}

module.exports = { isMethodEnabled, VALID_METHODS };
