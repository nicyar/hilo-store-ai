-- 0001_init.sql
-- Esquema inicial para el catálogo de productos (medias/panties).
-- Motor: SQLite (ver db/README implícito en el mensaje de carga; justificación
-- completa en el reporte de la tarea). No hay servidor de base de datos
-- corriendo todavía en el proyecto, así que un archivo .sqlite3 versionable
-- y sin infraestructura es lo más simple para esta etapa de prototipo.

PRAGMA foreign_keys = ON;

-- Registro de qué migraciones ya se aplicaron, para que el runner
-- (db/scripts/run_migrations.py) sea idempotente.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
-- Un producto = una página de detalle en el sitio del proveedor
-- (ej. https://www.lyondor.com.ar/daily_12.php).
--
-- `slug_o_id_origen` es la clave natural del scraper (ej. "daily_12") y es
-- la que usa el ETL de carga para hacer upsert: volver a correr el scraper
-- y el load no debe duplicar productos, solo actualizar sus datos.
--
-- `proveedor` acompaña a `slug_o_id_origen` en el UNIQUE en lugar de dejar
-- slug_o_id_origen solo como UNIQUE global: hoy solo hay un proveedor
-- (lyondor), pero si mañana se suma otro proveedor cuyo scraper también
-- genere ids tipo "12" o repita convención de slugs, no queremos que
-- colisionen entre sí. No es un campo inventado: es la fuente real del dato.
--
-- `articulo` es el código de artículo del proveedor (ej. "12", "700").
-- Va en su propia columna (no solo embebido en el nombre) porque es el
-- identificador de negocio que usa el proveedor y por el que probablemente
-- se busque/filtre; por eso tiene su propio índice.
--
-- precio_centavos / stock: nullable a propósito. Todavía no hay esa
-- información (no vino del scraping). Se guardan en centavos (entero) para
-- evitar los problemas de redondeo de floats en dinero, siguiendo la
-- convención habitual. Cuando haya datos reales de precio/stock sin
-- variantes, se completan estas columnas sin romper nada existente.
--
-- activo: soft-flag para poder ocultar un producto sin borrarlo (ej. si el
-- proveedor lo discontinúa). Default 1 porque todo lo que llega desde un
-- scrape exitoso está activo por definición.
CREATE TABLE IF NOT EXISTS products (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  proveedor           TEXT NOT NULL DEFAULT 'lyondor',
  slug_o_id_origen    TEXT NOT NULL,
  articulo            TEXT NOT NULL,
  nombre              TEXT NOT NULL,
  descripcion         TEXT,
  url_origen          TEXT,
  precio_centavos     INTEGER,
  stock               INTEGER,
  activo              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (proveedor, slug_o_id_origen)
);

CREATE INDEX IF NOT EXISTS idx_products_articulo ON products (articulo);

-- ---------------------------------------------------------------------------
-- product_images
-- ---------------------------------------------------------------------------
-- Relación 1-a-N: un producto tiene varias imágenes y el ORDEN importa
-- (foto 1, foto 2, cuadro de talles suele ir último). Por eso no alcanza con
-- una columna de texto separada por comas ni con JSON embebido en products:
-- modelarlo como tabla aparte permite mantener el orden explícito en
-- `position`, tener una fila por imagen (más fácil de mantener/actualizar
-- que reescribir un blob), y borrar en cascada si se borra el producto.
--
-- `path` guarda la ruta relativa al root del proyecto tal como está en el
-- JSON de Door (ej. "uploads/37eaee...jpg"), que es también como la
-- referencia el front actual (rutas relativas desde index.html).
--
-- UNIQUE (product_id, position): no puede haber dos imágenes del mismo
-- producto ocupando el mismo lugar en el orden.
CREATE TABLE IF NOT EXISTS product_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, position)
);

CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON product_images (product_id);

-- ---------------------------------------------------------------------------
-- product_variants (preparada para más adelante, vacía por ahora)
-- ---------------------------------------------------------------------------
-- Todavía no hay datos reales de variantes (talle x color) ni de su
-- precio/stock individual -- el scraping actual solo trae "Talle único" o
-- "Talles 1 al 5" como texto libre dentro de `descripcion`. En vez de
-- inventar esa estructura, se deja la tabla creada pero sin filas: cuando
-- Door traiga variantes reales con su propio precio/stock por combinación,
-- se cargan acá sin tocar `products` ni `product_images`.
CREATE TABLE IF NOT EXISTS product_variants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  talle             TEXT,
  color             TEXT,
  sku               TEXT,
  precio_centavos   INTEGER,
  stock             INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, talle, color)
);
