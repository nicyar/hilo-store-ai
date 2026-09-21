"use strict";

// Envío de SMS transaccionales (por ahora, solo el código de verificación de
// login por teléfono). Mismo criterio y misma estructura que mailer.js:
//
// POST /api/auth/phone/request-code tiene que responder SIEMPRE 200
// { ok: true }, exista o no ya un usuario con ese teléfono, se haya podido
// mandar el SMS real o no -- mismo criterio anti-enumeración que
// /password/forgot. Por eso esta función NUNCA lanza: si hay un proveedor
// configurado (SMS_PROVIDER + credenciales) lo usa; si no, o si el envío
// real falla, loguea el código completo en la consola del server con un
// prefijo bien visible -- así se puede probar el flujo de punta a punta sin
// depender de tener ya una cuenta de SMS dada de alta (caso real hoy:
// SMS_PROVIDER todavía no está seteado).

const SMS_PROVIDER = String(process.env.SMS_PROVIDER || "").trim().toLowerCase();

function buildMessageBody(code) {
  return `HILO Store: tu código de verificación es ${code}. Vence en 10 minutos. Si no lo pediste vos, ignorá este mensaje.`;
}

/**
 * Envía por Twilio (https://www.twilio.com) vía su API REST directa
 * (fetch, sin agregar el SDK de Twilio como dependencia -- mismo criterio
 * que mailer.js con Resend: Node 20 trae fetch nativo, y no vale la pena
 * sumar una dependencia entera por un solo POST). Pensada para poder
 * enchufar otro proveedor después: cualquier función nueva con la misma
 * firma ({ to, body }) se agrega a PROVIDERS abajo.
 */
async function sendViaTwilio({ to, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error(
      "SMS_PROVIDER=twilio pero falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER"
    );
  }

  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: fromNumber, Body: body });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new Error(`Twilio respondió ${response.status}: ${responseBody}`);
  }

  return response.json();
}

// Mapa de proveedores soportados -- agregar acá una entrada nueva alcanza
// para enchufar otro (ej. Vonage, AWS SNS) sin tocar el resto.
const PROVIDERS = {
  twilio: sendViaTwilio,
};

/**
 * Manda (o simula, en modo dev) el SMS con el código de verificación. Nunca
 * lanza: cualquier falla se loguea acá adentro y se resuelve igual, porque
 * el caller (POST /api/auth/phone/request-code) siempre debe responder 200
 * { ok: true } sin importar el resultado del envío.
 */
async function sendVerificationSms({ to, code }) {
  const body = buildMessageBody(code);

  if (!SMS_PROVIDER) {
    // Modo dev/consola: no hay proveedor configurado todavía (caso real de
    // este proyecto hoy). En vez de bloquear el flujo, se loguea el código
    // completo para poder probar "login por teléfono" de punta a punta.
    console.log(`[DEV][SMS NO ENVIADO] Código para ${to}: ${code}`);
    return { delivered: false, mode: "dev-console" };
  }

  const send = PROVIDERS[SMS_PROVIDER];
  if (!send) {
    console.error(
      `[sms] SMS_PROVIDER="${SMS_PROVIDER}" no está soportado (usar "twilio" o dejarlo vacío). ` +
        `Cayendo a modo consola para no bloquear el flujo.`
    );
    console.log(`[DEV][SMS NO ENVIADO] Código para ${to}: ${code}`);
    return { delivered: false, mode: "unsupported-provider" };
  }

  try {
    await send({ to, body });
    return { delivered: true, mode: SMS_PROVIDER };
  } catch (err) {
    // El envío real falló (credenciales inválidas, número no verificado en
    // cuenta trial, rate limit del proveedor, etc.) -- se loguea para debug
    // del server pero NUNCA se propaga: el cliente de /request-code no se
    // entera, mismo contrato que mailer.js.
    console.error(`[sms] Falló el envío real via "${SMS_PROVIDER}":`, err.message);
    console.log(`[DEV][SMS NO ENVIADO] Código para ${to}: ${code}`);
    return { delivered: false, mode: "send-failed" };
  }
}

module.exports = { sendVerificationSms };
