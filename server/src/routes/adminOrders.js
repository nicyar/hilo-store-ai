"use strict";

// Revisión manual de comprobantes de transferencia -- NO es un panel de
// admin completo (no hay tabla de admins, roles ni login propio), es una
// pantalla mínima (admin/comprobantes.html) + estos 3 endpoints, protegidos
// por una API key única (`x-admin-key`, ver lib/adminAuth.js). Alcance
// acotado a propósito: hoy la única operación que el negocio necesita hacer
// a mano es "revisar este comprobante y aprobar o rechazar" -- ver
// CLAUDE.md, "Checkout: confirmación de transferencias por comprobante".

const express = require("express");
const rateLimit = require("express-rate-limit");

const { requireAdminKey } = require("../lib/adminAuth");
const {
  findOrderByPublicCode,
  getOrderWithItems,
  listOrdersPendingRevision,
  setOrderReviewResult,
} = require("../lib/orders");

const router = express.Router();

// Generoso pero no infinito -- esta pantalla la usa una sola persona del
// negocio a la vez, no hace falta un límite estricto, pero tampoco queda
// sin ninguno (mismo criterio que el resto de las rutas del proyecto).
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

router.use(adminLimiter, requireAdminKey);

/**
 * Serializa un pedido para la pantalla de revisión -- a diferencia de
 * `serializeOrder` en routes/orders.js (pensado para el cliente dueño del
 * pedido), acá SÍ tiene sentido exponer el contacto completo (el negocio
 * necesita saber quién dice haber pagado) y el link al comprobante. Sigue
 * sin exponer `id`/`user_id` (rowid) -- `public_code` alcanza para operar
 * sobre el pedido desde esta pantalla también.
 */
function serializeAdminOrder(order) {
  return {
    public_code: order.public_code,
    status: order.status,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    contact: {
      name: order.contact_name,
      email: order.contact_email,
      phone: order.contact_phone,
      dni: order.contact_dni,
    },
    total_cents: order.total_cents,
    currency: order.currency,
    comprobante_uploaded_at: order.comprobante_uploaded_at,
    // El front pega a este mismo endpoint con el header x-admin-key (ver
    // admin/comprobantes.html) -- no es un link público clickeable tal
    // cual, GET /api/orders/:public_code/comprobante exige esa key o ser el
    // dueño del pedido.
    comprobante_url: `/api/orders/${order.public_code}/comprobante`,
    items: (order.items || []).map((it) => ({
      product_id: it.product_id,
      name: it.name_snapshot,
      unit_price_cents: it.unit_price_cents,
      quantity: it.quantity,
      line_total_cents: it.line_total_cents,
    })),
    created_at: order.created_at,
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/orders/pending -- cola de comprobantes por revisar.
// ---------------------------------------------------------------------------
router.get("/pending", (req, res, next) => {
  try {
    const orders = listOrdersPendingRevision().map((order) => serializeAdminOrder(getOrderWithItems(order)));
    return res.status(200).json({ orders });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/orders/:public_code/confirm -- comprobante OK, pago
// acreditado.
// ---------------------------------------------------------------------------
router.post("/:public_code/confirm", (req, res, next) => {
  try {
    const order = findOrderByPublicCode(req.params.public_code);
    if (!order) {
      return res.status(404).json({ error: "order_not_found" });
    }
    // Solo se puede confirmar/rechazar un pedido que efectivamente está
    // esperando revisión -- evita, por ejemplo, "confirmar" dos veces un
    // pedido ya aprobado (que podría pisar `updated_at` sin ningún cambio
    // de estado real) o confirmar un pedido que todavía ni subió
    // comprobante.
    if (order.payment_status !== "pendiente_revision") {
      return res.status(409).json({ error: "invalid_state", payment_status: order.payment_status });
    }

    setOrderReviewResult(order.id, { paymentStatus: "aprobado", orderStatus: "confirmado" });

    const updatedOrder = getOrderWithItems(findOrderByPublicCode(order.public_code));
    return res.status(200).json({ order: serializeAdminOrder(updatedOrder) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/orders/:public_code/reject -- comprobante inválido/
// ilegible/no corresponde.
// ---------------------------------------------------------------------------
router.post("/:public_code/reject", (req, res, next) => {
  try {
    const order = findOrderByPublicCode(req.params.public_code);
    if (!order) {
      return res.status(404).json({ error: "order_not_found" });
    }
    if (order.payment_status !== "pendiente_revision") {
      return res.status(409).json({ error: "invalid_state", payment_status: order.payment_status });
    }

    // `status` vuelve a 'pendiente' (no 'cancelado') -- mismo criterio que
    // mercadopagoWebhook.js para un pago rechazado: el pedido sigue vivo,
    // el cliente puede corregir y volver a subir un comprobante (ver
    // POST /api/orders/:public_code/comprobante, que acepta re-subida
    // cuando payment_status='rechazado').
    setOrderReviewResult(order.id, { paymentStatus: "rechazado", orderStatus: "pendiente" });

    const updatedOrder = getOrderWithItems(findOrderByPublicCode(order.public_code));
    return res.status(200).json({ order: serializeAdminOrder(updatedOrder) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
