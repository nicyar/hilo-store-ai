-- 0003_password_reset.sql
-- Recuperación de contraseña ("olvidé mi contraseña"). Se suma a la misma
-- etapa de auth (0001/0002 ya existentes) -- no es una etapa aparte: hoy
-- email/contraseña es el único método realmente funcional (WebAuthn
-- requiere una passkey ya registrada de antes, Apple Sign-In es un stub
-- 501), así que sin esto un usuario que se olvida la contraseña queda sin
-- forma de recuperar su cuenta.
--
-- Esta migración NO reescribe 0001 ni 0002, ni toca `products`,
-- `product_images`, `product_variants`, `users`, `sessions` ni
-- `webauthn_credentials` -- solo agrega una tabla nueva. La aplica el mismo
-- runner genérico db/scripts/run_migrations.py.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- password_reset_tokens
-- ---------------------------------------------------------------------------
-- Mismo criterio que `sessions` (0002) para el token: el valor real que
-- viaja en el link del email lo genera el server con
-- crypto.randomBytes(32).toString('base64url') (alta entropía, no
-- adivinable) y NUNCA se guarda en texto plano -- acá solo se persiste
-- `token_hash` (sha256 del token). Si alguien lee la base no puede
-- reconstruir un link de reset válido a partir de esta tabla.
--
-- `expires_at`: ventana corta (45 minutos desde la creación), bastante más
-- corta que una sesión (7 días) -- un link de reset de contraseña vive poco
-- a propósito, para acotar la ventana de uso si el email quedó interceptado
-- o en una bandeja de entrada vieja/compartida.
--
-- `used_at`: nullable, hace que el token sea de un solo uso. Se completa
-- cuando el token se consume con éxito en POST /api/auth/password/reset;
-- si ya tiene `used_at`, ese token nunca vuelve a servir aunque todavía no
-- haya expirado (evita reusar un link viejo, por ejemplo si fue reenviado
-- sin querer o quedó guardado en algún lado).
--
-- ON DELETE CASCADE: si se borra el usuario, sus tokens de reset pendientes
-- no deberían quedar huérfanos.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
  ON password_reset_tokens (expires_at);
