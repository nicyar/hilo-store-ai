/*
  HILO Store — cliente HTTP del checkout.

  Sin DOM (ver CLAUDE.md / plan de checkout, Etapa 2) — solo fetch +
  parseo de respuesta. checkout-page.js es quien decide qué hacer con
  cada resultado (pintar el resumen, mostrar un error, etc.).

  Mismo criterio que frontend/src/services/authService.js (credentials:
  "include" siempre, porque la cookie hilo_session es HttpOnly) para no
  divergir del patrón ya validado ahí, aunque este módulo es vanilla
  (Promises + .then, no async/await) para no romper con el estilo del
  resto de js/*.js (sin build step / transpilación).

  Todas las funciones devuelven una Promise que resuelve a
  { ok, status, data } — nunca rechazan por un 4xx/5xx (esos son
  respuestas válidas del contrato, ver server/src/routes/orders.js: 409
  precios_actualizados, 401 no_session, etc.). Solo rechazan ante una
  falla real de red (fetch tira, o la respuesta no es JSON parseable).
*/
(function () {
  "use strict";

  function request(path, options) {
    options = options || {};
    // FormData (subida de comprobante, ver uploadComprobante) arma su
    // propio Content-Type con boundary -- si lo forzamos a
    // application/json acá, el server no puede parsear el multipart.
    var isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
    var headers = isFormData
      ? Object.assign({}, options.headers || {})
      : Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    return fetch(path, {
      credentials: "include",
      headers: headers,
      method: options.method || "GET",
      body: options.body,
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (data) {
          return { ok: response.ok, status: response.status, data: data || {} };
        });
    });
  }

  /**
   * GET /api/auth/session -- si hay 401, no hay sesión. Se usa para
   * mandar a loguearse ANTES de que la persona complete todo el
   * formulario (ver checkout-page.js) — POST /api/orders también exige
   * sesión (requireSession), esto es solo para no hacerla esperar hasta
   * el submit para enterarse.
   */
  function getSession() {
    return request("/api/auth/session");
  }

  function getCheckoutConfig() {
    return request("/api/checkout/config");
  }

  function getShippingRates() {
    return request("/api/shipping/rates");
  }

  /**
   * body: { items, contact, shipping_method, address, payment_method,
   * idempotency_key } — ver contrato completo en
   * server/src/routes/orders.js.
   */
  function createOrder(body) {
    return request("/api/orders", { method: "POST", body: JSON.stringify(body) });
  }

  /**
   * publicCode: el `public_code` del pedido ya creado (ej. "HILO-000123")
   * -- OJO, el param de la URL se llama `:id` pero el valor esperado es
   * el public_code, nunca el rowid (ver comentario en
   * server/src/routes/orders.js).
   */
  function payWithMercadopago(publicCode) {
    return request(
      "/api/orders/" + encodeURIComponent(publicCode) + "/pay/mercadopago",
      { method: "POST" }
    );
  }

  /**
   * publicCode: el public_code del pedido ya confirmado. file: el File
   * elegido en <input type="file">, se manda tal cual dentro de un
   * FormData -- el campo se llama "comprobante" porque así lo registró
   * multer del lado del server (upload.single("comprobante"), ver
   * server/src/lib/comprobantes.js). Devuelve el mismo shape { ok,
   * status, data } que el resto: 400 invalid_file_type / file_too_large
   * son respuestas válidas del contrato, no rechazos de la Promise.
   */
  function uploadComprobante(publicCode, file) {
    var formData = new FormData();
    formData.append("comprobante", file);
    return request("/api/orders/" + encodeURIComponent(publicCode) + "/comprobante", {
      method: "POST",
      body: formData,
    });
  }

  window.HILO = window.HILO || {};
  window.HILO.checkout = window.HILO.checkout || {};
  window.HILO.checkout.api = {
    getSession: getSession,
    getCheckoutConfig: getCheckoutConfig,
    getShippingRates: getShippingRates,
    createOrder: createOrder,
    payWithMercadopago: payWithMercadopago,
    uploadComprobante: uploadComprobante,
  };
})();
