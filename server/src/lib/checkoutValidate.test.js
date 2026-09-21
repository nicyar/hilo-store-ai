"use strict";

// Tests de regresión del hallazgo de QA adversarial 2026-09-18 (ver
// CLAUDE.md, "Checkout: endurecimiento de la validación de POST
// /api/orders"). `node --test`, sin DB ni servidor -- este módulo no toca
// better-sqlite3, es validación pura de forma.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateContact,
  validateAddress,
  validateItemsShape,
  aggregateItemsByProductId,
  MAX_QTY_PER_PRODUCT,
  MAX_QTY_PER_LINE,
  MAX_ITEM_LINES,
  MAX_LEN,
} = require("./checkoutValidate");

function validContact(overrides) {
  return Object.assign(
    {
      name: "Juana Pérez",
      email: "juana@example.com",
      phone: "+5491122334455",
      dni: "30123456",
    },
    overrides
  );
}

function validAddress(overrides) {
  return Object.assign(
    {
      calle: "Av. Siempre Viva",
      numero: "742",
      localidad: "Springfield",
      provincia: "Buenos Aires",
      cp: "1900",
    },
    overrides
  );
}

// --- Repro literal de los 3 hallazgos de Palito -------------------------

test("repro hallazgo crítico: 5 líneas de qty:1 del mismo producto se agregan a una sola línea de qty:5", () => {
  const items = Array.from({ length: 5 }, () => ({ product_id: "daily_12", quantity: 1 }));
  const shapeCheck = validateItemsShape(items);
  assert.equal(shapeCheck.valid, true);

  const aggregated = aggregateItemsByProductId(items);
  assert.equal(aggregated.valid, true);
  assert.deepEqual(aggregated.items, [
    { product_id: "daily_12", quantity: 5, unit_price_snapshot_cents: null },
  ]);
});

test("repro hallazgo alto: 20 líneas de qty:10 del mismo producto se rechazan al agregar (evadía MAX_QTY_PER_LINE antes del fix)", () => {
  const items = Array.from({ length: 20 }, () => ({ product_id: "daily_12", quantity: 10 }));
  const shapeCheck = validateItemsShape(items);
  assert.equal(shapeCheck.valid, true); // cada línea individual es válida (qty=10)

  const aggregated = aggregateItemsByProductId(items);
  assert.equal(aggregated.valid, false);
  assert.equal(aggregated.error, "invalid_item");
  assert.equal(aggregated.reason, "invalid_quantity");
  assert.equal(aggregated.product_id, "daily_12");
});

test("repro hallazgo alto (500 líneas): rechazado por too_many_lines antes de llegar a agregar", () => {
  const items = Array.from({ length: 500 }, () => ({ product_id: "daily_12", quantity: 10 }));
  const shapeCheck = validateItemsShape(items);
  assert.equal(shapeCheck.valid, false);
  assert.equal(shapeCheck.error, "invalid_item");
  assert.equal(shapeCheck.reason, "too_many_lines");
});

test("repro hallazgo bajo: contact.name de 10.000 caracteres es too_long", () => {
  const check = validateContact(validContact({ name: "a".repeat(10000) }));
  assert.equal(check.valid, false);
  assert.equal(check.fields.name, "too_long");
});

// --- Bordes ---------------------------------------------------------------

test("bordes MAX_QTY_PER_PRODUCT: 10 unidades agregadas es válido, 11 no", () => {
  const okItems = [
    { product_id: "daily_12", quantity: 5 },
    { product_id: "daily_12", quantity: 5 },
  ];
  assert.equal(aggregateItemsByProductId(okItems).valid, true);

  const tooMuchItems = [
    { product_id: "daily_12", quantity: 5 },
    { product_id: "daily_12", quantity: 6 },
  ];
  const result = aggregateItemsByProductId(tooMuchItems);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid_quantity");
});

test("bordes MAX_ITEM_LINES: 50 líneas es válido, 51 no", () => {
  const okItems = Array.from({ length: 50 }, (_, i) => ({ product_id: `p${i}`, quantity: 1 }));
  assert.equal(validateItemsShape(okItems).valid, true);

  const tooManyItems = Array.from({ length: 51 }, (_, i) => ({ product_id: `p${i}`, quantity: 1 }));
  const result = validateItemsShape(tooManyItems);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "too_many_lines");
});

