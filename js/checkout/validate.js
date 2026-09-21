/*
  HILO Store — validación pura del formulario de checkout.

  Módulo puro, sin DOM (ver CLAUDE.md / plan de checkout, Etapa 2).
  Expone window.HILO.checkout.validate. checkout-page.js sigue siendo
  dueño de CUÁNDO validar y CÓMO mostrar el error en el DOM (mismo
  patrón que ya armó nico con showFieldError/clearFieldError) — este
  módulo solo decide si un valor es válido.

  DNI: mismo patrón que server/src/lib/checkoutValidate.js (DNI_RE) —
  7 u 8 dígitos, sin puntos. Duplicado a propósito (front y back no
  comparten módulos, ver criterio ya aplicado en cart.js/catalog.js);
  si el server cambia esta regla, hay que actualizar los dos lados.
*/
(function () {
  "use strict";

  var DNI_PATTERN = /^\d{7,8}$/;

  // Mismo formato que exige el server (server/src/lib/validate.js,
  // PHONE_RE): E.164, "+" + 8 a 15 dígitos, el primero distinto de 0.
  var PHONE_E164_PATTERN = /^\+[1-9]\d{7,14}$/;

  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function isValidDni(value) {
    return DNI_PATTERN.test(String(value || "").trim());
  }

  function isValidEmail(value) {
    return EMAIL_PATTERN.test(String(value || "").trim());
  }

  /**
   * Normaliza un teléfono ingresado en formato libre (el placeholder de
   * nico en checkout.html sugiere formato local argentino, "11 5555
   * 0123") a la forma E.164 que exige el server compartido
   * (lib/validate.js PHONE_RE, reusado por checkoutValidate.js).
   *
   * Esto es un dato de CONTACTO (para que el negocio pueda comunicarse
   * con quien compró), no el teléfono del login por SMS (eso es un flujo
   * completamente distinto, server/src/lib/sms.js) — no hace falta que
   * sea 100% marcable, alcanza con que tenga forma E.164 válida. Por eso
   * NO se intenta resolver el "9" de celular ni el código de área: si el
   * usuario no escribe el "+", se asume Argentina (+54) y se antepone tal
   * cual. Si el resultado no matchea el patrón igual (ej. muy corto), la
   * validación lo va a rechazar y el usuario ve el error antes de
   * submitear.
   */
  function normalizePhoneToE164(rawValue) {
    var digits = String(rawValue || "").replace(/[^\d+]/g, "");
    if (digits.indexOf("+") === 0) {
      // Puede haber quedado un "+" de más si el usuario escribió algo raro
      // (ej. "11+5555") -- nos quedamos solo con el primero.
      return "+" + digits.slice(1).replace(/\+/g, "");
    }
    // Sin "+": se interpreta como número local argentino. Se saca un
    // eventual 0 inicial de larga distancia ("011...") antes de anteponer
    // el código de país.
    digits = digits.replace(/^0+/, "");
    return "+54" + digits;
  }

  function isValidPhone(rawValue) {
    return PHONE_E164_PATTERN.test(normalizePhoneToE164(rawValue));
  }

  window.HILO = window.HILO || {};
  window.HILO.checkout = window.HILO.checkout || {};
  window.HILO.checkout.validate = {
    isValidDni: isValidDni,
    isValidEmail: isValidEmail,
    isValidPhone: isValidPhone,
    normalizePhoneToE164: normalizePhoneToE164,
  };
})();
