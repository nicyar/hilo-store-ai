-- 0004_precio_prueba_flag.sql
-- Flag para distinguir precios de PRUEBA (temporales) de precios reales del
-- negocio en `products.precio_centavos`.
--
-- Contexto: el carrito de compras (Valentina, vanilla JS sobre index.html)
-- está bloqueado porque los 7 productos reales tienen precio_centavos NULL
-- -- el negocio todavía no cargó precios reales. Para destrabar el frontend
-- se cargan precios de prueba con db/scripts/seed_precios_prueba.py, pero
-- necesitamos una forma PROGRAMÁTICA (no solo un comentario en el código) de
-- saber cuáles filas son de prueba y hay que reemplazar cuando lleguen los
-- precios reales.
--
-- PRECIO DE PRUEBA -- no es un precio real del negocio, ver
-- precio_es_prueba = 1. Reemplazar corriendo el mismo script
-- (seed_precios_prueba.py) con datos reales, o actualizando la tabla
-- directamente, cuando el usuario provea la lista de precios definitiva.
--
-- `precio_es_prueba`: INTEGER/boolean, default 0 (no-prueba) para no marcar
-- como "prueba" ningún precio que ya exista o se cargue de otra forma
-- (ej. carga manual futura). El script de siembra es el único que pone este
-- flag en 1, y solo en filas donde precio_centavos es NULL. Una vez que el
-- usuario reemplaza el precio real (a mano o corriendo el script con datos
-- reales), pasa a 0.
--
-- Esta migración NO reescribe 0001, ni toca `product_images`,
-- `product_variants`, `users`, `sessions`, `webauthn_credentials` ni
-- `password_reset_tokens` -- solo agrega una columna a `products`. La
-- aplica el mismo runner genérico db/scripts/run_migrations.py.

PRAGMA foreign_keys = ON;

ALTER TABLE products
  ADD COLUMN precio_es_prueba INTEGER NOT NULL DEFAULT 0;
