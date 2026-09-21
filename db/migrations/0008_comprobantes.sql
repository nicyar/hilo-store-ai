-- 0008_comprobantes.sql
-- Comprobantes de transferencia (subida manual del cliente + revisión del
-- negocio). Ver CLAUDE.md, sección "Checkout: confirmación de
-- transferencias por comprobante", y server/src/routes/orders.js /
-- server/src/routes/adminOrders.js para el flujo completo. Esta migración
-- NO reescribe 0001-0007 -- agrega dos columnas a `orders` y amplía el
-- CHECK de `payment_status` para sumar el estado intermedio
-- 'pendiente_revision'. `order_items` no se toca.
--
-- Ciclo de vida de `payment_status` para transferencia (mercadopago sigue
-- usando el mismo mapeo que ya tenía, ver mercadopagoWebhook.js):
--   'pendiente'            -- pedido creado, todavía sin comprobante.
--   'pendiente_revision'   -- el cliente subió un comprobante
--                              (POST /api/orders/:public_code/comprobante),
--                              esperando que el negocio lo revise a mano.
--   'aprobado'              -- el negocio confirmó el comprobante
--                              (POST /api/admin/orders/:public_code/confirm)
--                              -- reusa el mismo valor que ya usaba
--                              mercadopago para "pago acreditado", no se
--                              inventa un 'paid' nuevo para no divergir dos
--                              vocabularios distintos en la misma columna.
--   'rechazado'              -- el negocio rechazó el comprobante
--                              (POST /api/admin/orders/:public_code/reject)
--                              -- valor que YA existía en el CHECK de 0006
--                              (se usaba para pagos de Mercado Pago
--                              rechazados), se reutiliza tal cual.
--   'cancelado'              -- sin cambios, ya existía.
--
-- SQLite no permite modificar un CHECK ya definido en una columna con
-- ALTER TABLE -- hace falta el procedimiento de "recrear la tabla" que
-- recomienda la documentación oficial
-- (https://www.sqlite.org/lang_altertable.html#otheralter): crear la tabla
-- nueva con el esquema final, copiar los datos, borrar la vieja y
-- renombrar, todo dentro de una única transacción explícita para que nunca
-- pueda quedar la base a mitad de camino (sin `orders` o con dos copias).
-- `order_items.order_id REFERENCES orders (id)` sigue apuntando al mismo
-- nombre de tabla una vez terminado el rename, así que no hace falta
-- recrear ni tocar `order_items`.
--
-- PRAGMA foreign_keys=OFF tiene que ejecutarse FUERA de cualquier
-- transacción (no-op si se llama dentro de un BEGIN, ver documentación de
-- SQLite) -- por eso va antes del BEGIN TRANSACTION explícito, y
-- foreign_keys=ON se restaura después del COMMIT.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE orders_new (
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
  -- Único cambio real de esquema de esta migración: se suma
  -- 'pendiente_revision' al CHECK, en orden lógico entre 'pendiente' y
  -- 'aprobado' (ver ciclo de vida documentado arriba).
  payment_status      TEXT NOT NULL DEFAULT 'pendiente'
                         CHECK (payment_status IN ('pendiente', 'pendiente_revision', 'aprobado', 'rechazado', 'cancelado')),

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

  -- Comprobante de transferencia (nuevo en esta migración).
  -- `comprobante_path`: nombre de archivo generado por el SERVER dentro de
  -- uploads/comprobantes/ (ej. "42_3f9c2b1a-....jpg") -- nunca el
  -- `originalname` que manda el cliente (evita path traversal, ver
  -- server/src/routes/orders.js). Ruta relativa a ese directorio, no
  -- absoluta del filesystem. NULL hasta que el cliente sube algo, y se
  -- mantiene NULL para siempre en pedidos con payment_method='mercadopago'
  -- (ese método no usa comprobante).
  -- `comprobante_uploaded_at`: timestamp de la última subida exitosa (se
  -- pisa si el cliente vuelve a subir un comprobante nuevo, ver guardrail
  -- de "no bloquear un pedido rechazado sin forma de corregirlo" en
  -- server/src/routes/orders.js).
  comprobante_path         TEXT,
  comprobante_uploaded_at  TEXT,

  idempotency_key     TEXT NOT NULL UNIQUE,

  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),

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

INSERT INTO orders_new (
  id, public_code, user_id,
  contact_name, contact_email, contact_phone, contact_dni,
  status, payment_method, payment_status,
  shipping_method, calle, numero, piso_depto, barrio, localidad, provincia, cp, pais, notas,
  subtotal_cents, shipping_cents, total_cents, currency,
  mp_preference_id, mp_payment_id,
  comprobante_path, comprobante_uploaded_at,
  idempotency_key,
  created_at, updated_at
)
SELECT
  id, public_code, user_id,
  contact_name, contact_email, contact_phone, contact_dni,
  status, payment_method, payment_status,
  shipping_method, calle, numero, piso_depto, barrio, localidad, provincia, cp, pais, notas,
  subtotal_cents, shipping_cents, total_cents, currency,
  mp_preference_id, mp_payment_id,
  NULL, NULL,
  idempotency_key,
  created_at, updated_at
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_public_code ON orders (public_code);
-- Reutilizado por GET /api/admin/orders/pending (WHERE payment_status =
-- 'pendiente_revision') además de su uso original.
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders (payment_status);

COMMIT;

PRAGMA foreign_keys = ON;
