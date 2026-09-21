"use strict";

// Envío de emails transaccionales (por ahora, solo el de recuperación de
// contraseña). Este módulo existe aparte de authPassword.js a propósito:
// el criterio de "si no está configurado, fallar de forma clara y visible"
// que se usó para Apple Sign-In (ver routes/authApple.js) y para Mercado
// Pago NO se puede aplicar acá.
//
// ¿Por qué no? Porque POST /api/auth/password/forgot tiene que responder
// SIEMPRE 200 { ok: true }, exista o no el email, se haya podido mandar el
// mail o no -- ese es el criterio anti-enumeración del endpoint (ver
// routes/authPassword.js). Si sendPasswordResetEmail lanzara un error
// visible cuando no hay proveedor configurado, o cuando el proveedor real
// falla, o filtraría "el email no se pudo enviar" (información) o rompería
// el contrato 200 siempre que ya coordinamos con el frontend.
//
// Por eso: esta función NUNCA lanza. Si hay un proveedor configurado
// (EMAIL_PROVIDER + credenciales) lo usa; si no, o si el envío real falla,
// loguea el link completo en la consola del server con un prefijo bien
// visible -- así se puede seguir desarrollando y probando el flujo
// end-to-end sin depender de tener ya una cuenta de email transaccional
// dada de alta (que es el caso hoy: EMAIL_PROVIDER todavía no está seteado).

const EMAIL_PROVIDER = String(process.env.EMAIL_PROVIDER || "").trim().toLowerCase();
const EMAIL_FROM = process.env.EMAIL_FROM || "HILO Store <onboarding@resend.dev>";

function buildEmailContent({ resetLink }) {
  const subject = "Recuperá tu contraseña — HILO Store";
  const text =
    `Recibimos un pedido para restablecer tu contraseña en HILO Store.\n\n` +
    `Si fuiste vos, entrá a este link (válido por 45 minutos):\n${resetLink}\n\n` +
    `Si no pediste esto, podés ignorar este email -- tu contraseña actual sigue funcionando.`;
  const html =
    `<p>Recibimos un pedido para restablecer tu contraseña en <strong>HILO Store</strong>.</p>` +
    `<p>Si fuiste vos, hacé click en el siguiente link (válido por 45 minutos):</p>` +
    `<p><a href="${resetLink}">${resetLink}</a></p>` +
    `<p>Si no pediste esto, podés ignorar este email -- tu contraseña actual sigue funcionando.</p>`;
  return { subject, text, html };
}

/**
 * Envía por Resend (https://resend.com) vía su API REST directa (fetch,
 * sin agregar el SDK como dependencia -- Node 20 trae fetch nativo). Pensada
 * para poder enchufar otro proveedor después: cualquier función nueva con
 * la misma firma ({ to, subject, html, text }) se agrega a PROVIDERS abajo.
 */
async function sendViaResend({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("EMAIL_PROVIDER=resend pero falta RESEND_API_KEY");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend respondió ${response.status}: ${body}`);
  }

  return response.json();
}

// Mapa de proveedores soportados -- agregar acá una entrada nueva alcanza
// para enchufar otro (ej. Postmark, SES, SendGrid) sin tocar el resto.
const PROVIDERS = {
  resend: sendViaResend,
};

/**
 * Manda (o simula, en modo dev) el email de recuperación de contraseña.
 * Nunca lanza: cualquier falla se loguea acá adentro y se resuelve igual,
 * porque el caller (POST /api/auth/password/forgot) siempre debe responder
 * 200 { ok: true } sin importar el resultado del envío.
 */
async function sendPasswordResetEmail({ to, resetLink }) {
  const { subject, text, html } = buildEmailContent({ resetLink });

  if (!EMAIL_PROVIDER) {
    // Modo dev/consola: no hay proveedor configurado todavía (caso real de
    // este proyecto hoy). En vez de bloquear el flujo, se loguea el link
    // completo para poder probar "olvidé mi contraseña" de punta a punta.
    console.log(`[DEV][EMAIL NO ENVIADO] Link de reset de contraseña para ${to}: ${resetLink}`);
    return { delivered: false, mode: "dev-console" };
  }

  const send = PROVIDERS[EMAIL_PROVIDER];
  if (!send) {
    console.error(
      `[mailer] EMAIL_PROVIDER="${EMAIL_PROVIDER}" no está soportado (usar "resend" o dejarlo vacío). ` +
        `Cayendo a modo consola para no bloquear el flujo.`
    );
    console.log(`[DEV][EMAIL NO ENVIADO] Link de reset de contraseña para ${to}: ${resetLink}`);
    return { delivered: false, mode: "unsupported-provider" };
  }

  try {
    await send({ to, subject, html, text });
    return { delivered: true, mode: EMAIL_PROVIDER };
  } catch (err) {
    // El envío real falló (API key inválida, cuenta sin verificar, rate
    // limit del proveedor, etc.) -- se loguea para debug del server pero
    // NUNCA se propaga: el cliente de /password/forgot no se entera.
    console.error(`[mailer] Falló el envío real via "${EMAIL_PROVIDER}":`, err.message);
    console.log(`[DEV][EMAIL NO ENVIADO] Link de reset de contraseña para ${to}: ${resetLink}`);
    return { delivered: false, mode: "send-failed" };
  }
}

module.exports = { sendPasswordResetEmail };