test("bordes MAX_LEN.name: 120 chars es válido, 121 no", () => {
  const okCheck = validateContact(validContact({ name: "a".repeat(120) }));
  assert.equal(okCheck.valid, true);

  const tooLongCheck = validateContact(validContact({ name: "a".repeat(121) }));
  assert.equal(tooLongCheck.valid, false);
  assert.equal(tooLongCheck.fields.name, "too_long");
});

// --- No-regresión: casos ya cubiertos antes del fix ------------------------

test("no-regresión: items_required cuando items es vacío/no-array", () => {
  assert.equal(validateItemsShape([]).error, "items_required");
  assert.equal(validateItemsShape(null).error, "items_required");
  assert.equal(validateItemsShape(undefined).error, "items_required");
});

test("no-regresión: product_id_required cuando falta product_id", () => {
  const result = validateItemsShape([{ quantity: 1 }]);
  assert.equal(result.valid, false);
  assert.equal(result.error, "invalid_item");
  assert.equal(result.reason, "product_id_required");
  assert.equal(result.index, 0);
});

test("no-regresión: invalid_quantity con qty 0, -1, 1.5 y 11 (por línea)", () => {
  for (const quantity of [0, -1, 1.5, 11]) {
    const result = validateItemsShape([{ product_id: "daily_12", quantity }]);
    assert.equal(result.valid, false, `quantity=${quantity} debería ser inválida`);
    assert.equal(result.reason, "invalid_quantity");
  }
});

test("no-regresión: orden de errores en validateContact -- longitud antes que formato", () => {
  // Email inválido Y demasiado largo a la vez: se espera too_long, no
  // invalid_format (el chequeo de longitud corre primero, más barato y más
  // específico).
  const longInvalidEmail = `${"a".repeat(300)}@example.com`;
  const check = validateContact(validContact({ email: longInvalidEmail }));
  assert.equal(check.valid, false);
  assert.equal(check.fields.email, "too_long");
});

test("no-regresión: campos opcionales de dirección siguen aceptando ausente/vacío", () => {
  const check = validateAddress(validAddress({ piso_depto: undefined, barrio: "", notas: undefined }));
  assert.equal(check.valid, true);
});

test("dirección: piso_depto/barrio/notas demasiado largos se rechazan (antes no se validaban en absoluto)", () => {
  assert.equal(validateAddress(validAddress({ piso_depto: "a".repeat(41) })).valid, false);
  assert.equal(validateAddress(validAddress({ barrio: "a".repeat(81) })).valid, false);
  assert.equal(validateAddress(validAddress({ notas: "a".repeat(501) })).valid, false);
});

// --- Camino feliz -----------------------------------------------------------

test("camino feliz: contacto + carrito normal (2 productos, cantidades distintas) es válido de punta a punta", () => {
  const contactCheck = validateContact(validContact());
  assert.equal(contactCheck.valid, true);

  const addressCheck = validateAddress(validAddress());
  assert.equal(addressCheck.valid, true);

  const items = [
    { product_id: "daily_12", quantity: 2 },
    { product_id: "daily_20", quantity: 3 },
  ];
  const shapeCheck = validateItemsShape(items);
  assert.equal(shapeCheck.valid, true);

  const aggregated = aggregateItemsByProductId(items);
  assert.equal(aggregated.valid, true);
  assert.deepEqual(aggregated.items, [
    { product_id: "daily_12", quantity: 2, unit_price_snapshot_cents: null },
    { product_id: "daily_20", quantity: 3, unit_price_snapshot_cents: null },
  ]);
});

// --- Exports / rename -------------------------------------------------------

test("MAX_QTY_PER_LINE se sigue exportando y apunta al mismo valor que MAX_QTY_PER_PRODUCT", () => {
  assert.equal(MAX_QTY_PER_LINE, MAX_QTY_PER_PRODUCT);
  assert.equal(MAX_QTY_PER_PRODUCT, 10);
});

test("MAX_ITEM_LINES y MAX_LEN quedan expuestos para que checkout.html/js/checkout-page.js puedan reusarlos", () => {
  assert.equal(MAX_ITEM_LINES, 50);
  assert.equal(MAX_LEN.name, 120);
  assert.equal(MAX_LEN.notas, 500);
});
