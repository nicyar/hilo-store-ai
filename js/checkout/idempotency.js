/*
  HILO Store — idempotency key del checkout.

  Módulo puro, sin DOM (ver CLAUDE.md / plan de checkout, Etapa 2: "la
  lógica va en módulos sin DOM... así la migración a React posterior
  reescribe solo la vista"). Expone window.HILO.checkout.idempotency.

  Una sola key por INTENTO de checkout: se genera una vez, lazy, la
  primera vez que algo la pide (primer submit), y se reutiliza para
  cualquier reintento de ESE mismo submit -- doble click, reintento de
  red, o un 409 (precios_actualizados / sin_stock) que el usuario
  resuelve y vuelve a confirmar sin salir de la pantalla. Esto es lo que
  permite que POST /api/orders trate un reintento como "ya generé este
  pedido, te lo devuelvo" en vez de crear un segundo pedido (ver
  server/src/routes/orders.js, findOrderByIdempotencyKey).

  Recién se recarga la página (ej. el usuario abandona y vuelve más
  tarde) empieza un intento nuevo con una key nueva -- correcto: no es
  el mismo submit.
*/
(function () {
  "use strict";

  var currentKey = null;

  function generateUUID() {
    // crypto.randomUUID existe en todos los navegadores modernos
    // (Chrome 92+, Firefox 95+, Safari 15.4+) servidos por HTTPS o
    // localhost -- que es exactamente el caso de este proyecto en dev
    // (:4000) y en cualquier deploy real (HTTPS obligatorio). Fallback
    // manual solo por si corre en un contexto sin esa API.
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    // RFC 4122 v4 "buena onda" (no criptográficamente perfecto, pero
    // alcanza para una idempotency key que solo necesita ser única por
    // intento, no impredecible frente a un atacante).
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getIdempotencyKey() {
    if (!currentKey) {
      currentKey = generateUUID();
    }
    return currentKey;
  }

  /**
   * Fuerza un intento nuevo (key nueva). No hace falta llamarla en el
   * flujo normal (recargar la página ya alcanza), pero queda expuesta
   * por si algún caller necesita empezar un intento de checkout distinto
   * sin recargar (ej. el usuario vacía el carrito y vuelve a armar el
   * pedido desde cero).
   */
  function resetIdempotencyKey() {
    currentKey = null;
  }

  window.HILO = window.HILO || {};
  window.HILO.checkout = window.HILO.checkout || {};
  window.HILO.checkout.idempotency = {
    getIdempotencyKey: getIdempotencyKey,
    resetIdempotencyKey: resetIdempotencyKey,
  };
})();
