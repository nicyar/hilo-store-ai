"use strict";

require("dotenv").config();

const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");

const { router: authPasswordRouter } = require("./routes/authPassword");
const authGoogleRouter = require("./routes/authGoogle");
const authPhoneRouter = require("./routes/authPhone");
const checkoutConfigRouter = require("./routes/checkoutConfig");
const shippingRatesRouter = require("./routes/shippingRates");
const ordersRouter = require("./routes/orders");
const adminOrdersRouter = require("./routes/adminOrders");
const mercadopagoWebhookRouter = require("./routes/mercadopagoWebhook");
const { isProd } = require("./lib/cookies");
const db = require("./lib/db");

const app = express();

const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

// Sirve el sitio vanilla (home + catálogo) desde este mismo server en dev,
// para que el redirect post-login (VITE_HOME_URL) tenga un origen real al
// que volver -- ver CLAUDE.md, "Redirect a la home después del login".
// Default: on salvo NODE_ENV=production (ahí lo sirve nginx/CDN delante,
// no este proceso Node). SERVE_STATIC_SITE explícito pisa el default en
// cualquier entorno.
const SERVE_STATIC_SITE =
  process.env.SERVE_STATIC_SITE !== undefined
    ? process.env.SERVE_STATIC_SITE === "true"
    : !isProd();

// Raíz del proyecto (server/src/index.js -> ../.. == raíz de ecommerce/).
// Nunca se expone entera con express.static: eso serviría también
// server/.env, db/lyondor.sqlite3, frontend/ y el respaldo de
// webauthn/apple. Se montan solo las carpetas puntuales que el sitio
// vanilla necesita.
const PROJECT_ROOT = path.resolve(__dirname, "../..");

app.use(express.json());
app.use(cookieParser());

// CORS explícito con origin fijo (nunca "*") porque las cookies de sesión
// viajan con credentials:true, y el spec de CORS no permite combinar
// credentials con origin comodín. En dev, con el proxy de Vite, el browser
// ni siquiera dispara CORS (todo es same-origin) -- esto cubre el caso de
// pegarle directo al server sin pasar por el proxy.
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
  })
);

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "hilo-auth-server" });
});

app.use("/api/auth", authPasswordRouter);
app.use("/api/auth/google", authGoogleRouter);
app.use("/api/auth/phone", authPhoneRouter);
app.use("/api/checkout/config", checkoutConfigRouter);
app.use("/api/shipping/rates", shippingRatesRouter);
app.use("/api/orders", ordersRouter);
// Revisión manual de comprobantes de transferencia -- protegido por API key
// (x-admin-key), no por cookie de sesión, ver server/src/lib/adminAuth.js.
app.use("/api/admin/orders", adminOrdersRouter);
// Sin requireSession (Mercado Pago no manda la cookie hilo_session) y con
// su propio rate limit -- ver server/src/routes/mercadopagoWebhook.js.
app.use("/api/webhooks/mercadopago", mercadopagoWebhookRouter);

