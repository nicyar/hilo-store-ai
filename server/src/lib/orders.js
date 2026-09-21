"use strict";

// Acceso a datos de `orders`/`order_items` (migración 0006). La lógica de
// negocio (recalcular precios, validar stock, decidir 409 vs 201) vive en
// la ruta (server/src/routes/orders.js) -- este módulo solo persiste y
// lee, siguiendo el mismo criterio de separación que el resto del proyecto
// (ver lib/users.js, lib/session.js).

const db = require("./db");

/**
 * "HILO-000123" a partir del rowid -- el ÚNICO identificador de pedido que
 * se expone en URLs/emails/pantallas (ver comentario de la migración
 * 0006). Padding a 6 dígitos: cubre hasta 999.999 pedidos sin verse
 * desprolijo; si algún día se supera ese número, el padding simplemente
 * deja de agregar ceros (String(...).padStart no trunca), no rompe nada.
 */
function buildPublicCode(id) {
  return `HILO-${String(id).padStart(6, "0")}`;
}

function findOrderByIdempotencyKey(idempotencyKey) {
  return db
    .prepare(`SELECT * FROM orders WHERE idempotency_key = ?`)
    .get(idempotencyKey);
}

function findOrderByPublicCode(publicCode) {
  return db.prepare(`SELECT * FROM orders WHERE public_code = ?`).get(publicCode);
}

function findOrderById(id) {
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
}

function findItemsByOrderId(orderId) {
  return db
    .prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY id`)
    .all(orderId);
}

/**
 * Pedido + sus ítems, para las respuestas de la API (GET /api/orders/:code,
 * POST /api/orders, POST /api/orders/:id/pay/mercadopago).
 */
function getOrderWithItems(order) {
  if (!order) return null;
  return { ...order, items: findItemsByOrderId(order.id) };
}

/**
 * Crea el pedido + todos sus ítems en una ÚNICA transacción
 * (db.transaction, primer uso real en el proyecto -- ver CLAUDE.md) para
 * que nunca pueda quedar un pedido a mitad de camino (fila en `orders` sin
 * sus `order_items`, o viceversa). Si cualquier INSERT falla, better-sqlite3
 * revierte toda la transacción automáticamente.
 *
 * El `public_code` se calcula DESPUÉS del primer INSERT (necesita el rowid
 * ya asignado por AUTOINCREMENT) y se fija con un UPDATE inmediato, todo
 * dentro de la misma transacción -- ninguna otra conexión puede ver la fila
 * con un public_code vacío/temporal en el medio.
 *
 * `order`: { userId, contact: {name,email,phone,dni}, paymentMethod,
 *   shippingMethod, address (o null si retiro), subtotalCents,
 *   shippingCents, totalCents, idempotencyKey }
 * `items`: [{ productId, nameSnapshot, unitPriceCents, quantity,
 *   lineTotalCents, imageSnapshot, precioEraPrueba }]
 */
function createOrderWithItems(order, items) {
  const run = db.transaction(() => {
    const address = order.address || {};

    const insertOrder = db.prepare(
      `INSERT INTO orders (
         public_code, user_id,
         contact_name, contact_email, contact_phone, contact_dni,
         status, payment_method, payment_status,
         shipping_method, calle, numero, piso_depto, barrio, localidad, provincia, cp, pais, notas,
         subtotal_cents, shipping_cents, total_cents, currency,
         idempotency_key
       ) VALUES (
         '', ?,
         ?, ?, ?, ?,
         'pendiente', ?, 'pendiente',
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, 'ARS',
         ?
       )`
    );

    const info = insertOrder.run(
      order.userId,
      order.contact.name,
      order.contact.email,
      order.contact.phone,
      order.contact.dni,
      order.paymentMethod,
      order.shippingMethod,
      order.shippingMethod === "envio" ? address.calle : null,
      order.shippingMethod === "envio" ? address.numero : null,
      order.shippingMethod === "envio" ? address.pisoDepto || null : null,
      order.shippingMethod === "envio" ? address.barrio || null : null,
      order.shippingMethod === "envio" ? address.localidad : null,
      order.shippingMethod === "envio" ? address.provincia : null,
      order.shippingMethod === "envio" ? address.cp : null,
      "AR",
      order.shippingMethod === "envio" ? address.notas || null : null,
      order.subtotalCents,
      order.shippingCents,
      order.totalCents,
      order.idempotencyKey
    );

    const orderId = info.lastInsertRowid;
    const publicCode = buildPublicCode(orderId);
    db.prepare(`UPDATE orders SET public_code = ? WHERE id = ?`).run(publicCode, orderId);

    const insertItem = db.prepare(
      `INSERT INTO order_items (
         order_id, product_id, name_snapshot, unit_price_cents, quantity,
         line_total_cents, image_snapshot, precio_era_prueba
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const item of items) {
      insertItem.run(
        orderId,
        item.productId,
        item.nameSnapshot,
        item.unitPriceCents,
        item.quantity,
        item.lineTotalCents,
        item.imageSnapshot || null,
        item.precioEraPrueba ? 1 : 0
      );
    }

    return orderId;
  });

  const orderId = run();
  return getOrderWithItems(findOrderById(orderId));
}

