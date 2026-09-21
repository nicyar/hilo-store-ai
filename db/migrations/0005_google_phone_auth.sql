-- 0005_google_phone_auth.sql
-- Reemplaza WebAuthn/Passkeys y Apple Sign-In (0002/0004, nunca reescritas)
-- por Google OAuth y login por teléfono/SMS -- decisión de producto
-- confirmada explícitamente por el usuario el 2026-09-14 (ver CLAUDE.md,
-- sección "Métodos de autenticación social: revertidos"). Email/contraseña
-- no se toca.
--
-- Esta migración NO reescribe 0001-0004, ni dropea `webauthn_credentials`
-- ni `apple_identities` -- quedan en el esquema sin uso (mismo criterio de
-- "nunca reescribir/eliminar una migración ya aplicada" que ya se venía
-- aplicando). La aplica el mismo runner genérico
-- db/scripts/run_migrations.py.

PRAGMA foreign_keys = OFF;

-- ---------------------------------------------------------------------------
-- users: relajar `email NOT NULL UNIQUE` + agregar `phone` y `google_sub`
-- ---------------------------------------------------------------------------
-- SQLite no soporta "ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL" ni
-- agregar un CHECK constraint a una tabla existente -- la única forma es
-- recrear la tabla (el patrón de 12 pasos documentado por la propia SQLite
-- para cambios de esquema que ALTER TABLE no puede expresar directamente).
-- Por eso PRAGMA foreign_keys=OFF arriba: mientras se recrea `users` hay
-- cuatro tablas con FK hacia ella (sessions, webauthn_credentials,
-- apple_identities, password_reset_tokens, y la phone_verification_codes
-- que se agrega más abajo no tiene FK a users a propósito, ver esa sección)
-- y no queremos que SQLite se queje en el paso intermedio en el que la
-- tabla vieja ya no existe pero la nueva todavía no tiene los datos. Los
-- `id` de usuario se preservan 1:1 (se copian explícitos, no se
-- regeneran), así que ninguna de esas FKs queda huérfana ni rota.
--
-- POR QUÉ HAY QUE TOCAR ESTO (el problema de fondo): hasta ahora `email`
-- era la única identidad de login posible, así que tenía sentido que fuera
-- NOT NULL UNIQUE. Con teléfono como alta independiente (te registrás
-- mandando un SMS, nunca das un email) y Google como alta independiente
-- (el día de mañana que se active, tampoco da un email obligatorio del
-- lado del server aunque Google sí lo mande), vamos a tener usuarios sin
-- email. La restricción NOT NULL original ya no puede sostenerse.
--
-- DECISIÓN DE ESQUEMA -- una tabla `users` con columnas nullable +
-- CHECK, en vez de una tabla separada de "identidades" (que fue la otra
-- opción evaluada, y es literalmente el patrón que ya existe para Apple:
-- `apple_identities` es una tabla 1-a-1 aparte por user_id):
--   * Para Apple, la tabla aparte se justificaba porque Apple puede mandar
--     un "relay email" distinto del real y puede no reenviarlo en logins
--     subsiguientes -- había que guardar ese email de forma independiente
--     de `users.email`. Ni teléfono ni Google tienen ese problema: el
--     teléfono ES la identidad (no hay "teléfono real" vs "teléfono
--     relay"), y el `sub` de Google es estable y 1:1 con la cuenta de
--     Google igual que `apple_sub`, pero sin el matiz del email relay que
--     motivó separar Apple.
--   * Con column nullable + UNIQUE, SQLite permite múltiples filas con esa
--     columna en NULL (UNIQUE trata NULL como "no comparable a sí mismo"),
--     que es exactamente lo que hace falta: muchos usuarios sin teléfono,
--     muchos sin google_sub, muchos sin email -- pero cada uno de los tres,
--     cuando SÍ está presente, sigue siendo único globalmente.
--   * El CHECK constraint de abajo es la garantía de integridad que
--     reemplaza a la vieja "email NOT NULL": en vez de "todo usuario tiene
--     email", ahora es "todo usuario tiene AL MENOS UN identificador de
--     login" -- se sigue pudiendo razonar sobre la tabla sin auditar cada
--     ruta de alta a mano para confirmar que no crea usuarios huérfanos
--     de identidad.
--   * Una tabla `google_identities` aparte (simétrica a `apple_identities`)
--     hubiera sido la alternativa más "consistente" a primera vista, pero
--     agrega un JOIN a cada lookup de login por Google sin resolver ningún
--     problema real (no hay relay email que forzar a separar) -- se
--     eligió la opción más simple que cumple el mismo contrato.
--
-- `password_hash` sigue nullable, sin cambios (ya lo era desde 0002).
CREATE TABLE users_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT UNIQUE,
  password_hash  TEXT,
  phone          TEXT UNIQUE,
  google_sub     TEXT UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (email IS NOT NULL OR phone IS NOT NULL OR google_sub IS NOT NULL)
);

