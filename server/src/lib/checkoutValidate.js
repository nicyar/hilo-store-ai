"use strict";

// Validación de entrada de POST /api/orders -- mismo criterio "minimalista
// pero sin basura" que lib/validate.js (reusa EMAIL_RE/PHONE_RE de ahí para
// no divergir de las reglas que ya usa auth). No valida reglas de negocio
// (precio, stock, disponibilidad del método de pago) -- eso vive en la ruta
// (server/src/routes/orders.js), que es quien tiene acceso a `products` y
// `shipping_rates`. Este módulo solo valida la FORMA del body.

const { EMAIL_RE, PHONE_RE } = require("./validate");

// Tope por PRODUCTO agregado, no por línea cruda del body (hallazgo QA
// adversarial 2026-09-18, ver CLAUDE.md -- "Checkout: endurecimiento de la
// validación de POST /api/orders"): validar línea por línea permitía evadir
// el tope partiendo la cantidad en varias líneas del mismo product_id.
// Se exporta también como MAX_QTY_PER_LINE (mismo valor) porque nadie más
// importa el nombre nuevo todavía -- js/cart.js y CLAUDE.md siguen usando
// el nombre viejo, y no vale la pena tocarlos solo por el rename.
const MAX_QTY_PER_PRODUCT = 10;
const MAX_QTY_PER_LINE = MAX_QTY_PER_PRODUCT;

// Tope de cantidad de líneas del array `items` en el body -- el catálogo
// tiene 7 productos hoy, 50 da ~7x de margen. Sin esto, cientos de líneas
// de qty:10 del mismo producto armaban un pedido de miles de unidades
// (mismo hallazgo QA que motivó MAX_QTY_PER_PRODUCT -- distinto eje, mismo
// archivo).
const MAX_ITEM_LINES = 50;

// Cota de longitud por campo de texto libre (hallazgo QA adversarial "bajo":
// un nombre de 10.000 caracteres se aceptaba y persistía sin límite). Tabla
// por campo, no una constante compartida -- `notas` necesita mucho más
// margen que `cp`. `phone`/`dni` no tienen cota propia acá: ya están
// acotados por PHONE_RE/DNI_RE, una segunda cota numérica en paralelo
// divergiría de esa fuente de verdad.
const MAX_LEN = {
  name: 120,
  email: 254, // RFC 5321
  calle: 120,
  numero: 20,
  piso_depto: 40,
  barrio: 80,
  localidad: 80,
  provincia: 80,
  cp: 12,
  notas: 500,
};

// DNI argentino: solo dígitos, 7 u 8 (los DNI de 7 dígitos siguen siendo
// válidos para personas registradas antes de cierto rango numérico). Sin
// puntos ni espacios -- el front es responsable de normalizar antes de
// mandar, mismo criterio que PHONE_RE en validate.js.
const DNI_RE = /^\d{7,8}$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Solo aplica el chequeo de longitud a strings no vacíos -- una ausencia
// (undefined/null/"") ya la maneja `required`/el carácter opcional del
// campo; esto solo corta el caso "sí vino, y es enorme".
function isTooLong(value, maxLen) {
  return typeof value === "string" && value.length > maxLen;
}

/**
 * Valida { name, email, phone, dni }. Devuelve { valid, fields }.
 */
function validateContact(contact) {
  const fields = {};
  const c = contact || {};

  // Chequeo de longitud antes que formato en todos los campos -- más barato
  // (evita, en particular, backtracking de EMAIL_RE sobre un string enorme)
  // y evita que un string gigante encima "parezca" simplemente mal formado.
  if (!isNonEmptyString(c.name)) {
    fields.name = "required";
  } else if (isTooLong(c.name, MAX_LEN.name)) {
    fields.name = "too_long";
  }

  if (!isNonEmptyString(c.email)) {
    fields.email = "required";
  } else if (isTooLong(c.email, MAX_LEN.email)) {
    fields.email = "too_long";
  } else if (!EMAIL_RE.test(c.email.trim())) {
    fields.email = "invalid_format";
  }

  if (!isNonEmptyString(c.phone)) {
    fields.phone = "required";
  } else if (!PHONE_RE.test(c.phone.trim())) {
    fields.phone = "invalid_format";
  }

  // DNI obligatorio -- decisión explícita del usuario (2026-09-17, ver
  // CLAUDE.md), a diferencia de name/email/phone que ya eran obligatorios
  // por ser los datos mínimos de contacto.
  if (!isNonEmptyString(c.dni)) {
    fields.dni = "required";
  } else if (!DNI_RE.test(c.dni.trim())) {
    fields.dni = "invalid_format";
  }

  return Object.keys(fields).length > 0 ? { valid: false, fields } : { valid: true };
}

/**
 * Valida la dirección de envío (solo aplica si shipping_method='envio' --
 * el caller decide cuándo llamar esto). calle/numero/localidad/provincia/cp
 * son obligatorios (mismo mínimo que exige el CHECK de la migración 0006);
 * piso_depto/barrio/notas son opcionales, pero si vienen también se cotejan
 * contra MAX_LEN -- antes no se validaban en absoluto.
 */
