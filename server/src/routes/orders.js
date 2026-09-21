"use strict";

const fs = require("fs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const { requireSession } = require("../lib/middleware");
const { getSessionTokenFromRequest } = require("../lib/cookies");
const { getUserBySessionToken } = require("../lib/session");
const { isValidAdminKey } = require("../lib/adminAuth");
const {
  validateContact,
  validateAddress,
  validateItemsShape,
  aggregateItemsByProductId,
  VALID_PAYMENT_METHODS,
  VALID_SHIPPING_METHODS,
} = require("../lib/checkoutValidate");
const { findActiveProductBySlug, findPrimaryImagePath } = require("../lib/products");
const { findActiveRateByProvincia } = require("../lib/shippingRates");
const {
  getTransferenciaConfig,
  getMercadopagoConfig,
  getRetiroConfig,
} = require("../lib/checkoutConfig");
const {
  findOrderByIdempotencyKey,
  findOrderByPublicCode,
  getOrderWithItems,
  createOrderWithItems,
  setOrderMercadopagoPreference,
  setOrderComprobante,
} = require("../lib/orders");
const { upload: uploadComprobante, resolveComprobantePath, MAX_FILE_SIZE_BYTES } = require("../lib/comprobantes");
const { detectFileTypeFromFilePath } = require("../lib/fileSignature");

const router = express.Router();

// Rate limit de creación de pedidos: más estricto que las rutas de solo
// lectura (mismo espíritu que loginLimiter en authPassword.js) -- crear un
// pedido dispara trabajo real (transacción, y eventualmente el email
// diferido, ver CLAUDE.md) y no hace falta permitir ráfagas.
const createOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

const readOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

const payLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

// Subida de comprobante: mismo espíritu que createOrderLimiter (dispara
// trabajo real -- escritura a disco + lectura de magic bytes), algo más
// generoso porque un cliente legítimo puede necesitar reintentar si su
// primer archivo fue rechazado (tipo/tamaño inválido) o si el negocio
// rechazó su primer comprobante y sube uno corregido.
const comprobanteUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "too_many_attempts" });
  },
});

/**
 * Serializa un pedido (con items) para la respuesta HTTP. No expone `id`
 * (rowid) ni `user_id` -- `public_code` es el único identificador externo
 * (ver CLAUDE.md / migración 0006).
 */
function serializeOrder(order) {
  return {
    public_code: order.public_code,
    status: order.status,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    shipping_method: order.shipping_method,
    address:
      order.shipping_method === "envio"
        ? {
            calle: order.calle,
            numero: order.numero,
            piso_depto: order.piso_depto,
            barrio: order.barrio,
            localidad: order.localidad,
            provincia: order.provincia,
            cp: order.cp,
            pais: order.pais,
            notas: order.notas,
          }
        : null,
    contact: {
      name: order.contact_name,
      email: order.contact_email,
      phone: order.contact_phone,
      dni: order.contact_dni,
    },
    subtotal_cents: order.subtotal_cents,
    shipping_cents: order.shipping_cents,
    total_cents: order.total_cents,
    currency: order.currency,
    // No se expone `comprobante_path` (es un nombre de archivo interno del
    // filesystem del server, no algo que el cliente necesite) -- solo si
    // hay uno subido y cuándo, para que el front sepa si mostrar "en
    // revisión" y pueda armar el link a GET /:public_code/comprobante con
    // el public_code que ya tiene.
    comprobante_uploaded_at: order.comprobante_uploaded_at || null,
    items: order.items.map((it) => ({
      product_id: it.product_id,
      name: it.name_snapshot,
      unit_price_cents: it.unit_price_cents,
      quantity: it.quantity,
      line_total_cents: it.line_total_cents,
      image: it.image_snapshot,
      precio_era_prueba: Boolean(it.precio_era_prueba),
    })),
    created_at: order.created_at,
  };
}