INSERT INTO users_new (id, email, password_hash, created_at, updated_at)
  SELECT id, email, password_hash, created_at, updated_at FROM users;

DROP TABLE users;

-- SQLite actualiza automáticamente la entrada de `sqlite_sequence` (el
-- contador de AUTOINCREMENT) cuando se renombra una tabla, así que el
-- próximo INSERT sigue después del último id existente -- no hace falta
-- tocar sqlite_sequence a mano. Verificado como parte de la verificación
-- de esta migración antes de aplicarla contra la base real.
ALTER TABLE users_new RENAME TO users;

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- phone_verification_codes
-- ---------------------------------------------------------------------------
-- Códigos de un solo uso para login/registro por teléfono, mismo patrón que
-- `password_reset_tokens` (0003) pero para un código corto de 6 dígitos en
-- vez de un token de 256 bits:
--
-- `code_hash` -- NUNCA se guarda el código en texto plano, mismo criterio
-- que sessions/password_reset_tokens. OJO con la diferencia de fondo: un
-- token de reset tiene 256 bits de entropía (hashearlo es "gratis" porque
-- además de ilegible es impracticable de fuerza-bruta incluso conociendo el
-- hash). Un código de 6 dígitos tiene ~20 bits (1 millón de combinaciones):
-- alguien con acceso de lectura a esta tabla podría precalcular
-- sha256(phone || ':' || code) para las 1M combinaciones de un teléfono
-- puntual en segundos y revertir el hash. Hashear igual sirve como defensa
-- en profundidad barata (evita el caso más tonto: alguien mirando la base
-- de casualidad ve el código en claro), pero la protección real contra
-- fuerza bruta acá es otra: ventana de expiración corta (10 minutos), un
-- solo uso (`used_at`), y el rate limiting de POST /api/auth/phone/verify-code
-- (ver server/src/routes/authPhone.js) que limita cuántos intentos de
-- código se pueden probar por IP en esa ventana. Documentado así de
-- explícito para que quede claro que es una decisión consciente, no que
-- alguien creyó que hashear un PIN de 6 dígitos da la misma garantía que
-- hashear un token de sesión.
--
-- `phone` es TEXT suelto (no FK a `users`) a propósito: pedir un código es
-- el primer paso tanto para loguearse (el teléfono ya tiene usuario) como
-- para registrarse (todavía no existe ningún usuario con ese teléfono) --
-- en el momento de generar el código no sabemos todavía si va a terminar
-- creando un usuario nuevo o no, así que no hay un user_id que referenciar.
--
-- No hay índice UNIQUE sobre (phone, code_hash): a propósito se permite
-- pedir varios códigos seguidos para el mismo teléfono (ej. el usuario no
-- recibió el SMS y lo reintenta) -- todos quedan válidos hasta que se usan
-- o expiran, igual que password_reset_tokens no invalida tokens previos al
-- emitir uno nuevo. El rate limiting de /phone/request-code (por IP Y por
-- teléfono, igual que /password/forgot) es lo que evita el abuso de pedir
-- de más.
CREATE TABLE IF NOT EXISTS phone_verification_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_phone_verification_codes_phone
  ON phone_verification_codes (phone);
CREATE INDEX IF NOT EXISTS idx_phone_verification_codes_expires_at
  ON phone_verification_codes (expires_at);
