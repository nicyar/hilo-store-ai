-- 0006_orders.sql
-- Pedidos (checkout). Ver CLAUDE.md, seccion "Checkout: pedidos y pagos"
-- para el contexto completo de la etapa. Esta migracion NO reescribe
-- 0001-0005 ni ninguna tabla existente -- solo agrega `orders` y
-- `order_items`.
--
-- La aplica el mismo runner generico db/scripts/run_migrations.py.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
-- Un pedido confirmado desde el checkout. `user_id` NOT NULL porque el
-- checkout exige sesion iniciada (ver requireSession en
-- server/src/routes/orders.js) -- no existe "pedido de invitado" en esta
-- etapa.
--
-- `public_code` ("HILO-000123") es el UNICO identificador de pedido que se
-- expone en URLs, emails o pantallas -- nunca el rowid (`id`) crudo. Se
-- genera a partir de `id` (padding a 6 digitos) dentro de la misma
-- transaccion que crea la fila (ver lib/orders.js, createOrderWithItems):
-- se inserta la fila para obtener el rowid via AUTOINCREMENT, y se hace un
-- UPDATE inmediato con el public_code ya calculado, todo dentro de
-- db.transaction() para que nunca quede una fila sin public_code visible
-- desde otra conexion.
--
-- Snapshot de contacto (contact_name/email/phone/dni): el checkout pide
-- estos datos en el propio formulario y se guardan tal como se recibieron
-- en ESE pedido, en vez de leerlos de `users` en el momento de mostrar el
-- pedido. Dos motivos: (1) `users.email` puede ser NULL (login por telefono
-- o Google sin email verificado, ver migracion 0005) asi que no hay de
-- donde sacar un contacto de compra confiable solo de `users`; (2) aunque
-- lo hubiera, un pedido es un documento historico -- si el usuario cambia
-- su email despues, el pedido viejo tiene que seguir mostrando el contacto
-- que se uso EN ESE MOMENTO para coordinar la entrega, no el actual.
-- `contact_dni` es NOT NULL por pedido explicito del usuario (obligatorio
-- para todo pedido, confirmado 2026-09-17); nombre/email/telefono tambien
-- son NOT NULL porque el checkout no puede completarse sin ellos (son los
-- datos minimos para poder entregar/facturar).
--
-- Direccion desnormalizada (calle...notas): mismo criterio de snapshot que
-- el contacto -- un pedido con envio conserva la direccion tal como se usó
-- para despacharlo, aunque el usuario la borre o cambie despues en su
-- perfil (que hoy ni siquiera existe como entidad separada). Todas estas
-- columnas son NULL cuando `shipping_method = 'retiro'` (no hay adonde
-- enviar) -- el CHECK de abajo hace cumplir esa regla en el esquema, no
-- solo en el codigo de la ruta.
--
-- `payment_method`/`payment_status`/`status`/`shipping_method` son TEXT +
-- CHECK porque SQLite no tiene tipo enum nativo.
--   * `status`: ciclo de vida general del pedido en esta etapa (todavia sin
--     logistica de fulfillment real). 'pendiente' al crearse, 'confirmado'
--     cuando el pago quedo acreditado (transferencia verificada a mano por
--     el negocio, o webhook de Mercado Pago aprobado), 'cancelado' si se
--     cae.
--   * `payment_status`: estado puntual del cobro, distinto de `status`
--     porque un pedido puede estar 'pendiente' de pago (recien creado, sin
--     acreditar) sin que el pedido en si este cancelado. Valores:
--     'pendiente' | 'aprobado' | 'rechazado' | 'cancelado'.
--
-- `subtotal_cents`/`shipping_cents`/`total_cents`: SIEMPRE INTEGER
-- (centavos), nunca floats -- guardrail no negociable del proyecto para
-- evitar errores de redondeo con dinero real. Se calculan 100% server-side
-- en el momento de crear el pedido (leyendo `products` y `shipping_rates`),
-- nunca se toma un precio/total que mande el cliente -- ver
-- server/src/routes/orders.js.
--
-- `mp_preference_id`/`mp_payment_id`: nullable porque existen recien cuando
-- `payment_method = 'mercadopago'` Y se llamo a
-- POST /api/orders/:id/pay/mercadopago. El pedido se crea SIEMPRE primero
-- con estos dos en NULL y `payment_status = 'pendiente'`, antes de hablar
-- con Mercado Pago -- si MP esta caido o sin configurar, el pedido igual
-- queda registrado. `mp_payment_id` es UNIQUE (cuando no es NULL; SQLite
-- trata NULL como "no comparable a si mismo" en un UNIQUE, asi que muchas
-- filas en NULL conviven bien) para que el webhook sea idempotente por
-- pago: si ya se proceso ese `mp_payment_id`, no se reprocesa (ver
-- server/src/routes/mercadopagoWebhook.js).
--
-- `idempotency_key` UNIQUE: el front genera una key nueva por intento de
-- click en "Confirmar" (no por sesion completa) y la manda en el body de
-- POST /api/orders. Si el mismo key llega dos veces (doble click, reintento
-- de red), el server devuelve el pedido ya creado en vez de crear uno
-- nuevo -- protege contra pedidos duplicados sin necesitar deduplicar en
-- el cliente.
CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_code         TEXT NOT NULL UNIQUE,
  user_id             INTEGER NOT NULL REFERENCES users (id),

  contact_name        TEXT NOT NULL,
  contact_email       TEXT NOT NULL,
  contact_phone       TEXT NOT NULL,
  contact_dni         TEXT NOT NULL,

  status              TEXT NOT NULL DEFAULT 'pendiente'
                         CHECK (status IN ('pendiente', 'confirmado', 'cancelado')),
  payment_method      TEXT NOT NULL
                         CHECK (payment_method IN ('transferencia', 'mercadopago')),
  payment_status      TEXT NOT NULL DEFAULT 'pendiente'
                         CHECK (payment_status IN ('pendiente', 'aprobado', 'rechazado', 'cancelado')),

  shipping_method     TEXT NOT NULL CHECK (shipping_method IN ('retiro', 'envio')),
  calle               TEXT,
  numero              TEXT,
  piso_depto          TEXT,
  barrio              TEXT,
  localidad           TEXT,
  provincia           TEXT,
  cp                  TEXT,
  pais                TEXT NOT NULL DEFAULT 'AR',
  notas               TEXT,

  subtotal_cents      INTEGER NOT NULL,
  shipping_cents      INTEGER NOT NULL,
  total_cents         INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'ARS',

  mp_preference_id    TEXT,
  mp_payment_id       TEXT UNIQUE,

  idempotency_key     TEXT NOT NULL UNIQUE,

  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),

  -- Integridad de la direccion desnormalizada: si es retiro, no puede haber
  -- datos de envio cargados (evita un pedido "retiro" con una direccion
  -- vieja/inconsistente colgando); si es envio, los campos minimos para
  -- poder despachar (calle, numero, localidad, provincia, cp) son
  -- obligatorios -- piso_depto/barrio/notas siguen siendo opcionales porque
  -- no todas las direcciones los tienen. Table-level CHECK: tiene que ir
  -- DESPUES de todas las columnas (SQLite no admite mezclar una
  -- column-constraint como esta con mas definiciones de columna despues).
  CHECK (
    (shipping_method = 'retiro'
      AND calle IS NULL AND numero IS NULL AND piso_depto IS NULL
      AND barrio IS NULL AND localidad IS NULL AND provincia IS NULL
      AND cp IS NULL AND notas IS NULL)
    OR
    (shipping_method = 'envio'
      AND calle IS NOT NULL AND numero IS NOT NULL
      AND localidad IS NOT NULL AND provincia IS NOT NULL AND cp IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_public_code ON orders (public_code);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders (payment_status);

-- ---------------------------------------------------------------------------
-- order_items
-- ---------------------------------------------------------------------------
-- Un renglon por producto dentro de un pedido, congelado ("snapshot") al
-- momento de la compra.
--
-- `product_id` es TEXT y a proposito NO tiene FK a `products`: no guarda el
-- rowid entero de `products.id`, guarda `products.slug_o_id_origen` (ej.
-- "daily_12") -- el mismo identificador estable que ya usa el carrito como
-- `data-product-id` (ver CLAUDE.md, "Carrito: vanilla JS..."). Ademas de
-- mantener el mismo contrato que el carrito, la ausencia de FK es
-- deliberada: si mañana se borra o desactiva un producto del catalogo, el
-- historial de ventas (este pedido) no puede romperse ni perder filas por
-- un ON DELETE CASCADE -- el pedido ya vendido existio independientemente
-- de que el producto siga existiendo hoy.
--
-- `name_snapshot`/`unit_price_cents`/`image_snapshot`: copia de
-- `products.nombre` / `products.precio_centavos` / la primera imagen de
-- `product_images` en el momento de confirmar el pedido -- si el nombre,
-- precio o imagen del producto cambian despues en el catalogo, este pedido
-- sigue mostrando lo que el cliente efectivamente compro y pago.
--
-- `precio_era_prueba`: copia de `products.precio_es_prueba` al momento de
-- la compra (ver migracion 0004). `precio_es_prueba` en la fila de
-- `products` NO bloquea la compra (bloquearia el 100% del catalogo hoy,
-- que todavia no tiene precios reales) -- pero sin este campo, dentro de
-- unos meses cuando ya haya precios reales cargados no habria forma de
-- distinguir que pedidos viejos se tomaron contra un precio de prueba
-- (provisorio, no representativo de lo que el negocio realmente cobra) de
-- los que se tomaron contra un precio real.
--
-- `line_total_cents` = unit_price_cents * quantity, calculado y guardado
-- server-side en el momento de crear el pedido (no se recalcula al leer)
-- para que el total historico del pedido no dependa de que la aritmetica
-- se repita igual en cada lectura futura.
CREATE TABLE IF NOT EXISTS order_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id            INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id          TEXT NOT NULL,
  name_snapshot       TEXT NOT NULL,
  unit_price_cents    INTEGER NOT NULL,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  line_total_cents    INTEGER NOT NULL,
  image_snapshot      TEXT,
  precio_era_prueba   INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items (product_id);
