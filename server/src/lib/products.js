"use strict";

// Lectura de solo-consulta de `products`/`product_images` para el checkout
// (POST /api/orders necesita el precio, stock y flag de precio_es_prueba
// VIGENTES en el momento de confirmar, nunca los que mande el cliente). Este
// modulo SOLO hace SELECT -- nunca INSERT/UPDATE/DELETE sobre `products` ni
// `product_images`: esas tablas siguen siendo territorio de lyon/door via
// los scripts de db/scripts/ (scraping, seed de precios, carga de
// imagenes). Ver el comentario de lib/db.js.

const db = require("./db");

/**
 * Busca un producto activo por su identificador ESTABLE
 * (`slug_o_id_origen`, ej. "daily_12") -- el mismo valor que el carrito usa
 * como `data-product-id` (ver CLAUDE.md, contrato del carrito) y que el
 * export de catalogo expone como `id`. Deliberadamente NO es el rowid
 * entero `products.id` -- ese nunca sale de la base ni el front lo conoce.
 *
 * Hoy solo existe un proveedor ("lyondor"), asi que no se filtra por
 * `proveedor` -- si en el futuro se suma un segundo proveedor cuyo slug
 * pudiera colisionar, esta funcion tiene que actualizarse para desambiguar
 * (el carrito tendria que empezar a mandar el proveedor tambien).
 *
 * Devuelve null si no existe o no esta activo -- un producto inactivo/
 * borrado no se puede comprar, aunque siga en el historial de pedidos
 * viejos via el snapshot de order_items (que no tiene FK a esta tabla, ver
 * migracion 0006).
 */
function findActiveProductBySlug(slug) {
  const row = db
    .prepare(
      `SELECT id, slug_o_id_origen, nombre, precio_centavos, precio_es_prueba, stock
         FROM products
        WHERE slug_o_id_origen = ? AND activo = 1
        ORDER BY id
        LIMIT 1`
    )
    .get(slug);
  return row || null;
}

/**
 * Primera imagen (position mas baja) de un producto, para el
 * `image_snapshot` de order_items -- mismo criterio que
 * `imagen_principal` del export de catalogo (db/scripts/export_catalogo_con_precios.py).
 */
function findPrimaryImagePath(productId) {
  const row = db
    .prepare(
      `SELECT path FROM product_images WHERE product_id = ? ORDER BY position LIMIT 1`
    )
    .get(productId);
  return row ? row.path : null;
}

module.exports = { findActiveProductBySlug, findPrimaryImagePath };
