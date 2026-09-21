"use strict";

// Webhook de Mercado Pago -- notifica cambios de estado de un pago
// (aprobado, rechazado, etc.). Exento de requireSession a propósito: MP no
// manda la cookie hilo_session, es un servidor externo pegándole
// directamente a esta URL.
//
// Dos reglas duras no negociables acá (guardrails del proyecto):
//   1. Validar la firma HMAC ANTES de leer el payload -- si no, cualquiera
//      que adivine la URL podría mandar un POST fabricado marcando
//      cualquier pedido como pagado.
//   2. NUNCA confiar en el monto/estado que manda el payload de la
//      notificación -- la notificación solo dice "algo cambió para el pago
//      X", así que se re-consulta ESE pago a la API de MP (fuente de
//      verdad) antes de tocar `orders`.
//
// Idempotente por `mp_payment_id` (UNIQUE en `orders`, migración 0006): si
// ya se procesó ese pago, no se reprocesa -- MP reintenta notificaciones
// que no devolvieron 2xx a tiempo, así que este handler puede recibir el
// mismo evento más de una vez.

const express = require("express");
const rateLimit = require("express-rate-limit");
const { MercadoPagoConfig, Payment, WebhookSignatureValidator, InvalidWebhookSignatureError } = require("mercadopago");

const {
  findOrderByPublicCode,
  findOrderByMercadopagoPaymentId,
  applyMercadopagoPaymentResult,
} = require("../lib/orders");
const { getMercadopagoConfig } = require("../lib/checkoutConfig");

const router = express.Router();

// Rate limit propio (no requireSession, así que no hereda ninguna
// protección de sesión) -- generoso porque MP puede reintentar varias
// notificaciones seguidas, pero acotado para no quedar expuesto a un
// flood de requests fabricados a esta URL pública.
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

// Mapeo del status de MP (https://www.mercadopago.com.ar/developers/es/docs/checkout-api/response-handling/collection-results)
// a nuestros CHECK de `orders` (migración 0006). Cualquier status de MP no
// listado acá se trata como "pendiente" -- fail-safe: nunca marcar un
// pedido como pagado ante un status que no reconocemos explícitamente.
function mapPaymentStatus(mpStatus) {
  if (mpStatus === "approved") return { paymentStatus: "aprobado", orderStatus: "confirmado" };
  if (mpStatus === "rejected") return { paymentStatus: "rechazado", orderStatus: "pendiente" };
  if (mpStatus === "cancelled" || mpStatus === "refunded" || mpStatus === "charged_back") {
    return { paymentStatus: "cancelado", orderStatus: "cancelado" };
  }
  return { paymentStatus: "pendiente", orderStatus: "pendiente" };
}

router.post("/", webhookLimiter, express.json(), async (req, res) => {
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Sin secret configurado no hay forma de validar la firma -- rechazar
    // explícito en vez de aceptar notificaciones sin verificar (que sería
    // el equivalente a mockear la seguridad del webhook, algo que el
    // proyecto no permite). 501, mismo código que el resto de "falta
    // configurar" en este proyecto.
    console.error("[webhook mercadopago] MERCADOPAGO_WEBHOOK_SECRET no configurado -- notificación rechazada.");
    return res.status(501).json({ error: "mercadopago_webhook_no_configurado" });
  }

  // --- 1. Validar firma ANTES de leer nada del payload ---
  const dataId = req.query["data.id"] || (req.body && req.body.data && req.body.data.id);
  try {
    WebhookSignatureValidator.validate({
      xSignature: req.headers["x-signature"],
      xRequestId: req.headers["x-request-id"],
      dataId,
      secret: webhookSecret,
      toleranceSeconds: 300,
    });
  } catch (err) {
    if (err instanceof InvalidWebhookSignatureError) {
      console.error(`[webhook mercadopago] Firma inválida (${err.reason}), x-request-id=${err.requestId}`);
      return res.status(401).json({ error: "invalid_signature" });
    }
    console.error("[webhook mercadopago] Error validando firma:", err);
    return res.status(400).json({ error: "invalid_signature" });
  }

  // --- 2. Firma OK: recién ahora se lee/usa el payload ---
  const eventType = req.body && (req.body.type || req.body.topic);
  if (eventType !== "payment") {
    // MP también manda otros topics (merchant_order, etc.) -- se ignoran
    // con 200 para que MP no siga reintentando algo que no procesamos.
    return res.status(200).json({ ok: true, ignored: true });
  }

  const paymentId = dataId;
  if (!paymentId) {
    return res.status(400).json({ error: "missing_payment_id" });
  }

  const mpConfig = getMercadopagoConfig();
  if (!mpConfig.disponible) {
    console.error("[webhook mercadopago] MERCADOPAGO_ACCESS_TOKEN no configurado -- no se puede re-consultar el pago.");
    return res.status(501).json({ error: "mercadopago_no_configurado" });
  }

  // --- 3. Idempotencia: si este pago ya se procesó, no repetir trabajo ---
  const alreadyProcessed = findOrderByMercadopagoPaymentId(String(paymentId));
  if (alreadyProcessed) {
    return res.status(200).json({ ok: true, already_processed: true });
  }

  // --- 4. Re-consultar el pago a la API de MP -- NUNCA confiar en el
  // monto/estado del payload de la notificación ---
  let payment;
  try {
    const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
    payment = await new Payment(client).get({ id: paymentId });
  } catch (err) {
    console.error("[webhook mercadopago] Falló re-consultar el pago a la API de MP:", err.message);
    // 500 -- MP reintenta notificaciones que no devuelven 2xx, y acá
    // conviene que reintente (puede ser un problema transitorio nuestro o
    // de la API de MP), en vez de darle un 200 que le haga creer que ya lo
    // procesamos.
    return res.status(500).json({ error: "mercadopago_lookup_failed" });
  }

  const externalReference = payment.external_reference;
  if (!externalReference) {
    console.error(`[webhook mercadopago] Pago ${paymentId} sin external_reference -- no se puede asociar a un pedido.`);
    return res.status(200).json({ ok: true, unmatched: true });
  }

  const order = findOrderByPublicCode(externalReference);
  if (!order) {
    console.error(`[webhook mercadopago] Pago ${paymentId} referencia el pedido ${externalReference}, que no existe.`);
    return res.status(200).json({ ok: true, unmatched: true });
  }

  // El total del pedido es la fuente de verdad server-side -- si el monto
  // que MP dice haber cobrado no coincide con `total_cents`, no se marca
  // como aprobado ciegamente: se deja en pendiente y se loguea para
  // revisión manual (nunca se ajusta el pedido al monto que vino de
  // afuera).
  const transactionAmountCents = Math.round((payment.transaction_amount || 0) * 100);
  if (payment.status === "approved" && transactionAmountCents !== order.total_cents) {
    console.error(
      `[webhook mercadopago] Pago ${paymentId} aprobado por ${transactionAmountCents} cents, ` +
        `pero el pedido ${order.public_code} espera ${order.total_cents} cents -- NO se marca como pagado, revisar a mano.`
    );
    return res.status(200).json({ ok: true, amount_mismatch: true });
  }

  const { paymentStatus, orderStatus } = mapPaymentStatus(payment.status);
  applyMercadopagoPaymentResult(order.id, {
    mpPaymentId: String(paymentId),
    paymentStatus,
    orderStatus,
  });

  return res.status(200).json({ ok: true });
});

module.exports = router;