// ---------------------------------------------------------------------------
// POST /api/orders -- crea un pedido a partir del carrito.
// ---------------------------------------------------------------------------
// Detrás de requireSession: primer uso real de ese middleware en el
// proyecto (estaba escrito y probado, nunca enganchado a ninguna ruta,
// ver server/src/lib/middleware.js).
//
// Regla dura no negociable: el body SOLO aporta product_id + quantity por
// ítem (más contacto/envío/pago). Ningún precio/subtotal/total que venga
// en el body se lee ni se usa para comparar -- todo se recalcula acá leyendo
// `products` y `shipping_rates` en el momento del request.
router.post("/", requireSession, createOrderLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const {
      items,
      contact,
      shipping_method: shippingMethod,
      address,
      payment_method: paymentMethod,
      idempotency_key: idempotencyKey,
    } = body;

    // --- Idempotencia primero: si esta key ya generó un pedido, devolverlo
    // tal cual en vez de volver a validar/crear -- protege contra doble
    // click y reintentos de red sin necesitar que el resto del flujo sea
    // idempotente también.
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      return res.status(400).json({ error: "invalid_input", fields: { idempotency_key: "required" } });
    }

    const existing = findOrderByIdempotencyKey(idempotencyKey.trim());
    if (existing) {
      if (existing.user_id !== req.user.id) {
        // La key ya se usó, pero para un pedido de otro usuario -- esto no
        // debería pasar nunca si el front genera keys con suficiente
        // entropía (ver CLAUDE.md, Etapa 2), así que se trata como
        // conflicto en vez de filtrar el pedido ajeno.
        return res.status(409).json({ error: "idempotency_key_conflict" });
      }
      return res.status(200).json({ order: serializeOrder(getOrderWithItems(existing)) });
    }

    // --- Validación de forma ---
    const itemsCheck = validateItemsShape(items);
    if (!itemsCheck.valid) {
      return res.status(400).json({ error: itemsCheck.error, index: itemsCheck.index, reason: itemsCheck.reason });
    }

    // --- Agregación por product_id (hallazgo QA adversarial 2026-09-18,
    // ver CLAUDE.md) -- validateItemsShape solo valida CADA línea por
    // separado; sin esto, varias líneas del mismo product_id evadían tanto
    // el tope de cantidad (MAX_QTY_PER_PRODUCT) como el chequeo de stock
    // más abajo, que también itera por línea cruda. Todo el resto del
    // flujo (stock, precio, creación del pedido) usa `aggregated.items`
    // desde acá en adelante, nunca `items` crudo.
    const aggregated = aggregateItemsByProductId(items);
    if (!aggregated.valid) {
      return res.status(400).json({
        error: aggregated.error,
        index: aggregated.index,
        product_id: aggregated.product_id,
        reason: aggregated.reason,
      });
    }

    const contactCheck = validateContact(contact);
    if (!contactCheck.valid) {
      return res.status(400).json({ error: "invalid_input", fields: contactCheck.fields });
    }

    if (!VALID_SHIPPING_METHODS.has(shippingMethod)) {
      return res.status(400).json({ error: "invalid_input", fields: { shipping_method: "invalid" } });
    }

    if (!VALID_PAYMENT_METHODS.has(paymentMethod)) {
      return res.status(400).json({ error: "invalid_input", fields: { payment_method: "invalid" } });
    }

    let normalizedAddress = null;
    let shippingCents = 0;

    if (shippingMethod === "envio") {
      const addressCheck = validateAddress(address);
      if (!addressCheck.valid) {
        return res.status(400).json({ error: "invalid_input", fields: addressCheck.fields });
      }

      const rate = findActiveRateByProvincia(String(address.provincia).trim());
      if (!rate) {
        // La provincia no está en shipping_rates (no listada, o desactivada
        // entre que el front cargó el selector y se confirmó el pedido) --
        // 400, no 409: no es un problema de precio/stock cambiado, es un
        // dato de entrada que no matchea ninguna opción válida.
        return res.status(400).json({ error: "invalid_input", fields: { provincia: "not_found" } });
      }
      shippingCents = rate.price_cents;

      normalizedAddress = {
        calle: String(address.calle).trim(),
        numero: String(address.numero).trim(),
        pisoDepto: address.piso_depto ? String(address.piso_depto).trim() : null,
        barrio: address.barrio ? String(address.barrio).trim() : null,
        localidad: String(address.localidad).trim(),
        provincia: String(address.provincia).trim(),
        cp: String(address.cp).trim(),
        notas: address.notas ? String(address.notas).trim() : null,
      };
    } else {
      // shipping_method === 'retiro': sin credenciales de retiro cargadas
      // (RETIRO_DIRECCION/RETIRO_HORARIOS), este método no está disponible
      // -- mismo criterio que transferencia/MP sin configurar. shippingCents
      // queda en 0 (retirar en el local no tiene costo de envío).
      const retiroConfig = getRetiroConfig();
      if (!retiroConfig.disponible) {
        return res.status(409).json({ error: "shipping_method_unavailable", method: "retiro" });
      }
    }

    // --- Disponibilidad del método de pago (mismo criterio que arriba) ---
    if (paymentMethod === "transferencia" && !getTransferenciaConfig().disponible) {
      return res.status(409).json({ error: "payment_method_unavailable", method: "transferencia" });
    }
    if (paymentMethod === "mercadopago" && !getMercadopagoConfig().disponible) {
      return res.status(409).json({ error: "payment_method_unavailable", method: "mercadopago" });
    }

    // --- Recalcular precio + stock leyendo `products`, nunca el body ---
    const resolvedItems = [];
    let subtotalCents = 0;
    let preciosCambiaron = false;

    // Itera el carrito ya agregado por product_id (nunca `items` crudo) --
    // esto es lo que garantiza que el chequeo de stock de acá abajo compare
    // contra la cantidad TOTAL pedida de cada producto, no contra una línea
    // aislada. Nota: no hay `UNIQUE(order_id, product_id)` en el esquema de
    // `order_items` (migración 0006) -- la única garantía de que un pedido
    // no termine con dos filas del mismo product_id es que `resolvedItems`
    // se construye acá a partir de `aggregated.items`, que ya tiene un solo
    // elemento por product_id.
    for (const rawItem of aggregated.items) {
      const product = findActiveProductBySlug(rawItem.product_id);
      if (!product) {
        return res.status(409).json({ error: "producto_no_disponible", product_id: rawItem.product_id });
      }

      if (product.precio_centavos === null || product.precio_centavos === undefined) {
        // Sin precio cargado (todavía puede pasar si el negocio des-cargó
        // un precio, o para un producto nuevo sin precio de prueba
        // sembrado) -- no hay nada que cobrar, no se puede vender.
        return res.status(409).json({ error: "producto_no_disponible", product_id: rawItem.product_id });
      }

      if (product.stock !== null && product.stock !== undefined && product.stock < rawItem.quantity) {
        return res.status(409).json({
          error: "sin_stock",
          product_id: rawItem.product_id,
          stock_disponible: product.stock,
        });
      }

      // Snapshot opcional de qué precio vio el front al agregar al carrito
      // (contrato definitivo a cerrar con nico/valentina en la Etapa 2, ver
      // CLAUDE.md) -- si viene, se usa SOLO para detectar que el precio
      // cambió entre agregar y confirmar, nunca para calcular el total.
      const snapshotCents =
        typeof rawItem.unit_price_snapshot_cents === "number"
          ? rawItem.unit_price_snapshot_cents
          : null;
      if (snapshotCents !== null && snapshotCents !== product.precio_centavos) {
        preciosCambiaron = true;
      }

      const lineTotalCents = product.precio_centavos * rawItem.quantity;
      subtotalCents += lineTotalCents;

      resolvedItems.push({
        productId: product.slug_o_id_origen,
        nameSnapshot: product.nombre,
        unitPriceCents: product.precio_centavos,
        quantity: rawItem.quantity,
        lineTotalCents,
        imageSnapshot: findPrimaryImagePath(product.id),
        precioEraPrueba: Boolean(product.precio_es_prueba),
      });
    }

    if (preciosCambiaron) {
      return res.status(409).json({
        error: "precios_actualizados",
        cart: {
          items: resolvedItems.map((it) => ({
            product_id: it.productId,
            name: it.nameSnapshot,
            unit_price_cents: it.unitPriceCents,
            quantity: it.quantity,
            line_total_cents: it.lineTotalCents,
          })),
          subtotal_cents: subtotalCents,
          shipping_cents: shippingCents,
          total_cents: subtotalCents + shippingCents,
          currency: "ARS",
        },
      });
    }

    const totalCents = subtotalCents + shippingCents;

    const createdOrder = createOrderWithItems(
      {
        userId: req.user.id,
        contact: {
          name: contact.name.trim(),
          email: contact.email.trim().toLowerCase(),
          phone: contact.phone.trim(),
          dni: contact.dni.trim(),
        },
        paymentMethod,
        shippingMethod,
        address: normalizedAddress,
        subtotalCents,
        shippingCents,
        totalCents,
        idempotencyKey: idempotencyKey.trim(),
      },
      resolvedItems
    );

    // Aviso de pedido nuevo por email: DIFERIDO por pedido explícito del
    // usuario (ver CLAUDE.md, "Pendiente / decisiones abiertas") -- el
    // pedido se guarda completo igual, simplemente sin el aviso automático
    // todavía. No se agrega código a medio escribir para esto.

    return res.status(201).json({ order: serializeOrder(createdOrder) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/orders/:public_code -- detalle de un pedido propio.
// ---------------------------------------------------------------------------
router.get("/:public_code", requireSession, readOrderLimiter, (req, res, next) => {
  try {
    const order = findOrderByPublicCode(req.params.public_code);
    // 404 tanto si no existe como si existe pero es de otro usuario -- no
    // se filtra cuál de los dos casos es (mismo criterio anti-enumeración
    // que ya usa el proyecto en auth).
    if (!order || order.user_id !== req.user.id) {
      return res.status(404).json({ error: "order_not_found" });
    }
    return res.status(200).json({ order: serializeOrder(getOrderWithItems(order)) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/orders/:public_code/comprobante -- sube el comprobante de una
// transferencia (migración 0008). Ver CLAUDE.md, "Checkout: confirmación de
// transferencias por comprobante".
// ---------------------------------------------------------------------------
// Middleware previo a multer: resuelve y valida el pedido ANTES de aceptar
// el archivo (necesita el id del pedido para nombrar el archivo -- ver
// lib/comprobantes.js -- y no tiene sentido gastar I/O escribiendo un
// archivo a disco para un pedido que ni siquiera es del usuario logueado).
function loadOwnedTransferOrder(req, res, next) {
  const order = findOrderByPublicCode(req.params.public_code);
  // 404 tanto si no existe como si es de otro usuario -- mismo criterio
  // anti-enumeración que GET /:public_code.
  if (!order || order.user_id !== req.user.id) {
    return res.status(404).json({ error: "order_not_found" });
  }
  if (order.payment_method !== "transferencia") {
    return res.status(409).json({ error: "invalid_payment_method" });
  }
  // Ya confirmado o cancelado: no tiene sentido aceptar un comprobante
  // nuevo. 'pendiente', 'pendiente_revision' (re-subida, ej. el archivo
  // anterior era ilegible) y 'rechazado' (el cliente corrige y reintenta)
  // sí lo aceptan.
  if (order.payment_status === "aprobado") {
    return res.status(409).json({ error: "ya_confirmado" });
  }
  if (order.payment_status === "cancelado") {
    return res.status(409).json({ error: "pedido_cancelado" });
  }
  req.order = order;
  next();
}

router.post(
  "/:public_code/comprobante",
  requireSession,
  comprobanteUploadLimiter,
  loadOwnedTransferOrder,
  (req, res, next) => {
    uploadComprobante(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "file_too_large", max_bytes: MAX_FILE_SIZE_BYTES });
        }
        if (err instanceof multer.MulterError) {
          return res.status(400).json({ error: "upload_error", code: err.code });
        }
        return next(err);
      }

      // fileFilter de multer (lib/comprobantes.js) ya descartó mimetypes
      // fuera de la whitelist declarada por el cliente -- si no hay
      // req.file, no llegó ningún archivo válido según ESE chequeo rápido
      // (que todavía no es el que importa de verdad).
      if (!req.file) {
        return res.status(400).json({ error: "invalid_file_type" });
      }

      // --- Chequeo que de verdad importa: magic bytes del archivo real en
      // disco, nunca el mimetype que declaró el cliente (ver
      // lib/fileSignature.js). Se exige que coincidan: no alcanza con que
      // el contenido real sea "alguno de los 3 tipos permitidos" -- si el
      // cliente declaró image/jpeg pero el contenido real es un PDF (o
      // cualquier otra cosa), es mimetype mentiroso y se rechaza entero,
      // aunque el tipo real también estuviera en la whitelist. ---
      const detected = detectFileTypeFromFilePath(req.file.path);
      if (!detected || detected.mime !== req.file.mimetype) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "invalid_file_type" });
      }

      // Re-subida: borra el comprobante anterior en disco (best-effort, no
      // bloquea la respuesta si falla) para no acumular archivos huérfanos
      // de intentos previos rechazados o corregidos.
      if (req.order.comprobante_path) {
        const oldAbsolute = resolveComprobantePath(req.order.comprobante_path);
        if (oldAbsolute) {
          fs.unlink(oldAbsolute, () => {});
        }
      }

      setOrderComprobante(req.order.id, req.file.filename);

      const updatedOrder = getOrderWithItems(findOrderByPublicCode(req.order.public_code));
      return res.status(200).json({ order: serializeOrder(updatedOrder) });
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/orders/:public_code/comprobante -- sirve el archivo subido.
// ---------------------------------------------------------------------------
// Autorización OR (no requireSession a secas): el dueño del pedido (cookie
// de sesión) O el negocio (header x-admin-key, ver lib/adminAuth.js) -- la
// pantalla de revisión (admin/comprobantes.html) no inicia sesión como
// ningún usuario, solo tiene la API key.
router.get("/:public_code/comprobante", readOrderLimiter, (req, res, next) => {
  try {
    const order = findOrderByPublicCode(req.params.public_code);
    if (!order) {
      return res.status(404).json({ error: "order_not_found" });
    }

    const adminKeyHeader = req.headers["x-admin-key"];
    const isAdmin = isValidAdminKey(adminKeyHeader);

    if (!isAdmin) {
      const token = getSessionTokenFromRequest(req);
      const user = getUserBySessionToken(token);
      // Mismo criterio anti-enumeración que el resto de las rutas de
      // pedidos: 404, no 401/403, para no confirmar que el public_code
      // existe cuando quien pregunta no tiene ningún derecho sobre él.
      if (!user || user.id !== order.user_id) {
        return res.status(404).json({ error: "order_not_found" });
      }
    }

    if (!order.comprobante_path) {
      return res.status(404).json({ error: "comprobante_not_found" });
    }

    const absolutePath = resolveComprobantePath(order.comprobante_path);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: "comprobante_not_found" });
    }

    return res.sendFile(absolutePath);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/orders/:id/pay/mercadopago -- crea la preference de Checkout Pro.
// ---------------------------------------------------------------------------
// OJO con el nombre del param: se llama `:id` (como pide el contrato de la
// etapa) pero el VALOR que recibe es el `public_code` del pedido
// ("HILO-000123"), nunca el rowid -- el guardrail del proyecto de "nunca
// exponer el rowid en URLs" aplica acá igual que en GET /:public_code. El
// front ya tiene el public_code disponible (se lo devolvió POST /api/orders),
// así que no hace falta el rowid para nada.
router.post("/:id/pay/mercadopago", requireSession, payLimiter, async (req, res, next) => {
  try {
    const order = findOrderByPublicCode(req.params.id);
    if (!order || order.user_id !== req.user.id) {
      return res.status(404).json({ error: "order_not_found" });
    }

    if (order.payment_method !== "mercadopago") {
      return res.status(400).json({ error: "invalid_payment_method" });
    }

    const mpConfig = getMercadopagoConfig();
    if (!mpConfig.disponible) {
      return res.status(501).json({
        error: "mercadopago_no_configurado",
        message: "Mercado Pago todavía no está disponible como medio de pago.",
      });
    }

    const orderWithItems = getOrderWithItems(order);

    const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
    const preferenceClient = new Preference(client);

    const appBaseUrl = process.env.APP_BASE_URL || "http://localhost:4000";
    // notification_url tiene que ser una URL pública que MP pueda alcanzar
    // -- en dev (localhost) MP no puede pegarle, así que el webhook real
    // solo se puede probar con un túnel (ngrok o similar) o en un deploy
    // real. Se arma igual con la env var que ya declara el resto del
    // proyecto para el origen público del server.
    const publicServerUrl = process.env.PUBLIC_SERVER_URL || `http://localhost:${process.env.PORT || 4000}`;

    // `auto_return: "approved"` solo es válido para MP si `back_urls.success`
    // es una URL pública real -- diagnosticado 2026-09-18 contra la API real
    // de MP con una cuenta de prueba: mandar auto_return con back_urls
    // apuntando a localhost responde 400 "auto_return invalid. back_url.success
    // must be defined" (MP lo trata como no-definido). Sin `auto_return`, la
    // preference se crea igual y el comprador solo pierde el redirect
    // automático post-pago (tiene que tocar "Volver al sitio" a mano) -- por
    // eso en dev local (APP_BASE_URL sin setear o apuntando a localhost/127.0.0.1)
    // se omite en vez de romper el checkout entero. En producción, con
    // APP_BASE_URL real, se manda como siempre.
    const isLocalAppBaseUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(appBaseUrl);

    let preference;
    try {
      preference = await preferenceClient.create({
        body: {
          items: orderWithItems.items.map((it) => ({
            id: it.product_id,
            title: it.name_snapshot,
            quantity: it.quantity,
            unit_price: it.unit_price_cents / 100,
            currency_id: orderWithItems.currency,
          })),
          external_reference: orderWithItems.public_code,
          notification_url: `${publicServerUrl}/api/webhooks/mercadopago`,
          back_urls: {
            success: `${appBaseUrl}/checkout.html?order=${orderWithItems.public_code}&pago=aprobado`,
            pending: `${appBaseUrl}/checkout.html?order=${orderWithItems.public_code}&pago=pendiente`,
            failure: `${appBaseUrl}/checkout.html?order=${orderWithItems.public_code}&pago=rechazado`,
          },
          ...(isLocalAppBaseUrl ? {} : { auto_return: "approved" }),
        },
      });
    } catch (mpErr) {
      // Falla real de la API de MP (credenciales inválidas, etc.) -- se
      // loguea para debug pero no se filtra el detalle interno al cliente,
      // mismo criterio que el resto del proyecto.
      console.error("[orders] Falló Preference.create de Mercado Pago:", mpErr.message);
      return res.status(502).json({ error: "mercadopago_error" });
    }

    setOrderMercadopagoPreference(order.id, preference.id);

    // `sandbox_init_point` solo viene poblado cuando la Preference se creó
    // con credenciales de una cuenta de PRUEBA de MP (confirmado 2026-09-18:
    // con credenciales de producción reales, MP no lo manda) -- es la URL de
    // checkout que corresponde para simular una compra (sandbox.mercadopago.*,
    // distinto dominio de mercadopago.* que usa `init_point`). Se prioriza
    // acá para no tener que duplicar esta lógica en el front -- cuando el
    // usuario cargue credenciales de producción reales, esto vuelve a
    // devolver `init_point` solo, sin cambiar nada más.
    return res.status(200).json({
      preference_id: preference.id,
      init_point: preference.sandbox_init_point || preference.init_point,
      public_key: mpConfig.public_key,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
