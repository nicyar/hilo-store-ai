/*
  HILO Store — interacciones de la home
  Sin dependencias externas. Cada handler expone el resultado
  de la acción de forma visible e inmediata (texto/estado del
  botón, no solo color) y avisa a lectores de pantalla via
  regiones aria-live cuando corresponde.
*/
(function () {
  "use strict";

  var doc = document;

  /* ---------------- Menú mobile ---------------- */
  var navToggle = doc.querySelector("[data-nav-toggle]");
  var mobileNav = doc.getElementById("mobile-nav");

  function closeMobileNav() {
    if (!mobileNav || mobileNav.hidden) return;
    mobileNav.hidden = true;
    navToggle.setAttribute("aria-expanded", "false");
  }

  function openMobileNav() {
    mobileNav.hidden = false;
    navToggle.setAttribute("aria-expanded", "true");
    var firstLink = mobileNav.querySelector("a");
    if (firstLink) firstLink.focus();
  }

  if (navToggle && mobileNav) {
    navToggle.addEventListener("click", function () {
      var isOpen = navToggle.getAttribute("aria-expanded") === "true";
      if (isOpen) {
        closeMobileNav();
        navToggle.focus();
      } else {
        openMobileNav();
      }
    });

    doc.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeMobileNav();
      }
    });
  }

  /* ---------------- Buscador expandible ---------------- */
  var searchToggle = doc.querySelector("[data-search-toggle]");
  var searchForm = doc.querySelector("[data-search-form]");
  var searchInput = searchForm ? searchForm.querySelector("input") : null;

  if (searchToggle && searchForm && searchInput) {
    searchToggle.addEventListener("click", function () {
      var isOpen = searchForm.classList.toggle("is-open");
      searchToggle.setAttribute("aria-expanded", String(isOpen));
      if (isOpen) {
        searchInput.focus();
      }
    });

    searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        searchForm.classList.remove("is-open");
        searchToggle.setAttribute("aria-expanded", "false");
        searchToggle.focus();
      }
    });

    searchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      // No hay backend de búsqueda todavía: se deja el enganche listo.
      searchInput.blur();
    });
  }

  /* ---------------- Carrito: drawer y badge del header ----------------
     El estado del carrito (persistencia, validación, clamp de cantidad)
     vive en js/cart.js y se expone como window.HILO.cart — ver ese
     archivo. Este módulo solo renderiza el drawer/badge a partir de ese
     estado y traduce clicks del DOM en llamadas a esa API.

     Contrato de datos que exponen los product-card (demo o catálogo real,
     ver index.html): data-product-id, data-product-name, data-product-price
     (número en pesos sin "$" ni separador de miles, solo si hay precio
     cargado) y data-product-image (opcional). Cuando el precio todavía no
     está cargado, el botón trae data-price-unavailable="true".

     Este módulo lee esos atributos de forma genérica —nunca hardcodea un
     producto puntual— para no necesitar cambios acá cuando el catálogo
     real reemplace a los productos de muestra. */

  // Duplicado a propósito (mismo criterio que formatPrice en catalog.js):
  // MAX_QTY_PER_LINE es dato de js/cart.js (que clampea de verdad), acá
  // solo hace falta para decidir si el botón "+" se ve disabled. Si cambia
  // el máximo, hay que tocar los dos archivos.
  var MAX_QTY_PER_LINE = 10;

  var cartCount = doc.querySelector("[data-cart-count]");
  var liveRegion = doc.querySelector("[data-cart-live]");
  var cartLink = doc.querySelector("[data-cart-link]");
  var cartDrawer = doc.querySelector("[data-cart-drawer]");
  var cartPanel = cartDrawer ? cartDrawer.querySelector(".cart-drawer__panel") : null;
  var cartBody = cartDrawer ? cartDrawer.querySelector("[data-cart-body]") : null;
  var cartFooter = cartDrawer ? cartDrawer.querySelector("[data-cart-footer]") : null;
  var cartTotalEl = cartDrawer ? cartDrawer.querySelector("[data-cart-total]") : null;

  var lastCartTrigger = null;

  function announce(message) {
    if (!liveRegion) return;
    liveRegion.textContent = message;
  }

  /* ---- Utilidades ---- */
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  // Sin \uXXXX ni normalize("NFD") a propósito: en este entorno los escapes
  // unicode dentro de literales de regex se resuelven antes de llegar al
  // archivo. Un mapa de acentos explícito alcanza para nombres en español.
  var SLUG_ACCENTS = { á: "a", é: "e", í: "i", ó: "o", ú: "u", ñ: "n", ü: "u" };

  function slugify(text) {
    var slug = String(text)
      .toLowerCase()
      .replace(/[áéíóúñü]/g, function (ch) {
        return SLUG_ACCENTS[ch] || ch;
      })
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "");
    return slug || "producto";
  }

  function formatPrice(value) {
    var amount = Number(value) || 0;
    return "$" + amount.toLocaleString("es-AR", { maximumFractionDigits: 0 });
  }

  function readAttr(button, card, name) {
    return button.getAttribute(name) || (card && card.getAttribute(name)) || null;
  }

  // Un producto está "sin precio" si lo dice explícitamente
  // data-price-unavailable, o si no expone un data-product-price numérico
  // válido — así el carrito nunca puede recibir un precio inventado,
  // sin depender de que cada card recuerde marcar el atributo a mano.
  function readProductData(button) {
    var card = button.closest(".product-card");
    var name = readAttr(button, card, "data-product-name") || "Producto";
    var id = readAttr(button, card, "data-product-id") || slugify(name);
    var image = readAttr(button, card, "data-product-image");
    var explicitUnavailable = readAttr(button, card, "data-price-unavailable") === "true";
    var priceRaw = readAttr(button, card, "data-product-price");
    var price = null;

    if (!explicitUnavailable && priceRaw !== null && priceRaw !== "") {
      var parsed = Number(priceRaw);
      if (isFinite(parsed) && parsed >= 0) price = parsed;
    }

    return {
      id: id,
      name: name,
      price: price,
      image: image,
      unavailable: explicitUnavailable || price === null,
    };
  }

  /* ---- Estado del carrito: wrappers finos sobre window.HILO.cart ----
     El render (drawer + badge) se dispara solo por window.HILO.cart.subscribe
     (ver más abajo), así que estas funciones no llaman a renderCartDrawer/
     updateHeaderCartUI directamente -- solo mutan el estado y, cuando
     corresponde, anuncian el resultado a los lectores de pantalla. */
  function addToCart(product) {
    window.HILO.cart.add(product);
  }

  function changeCartQuantity(id, delta) {
    var items = window.HILO.cart.getItems();
    var item = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) {
        item = items[i];
        break;
      }
    }
    if (!item) return;
    var next = item.quantity + delta;
    // Mínimo 1: para sacar el producto se usa el botón "Quitar" explícito,
    // nunca se deja que la cantidad baje a 0 sola.
    if (next < 1 || next > MAX_QTY_PER_LINE) return;
    window.HILO.cart.setQuantity(id, next);
    announce(
      "Cantidad de " + item.name + " actualizada a " + next + ". Total del carrito: " + formatPrice(window.HILO.cart.getSubtotal()) + "."
    );
  }

  function removeCartItem(id) {
    var items = window.HILO.cart.getItems();
    var item = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) {
        item = items[i];
        break;
      }
    }
    if (!item) return;
    window.HILO.cart.remove(id);
    announce(item.name + " quitado del carrito. Total del carrito: " + formatPrice(window.HILO.cart.getSubtotal()) + ".");
  }

  /* ---- Render ---- */
  function updateHeaderCartUI() {
    var count = window.HILO.cart.getCount();
    if (cartCount) {
      cartCount.textContent = String(count);
      cartCount.classList.toggle("is-empty", count === 0);
    }
    if (cartLink) {
      var noun = count === 1 ? "producto" : "productos";
      cartLink.setAttribute("aria-label", "Ver carrito de compras, " + count + " " + noun);
    }
  }

  function renderCartItemHTML(item) {
    var safeName = escapeHtml(item.name);
    var media = item.image
      ? '<img src="' + escapeHtml(item.image) + '" alt="" loading="lazy" />'
      : '<svg aria-hidden="true"><use href="#icon-sock"/></svg>';
    var atMax = item.quantity >= MAX_QTY_PER_LINE;

    return (
      '<li class="cart-item" data-cart-item="' + escapeHtml(item.id) + '">' +
        '<div class="cart-item__media">' + media + "</div>" +
        '<div class="cart-item__body">' +
          '<p class="cart-item__name">' + safeName + "</p>" +
          '<p class="cart-item__unit-price">' + formatPrice(item.price) + " c/u</p>" +
          '<div class="cart-item__qty" role="group" aria-label="Cantidad de ' + safeName + '">' +
            '<button type="button" class="cart-item__qty-btn" data-qty-decrease="' + escapeHtml(item.id) + '" aria-label="Restar una unidad de ' + safeName + '"' + (item.quantity <= 1 ? " disabled" : "") + ">&minus;</button>" +
            '<span class="cart-item__qty-value">' + item.quantity + "</span>" +
            '<button type="button" class="cart-item__qty-btn" data-qty-increase="' + escapeHtml(item.id) + '" aria-label="Sumar una unidad de ' + safeName + '"' + (atMax ? " disabled" : "") + ">+</button>" +
          "</div>" +
        "</div>" +
        '<div class="cart-item__end">' +
          '<p class="cart-item__subtotal">' + formatPrice(item.price * item.quantity) + "</p>" +
          '<button type="button" class="cart-item__remove" data-remove-item="' + escapeHtml(item.id) + '" aria-label="Quitar ' + safeName + ' del carrito">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>' +
            "<span>Quitar</span>" +
          "</button>" +
        "</div>" +
      "</li>"
    );
  }

  function renderCartDrawer() {
    if (!cartBody) return;

    var cart = window.HILO.cart.getItems();

    var noticeHTML = "";
    if (!window.HILO.cart.isStorageAvailable()) {
      noticeHTML =
        '<div class="cart-drawer__notice" role="status">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="18" height="18"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>' +
          "<span>No pudimos guardar tu carrito en este dispositivo (el almacenamiento local no está disponible). Vas a poder seguir comprando, pero el carrito no va a persistir si cerrás la pestaña.</span>" +
        "</div>";
    }

    if (!cart.length) {
      cartBody.innerHTML =
        noticeHTML +
        '<div class="cart-empty">' +
          '<svg aria-hidden="true"><use href="#icon-sock"/></svg>' +
          '<p class="cart-empty__title">Tu carrito está vacío</p>' +
          '<p class="cart-empty__subtitle">Agregá tus medias favoritas y volvé por acá cuando quieras.</p>' +
          '<a class="btn btn--primary" href="#destacados" data-cart-continue>Ver catálogo</a>' +
        "</div>";
      if (cartFooter) cartFooter.hidden = true;
    } else {
      cartBody.innerHTML = noticeHTML + '<ul class="cart-list">' + cart.map(renderCartItemHTML).join("") + "</ul>";
      if (cartFooter) cartFooter.hidden = false;
      if (cartTotalEl) cartTotalEl.textContent = formatPrice(window.HILO.cart.getSubtotal());
    }
  }

  /* ---- Drawer: abrir/cerrar, foco y teclado ---- */
  function isCartOpen() {
    return !!cartDrawer && !cartDrawer.hidden;
  }

  function getFocusableElements(container) {
    if (!container) return [];
    var selector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.slice.call(container.querySelectorAll(selector)).filter(function (el) {
      return el.offsetParent !== null;
    });
  }

  function openCartDrawer(trigger) {
    if (!cartDrawer) return;
    lastCartTrigger = trigger || cartLink;
    cartDrawer.hidden = false;
    doc.body.classList.add("has-open-drawer");
    var focusable = getFocusableElements(cartPanel);
    if (focusable.length) focusable[0].focus();
  }

  function closeCartDrawer(options) {
    if (!cartDrawer || cartDrawer.hidden) return;
    cartDrawer.hidden = true;
    doc.body.classList.remove("has-open-drawer");
    var shouldRestoreFocus = !options || options.restoreFocus !== false;
    if (shouldRestoreFocus && lastCartTrigger) lastCartTrigger.focus();
  }

  function trapCartFocus(event) {
    var focusable = getFocusableElements(cartPanel);
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (cartLink && cartDrawer) {
    cartLink.addEventListener("click", function (event) {
      event.preventDefault();
      openCartDrawer(cartLink);
    });

    cartDrawer.querySelectorAll("[data-cart-close]").forEach(function (closeEl) {
      closeEl.addEventListener("click", function () {
        closeCartDrawer();
      });
    });

    doc.addEventListener("keydown", function (event) {
      if (!isCartOpen()) return;
      if (event.key === "Escape") {
        closeCartDrawer();
      } else if (event.key === "Tab") {
        trapCartFocus(event);
      }
    });

    // Delegación de eventos: la lista de ítems se re-renderiza entera en
    // cada cambio, así que los handlers viven en el contenedor fijo.
    cartBody.addEventListener("click", function (event) {
      var increaseBtn = event.target.closest("[data-qty-increase]");
      var decreaseBtn = event.target.closest("[data-qty-decrease]");
      var removeBtn = event.target.closest("[data-remove-item]");
      var continueBtn = event.target.closest("[data-cart-continue]");

      if (increaseBtn) {
        changeCartQuantity(increaseBtn.getAttribute("data-qty-increase"), 1);
      } else if (decreaseBtn) {
        changeCartQuantity(decreaseBtn.getAttribute("data-qty-decrease"), -1);
      } else if (removeBtn) {
        removeCartItem(removeBtn.getAttribute("data-remove-item"));
      } else if (continueBtn) {
        closeCartDrawer({ restoreFocus: false });
      }
    });
  }

  /* ---------------- Botones "Agregar al carrito" ----------------
     Ajuste sobre el diseño original: antes se enganchaba un listener por
     botón, asumiendo que todas las product-cards ya estaban en el DOM
     cuando este script corre. Desde que el catálogo se renderiza de
     forma asíncrona (fetch en js/catalog.js), eso ya no es cierto — las
     cards pueden no existir todavía en este punto. Se pasa a delegación
     de eventos sobre `document` (mismo patrón que ya se usa arriba para
     los botones del drawer), así que "Agregar al carrito" funciona sin
     importar cuándo se inserten las cards. */

  // Defensa + UX: si el producto no tiene precio cargado, el botón queda
  // deshabilitado con el label acordado con nico. En el catálogo dinámico
  // esto ya viene resuelto en el HTML que genera js/catalog.js (disabled
  // nativo + label correctos) — esta función es una segunda capa de
  // seguridad, no la única fuente de verdad, y sigue haciendo falta para
  // cualquier product-card que se agregue a mano en el futuro.
  function setInitialButtonState(button) {
    var defaultLabel = button.querySelector("[data-btn-label]");
    var initialData = readProductData(button);

    if (initialData.unavailable) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      if (defaultLabel) {
        defaultLabel.textContent = "Precio a confirmar";
      } else {
        button.textContent = "Precio a confirmar";
      }
    }
  }

  function initializeAddToCartButtons() {
    doc.querySelectorAll("[data-add-to-cart]").forEach(setInitialButtonState);
  }

  initializeAddToCartButtons();

  // Expuesto para que js/catalog.js pueda re-aplicar este estado inicial
  // después de insertar las cards del catálogo (ver su uso allá).
  window.HILO = window.HILO || {};
  window.HILO.refreshAddToCartButtons = initializeAddToCartButtons;

  doc.addEventListener("click", function (event) {
    var button = event.target.closest("[data-add-to-cart]");
    // Evita doble-submit: un botón nativamente disabled ni siquiera
    // dispara este evento, pero se chequea igual por claridad.
    if (!button || button.disabled) return;

    var defaultLabel = button.querySelector("[data-btn-label]");
    var originalText = defaultLabel ? defaultLabel.textContent : button.textContent;
    var product = readProductData(button);

    // Defensa extra ante un DOM forzado (ej. alguien saca el atributo
    // "disabled" a mano): nunca se agrega un producto sin precio real.
    if (product.unavailable) {
      console.warn(
        'HILO Store: se intentó agregar "' + product.name + '" sin precio cargado; se ignora el click.'
      );
      return;
    }

    button.disabled = true;
    button.classList.add("btn--added");

    if (defaultLabel) {
      defaultLabel.textContent = "Agregado";
    } else {
      button.textContent = "Agregado";
    }

    addToCart(product);
    announce(product.name + " agregado al carrito. Total de productos: " + window.HILO.cart.getCount() + ".");

    window.setTimeout(function () {
      button.disabled = false;
      button.classList.remove("btn--added");
      if (defaultLabel) {
        defaultLabel.textContent = originalText;
      } else {
        button.textContent = originalText;
      }
    }, 1600);
  });

  // El drawer y el badge del header se re-renderizan solos en cada cambio
  // de estado del carrito (agregar/cambiar cantidad/quitar/vaciar),
  // incluido el que dispare el futuro checkout -- no hace falta que cada
  // caller se acuerde de llamar a renderCartDrawer/updateHeaderCartUI.
  window.HILO.cart.subscribe(function () {
    renderCartDrawer();
    updateHeaderCartUI();
  });

  // Estado inicial del header y del drawer a partir de lo que haya
  // sobrevivido en localStorage (o del carrito vacío en memoria).
  updateHeaderCartUI();
  renderCartDrawer();

  /* ---------------- Newsletter ---------------- */
  var newsletterForm = doc.querySelector("[data-newsletter-form]");

  if (newsletterForm) {
    var emailInput = newsletterForm.querySelector("input[type='email']");
    var message = newsletterForm.querySelector("[data-form-message]");

    newsletterForm.addEventListener("submit", function (event) {
      event.preventDefault();
      emailInput.setAttribute("data-touched", "true");

      if (!emailInput.checkValidity()) {
        message.textContent = "Ingresá un email válido para suscribirte.";
        message.className = "form-message form-message--error";
        emailInput.focus();
        return;
      }

      message.textContent = "¡Listo! Te vamos a escribir a " + emailInput.value + ".";
      message.className = "form-message form-message--success";
      newsletterForm.reset();
      emailInput.removeAttribute("data-touched");
    });
  }

  /* ---------------- Año dinámico del footer ---------------- */
  var yearEl = doc.querySelector("[data-current-year]");
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }
})();