function validateAddress(address) {
  const fields = {};
  const a = address || {};

  if (!isNonEmptyString(a.calle)) {
    fields.calle = "required";
  } else if (isTooLong(a.calle, MAX_LEN.calle)) {
    fields.calle = "too_long";
  }

  if (!isNonEmptyString(a.numero)) {
    fields.numero = "required";
  } else if (isTooLong(a.numero, MAX_LEN.numero)) {
    fields.numero = "too_long";
  }

  if (!isNonEmptyString(a.localidad)) {
    fields.localidad = "required";
  } else if (isTooLong(a.localidad, MAX_LEN.localidad)) {
    fields.localidad = "too_long";
  }

  if (!isNonEmptyString(a.provincia)) {
    fields.provincia = "required";
  } else if (isTooLong(a.provincia, MAX_LEN.provincia)) {
    fields.provincia = "too_long";
  }

  if (!isNonEmptyString(a.cp)) {
    fields.cp = "required";
  } else if (isTooLong(a.cp, MAX_LEN.cp)) {
    fields.cp = "too_long";
  }

  // Opcionales: ausente/vacío sigue siendo válido -- solo se rechaza si
  // vino con contenido y ese contenido es demasiado largo.
  if (isNonEmptyString(a.piso_depto) && isTooLong(a.piso_depto, MAX_LEN.piso_depto)) {
    fields.piso_depto = "too_long";
  }
  if (isNonEmptyString(a.barrio) && isTooLong(a.barrio, MAX_LEN.barrio)) {
    fields.barrio = "too_long";
  }
  if (isNonEmptyString(a.notas) && isTooLong(a.notas, MAX_LEN.notas)) {
    fields.notas = "too_long";
  }

  return Object.keys(fields).length > 0 ? { valid: false, fields } : { valid: true };
}

/**
 * Valida el array `items` del body: no vacío, no más de MAX_ITEM_LINES
 * líneas, cada elemento con `product_id` (string no vacío) y `quantity`
 * (entero 1..MAX_QTY_PER_PRODUCT). Esto es solo el chequeo POR LÍNEA -- el
 * tope agregado por producto (evade-able repitiendo product_id en varias
 * líneas) lo aplica `aggregateItemsByProductId`, que el caller corre
 * después de que esta función dé `valid:true`.
 * NO valida que el producto exista ni que haya stock -- eso requiere leer
 * `products`, y vive en la ruta (necesita acceso a la DB, no es una
 * validación de forma pura).
 */
function validateItemsShape(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, error: "items_required" };
  }

  if (items.length > MAX_ITEM_LINES) {
    return { valid: false, error: "invalid_item", reason: "too_many_lines" };
  }

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || !isNonEmptyString(item.product_id)) {
      return { valid: false, error: "invalid_item", index: i, reason: "product_id_required" };
    }
    const qty = item.quantity;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_PRODUCT) {
      return { valid: false, error: "invalid_item", index: i, reason: "invalid_quantity" };
    }
  }

  return { valid: true };
}

/**
 * Agrupa `items` (ya validado por `validateItemsShape`) por `product_id`
 * EXACTO -- sin trim/lowercase: `products.slug_o_id_origen` es
 * `TEXT NOT NULL` sin `COLLATE NOCASE` (confirmado en
 * db/migrations/0001_init.sql), normalizar acá rompería la equivalencia con
 * el `SELECT ... WHERE slug_o_id_origen = ?` de `findActiveProductBySlug`.
 * Preserva el orden de primera aparición de cada product_id (no altera el
 * orden en que el resto del flujo arma `resolvedItems`/la respuesta).
 *
 * Devuelve `{ valid:true, items:[{product_id, quantity,
 * unit_price_snapshot_cents}] }` -- una fila por producto, cantidades
 * sumadas -- o `{ valid:false, error:"invalid_item", index, product_id,
 * reason:"invalid_quantity" }` si el total agregado de algún producto
 * supera MAX_QTY_PER_PRODUCT (el fix del hallazgo crítico/alto de QA: antes
 * el tope se chequeaba por línea, así que 5 líneas de qty:1 del mismo
 * producto lo evadían).
 *
 * `unit_price_snapshot_cents`: si varias líneas del mismo producto traen
 * valores distintos (o solo algunas lo traen), se conserva el de la
 * PRIMERA línea -- es un campo forward-compatible / informativo (ver
 * CLAUDE.md, "Checkout: pedidos, pagos y envío"), no algo que el server use
 * para calcular el total.
 */
function aggregateItemsByProductId(items) {
  const order = [];
  const totals = new Map();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const productId = item.product_id;

    if (!totals.has(productId)) {
      totals.set(productId, {
        quantity: 0,
        unitPriceSnapshotCents:
          typeof item.unit_price_snapshot_cents === "number" ? item.unit_price_snapshot_cents : null,
      });
      order.push(productId);
    }

    const entry = totals.get(productId);
    entry.quantity += item.quantity;

    if (entry.quantity > MAX_QTY_PER_PRODUCT) {
      return {
        valid: false,
        error: "invalid_item",
        index: i,
        product_id: productId,
        reason: "invalid_quantity",
      };
    }
  }

  const aggregatedItems = order.map((productId) => {
    const entry = totals.get(productId);
    return {
      product_id: productId,
      quantity: entry.quantity,
      unit_price_snapshot_cents: entry.unitPriceSnapshotCents,
    };
  });

  return { valid: true, items: aggregatedItems };
}

const VALID_PAYMENT_METHODS = new Set(["transferencia", "mercadopago"]);
const VALID_SHIPPING_METHODS = new Set(["retiro", "envio"]);

module.exports = {
  validateContact,
  validateAddress,
  validateItemsShape,
  aggregateItemsByProductId,
  VALID_PAYMENT_METHODS,
  VALID_SHIPPING_METHODS,
  MAX_QTY_PER_PRODUCT,
  MAX_QTY_PER_LINE,
  MAX_ITEM_LINES,
  MAX_LEN,
  DNI_RE,
};