// Sitio vanilla (home + catálogo), montado DESPUÉS de /api/* para que
// ninguna ruta estática pueda capturar una llamada a la API. Allowlist
// explícito de carpetas -- ver comentario de PROJECT_ROOT más arriba sobre
// por qué nunca es express.static(PROJECT_ROOT) a secas.
if (SERVE_STATIC_SITE) {
  app.use("/css", express.static(path.resolve(PROJECT_ROOT, "css")));
  app.use("/js", express.static(path.resolve(PROJECT_ROOT, "js")));
  app.use("/data", express.static(path.resolve(PROJECT_ROOT, "data")));
  app.use("/img", express.static(path.resolve(PROJECT_ROOT, "img")));
  // Imágenes de producto reales: el catálogo (data/catalogo_con_precios.json)
  // referencia rutas "uploads/<hash>.jpg" (ver db/scripts, door), no "img/".
  // Se monta también para que las cards no queden con imágenes rotas.
  //
  // OJO: uploads/comprobantes/ vive DENTRO de esta misma carpeta uploads/
  // (mismo directorio raíz que las imágenes de producto, por pedido
  // explícito -- ver migración 0008 / lib/comprobantes.js), pero un
  // comprobante de pago es información sensible del cliente (nombre, a
  // veces CBU/DNI visibles en la imagen) y NUNCA tiene que quedar
  // alcanzable por URL pública sin autenticar, a diferencia de una foto de
  // producto. Este guard corta esa subcarpeta específica ANTES de llegar a
  // express.static -- servirla solo pasa por
  // GET /api/orders/:public_code/comprobante (dueño del pedido o
  // x-admin-key, ver routes/orders.js).
  app.use("/uploads/comprobantes", (req, res) => {
    res.status(404).end();
  });
  app.use("/uploads", express.static(path.resolve(PROJECT_ROOT, "uploads")));

  // App de React (login), buildeada (`frontend/dist`), montada SAME-ORIGIN
  // bajo /login -- hallazgo de valentina (Etapa 0): antes el login solo era
  // alcanzable en http://localhost:5173, y el checkout necesita login
  // same-origin porque la cookie de sesión no viaja bien entre orígenes
  // distintos para el flujo `?next=` (ver CLAUDE.md). No pisa `/` (home
  // vanilla) ni ninguna ruta `/api/*` -- se monta DESPUÉS de esas rutas por
  // el mismo motivo que el resto del sitio estático.
  //
  // express.static primero (assets con hash: JS/CSS/imágenes del build de
  // Vite), y recién si ningún archivo estático matchea, fallback a
  // index.html de esa carpeta -- necesario porque React Router (client-side)
  // maneja subrutas como /login/reset-password que no existen como archivo
  // físico en frontend/dist.
  //
  // OJO con /assets: el build de Vite (frontend/vite.config.js) no tiene
  // seteado `base`, así que frontend/dist/index.html referencia sus JS/CSS
  // con rutas absolutas de raíz ("/assets/index-*.js"), no
  // "/login/assets/...". Para no tener que tocar la config de build ni
  // rebuildear (frontend/ es dominio de valentina/nico), se monta
  // frontend/dist/assets también en /assets a secas -- no colisiona con
  // nada: el sitio vanilla no tiene ninguna carpeta "assets" en su
  // allowlist (usa css/js/data/img/uploads). Si en algún momento se le
  // agrega `base: "/login/"` a vite.config.js y se rebuildea, este mount
  // extra deja de hacer falta pero no rompe nada dejarlo.
  const FRONTEND_DIST = path.resolve(PROJECT_ROOT, "frontend", "dist");
  app.use("/assets", express.static(path.resolve(FRONTEND_DIST, "assets")));
  app.use("/login", express.static(FRONTEND_DIST));
  app.get("/login*", (req, res) => {
    res.sendFile(path.resolve(FRONTEND_DIST, "index.html"));
  });

  app.get("/", (req, res) => {
    res.sendFile(path.resolve(PROJECT_ROOT, "index.html"));
  });

  // checkout.html vive en la raíz del proyecto igual que index.html, pero
  // hasta la Etapa 2 del plan de checkout nada lo servía -- el allowlist de
  // arriba solo monta carpetas (css/js/data/img/uploads) más "/" a secas, así
  // que el botón "Finalizar compra" de index.html apuntaba a un 404 real en
  // este server (encontrado al verificar el flujo end-to-end, ver CLAUDE.md /
  // plan de checkout). Ruta explícita, mismo criterio que "/" -- nunca
  // express.static(PROJECT_ROOT) entero (expondría server/.env, la DB, etc.).
  app.get("/checkout.html", (req, res) => {
    res.sendFile(path.resolve(PROJECT_ROOT, "checkout.html"));
  });

  // Pantalla de revisión de comprobantes (admin/comprobantes.html) -- mismo
  // criterio que checkout.html (carpeta fuera del allowlist de arriba, se
  // monta explícito), pero a propósito NO hay ningún link a esta ruta desde
  // el sitio público (index.html/checkout.html) -- se llega solo
  // escribiendo la URL a mano. No es seguridad real (cualquiera que
  // adivine/vea esta ruta en el código puede abrirla), la seguridad de
  // verdad es la API key que exige cada request a /api/admin/* -- ver
  // lib/adminAuth.js. Esto solo evita que quede como un botón visible para
  // cualquier visitante del sitio.
  app.use("/admin", express.static(path.resolve(PROJECT_ROOT, "admin")));

  // Mismo hallazgo: cualquier link relativo "index.html" escrito DESDE una
  // página que no está en "/" (ej. el "Volver a la tienda"/logo de
  // checkout.html, o un redirect de vuelta a la home hecho en JS) resuelve a
  // "/index.html" según las reglas de URLs relativas del browser -- no a
  // "/", que es la única ruta que existía para la home. Alias explícito en
  // vez de reescribir esos hrefs (son de nico, no se tocan sin avisar).
  app.get("/index.html", (req, res) => {
    res.sendFile(path.resolve(PROJECT_ROOT, "index.html"));
  });
}

// Manejador de errores centralizado: nunca devolver el stack/mensaje crudo
// al cliente (podría filtrar detalles internos), pero sí loguearlo en el
// server para debug.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[error]", err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(`HILO auth server escuchando en http://localhost:${PORT}`);
  console.log(`DB: ${db.DB_PATH}`);
  console.log(`CORS origin permitido: ${CORS_ORIGIN}`);
  console.log(
    SERVE_STATIC_SITE
      ? `Sitio vanilla servido desde ${PROJECT_ROOT} (SERVE_STATIC_SITE=on)`
      : "Sitio vanilla NO servido por este proceso (SERVE_STATIC_SITE=off) -- esperado detrás de nginx/CDN en producción."
  );
  if (!isProd()) {
    console.log(
      "[dev] NODE_ENV != production -> cookie de sesión sin flag Secure (requerido para correr por HTTP en localhost). " +
        "En producción esto DEBE correr con NODE_ENV=production detrás de HTTPS real."
    );
  } else {
    console.log("[prod] Cookie de sesión con Secure activo -- requiere HTTPS real delante.");
  }
});

module.exports = app;
