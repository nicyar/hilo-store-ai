"use strict";

// Config del checkout expuesta por GET /api/checkout/config: que metodos de
// pago y de envio estan realmente disponibles, para que la UI (nico/
// valentina) muestre "en configuracion"/"proximamente" en vez de dejar que
// el usuario complete todo el formulario y recien se entere con un error
// crudo al confirmar.
//
// CONCEPTO DISTINTO al de authMethods.js (AUTH_METHODS_ENABLED): esto no es
// un apagado deliberado de producto, es una degradacion por FALTA DE DATOS/
// CREDENCIALES -- mismo criterio que mailer.js/sms.js: si falta la env var,
// se declara no disponible con un mensaje claro, nunca se inventa un valor
// (nunca un CBU de ejemplo, nunca una direccion de retiro inventada -- ver
// CLAUDE.md, guardrails).

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Datos de transferencia -- disponible solo si las TRES env vars
 * (CBU/alias/titular) estan cargadas. Si falta cualquiera, se considera no
 * disponible entera (mostrar un CBU sin titular, o viceversa, es peor que
 * no mostrar nada).
 */
function getTransferenciaConfig() {
  const cbu = process.env.TRANSFERENCIA_CBU;
  const alias = process.env.TRANSFERENCIA_ALIAS;
  const titular = process.env.TRANSFERENCIA_TITULAR;

  if (!isNonEmpty(cbu) || !isNonEmpty(alias) || !isNonEmpty(titular)) {
    return {
      disponible: false,
      mensaje: "Transferencia bancaria: medio de pago en configuración.",
    };
  }

  return {
    disponible: true,
    cbu: cbu.trim(),
    alias: alias.trim(),
    titular: titular.trim(),
  };
}

/**
 * Mercado Pago -- disponible (en el sentido de "la UI puede ofrecerlo")
 * solo si hay credenciales reales cargadas. Sin ellas, POST /api/orders
 * rechaza este metodo al crear el pedido y
 * POST /api/orders/:id/pay/mercadopago responde 501 -- ver
 * routes/orders.js. El SDK nunca se mockea (guardrail del proyecto):
 * simplemente no se ofrece hasta tener credenciales reales.
 */
function getMercadopagoConfig() {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  const publicKey = process.env.MERCADOPAGO_PUBLIC_KEY;

  if (!isNonEmpty(accessToken) || !isNonEmpty(publicKey)) {
    return {
      disponible: false,
      mensaje: "Mercado Pago: medio de pago en configuración.",
    };
  }

  return { disponible: true, public_key: publicKey.trim() };
}

/**
 * Punto de retiro -- disponible solo si direccion Y horarios estan
 * cargados. Nunca se inventa una direccion de ejemplo (guardrail del
 * proyecto).
 */
function getRetiroConfig() {
  const direccion = process.env.RETIRO_DIRECCION;
  const horarios = process.env.RETIRO_HORARIOS;

  if (!isNonEmpty(direccion) || !isNonEmpty(horarios)) {
    return {
      disponible: false,
      mensaje: "Retiro en local: todavía en configuración.",
    };
  }

  return { disponible: true, direccion: direccion.trim(), horarios: horarios.trim() };
}

/**
 * Config completa que devuelve GET /api/checkout/config. `envio` siempre
 * disponible=true porque no depende de ninguna credencial -- el costo sale
 * de `shipping_rates` (GET /api/shipping/rates), que ya viene sembrada con
 * valores de prueba (ver db/scripts/seed_shipping_rates.py).
 */
function getCheckoutConfig() {
  return {
    payment_methods: {
      transferencia: getTransferenciaConfig(),
      mercadopago: getMercadopagoConfig(),
    },
    shipping_methods: {
      retiro: getRetiroConfig(),
      envio: { disponible: true },
    },
  };
}

module.exports = {
  getCheckoutConfig,
  getTransferenciaConfig,
  getMercadopagoConfig,
  getRetiroConfig,
};