/**
 * Guarda el `mp_preference_id` generado al crear la preference de Checkout
 * Pro (ver routes/orders.js, POST /:id/pay/mercadopago). No toca
 * `payment_status` -- eso solo lo hace el webhook, con el pago ya
 * confirmado contra la API de MP (nunca desde acá).
 */
function setOrderMercadopagoPreference(orderId, preferenceId) {
  db.prepare(
    `UPDATE orders SET mp_preference_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(preferenceId, orderId);
}

/**
 * Marca el resultado de un pago de Mercado Pago sobre el pedido, llamado
 * ÚNICAMENTE desde el webhook después de re-consultar el pago a la API de
 * MP (nunca confiando en el payload de la notificación -- ver
 * routes/mercadopagoWebhook.js). Idempotente: si `mp_payment_id` ya está
 * seteado con el mismo valor, este UPDATE es un no-op en la práctica (pisa
 * los mismos valores), y el caller además evita volver a llamar dos veces
 * gracias al UNIQUE de `mp_payment_id` + la búsqueda previa.
 */
function applyMercadopagoPaymentResult(orderId, { mpPaymentId, paymentStatus, orderStatus }) {
  db.prepare(
    `UPDATE orders
        SET mp_payment_id = ?, payment_status = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(mpPaymentId, paymentStatus, orderStatus, orderId);
}

function findOrderByMercadopagoPaymentId(mpPaymentId) {
  return db.prepare(`SELECT * FROM orders WHERE mp_payment_id = ?`).get(mpPaymentId);
}

/**
 * Registra la subida de un comprobante de transferencia (migración 0008):
 * guarda el nombre de archivo generado por el server (ver
 * lib/comprobantes.js -- NUNCA el originalname del cliente) y mueve
 * `payment_status` a 'pendiente_revision'. Llamado únicamente desde
 * POST /api/orders/:public_code/comprobante, después de validar magic
 * bytes -- este módulo no valida nada, solo persiste.
 *
 * No toca `status` (el ciclo de vida general del pedido) -- subir un
 * comprobante no confirma nada por sí solo, solo dispara la cola de
 * revisión manual.
 */
function setOrderComprobante(orderId, comprobantePath) {
  db.prepare(
    `UPDATE orders
        SET comprobante_path = ?, comprobante_uploaded_at = datetime('now'),
            payment_status = 'pendiente_revision', updated_at = datetime('now')
      WHERE id = ?`
  ).run(comprobantePath, orderId);
}

/**
 * Pedidos con comprobante subido esperando revisión manual, para
 * GET /api/admin/orders/pending. Ordenados por fecha de subida ascendente
 * (más viejo primero) -- así la cola de revisión se atiende en el orden en
 * que los clientes esperan, no en el orden en que se crearon los pedidos
 * (un pedido puede quedar mucho tiempo en 'pendiente' antes de que el
 * cliente suba el comprobante).
 */
function listOrdersPendingRevision() {
  return db
    .prepare(`SELECT * FROM orders WHERE payment_status = 'pendiente_revision' ORDER BY comprobante_uploaded_at ASC`)
    .all();
}

/**
 * Aplica el resultado de la revisión manual de un comprobante (admin
 * confirma o rechaza, ver routes/adminOrders.js). Mismo par
 * payment_status/status que ya usa mercadopagoWebhook.js para mantener un
 * solo vocabulario de estados en toda la tabla:
 *   - confirmar: payment_status='aprobado', status='confirmado'.
 *   - rechazar:  payment_status='rechazado', status='pendiente' (el pedido
 *     en sí no se cancela solo -- el cliente puede volver a subir un
 *     comprobante corregido, ver POST /:public_code/comprobante).
 */
function setOrderReviewResult(orderId, { paymentStatus, orderStatus }) {
  db.prepare(
    `UPDATE orders SET payment_status = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(paymentStatus, orderStatus, orderId);
}

module.exports = {
  buildPublicCode,
  findOrderByIdempotencyKey,
  findOrderByPublicCode,
  findOrderById,
  findItemsByOrderId,
  getOrderWithItems,
  createOrderWithItems,
  setOrderMercadopagoPreference,
  applyMercadopagoPaymentResult,
  findOrderByMercadopagoPaymentId,
  setOrderComprobante,
  listOrdersPendingRevision,
  setOrderReviewResult,
};
