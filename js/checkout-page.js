/*
  HILO Store — checkout.html (vista, cableada a datos reales)

  Etapa 2 del plan de checkout: esta pantalla ya NO usa datos de
  mentira. Lee el carrito real (window.HILO.cart, js/cart.js), la
  configuración de checkout y las tarifas de envío reales
  (GET /api/checkout/config, GET /api/shipping/rates) y confirma el
  pedido contra POST /api/orders — ver server/src/routes/orders.js para
  el contrato exacto de cada respuesta.

  La lógica sin DOM (totales, validación, idempotency key, fetch) vive
  en js/checkout/*.js (cargados ANTES que este archivo, ver
  checkout.html) — así sobrevive tal cual a la futura migración a React
  (ver CLAUDE.md): solo este archivo se reescribe como componente,
  totals.js/validate.js/idempotency.js/api.js se reusan.

  El panel de "Vista previa de estados" que tenía nico para maquetar sin
  backend ya no existe (se borró de checkout.html) — los estados de acá
  (precio cambiado, método deshabilitado, etc.) ahora salen de
  respuestas reales del servidor.
*/
(function () {
  "use strict";

  var doc = document;

  // ---- Módulos puros (ver js/checkout/*.js) ----
  var totalsModule = window.HILO.checkout.totals;
  var validateModule = window.HILO.checkout.validate;
  var idempotencyModule = window.HILO.checkout.idempotency;
  var apiModule = window.HILO.checkout.api;

  // ---- Estado de la pantalla ----
  var shippingRates = []; // [{provincia, zona, price_cents, es_prueba}]
  var checkoutConfig = null; // { payment_methods: {...}, shipping_methods: {...} }
  var paymentBlocked = false; // true si ningún método de pago está disponible
  var isSubmitting = false; // guardia de doble click / doble submit
  var orderJustConfirmed = false; // ver handleOrderSuccess: evita que el
  // propio cart.clear() del pedido recién creado dispare el redirect a
  // index.html que boot() arma para cuando el carrito se vacía DESDE
  // OTRO lado (otra pestaña/el drawer) -- bug encontrado al verificar en
  // navegador la subida de comprobante (nunca se llegaba a ver la vista
  // de éxito, el pedido se creaba en el server pero la pantalla saltaba
  // sola a la home). cart.subscribe() notifica sincrónicamente a los
  // listeners de ESTA MISMA pestaña (ver js/cart.js), no solo a otras
  // pestañas -- por eso hacía falta esta bandera.

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /* ============================================================
     GUARDIA 1: carrito vacío -- nada que hacer en checkout.html.
     Se corta ANTES de tocar el resto del script (ver init() al final).
     ============================================================ */
  function cartIsEmpty() {
    return !window.HILO || !window.HILO.cart || window.HILO.cart.getItems().length === 0;
  }

  /* ============================================================
     GUARDIA 2: login obligatorio (ver CLAUDE.md, "Login obligatorio,
     sin excepciones"). Se chequea temprano para no hacer completar todo
     el formulario a alguien que igual va a rebotar con 401 al confirmar
     -- POST /api/orders también exige sesión (requireSession) como
     backstop si la sesión vence a mitad del flujo (ver el 401 dentro de
     handleOrderErrorResponse).
     ============================================================ */
  function redirectToLogin() {
    // El carrito no necesita nada especial para "preservarse": ya vive en
    // localStorage (js/cart.js), sobrevive a la navegación sola. `next`
    // le dice al login (frontend/src/config/authConfig.js, getNextUrl())
    // adónde volver -- soporte agregado en esta misma etapa, no existía.
    window.location.href = "/login?next=" + encodeURIComponent("/checkout.html");
  }

  /* ============================================================
     RESUMEN DEL PEDIDO
     ============================================================ */
  var summaryList = doc.querySelector("[data-summary-list]");
  var summarySubtotalEl = doc.querySelector("[data-summary-subtotal]");
  var summaryShippingEl = doc.querySelector("[data-summary-shipping]");
  var summaryTotalEl = doc.querySelector("[data-summary-total]");

  // displayItems: [{name, quantity, unitPriceCents, lineTotalCents}] --
  // forma normalizada para no tener dos renderers distintos según la
  // fuente sea el carrito local o el `cart` recalculado que devuelve el
  // server en un 409 precios_actualizados.
  function displayItemsFromCart(cartItems) {
    return cartItems.map(function (item) {
      var unitPriceCents = totalsModule.centsFromPesos(item.price);
      return {
        name: item.name,
        quantity: item.quantity,
        unitPriceCents: unitPriceCents,
        lineTotalCents: unitPriceCents * item.quantity,
      };
    });
  }

  function displayItemsFromServerCart(items) {
    return (items || []).map(function (it) {
      return {
        name: it.name,
        quantity: it.quantity,
        unitPriceCents: it.unit_price_cents,
        lineTotalCents: it.line_total_cents,
      };
    });
  }

  function renderSummaryList(displayItems) {
    if (!summaryList) return;
    summaryList.innerHTML = displayItems
      .map(function (item) {
        return (
          '<li class="checkout-summary__item">' +
            '<div class="checkout-summary__item-media"><svg aria-hidden="true"><use href="#icon-sock"/></svg></div>' +
            '<div class="checkout-summary__item-body">' +
              '<p class="checkout-summary__item-name">' + escapeHtml(item.name) + "</p>" +
              '<p class="checkout-summary__item-meta">' + item.quantity + " x " + totalsModule.formatPriceFromCents(item.unitPriceCents) + "</p>" +
            "</div>" +
            '<p class="checkout-summary__item-subtotal">' + totalsModule.formatPriceFromCents(item.lineTotalCents) + "</p>" +
          "</li>"
        );
      })
      .join("");
  }

  function findRateForProvincia(provincia) {
    for (var i = 0; i < shippingRates.length; i++) {
      if (shippingRates[i].provincia === provincia) return shippingRates[i];
    }
    return null;
  }

  // null = "no se puede calcular todavía" (envío elegido pero sin
  // provincia seleccionada, o la provincia no matchea ninguna tarifa).
  function currentShippingCentsOrNull() {
    var selected = doc.querySelector("[data-delivery-radio]:checked");
    if (!selected || selected.value !== "envio") return 0;
    var provinciaSelect = doc.getElementById("address-province");
    var rate = provinciaSelect ? findRateForProvincia(provinciaSelect.value) : null;
    return rate ? rate.price_cents : null;
  }

  function updateShippingExampleLabel() {
    var el = doc.querySelector("[data-shipping-example]");
    if (!el) return;
    if (!shippingRates.length) {
      el.textContent = "Cargando...";
      return;
    }
    var provinciaSelect = doc.getElementById("address-province");
    var rate = provinciaSelect ? findRateForProvincia(provinciaSelect.value) : null;
    el.textContent = rate ? totalsModule.formatPriceFromCents(rate.price_cents) : "Según provincia";
  }

  function updateTotals() {
    var cartItems = window.HILO.cart.getItems();
    var subtotalCents = totalsModule.computeSubtotalCents(cartItems);
    var shippingCentsOrNull = currentShippingCentsOrNull();
    var shippingCents = shippingCentsOrNull === null ? 0 : shippingCentsOrNull;
    var totalCents = totalsModule.computeTotalCents(subtotalCents, shippingCents);

    if (summarySubtotalEl) summarySubtotalEl.textContent = totalsModule.formatPriceFromCents(subtotalCents);
    if (summaryShippingEl) {
      if (shippingCentsOrNull === null) {
        summaryShippingEl.textContent = "Elegí tu provincia";
      } else if (shippingCentsOrNull === 0) {
        summaryShippingEl.textContent = "Gratis";
      } else {
        summaryShippingEl.textContent = totalsModule.formatPriceFromCents(shippingCentsOrNull);
      }
    }
    if (summaryTotalEl) summaryTotalEl.textContent = totalsModule.formatPriceFromCents(totalCents);
    updateShippingExampleLabel();
  }

  function renderSummaryFromCart() {
    renderSummaryList(displayItemsFromCart(window.HILO.cart.getItems()));
  }

  // Usado tras un 409 precios_actualizados: pinta el resumen con los
  // montos que YA recalculó el server (nunca los que había en el carrito
  // local, ver CLAUDE.md guardrail "no confiar en ningún precio que ya
  // tengas en el DOM/localStorage").
  function renderSummaryFromServerCart(cart) {
    renderSummaryList(displayItemsFromServerCart(cart.items));
    if (summarySubtotalEl) summarySubtotalEl.textContent = totalsModule.formatPriceFromCents(cart.subtotal_cents);
    if (summaryShippingEl) {
      summaryShippingEl.textContent =
        cart.shipping_cents === 0 ? "Gratis" : totalsModule.formatPriceFromCents(cart.shipping_cents);
    }
    if (summaryTotalEl) summaryTotalEl.textContent = totalsModule.formatPriceFromCents(cart.total_cents);
  }

  /* ============================================================
     PROVINCIA: select poblado desde GET /api/shipping/rates -- nunca
     hardcodeado (ver CLAUDE.md). Reemplaza las opciones de ejemplo que
     dejó nico (ver el comentario que las acompañaba en checkout.html).
     ============================================================ */
  function applyShippingRates(rates) {
    shippingRates = rates || [];
    var select = doc.getElementById("address-province");
    if (!select) return;

    var previousValue = select.value;
    var placeholder = select.querySelector("option[value='']");
    select.innerHTML = "";
    if (placeholder) select.appendChild(placeholder);

    shippingRates.forEach(function (rate) {
      var option = doc.createElement("option");
      option.value = rate.provincia;
      option.textContent = rate.provincia;
      select.appendChild(option);
    });

    if (previousValue && findRateForProvincia(previousValue)) {
      select.value = previousValue;
    }
  }

  /* ============================================================
     MÉTODO DE ENTREGA: toggle de dirección + disponibilidad de retiro
     (GET /api/checkout/config -- shipping_methods.retiro).
     ============================================================ */
  var addressFields = doc.querySelector("[data-address-fields]");
  var deliveryRadios = Array.prototype.slice.call(doc.querySelectorAll("[data-delivery-radio]"));

  var ADDRESS_REQUIRED_IDS = [
    "address-street",
    "address-number",
    "address-city",
    "address-province",
    "address-zip",
  ];

  function setAddressRequired(isRequired) {
    ADDRESS_REQUIRED_IDS.forEach(function (id) {
      var field = doc.getElementById(id);
      if (!field) return;
      if (isRequired) {
        field.setAttribute("required", "required");
      } else {
        field.removeAttribute("required");
        clearFieldError(field);
      }
    });
  }

  function handleDeliveryChange() {
    var selected = doc.querySelector("[data-delivery-radio]:checked");
    var isEnvio = !!selected && selected.value === "envio";
    if (addressFields) addressFields.hidden = !isEnvio;
    setAddressRequired(isEnvio);
    updateTotals();
  }

  deliveryRadios.forEach(function (radio) {
    radio.addEventListener("change", handleDeliveryChange);
  });

  var provinceSelectEl = doc.getElementById("address-province");
  if (provinceSelectEl) {
    provinceSelectEl.addEventListener("change", updateTotals);
  }

  // Deshabilita un método de ENTREGA ("retiro" hoy es el único que puede
  // estar apagado -- "envio" siempre disponible=true, ver
  // server/src/lib/checkoutConfig.js). Se agrega la clase
  // "delivery-option--disabled" como hook para CSS, pero hoy no tiene
  // estilo propio (a diferencia de payment-option--disabled) -- ver
  // reporte de entrega, es un estado visual que falta y no se improvisa
  // acá (guardrail del proyecto: no tocar el CSS de nico sin avisar). El
  // comportamiento funcional (no seleccionable, foco/teclado) queda
  // resuelto igual por el atributo nativo `disabled` del radio.
  function setDeliveryDisabled(method, disabled) {
    var radio = doc.querySelector('[data-delivery-radio][value="' + method + '"]');
    if (!radio) return;
    radio.disabled = disabled;
    var option = radio.closest(".delivery-option");
    if (option) option.classList.toggle("delivery-option--disabled", disabled);
    if (disabled && radio.checked) {
      var fallback = doc.querySelector("[data-delivery-radio]:not(:disabled)");
      if (fallback) {
        fallback.checked = true;
        handleDeliveryChange();
      }
    }
  }

  /* ============================================================
     MÉTODO DE PAGO: disponibilidad real (GET /api/checkout/config).
     ============================================================ */
  function setPaymentDisabled(method, disabled) {
    var option = doc.querySelector('[data-payment-option="' + method + '"]');
    if (!option) return;
    var radio = option.querySelector("[data-payment-radio]");
    if (!radio) return;
    radio.disabled = disabled;
    option.classList.toggle("payment-option--disabled", disabled);
    if (disabled && radio.checked) {
      var fallback = doc.querySelector("[data-payment-radio]:not(:disabled)");
      if (fallback) fallback.checked = true;
    }
  }

  function bothPaymentMethodsUnavailable() {
    var methods = (checkoutConfig && checkoutConfig.payment_methods) || {};
    var transferencia = methods.transferencia;
    var mercadopago = methods.mercadopago;
    return !(transferencia && transferencia.disponible) && !(mercadopago && mercadopago.disponible);
  }

  function updatePaymentBlockState() {
    paymentBlocked = bothPaymentMethodsUnavailable();
    if (confirmBtn) confirmBtn.disabled = paymentBlocked;
    if (paymentBlocked) {
      showNotice(
        "Todavía no podés confirmar tu pedido",
        "Ningún medio de pago está disponible en este momento. Volvé a intentar más tarde."
      );
    }
  }

  function applyCheckoutConfig(config) {
    checkoutConfig = config || {};
    var paymentMethods = checkoutConfig.payment_methods || {};
    var shippingMethods = checkoutConfig.shipping_methods || {};
    setPaymentDisabled("transferencia", !(paymentMethods.transferencia && paymentMethods.transferencia.disponible));
    setPaymentDisabled("mercadopago", !(paymentMethods.mercadopago && paymentMethods.mercadopago.disponible));
    setDeliveryDisabled("retiro", !(shippingMethods.retiro && shippingMethods.retiro.disponible));
    updatePaymentBlockState();
  }

  /* ============================================================
     AVISO GENÉRICO (reusa el mismo bloque que nico armó para "los
     precios cambiaron" -- ver checkout.html/css: .checkout-notice. Se
     reutiliza para cualquier aviso a nivel de formulario en vez de crear
     un elemento nuevo por caso, así no hace falta tocar HTML/CSS de
     nico para cada estado de error del server).
     ============================================================ */
  var noticeEl = doc.querySelector("[data-price-changed-notice]");
  var noticeTitleEl = noticeEl ? noticeEl.querySelector("strong") : null;
  var noticeBodyEl = noticeEl ? noticeEl.querySelector("p") : null;

  function showNotice(title, message) {
    if (!noticeEl) return;
    if (noticeTitleEl) noticeTitleEl.textContent = title;
    if (noticeBodyEl) noticeBodyEl.textContent = message;
    noticeEl.hidden = false;
  }

  function hideNotice() {
    if (!noticeEl) return;
    noticeEl.hidden = true;
  }

  /* ============================================================
     VALIDACIÓN DE CAMPOS (usa js/checkout/validate.js para las reglas
     que también aplica el server -- DNI, teléfono E.164; el resto sigue
     siendo validación de forma simple, igual que armó nico).
     ============================================================ */
  function fieldErrorEl(field) {
    return doc.getElementById(field.id + "-error");
  }

  function showFieldError(field, message) {
    field.classList.add("form-field__input--error");
    field.setAttribute("aria-invalid", "true");
    var errorEl = fieldErrorEl(field);
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
  }

  function clearFieldError(field) {
    field.classList.remove("form-field__input--error");
    field.removeAttribute("aria-invalid");
    var errorEl = fieldErrorEl(field);
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.hidden = true;
    }
  }

  function validateField(field) {
    if (field.offsetParent === null) {
      // Campo oculto (ej. dirección con "retirar en el local"): no bloquea.
      clearFieldError(field);
      return true;
    }

    var value = field.value.trim();
    var isRequired = field.hasAttribute("required");

    if (isRequired && !value) {
      showFieldError(field, "Este campo es obligatorio.");
      return false;
    }
    if (!value) {
      clearFieldError(field);
      return true;
    }

    if (field.id === "contact-email" && !validateModule.isValidEmail(value)) {
      showFieldError(field, "Ingresá un email válido.");
      return false;
    }

    if (field.id === "contact-dni" && !validateModule.isValidDni(value)) {
      showFieldError(field, "El DNI debe tener 7 u 8 números, sin puntos.");
      return false;
    }

    if (field.id === "contact-phone" && !validateModule.isValidPhone(value)) {
      showFieldError(field, "Ingresá un teléfono válido (con código de país, ej: +54 9 11 5555 0123, o en formato local).");
      return false;
    }

    clearFieldError(field);
    return true;
  }

  var VALIDATED_FIELD_IDS = [
    "contact-name",
    "contact-email",
    "contact-phone",
    "contact-dni",
    "address-street",
    "address-number",
    "address-city",
    "address-province",
    "address-zip",
  ];

  function validateForm() {
    var firstInvalid = null;
    VALIDATED_FIELD_IDS.forEach(function (id) {
      var field = doc.getElementById(id);
      if (!field) return;
      var isValid = validateField(field);
      if (!isValid && !firstInvalid) firstInvalid = field;
    });
    return firstInvalid;
  }

  VALIDATED_FIELD_IDS.forEach(function (id) {
    var field = doc.getElementById(id);
    if (!field) return;
    field.addEventListener("blur", function () {
      if (field.value.trim() || field.getAttribute("aria-invalid") === "true") {
        validateField(field);
      }
    });
  });

  // Mapea los `fields` de un 400 { error: "invalid_input", fields } del
  // server (ver server/src/lib/checkoutValidate.js) a los ids del DOM --
  // defensa en profundidad si algo pasa la validación del cliente pero
  // el server igual lo rechaza (ej. un caso de borde que el cliente no
  // cubrió).
  var CONTACT_FIELD_IDS = { name: "contact-name", email: "contact-email", phone: "contact-phone", dni: "contact-dni" };
  var ADDRESS_FIELD_IDS = {
    calle: "address-street",
    numero: "address-number",
    localidad: "address-city",
    provincia: "address-province",
    cp: "address-zip",
    // Campos opcionales de dirección -- no tienen entrada en
    // VALIDATED_FIELD_IDS (nunca son `required`), pero el server sí valida
    // su longitud (ver checkoutValidate.js MAX_LEN) y antes de este cambio
    // un 400 too_long en alguno de estos dos quedaba mudo: applyServerFieldErrors
    // no encontraba el id y no mostraba nada (ver CLAUDE.md, "Checkout:
    // endurecimiento de la validación de POST /api/orders").
    piso_depto: "address-floor",
    notas: "address-notes",
  };
  var SERVER_FIELD_ERROR_MESSAGES = {
    required: "Este campo es obligatorio.",
    invalid_format: "El formato no es válido.",
    not_found: "Esa provincia no está disponible para envío en este momento.",
    // maxlength en el HTML (ver checkout.html) ya evita este caso en el uso
    // normal -- este mensaje es el respaldo si igual llega un 400 too_long
    // del server (ej. el body se mandó por fuera del formulario).
    too_long: "Es demasiado largo.",
  };

  function applyServerFieldErrors(fields) {
    fields = fields || {};
    var firstField = null;
    Object.keys(fields).forEach(function (key) {
      var id = CONTACT_FIELD_IDS[key] || ADDRESS_FIELD_IDS[key];
      if (!id) return;
      var field = doc.getElementById(id);
      if (!field) return;
      showFieldError(field, SERVER_FIELD_ERROR_MESSAGES[fields[key]] || "Revisá este campo.");
      if (!firstField) firstField = field;
    });
    if (firstField) firstField.focus();
    announce("Hay campos con errores. Revisalos antes de confirmar.");
  }

  function buildAddressPayload() {
    return {
      calle: doc.getElementById("address-street").value.trim(),
      numero: doc.getElementById("address-number").value.trim(),
      piso_depto: doc.getElementById("address-floor").value.trim() || undefined,
      localidad: doc.getElementById("address-city").value.trim(),
      provincia: doc.getElementById("address-province").value,
      cp: doc.getElementById("address-zip").value.trim(),
      notas: doc.getElementById("address-notes").value.trim() || undefined,
    };
  }

  /* ============================================================
     ENVÍO DEL FORMULARIO
     ============================================================ */
  var checkoutForm = doc.querySelector("[data-checkout-form]");
  var confirmBtn = doc.querySelector("[data-confirm-btn]");
  var confirmSpinner = doc.querySelector("[data-confirm-spinner]");
  var confirmLabel = doc.querySelector("[data-confirm-label]");
  var liveRegion = doc.querySelector("[data-checkout-live]");
  var formView = doc.querySelector('[data-checkout-view="form"]');
  var successView = doc.querySelector('[data-checkout-view="success"]');
  var orderInstructionsEl = doc.querySelector("[data-order-instructions]");
  var orderTotalSummaryEl = doc.querySelector("[data-order-total-summary]");
  var orderCodeEl = doc.querySelector("[data-order-code]");
  var successHeadingEl = doc.querySelector("[data-success-heading]");

  /* ============================================================
     COMPROBANTE DE TRANSFERENCIA (vista de éxito, solo cuando
     order.payment_method === "transferencia" -- ver POST
     /api/orders/:public_code/comprobante en server/src/routes/orders.js,
     cerrado por lyon). No aplica a Mercado Pago, se paga distinto.
     ============================================================ */
  var comprobanteSection = doc.querySelector("[data-comprobante-section]");
  var comprobanteInput = doc.querySelector("[data-comprobante-input]");
  var comprobanteSubmitBtn = doc.querySelector("[data-comprobante-submit]");
  var comprobanteSubmitLabel = doc.querySelector("[data-comprobante-submit-label]");
  var comprobanteSpinner = doc.querySelector("[data-comprobante-spinner]");
  var comprobanteMessageEl = doc.querySelector("[data-comprobante-message]");
  var comprobanteFormRow = doc.querySelector("[data-comprobante-form-row]");
  var comprobanteSuccessEl = doc.querySelector("[data-comprobante-success]");
  var comprobanteUploading = false;
  var currentOrderPublicCode = null;

  // Mismo límite y misma whitelist que MAX_FILE_SIZE_BYTES/ALLOWED_MIME_TYPES
  // en server/src/lib/comprobantes.js -- duplicado acá a propósito para
  // avisar ANTES de subir un archivo grande por una conexión lenta. El
  // server vuelve a exigir ambas cosas igual (magic bytes incluido, ver
  // orders.js) -- este chequeo del cliente es solo UX, nunca la fuente de
  // verdad.
  var COMPROBANTE_MAX_BYTES = 5 * 1024 * 1024;
  var COMPROBANTE_ALLOWED_TYPES = ["image/jpeg", "image/png", "application/pdf"];

  function setComprobanteMessage(text, kind) {
    if (!comprobanteMessageEl) return;
    comprobanteMessageEl.textContent = text || "";
    comprobanteMessageEl.className = "form-message" + (kind ? " form-message--" + kind : "");
  }

  function setComprobanteBusy(isBusy) {
    comprobanteUploading = isBusy;
    if (comprobanteInput) comprobanteInput.disabled = isBusy;
    if (comprobanteSubmitBtn) {
      comprobanteSubmitBtn.disabled = isBusy || !comprobanteInput || !comprobanteInput.files.length;
    }
    if (comprobanteSpinner) comprobanteSpinner.hidden = !isBusy;
    if (comprobanteSubmitLabel) comprobanteSubmitLabel.textContent = isBusy ? "Subiendo..." : "Subir comprobante";
  }

  function showComprobanteUploaded() {
    if (comprobanteFormRow) comprobanteFormRow.hidden = true;
    setComprobanteMessage("", null);
    if (comprobanteSuccessEl) comprobanteSuccessEl.hidden = false;
    announce("Comprobante recibido. Tu pago quedó en revisión.");
  }

  // Se llama desde showSuccessView con CADA pedido que llega a esa vista
  // -- decide si la sección aplica (transferencia) y la deja en su
  // estado inicial. El pedido recién creado nunca llega acá con un
  // comprobante ya subido (payment_status pasa a pendiente_revision
  // recién DESPUÉS de subir uno), así que no hace falta reconstruir un
  // estado "ya subido" al entrar.
  function setupComprobanteSection(order) {
    if (!comprobanteSection) return;
    var isTransferencia = order.payment_method === "transferencia";
    comprobanteSection.hidden = !isTransferencia;
    if (!isTransferencia) return;

    currentOrderPublicCode = order.public_code;
    if (comprobanteFormRow) comprobanteFormRow.hidden = false;
    if (comprobanteSuccessEl) comprobanteSuccessEl.hidden = true;
    if (comprobanteInput) comprobanteInput.value = "";
    setComprobanteMessage("", null);
    setComprobanteBusy(false);
  }

  function handleComprobanteErrorResponse(status, data) {
    data = data || {};
    switch (data.error) {
      case "invalid_file_type":
        setComprobanteMessage("Ese tipo de archivo no está permitido. Subí un JPG, PNG o PDF.", "error");
        return;
      case "file_too_large":
        setComprobanteMessage("El archivo pesa más de 5 MB. Elegí uno más liviano.", "error");
        return;
      case "no_session":
        redirectToLogin();
        return;
      case "too_many_attempts":
        setComprobanteMessage("Demasiados intentos. Esperá unos minutos antes de volver a intentar.", "error");
        return;
      case "ya_confirmado":
        // Carrera rara (dos pestañas, o reintento tras un timeout que en
        // realidad sí había llegado a destino) -- el pedido ya está
        // confirmado, no hay nada más que subir.
        showComprobanteUploaded();
        return;
      default:
        setComprobanteMessage("No pudimos subir el comprobante. Intentá de nuevo en un momento.", "error");
    }
  }

  if (comprobanteInput) {
    comprobanteInput.addEventListener("change", function () {
      setComprobanteMessage("", null);
      if (comprobanteSubmitBtn) {
        comprobanteSubmitBtn.disabled = comprobanteUploading || !comprobanteInput.files.length;
      }
    });
  }

  if (comprobanteSubmitBtn) {
    comprobanteSubmitBtn.addEventListener("click", function () {
      if (comprobanteUploading) return;
      var file = comprobanteInput && comprobanteInput.files && comprobanteInput.files[0];
      if (!file) return;

      if (COMPROBANTE_ALLOWED_TYPES.indexOf(file.type) === -1) {
        setComprobanteMessage("Ese tipo de archivo no está permitido. Subí un JPG, PNG o PDF.", "error");
        return;
      }
      if (file.size > COMPROBANTE_MAX_BYTES) {
        setComprobanteMessage("El archivo pesa más de 5 MB. Elegí uno más liviano.", "error");
        return;
      }

      setComprobanteBusy(true);
      setComprobanteMessage("", null);

      apiModule
        .uploadComprobante(currentOrderPublicCode, file)
        .then(function (result) {
          if (result.status === 200) {
            showComprobanteUploaded();
            return;
          }
          handleComprobanteErrorResponse(result.status, result.data);
        })
        .catch(function () {
          setComprobanteMessage("No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.", "error");
        })
        .then(function () {
          setComprobanteBusy(false);
        });
    });
  }

  function announce(message) {
    if (!liveRegion) return;
    liveRegion.textContent = message;
  }

  function setBusyState(isBusy) {
    if (!confirmBtn) return;
    confirmBtn.disabled = isBusy || paymentBlocked;
    confirmBtn.setAttribute("aria-busy", isBusy ? "true" : "false");
    if (confirmSpinner) confirmSpinner.hidden = !isBusy;
    if (confirmLabel) confirmLabel.textContent = isBusy ? "Confirmando..." : "Confirmar pedido";
  }

  function buildInstructionsHTML(order, opts) {
    opts = opts || {};
    var parts = [];

    if (order.shipping_method === "envio" && order.address) {
      parts.push(
        "<p>Tu pedido va a llegar a " +
          escapeHtml(order.address.calle) + " " + escapeHtml(order.address.numero) +
          ", " + escapeHtml(order.address.localidad) + " (" + escapeHtml(order.address.provincia) + ")" +
          ", dentro de los próximos días hábiles.</p>"
      );
    } else {
      var retiro = checkoutConfig && checkoutConfig.shipping_methods && checkoutConfig.shipping_methods.retiro;
      if (retiro && retiro.disponible) {
        parts.push(
          "<p>Retirás en " + escapeHtml(retiro.direccion) + ". Horarios: " + escapeHtml(retiro.horarios) + ".</p>"
        );
      } else {
        parts.push("<p>Te vamos a escribir con la dirección y el horario del local para que puedas retirarlo.</p>");
      }
    }

    if (order.payment_method === "transferencia") {
      var transferencia = checkoutConfig && checkoutConfig.payment_methods && checkoutConfig.payment_methods.transferencia;
      if (transferencia && transferencia.disponible) {
        parts.push(
          "<p>Transferí <strong>" + totalsModule.formatPriceFromCents(order.total_cents) + "</strong> a:</p>" +
          "<p>CBU: <strong>" + escapeHtml(transferencia.cbu) + "</strong><br>" +
          "Alias: <strong>" + escapeHtml(transferencia.alias) + "</strong><br>" +
          "Titular: " + escapeHtml(transferencia.titular) + "</p>" +
          '<p>En cuanto acreditemos la transferencia, tu pedido pasa a "Pago confirmado".</p>'
        );
      } else {
        // No debería pasar (el método se deshabilita en el punto 5 del
        // pedido si esto no está configurado) -- mensaje de respaldo por
        // las dudas, nunca un CBU inventado.
        parts.push(
          "<p>Te vamos a enviar el CBU/alias y el monto a transferir a " + escapeHtml(order.contact.email) + ".</p>"
        );
      }
    } else if (order.payment_method === "mercadopago" && opts.paymentIssue) {
      parts.push("<p><strong>" + escapeHtml(opts.paymentIssue) + "</strong></p>");
    }

    return parts.join("");
  }

  function showSuccessView(order, opts) {
    if (orderCodeEl) orderCodeEl.textContent = order.public_code;
    if (orderTotalSummaryEl) {
      orderTotalSummaryEl.textContent = "Total: " + totalsModule.formatPriceFromCents(order.total_cents);
    }
    if (orderInstructionsEl) orderInstructionsEl.innerHTML = buildInstructionsHTML(order, opts);
    setupComprobanteSection(order);
    if (formView) formView.hidden = true;
    if (successView) successView.hidden = false;
    announce("Pedido confirmado. Número de pedido " + order.public_code + ".");
    if (successHeadingEl) successHeadingEl.focus();
  }

  function handleOrderSuccess(order) {
    // A partir de acá el pedido YA existe en el server pase lo que pase
    // con Mercado Pago -- nunca se debe volver a mostrar el formulario
    // ni dejar reintentar el submit (se perdería el carrito para nada,
    // el pedido ya está creado). Ver CLAUDE.md: "el pedido se crea
    // siempre primero, con payment_status='pendiente', antes de hablar
    // con MP".
    orderJustConfirmed = true;
    window.HILO.cart.clear();

    if (order.payment_method === "mercadopago") {
      if (confirmLabel) confirmLabel.textContent = "Redirigiendo a Mercado Pago...";
      apiModule
        .payWithMercadopago(order.public_code)
        .then(function (mpResult) {
          if (mpResult.ok && mpResult.data && mpResult.data.init_point) {
            window.location.href = mpResult.data.init_point;
            return;
          }
          showSuccessView(order, {
            paymentIssue:
              mpResult.data && mpResult.data.error === "mercadopago_no_configurado"
                ? "Mercado Pago no está disponible en este momento. Contactanos con tu número de pedido para coordinar el pago."
                : "No pudimos iniciar el pago con Mercado Pago. Contactanos con tu número de pedido para coordinar el pago.",
          });
        })
        .catch(function () {
          showSuccessView(order, {
            paymentIssue: "No pudimos conectar con Mercado Pago. Contactanos con tu número de pedido para coordinar el pago.",
          });
        });
      return;
    }

    showSuccessView(order, {});
  }

  function handleOrderErrorResponse(status, data) {
    data = data || {};
    switch (data.error) {
      case "precios_actualizados":
        renderSummaryFromServerCart(data.cart || {});
        showNotice(
          "Los precios cambiaron",
          "Actualizamos tu pedido con los precios actuales antes de confirmar. Revisá los totales de abajo y confirmá de nuevo."
        );
        announce("Los precios cambiaron. Revisá el resumen antes de confirmar de nuevo.");
        return;

      case "sin_stock": {
        var stockDisponible = data.stock_disponible;
        if (typeof stockDisponible === "number" && stockDisponible > 0) {
          window.HILO.cart.setQuantity(data.product_id, stockDisponible);
        } else {
          window.HILO.cart.remove(data.product_id);
        }
        if (cartIsEmpty()) {
          window.location.href = "index.html";
          return;
        }
        renderSummaryFromCart();
        updateTotals();
        showNotice(
          "No hay stock suficiente",
          "Ajustamos la cantidad de uno de tus productos según el stock disponible. Revisá tu pedido y confirmá de nuevo."
        );
        return;
      }

      case "producto_no_disponible":
        window.HILO.cart.remove(data.product_id);
        if (cartIsEmpty()) {
          window.location.href = "index.html";
          return;
        }
        renderSummaryFromCart();
        updateTotals();
        showNotice("Un producto ya no está disponible", "Lo sacamos de tu pedido. Revisá el resumen y confirmá de nuevo.");
        return;

      case "shipping_method_unavailable":
        setDeliveryDisabled(data.method, true);
        showNotice("Método de entrega no disponible", "Elegí otra forma de recibir tu pedido.");
        return;

      case "payment_method_unavailable":
        setPaymentDisabled(data.method, true);
        updatePaymentBlockState();
        showNotice("Método de pago no disponible", "Elegí otra forma de pagar.");
        return;

      case "mercadopago_no_configurado":
        setPaymentDisabled("mercadopago", true);
        updatePaymentBlockState();
        showNotice("Mercado Pago no disponible", "Todavía no está disponible como medio de pago. Elegí transferencia.");
        return;

      case "invalid_input":
        applyServerFieldErrors(data.fields);
        return;

      case "no_session":
        redirectToLogin();
        return;

      case "idempotency_key_conflict":
        showNotice("Ocurrió un problema", "Recargá la página e intentá de nuevo.");
        return;

      case "too_many_attempts":
        showNotice("Demasiados intentos", "Esperá unos minutos antes de volver a intentar.");
        return;

      default:
        showNotice("No pudimos confirmar tu pedido", "Intentá de nuevo en un momento.");
    }
  }

  if (checkoutForm) {
    checkoutForm.addEventListener("submit", function (event) {
      event.preventDefault();

      // Doble click / doble submit: guardia sincrónica en el cliente
      // (primera línea de defensa) -- el backstop real es que
      // idempotency_key se mantiene igual entre reintentos de ESTE
      // mismo submit, así que aunque este guard fallara por algún
      // motivo, el server igual devuelve el mismo pedido en vez de crear
      // uno nuevo (ver server/src/routes/orders.js, findOrderByIdempotencyKey).
      if (isSubmitting || paymentBlocked) return;

      var firstInvalid = validateForm();
      if (firstInvalid) {
        announce("Hay campos con errores. Revisalos antes de confirmar.");
        firstInvalid.focus();
        return;
      }

      var currentCartItems = window.HILO.cart.getItems();
      if (!currentCartItems.length) {
        window.location.href = "index.html";
        return;
      }

      var deliveryRadio = doc.querySelector("[data-delivery-radio]:checked");
      var paymentRadio = doc.querySelector("[data-payment-radio]:checked");
      var shippingMethod = deliveryRadio ? deliveryRadio.value : "retiro";
      var paymentMethod = paymentRadio ? paymentRadio.value : "transferencia";

      var body = {
        items: totalsModule.buildOrderItems(currentCartItems),
        contact: {
          name: doc.getElementById("contact-name").value.trim(),
          email: doc.getElementById("contact-email").value.trim(),
          phone: validateModule.normalizePhoneToE164(doc.getElementById("contact-phone").value),
          dni: doc.getElementById("contact-dni").value.trim(),
        },
        shipping_method: shippingMethod,
        payment_method: paymentMethod,
        idempotency_key: idempotencyModule.getIdempotencyKey(),
      };
      if (shippingMethod === "envio") {
        body.address = buildAddressPayload();
      }

      isSubmitting = true;
      hideNotice();
      setBusyState(true);
      announce("Confirmando tu pedido, un momento.");

      apiModule
        .createOrder(body)
        .then(function (result) {
          if (result.status === 201 || result.status === 200) {
            handleOrderSuccess(result.data.order);
            return;
          }
          handleOrderErrorResponse(result.status, result.data);
        })
        .catch(function () {
          showNotice("No pudimos conectar con el servidor", "Revisá tu conexión e intentá de nuevo.");
        })
        .then(function () {
          isSubmitting = false;
          setBusyState(false);
        });
    });
  }

  /* ---- Año dinámico del footer (mismo patrón que script.js) ---- */
  var yearEl = doc.querySelector("[data-current-year]");
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }

  /* ============================================================
     INICIALIZACIÓN
     ============================================================ */
  function boot() {
    renderSummaryFromCart();
    updateTotals();

    Promise.all([apiModule.getShippingRates(), apiModule.getCheckoutConfig()])
      .then(function (results) {
        var ratesResult = results[0];
        var configResult = results[1];
        if (ratesResult.ok) applyShippingRates(ratesResult.data.rates);
        if (configResult.ok) applyCheckoutConfig(configResult.data);
        updateTotals();
      })
      .catch(function () {
        showNotice(
          "No pudimos cargar los datos de envío y pago",
          "Recargá la página para intentar de nuevo."
        );
      });

    window.HILO.cart.subscribe(function () {
      // Sincroniza si el carrito cambia desde otra pestaña/ventana
      // mientras esta pantalla sigue abierta (ej. lo vacían desde el
      // drawer de index.html en otra tab). NO debe dispararse por el
      // cart.clear() que hacemos nosotros mismos al confirmar un pedido
      // (ver orderJustConfirmed más arriba) -- ese vaciado es esperado,
      // no un motivo para abandonar la vista de éxito.
      if (orderJustConfirmed) return;
      if (cartIsEmpty()) {
        window.location.href = "index.html";
        return;
      }
      renderSummaryFromCart();
      updateTotals();
    });
  }

  function init() {
    if (cartIsEmpty()) {
      window.location.href = "index.html";
      return;
    }

    apiModule
      .getSession()
      .then(function (result) {
        if (result.status === 401) {
          redirectToLogin();
          return;
        }
        boot();
      })
      .catch(function () {
        // Falla de red al chequear sesión por adelantado: no bloqueamos
        // el formulario por esto solo -- si en verdad no hay sesión, el
        // submit real (que también exige requireSession) lo va a
        // detectar igual y ahí sí redirige (ver handleOrderErrorResponse,
        // caso "no_session").
        boot();
      });
  }

  init();
})();
