/*
  HILO Store — cálculo de totales del checkout.

  Módulo puro, sin DOM (ver CLAUDE.md / plan de checkout, Etapa 2).
  Expone window.HILO.checkout.totals.

  OJO con la unidad: window.HILO.cart guarda `price` en PESOS (contrato
  de data-product-price, ver CLAUDE.md — "número en pesos, sin $ ni
  separador de miles"), pero orders/shipping_rates trabajan en
  CENTAVOS enteros (ver CLAUDE.md — "Centavos INTEGER, ARS explícito").
  Este módulo es el único lugar del checkout que convierte pesos -> centavos.

  Regla dura del proyecto (recordatorio, ver CLAUDE.md guardrails):
  ningún total calculado acá viaja como "la verdad" al server ni se
  muestra como definitivo después de POST /api/orders — es solo feedback
  inmediato antes de submitear. La respuesta del server siempre pisa lo
  que se haya mostrado con estas funciones (ver checkout-page.js).
*/
(function () {
  "use strict";

  /**
   * Convierte un precio en pesos (como lo guarda window.HILO.cart) a
   * centavos enteros. Math.round por las dudas de que algún precio
   * tenga decimales (el contrato del catálogo no lo prohíbe explícitamente).
   */
  function centsFromPesos(pesos) {
    var amount = Number(pesos);
    if (!isFinite(amount)) return 0;
    return Math.round(amount * 100);
  }

  /**
   * Subtotal en centavos a partir de los ítems del carrito
   * (window.HILO.cart.getItems()).
   */
  function computeSubtotalCents(cartItems) {
    return (cartItems || []).reduce(function (sum, item) {
      return sum + centsFromPesos(item.price) * item.quantity;
    }, 0);
  }

  function computeTotalCents(subtotalCents, shippingCents) {
    return (subtotalCents || 0) + (shippingCents || 0);
  }

  /**
   * Arma el array `items` que espera POST /api/orders a partir del
   * carrito: SOLO product_id + quantity (ver CLAUDE.md — "el front manda
   * solo [{product_id, quantity}]. Ni precios, ni subtotal, ni total").
   *
   * `unit_price_snapshot_cents` es la única excepción, y es opcional
   * a propósito: el server la usa SOLO para detectar que el precio
   * cambió entre agregar al carrito y confirmar (409 precios_actualizados),
   * nunca para calcular el total (ver server/src/routes/orders.js). Viaja
   * igual porque sin ella el server no podría dar ese aviso -- compararía
   * contra nada.
   */
  function buildOrderItems(cartItems) {
    return (cartItems || []).map(function (item) {
      return {
        product_id: item.id,
        quantity: item.quantity,
        unit_price_snapshot_cents: centsFromPesos(item.price),
      };
    });
  }

  // Mismo criterio de formato que ya usan js/cart.js/js/catalog.js/js/script.js
  // (duplicado a propósito, ver comentario en esos archivos: no hay bundler
  // que comparta un solo helper).
  function formatPriceFromCents(cents) {
    var pesos = (Number(cents) || 0) / 100;
    return "$" + pesos.toLocaleString("es-AR", { maximumFractionDigits: 0 });
  }

  window.HILO = window.HILO || {};
  window.HILO.checkout = window.HILO.checkout || {};
  window.HILO.checkout.totals = {
    centsFromPesos: centsFromPesos,
    computeSubtotalCents: computeSubtotalCents,
    computeTotalCents: computeTotalCents,
    buildOrderItems: buildOrderItems,
    formatPriceFromCents: formatPriceFromCents,
  };
})();
