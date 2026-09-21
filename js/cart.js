/*
  HILO Store — estado del carrito.

  Extraído de js/script.js (ver CLAUDE.md → "Carrito: vanilla JS,
  cliente-only, independiente de la sesión"). Antes esta lógica vivía en
  closures privados dentro de la IIFE de script.js; el checkout (próxima
  etapa) necesita poder leer y mutar el carrito desde afuera, así que se
  expone acá como window.HILO.cart.

  Se carga ANTES que catalog.js y script.js en index.html — es el único
  dueño del estado del carrito.

  Guardrail del proyecto (grepeable, por lo tanto auditable): nadie fuera
  de este archivo toca localStorage con CART_STORAGE_KEY directamente.
*/
(function () {
  "use strict";

  var CART_STORAGE_KEY = "hilo_cart_v1";
  var MAX_QTY_PER_LINE = 10; // Placeholder: no hay stock real cargado todavía.

  var storageAvailable = true;
  var cart = loadCartFromStorage();
  var subscribers = [];

  /* ---- Persistencia (localStorage con degradación a memoria) ---- */
  function isValidCartItem(item) {
    return (
      item &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.price === "number" &&
      isFinite(item.price) &&
      item.price >= 0 &&
      typeof item.quantity === "number" &&
      isFinite(item.quantity)
    );
  }

  function loadCartFromStorage() {
    try {
      var raw = window.localStorage.getItem(CART_STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidCartItem).map(function (item) {
        return {
          id: item.id,
          name: item.name,
          price: item.price,
          quantity: Math.min(Math.max(Math.round(item.quantity), 1), MAX_QTY_PER_LINE),
          image: typeof item.image === "string" ? item.image : null,
        };
      });
    } catch (err) {
      storageAvailable = false;
      console.warn(
        "HILO Store: no se pudo leer el carrito guardado (localStorage no disponible). Se arranca con un carrito vacío en memoria.",
        err
      );
      return [];
    }
  }

  function persistCart() {
    if (!storageAvailable) return;
    try {
      window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch (err) {
      storageAvailable = false;
      console.warn(
        "HILO Store: no se pudo guardar el carrito (localStorage no disponible o lleno). El carrito sigue funcionando, pero no va a sobrevivir a un reload.",
        err
      );
    }
  }

  /* ---- Suscripción: sincroniza drawer, badge del header y, más adelante,
     el checkout. Cada mutación (add/setQuantity/remove/clear) notifica. ---- */
  function notify() {
    subscribers.forEach(function (fn) {
      try {
        fn();
      } catch (err) {
        console.error("HILO Store: un suscriptor de window.HILO.cart tiró un error.", err);
      }
    });
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return function unsubscribe() {};
    subscribers.push(fn);
    return function unsubscribe() {
      subscribers = subscribers.filter(function (sub) {
        return sub !== fn;
      });
    };
  }

  /* ---- Lectura ---- */
  function findCartItem(id) {
    for (var i = 0; i < cart.length; i++) {
      if (cart[i].id === id) return cart[i];
    }
    return null;
  }

  function getItems() {
    // Copia superficial: nunca la referencia interna, para que nadie
    // pueda mutar el carrito por afuera sin pasar por add/setQuantity/
    // remove/clear (y así saltarse la persistencia y las notificaciones).
    return cart.map(function (item) {
      return {
        id: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        image: item.image,
      };
    });
  }

  function getCount() {
    return cart.reduce(function (sum, item) {
      return sum + item.quantity;
    }, 0);
  }

  function getSubtotal() {
    return cart.reduce(function (sum, item) {
      return sum + item.price * item.quantity;
    }, 0);
  }

  // No forma parte de la interfaz que pidió el plan de checkout, pero
  // script.js necesita saber si el aviso de "no se pudo guardar tu
  // carrito" corresponde sin duplicar la detección de localStorage acá
  // (eso violaría el guardrail de arriba).
  function isStorageAvailable() {
    return storageAvailable;
  }

  /* ---- Escritura ---- */
  function add(product) {
    if (!product || typeof product.id !== "string" || !product.id) return;
    if (typeof product.price !== "number" || !isFinite(product.price) || product.price < 0) return;

    var existing = findCartItem(product.id);
    if (existing) {
      existing.quantity = Math.min(existing.quantity + 1, MAX_QTY_PER_LINE);
    } else {
      cart.push({
        id: product.id,
        name: product.name || "Producto",
        price: product.price,
        quantity: 1,
        image: product.image || null,
      });
    }
    persistCart();
    notify();
  }

  // Setter absoluto (no delta): clampeado a [1, MAX_QTY_PER_LINE], mismo
  // criterio que ya se aplicaba al leer de localStorage. Si el pedido de
  // cantidad queda igual a la actual (ej. un caller intentando pasarse del
  // máximo), no persiste ni notifica -- evita renders/anuncios de "cambio"
  // cuando en realidad no cambió nada.
  function setQuantity(id, quantity) {
    var item = findCartItem(id);
    if (!item) return;
    var clamped = Math.min(Math.max(Math.round(quantity), 1), MAX_QTY_PER_LINE);
    if (clamped === item.quantity) return;
    item.quantity = clamped;
    persistCart();
    notify();
  }

  function remove(id) {
    var existing = findCartItem(id);
    if (!existing) return;
    cart = cart.filter(function (item) {
      return item.id !== id;
    });
    persistCart();
    notify();
  }

  function clear() {
    if (!cart.length) return;
    cart = [];
    persistCart();
    notify();
  }

  window.HILO = window.HILO || {};
  window.HILO.cart = {
    getItems: getItems,
    getCount: getCount,
    getSubtotal: getSubtotal,
    add: add,
    setQuantity: setQuantity,
    remove: remove,
    clear: clear,
    subscribe: subscribe,
    isStorageAvailable: isStorageAvailable,
  };
})();
