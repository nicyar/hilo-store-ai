"use strict";

// Almacenamiento en disco de comprobantes de transferencia (imagen/PDF que
// el cliente sube para que el negocio verifique el pago a mano). Mismo
// directorio raíz `uploads/` que ya usan las imágenes de producto (Door),
// pero en su propia subcarpeta `uploads/comprobantes/` -- a diferencia de
// las imágenes de producto, esta carpeta NUNCA se sirve como estático
// público (ver el guard explícito en server/src/index.js sobre
// /uploads/comprobantes) porque un comprobante de pago (con nombre, monto,
// a veces CBU/DNI visibles) es información sensible del cliente, no un
// asset de catálogo.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const { ALLOWED_MIME_TYPES } = require("./fileSignature");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const COMPROBANTES_DIR = path.resolve(PROJECT_ROOT, "uploads", "comprobantes");

// Se crea al cargar el módulo (arranque del server) en vez de esperar al
// primer upload -- así un `uploads/comprobantes/` faltante no se descubre
// recién con el primer cliente subiendo un archivo.
fs.mkdirSync(COMPROBANTES_DIR, { recursive: true });

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB, límite explícito del pedido.

// Extensión de archivo SOLO a partir del mimetype declarado por el cliente
// en esta etapa (multer todavía no escribió el archivo, no hay bytes reales
// para inspeccionar) -- es un nombre provisorio nada más. La validación de
// verdad (magic bytes) pasa DESPUÉS, ya con el archivo en disco, en el
// route handler (ver server/src/routes/orders.js) -- si no matchea, el
// archivo se borra y se responde 400 antes de tocar la base.
const MIME_TO_PROVISIONAL_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, COMPROBANTES_DIR),
  // Nombre generado 100% por el server: `${orderId}_${randomUUID()}.ext` --
  // NUNCA `file.originalname` (evita path traversal / nombres con
  // caracteres de control que vengan del cliente). `req.order` lo deja
  // seteado el middleware `loadOwnedTransferOrder` que corre ANTES de este
  // multer en la cadena de la ruta (necesita el id del pedido, que sale de
  // la URL, no del body -- por eso puede resolverse antes de que multer
  // termine de leer el multipart).
  filename: (req, file, cb) => {
    const ext = MIME_TO_PROVISIONAL_EXT[file.mimetype] || "";
    const name = `${req.order.id}_${crypto.randomUUID()}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    // Primer filtro, rápido pero NO confiable (mimetype lo declara el
    // cliente) -- solo para rechazar de entrada lo obviamente inválido sin
    // gastar I/O escribiendo el archivo. El chequeo que de verdad importa
    // (magic bytes) pasa después de escrito, en el route handler.
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(null, false);
    }
    cb(null, true);
  },
}).single("comprobante");

/**
 * Resuelve `filename` (tal como se guardó en `orders.comprobante_path`) a
 * una ruta absoluta DENTRO de uploads/comprobantes/, o `null` si el
 * resultado se saldría de ese directorio -- defensa en profundidad: hoy
 * `filename` siempre lo generó este mismo módulo (nunca viene directo del
 * cliente), pero servir un archivo es una operación sensible y este chequeo
 * es barato, así que se hace igual (ver server/src/routes/orders.js,
 * GET /:public_code/comprobante).
 */
function resolveComprobantePath(filename) {
  if (typeof filename !== "string" || filename.length === 0) return null;
  const resolved = path.join(COMPROBANTES_DIR, filename);
  const relative = path.relative(COMPROBANTES_DIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

module.exports = {
  COMPROBANTES_DIR,
  MAX_FILE_SIZE_BYTES,
  upload,
  resolveComprobantePath,
};
