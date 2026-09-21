"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const { listActiveRates } = require("../lib/shippingRates");

const router = express.Router();

const ratesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

// GET /api/shipping/rates -- el front arma su selector de provincia desde
// acá, nunca con una lista hardcodeada (ver CLAUDE.md).
router.get("/", ratesLimiter, (req, res, next) => {
  try {
    const rates = listActiveRates().map((r) => ({
      provincia: r.provincia,
      zona: r.zona,
      price_cents: r.price_cents,
      es_prueba: Boolean(r.es_prueba),
    }));
    return res.status(200).json({ country_code: "AR", rates });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
