"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const { getCheckoutConfig } = require("../lib/checkoutConfig");

const router = express.Router();

// Endpoint público de solo lectura (no requiere sesión: la pantalla de
// checkout necesita saber qué métodos ofrecer ANTES de saber si hay que
// mandar a loguearse). Rate limit generoso -- no hay dato sensible ni
// costo de cómputo, pero se limita igual siguiendo el mismo patrón que el
// resto de las rutas nuevas.
const configLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

// GET /api/checkout/config -- qué métodos de pago/envío están disponibles.
router.get("/", configLimiter, (req, res, next) => {
  try {
    return res.status(200).json(getCheckoutConfig());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
