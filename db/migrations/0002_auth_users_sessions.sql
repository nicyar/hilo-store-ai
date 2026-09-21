-- 0002_auth_users_sessions.sql
-- Esquema de autenticación (usuarios, passkeys/WebAuthn, sesiones y el
-- futuro de "Iniciar sesión con Apple"). Vive en la misma base SQLite que
-- el catálogo (db/lyondor.sqlite3) pero es un dominio totalmente aparte:
-- esta migración no toca `products`, `product_images` ni `product_variants`
-- (de la 0001 de Lyon) ni las reescribe -- solo agrega tablas nuevas.
--
-- La aplica el mismo runner genérico db/scripts/run_migrations.py (no es
-- específico del catálogo: solo ejecuta cualquier .sql nuevo en orden y lo
-- registra en schema_migrations), así que no hace falta un runner de Node
-- aparte para las migraciones.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- Un usuario del sitio (comprador). `email` es la identidad primaria de
-- login hoy (password y, más adelante, Apple Sign-In se cuelgan de la misma
-- fila via user_id).
--
-- `password_hash` es NULLABLE a propósito: un usuario que se registra por
-- passkey directamente (o el día de mañana solo por Apple) puede no tener
-- nunca una contraseña. Nunca se guarda la contraseña en texto plano -- acá
-- va el hash (bcrypt) generado por el servidor Node, jamás el valor crudo.
--
-- El email se normaliza a minúsculas antes de insertar/comparar (lo hace la
-- capa de la app, no SQLite) y por eso el UNIQUE es sobre la columna tal
-- cual se guarda.
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- webauthn_credentials
-- ---------------------------------------------------------------------------
-- Passkeys reales (WebAuthn). Un usuario puede tener más de una credencial
-- (celular, laptop, llave física), por eso es una tabla 1-a-N y no columnas
-- sueltas en `users`.
--
-- `credential_id` es el identificador que devuelve el autenticador
-- (base64url, tal como lo entrega @simplewebauthn/server) -- es único
-- globalmente (no por usuario) porque así lo exige el estándar WebAuthn:
-- sirve para encontrar la fila sin conocer de antemano el user_id, que es
-- justo lo que hace falta en el paso de login (el usuario todavía no probó
-- quién es).
--
-- `public_key` se guarda tal como la entrega la librería (buffer en
-- base64url) para no tener que re-derivarla.
--
-- `counter` es el contador anti-clonado de WebAuthn: cada vez que se firma
-- un login, el autenticador manda un contador que debe ser mayor al
-- guardado. Si no avanza, alguien clonó el autenticador y el login se
-- rechaza (esto se implementa en el server, esta columna solo persiste el
-- último valor visto).
--
-- `device_info` es opcional y solo para mostrarle al usuario "tenés una
-- passkey registrada desde Chrome en Windows" -- no se usa para lógica.
--
-- ON DELETE CASCADE: si se borra el usuario, sus passkeys no deberían
-- quedar huérfanas.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL UNIQUE,
  public_key     TEXT NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0,
  device_info    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id
  ON webauthn_credentials (user_id);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
-- Sesiones server-side. La cookie `hilo_session` que recibe el browser
-- contiene un token opaco de alta entropía generado con crypto.randomBytes;
-- acá NUNCA se guarda ese token en texto plano, solo `token_hash`
-- (sha256 del token) -- así, si alguien lee la base, no puede reconstruir
-- cookies válidas ni robar sesiones activas. El server, al validar, hashea
-- la cookie recibida y busca por token_hash.
--
-- `expires_at` en vez de confiar solo en Max-Age de la cookie: el server
-- valida expiración server-side en cada request a /api/auth/session, no
-- confía en que el browser haya borrado la cookie sola.
--
-- user_agent / ip son opcionales, solo informativos (para que un usuario
-- pueda eventualmente ver "sesiones activas" y cerrarlas); no son parte de
-- la validación de la sesión.
--
-- Logout = DELETE (o marcar revocada) de la fila, no solo borrar la cookie
-- del lado del browser -- así un token robado antes del logout deja de
-- servir inmediatamente.
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- apple_identities (preparada para más adelante, vacía por ahora)
-- ---------------------------------------------------------------------------
-- Hoy no hay cuenta de Apple Developer real: el endpoint POST /api/auth/apple
-- es un stub que siempre responde 501. Esta tabla se crea igual, ahora, para
-- que cuando se active de verdad (con Team ID / Services ID / Key ID / .p8 /
-- dominio verificado) alcance con escribir el handler -- no haga falta otra
-- migración ni tocar el resto del esquema de auth.
--
-- `apple_sub` es el identificador estable que manda Apple en el id_token
-- (claim "sub"), único por usuario de Apple y por Services ID -- es la
-- clave natural para relacionar una cuenta de Apple con un `user_id` local,
-- igual que credential_id en webauthn_credentials.
--
-- `email` se guarda aparte (no solo via users.email) porque Apple puede
-- mandar un "relay email" distinto al real y puede no reenviarlo en logins
-- subsiguientes -- conviene registrar el que vino la primera vez sin
-- depender de que siempre esté disponible.
CREATE TABLE IF NOT EXISTS apple_identities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  apple_sub   TEXT NOT NULL UNIQUE,
  email       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_apple_identities_user_id ON apple_identities (user_id);
