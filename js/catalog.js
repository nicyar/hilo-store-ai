/*
  HILO Store — catálogo dinámico de la sección #destacados.

  Genera las product-cards en el cliente a partir de
  data/catalogo_con_precios.json (export regenerado por
  db/scripts/export_catalogo_con_precios.py, ver CLAUDE.md → "Catálogo y
  precios") en vez de tenerlas escritas a mano en index.html. La
  estructura/clases de cada card son las mismas que ya definió nico en
  css/styles.css — este módulo solo cambia CÓMO se genera el HTML, no el
  diseño.

  Contrato que expone hacia el carrito (js/script.js): data-product-id,
  data-product-name, data-product-price (solo si hay precio),
  data-product-image y, cuando no hay precio, data-price-unavailable="true"
  + el atributo nativo `disabled` en el botón (no solo una clase visual —
  así el botón es inaccesible por teclado/lector de pantalla incluso si
  este script fallara en algún punto). js/script.js no sabe ni le importa
  que las cards se generen acá: sigue leyendo esos mismos atributos.

  Se incluye ANTES que js/script.js en index.html para que la grilla
  tenga contenido (o al menos el estado de carga) lo antes posible. El
  enganche de "Agregar al carrito" en js/script.js usa delegación de
  eventos sobre `document`, así que funciona igual sin importar que estas
  cards se inserten de forma asíncrona después de que ese script corra.
*/
(function () {
  "use strict";

  var CATALOG_URL = "data/catalogo_con_precios.json";
  var grid = document.querySelector(".product-grid");
  if (!grid) return; // Página sin sección de catálogo: no hay nada que hacer.

  // Mismo criterio de formato que formatPrice() en js/script.js (pesos
  // sin decimales, separador de miles es-AR). Se duplica acá a propósito
  // en vez de compartir función: son dos módulos independientes y no vale
  // la pena acoplarlos por 2 líneas de código — si cambia el criterio de
  // formato, hay que tocar los dos (son fáciles de encontrar, ambos se
  // llaman formatPrice).
  function formatPrice(value) {
    var amount = Number(value) || 0;
    return "$" + amount.toLocaleString("es-AR", { maximumFractionDigits: 0 });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  // Un solo <li> que ocupa toda la grilla (ver .product-grid__state en
  // css/styles.css) para loading / error / catálogo vacío — nunca una
  // sección en blanco, y nunca rompe el resto de la página (nav, header,
  // etc. viven fuera de este módulo).
  function renderState(message, isError) {
    var className = "product-grid__state" + (isError ? " product-grid__state--error" : "");
    grid.innerHTML = '<li class="' + className + '" role="status">' + escapeHtml(message) + "</li>";
  }

  // La descripción viene de la DB como texto separado por comas ("Fina,
  // Talle único"). El diseño de nico usa "·" como separador visual —
  // se reformatea acá, no se cambia el dato en el JSON.
  function formatDesc(descripcion) {
    return String(descripcion || "")
      .split(",")
      .map(function (part) { return part.trim(); })
      .filter(Boolean)
      .join(" · ");
  }

  // El JSON no trae texto alternativo dedicado para las fotos (columna
  // que no existe todavía en la DB — mismo tipo de deuda técnica que
  // NOMBRES_PROLIJOS_POR_SLUG, ver CLAUDE.md). No hay forma de inferir
  // color/estilo visual de la foto a partir de nombre+descripcion, así
  // que no se inventa: se arma un alt razonable combinando ambos campos,
  // mejor que repetir el nombre solo pero sin fabricar detalle que no
  // está en la data.
  function buildAlt(producto, descFormateada) {
    var nombre = producto.nombre || "Producto";
    return descFormateada ? nombre + " — " + descFormateada : nombre;
  }

  function buildCardHTML(producto) {
    var image = producto.imagen_principal || (producto.imagenes && producto.imagenes[0]) || "";
    var desc = formatDesc(producto.descripcion);
    var alt = buildAlt(producto, desc);

    // categoria: viene `null` para los 7 productos actuales (la columna
    // todavía no existe en la DB). Se omite el bloque completo en vez de
    // mostrar un <span> vacío o el texto "null" — el día que la columna
    // exista y el export la incluya, alcanza con que deje de mandar null
    // acá para que el badge vuelva a aparecer solo.
    var categoryRowHTML = producto.categoria
      ? '<div class="product-card__category-row"><span class="product-card__category">' +
          escapeHtml(producto.categoria) +
          "</span></div>"
      : "";

    var hasPrice = typeof producto.precio === "number" && isFinite(producto.precio);
    // El asterisco de "precio de prueba" es por-producto: si en el futuro
    // conviven productos con precio real y de prueba, cada card decide
    // por su cuenta si lo muestra (ver también renderCatalog, que decide
    // si aparece la nota al pie de la grilla).
    var showTestFlag = hasPrice && producto.precio_es_prueba === true;

    var priceHTML = hasPrice
      ? '<span class="product-card__price">' +
          formatPrice(producto.precio) +
          (showTestFlag ? '<sup class="product-card__price-flag">*</sup>' : "") +
          "</span>"
      : '<span class="product-card__price--pending">Precio a confirmar</span>';

    // Botón sin precio: `disabled` nativo (no solo una clase/opacity) +
    // data-price-unavailable="true", que es lo que js/script.js espera
    // para tratarlo como no agregable incluso si algo más fallara.
    var buttonAttrs =
      ' type="button" data-add-to-cart' +
      ' data-product-id="' + escapeHtml(producto.id) + '"' +
      ' data-product-name="' + escapeHtml(producto.nombre) + '"' +
      (hasPrice ? ' data-product-price="' + producto.precio + '"' : "") +
      (image ? ' data-product-image="' + escapeHtml(image) + '"' : "") +
      (hasPrice ? "" : ' data-price-unavailable="true" disabled aria-disabled="true"');

    var buttonLabel = hasPrice ? "Agregar al carrito" : "Precio a confirmar";

    return (
      '<li class="product-card">' +
        '<div class="product-card__media">' +
          '<img src="' + escapeHtml(image) + '" alt="' + escapeHtml(alt) + '" loading="lazy" />' +
        "</div>" +
        '<div class="product-card__body">' +
          categoryRowHTML +
          '<h3 class="product-card__name">' + escapeHtml(producto.nombre) + "</h3>" +
          (desc ? '<p class="product-card__desc">' + escapeHtml(desc) + "</p>" : "") +
          '<div class="product-card__price-row">' + priceHTML + "</div>" +
        "</div>" +
        '<div class="product-card__footer">' +
          '<button class="btn btn--outline btn--full"' + buttonAttrs + ">" +
            '<svg class="btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="21" r="1.5"/><circle cx="19" cy="21" r="1.5"/><path d="M2.5 3h2l2.4 12.2a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21 8H6"/></svg>' +
            '<span data-btn-label>' + escapeHtml(buttonLabel) + "</span>" +
          "</button>" +
        "</div>" +
      "</li>"
    );
  }

  // El <p class="product-grid__note"> vive como hermano del <ul>, no
  // adentro (así lo tenía nico a mano) — se agrega/saca del DOM acá en
  // vez de vivir hardcodeado en index.html.
  function syncFootnote(showFootnote) {
    var existing = grid.parentNode.querySelector(".product-grid__note");
    if (showFootnote && !existing) {
      var note = document.createElement("p");
      note.className = "product-grid__note";
      note.textContent = "* Precio de prueba, todavía no confirmado por el negocio — puede cambiar.";
      grid.insertAdjacentElement("afterend", note);
    } else if (!showFootnote && existing) {
      existing.parentNode.removeChild(existing);
    }
  }

  function renderCatalog(productos) {
    if (!productos || !productos.length) {
      syncFootnote(false);
      renderState("Todavía no hay productos cargados.", false);
      return;
    }

    grid.innerHTML = productos.map(buildCardHTML).join("");

    // Nota al pie: solo si al menos un producto la necesita (si algún día
    // todos tienen precio real confirmado, la nota deja de aparecer sola,
    // sin que haga falta tocar este archivo).
    var anyTestPrice = productos.some(function (p) {
      return typeof p.precio === "number" && isFinite(p.precio) && p.precio_es_prueba === true;
    });
    syncFootnote(anyTestPrice);

    // Segunda capa de defensa sobre el estado inicial de los botones
    // (disabled/label ya vienen bien en el HTML de arriba; esto es un
    // respaldo si script.js define esa lógica, no la única fuente de
    // verdad). Ver window.HILO.refreshAddToCartButtons en js/script.js.
    if (window.HILO && typeof window.HILO.refreshAddToCartButtons === "function") {
      window.HILO.refreshAddToCartButtons();
    }
  }

  renderState("Cargando productos…", false);

  fetch(CATALOG_URL)
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(function (data) {
      renderCatalog(data && data.productos);
    })
    .catch(function (err) {
      console.error("HILO Store: no se pudo cargar el catálogo (" + CATALOG_URL + ").", err);
      syncFootnote(false);
      renderState("No pudimos cargar el catálogo. Recargá la página.", true);
    });
})();
