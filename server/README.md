# server/ -- HILO Store auth server

Servidor Express de autenticación. Convive con la base SQLite del catálogo
(`../db/lyondor.sqlite3`) pero solo lee/escribe sus propias tablas
(`users`, `webauthn_credentials`, `sessions`, `apple_identities`, creadas
por `db/migrations/0002_auth_users_sessions.sql`). Nunca toca `products`,
`product_images` ni `product_variants`.

Es un proyecto Node separado (su propio `package.json`) del resto del
catálogo, que es Python (`db/scripts/*.py`) -- no se mezclan dependencias.

## Setup

```
cd server
npm install
cp .env.example .env   # ajustar si hace falta
npm start
```

Corre en `http://localhost:4000` por defecto (`PORT` en `.env`).

El frontend (Vite, puerto 5173) proxyea `/api/*` hacia acá -- ver
`frontend/vite.config.js`. Con ese proxy, desde el browser todo es
same-origin.

### `:4000` también sirve el sitio vanilla (home + catálogo) en dev

Además de la API, este server sirve `index.html`, `css/`, `js/`, `data/` y
`uploads/` de la raíz del proyecto -- ver `SERVE_STATIC_SITE` en
`.env.example` y el detalle en `../CLAUDE.md` ("Sitio vanilla servido desde
`server/` en dev"). Es el destino del redirect post-login
(`VITE_HOME_URL=http://localhost:4000` en `frontend/.env`). Montaje
explícito por carpeta, nunca la raíz del proyecto entera -- eso expondría
`.env`, `../db/lyondor.sqlite3`, `../frontend/` y el respaldo de
webauthn/apple. En producción se apaga (`SERVE_STATIC_SITE=false` o
`NODE_ENV=production`) y el sitio lo sirve nginx/CDN delante.

## IMPORTANTE: cookie de sesión y HTTPS en producción

La cookie `hilo_session` es HttpOnly, SameSite=Lax, y su flag `Secure`
depende de `NODE_ENV`:

- `NODE_ENV=development` (default) -> `Secure` desactivado, porque Vite
  sirve el front por HTTP en localhost y un browser directamente ignora
  cookies `Secure` sobre HTTP. Esto es SOLO para desarrollo local.
- `NODE_ENV=production` -> `Secure` activo.

**Esto NO es opcional en producción.** Si `server/src/index.js` arranca sin
`NODE_ENV=production`, lo loguea explícitamente al levantar. Antes de
desplegar a producción:

1. Setear `NODE_ENV=production` en el entorno del server.
2. Servir el sitio entero (front + este server, directo o vía proxy
   inverso) por HTTPS real -- terminación TLS en nginx/Caddy/la plataforma
   de hosting. Sin HTTPS, con `Secure` activo la cookie de sesión
   simplemente no se setea y nadie puede loguearse; y si alguien desactivara
   `Secure` "para que ande" en un deploy real, la cookie viajaría en texto
   plano por la red.
3. Ajustar `CORS_ORIGIN` al dominio real del frontend en producción (nunca
   dejar `*`: las cookies con `credentials: true` no lo permiten).

## Endpoints

Ver el contrato completo en la tarea / conversación con el equipo de
frontend. Resumen:

- `POST /api/auth/register`, `/login`, `/logout`, `GET /api/auth/session`
  -- flujo de email/password con cookie de sesión HttpOnly.
- `POST /api/auth/webauthn/register/options|verify` -- alta de passkey,
  requiere sesión activa (usuario ya logueado por password).
- `POST /api/auth/webauthn/login/options|verify` -- login con passkey.
- `POST /api/auth/apple` -- **stub**, siempre 501. Ver comentario en
  `src/routes/authApple.js` para qué hace falta activarlo de verdad.

## Decisiones de diseño no obvias

- El token de sesión que viaja en la cookie es aleatorio (32 bytes,
  `crypto.randomBytes`) y NUNCA se guarda tal cual en la base: se guarda
  `sha256(token)` en `sessions.token_hash`. Ver `src/lib/session.js`.
- El login siempre corre `bcrypt.compare` (contra un hash dummy si el
  usuario no existe o no tiene password) para no filtrar por timing si un
  email está registrado o no, además del mensaje de error genérico.
- Los challenges de WebAuthn en curso se guardan en memoria del proceso
  (no en SQLite): viven segundos y no tienen valor después de la ceremonia.
  Ver el comentario en `src/lib/challengeStore.js` -- si el server pasa a
  correr con más de una instancia, esto necesita moverse a un store
  compartido.
- Rate limiting de login es básico (por IP, no por email) -- ver
  `src/routes/authPassword.js`.
