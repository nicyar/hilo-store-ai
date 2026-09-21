"use strict";

// Detección de tipo de archivo real por "magic bytes" (los primeros bytes
// del contenido), NO por el `mimetype` que declara el cliente en el
// multipart/form-data (eso lo puede mentir cualquiera con curl -F
// "file=@evil.exe;type=image/jpeg" -- ver server/src/routes/orders.js,
// POST /:public_code/comprobante).
//
// Se implementa a mano en vez de instalar el paquete `file-type` (que era
// la sugerencia inicial): al momento de escribir esto, TODAS las versiones
// de `file-type` compatibles con CommonJS (13.x-16.x, que es lo máximo que
// soporta `require()` sin migrar el server entero a ESM -- ver "type":
// "commonjs" en package.json) tienen un CVE moderado abierto sin parche en
// esa rama (bucle infinito parseando un contenedor ASF armado a mano,
// GHSA-5v7r-6r5c-r473) -- alguien podría declarar mimetype: "image/jpeg" y
// subir un ASF corrupto para colgar el request. Como acá solo hace falta
// reconocer 3 firmas conocidas y fijas (JPEG/PNG/PDF), un chequeo manual de
// los primeros bytes es más chico, más rápido y no arrastra esa superficie
// de ataque -- no hace falta un parser general de formatos de archivo para
// esto. Si en el futuro hace falta reconocer más tipos, reevaluar con una
// versión de `file-type` que ya tenga el CVE resuelto en su rama CJS.

/**
 * Firmas de los 3 tipos que este proyecto acepta como comprobante. Cada
 * entrada es la secuencia de bytes que tiene que matchear desde el offset 0
 * del archivo.
 */
const SIGNATURES = [
  { mime: "image/jpeg", ext: ".jpg", bytes: [0xff, 0xd8, 0xff] },
  {
    mime: "image/png",
    ext: ".png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  // "%PDF-" en ASCII -- el spec de PDF permite algunos bytes de basura antes
  // (hasta 1024), pero para un comprobante subido recién por un usuario esa
  // flexibilidad no hace falta: si no arranca con "%PDF-" en el byte 0, se
  // rechaza.
  { mime: "application/pdf", ext: ".pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/**
 * Devuelve { mime, ext } si `buffer` arranca con alguna de las firmas
 * conocidas, o `null` si no matchea ninguna (archivo de otro tipo, vacío, o
 * más corto que la firma más larga).
 */
function detectFileType(buffer) {
  for (const sig of SIGNATURES) {
    if (buffer.length < sig.bytes.length) continue;
    let matches = true;
    for (let i = 0; i < sig.bytes.length; i += 1) {
      if (buffer[i] !== sig.bytes[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return { mime: sig.mime, ext: sig.ext };
  }
  return null;
}

const ALLOWED_MIME_TYPES = new Set(SIGNATURES.map((s) => s.mime));

// Firma más larga de las 3 (PNG, 8 bytes) -- no hace falta leer más que
// esto del archivo para decidir, aunque el archivo completo pese hasta 5MB.
const MAX_SIGNATURE_LENGTH = Math.max(...SIGNATURES.map((s) => s.bytes.length));

/**
 * Igual que `detectFileType`, pero lee solo los primeros bytes de un
 * archivo ya escrito en disco (`filePath`) en vez de recibir un buffer ya
 * en memoria -- usado después de que multer terminó de guardar el
 * comprobante (ver server/src/routes/orders.js).
 */
function detectFileTypeFromFilePath(filePath) {
  const fs = require("fs");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_SIGNATURE_LENGTH);
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_SIGNATURE_LENGTH, 0);
    return detectFileType(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { detectFileType, detectFileTypeFromFilePath, ALLOWED_MIME_TYPES };
