/*
  authService.js — HILO Store
  ---------------------------------------------------------
  Única capa que habla con /api/auth/*. Los componentes nunca
  hacen fetch directo ni parsean la forma cruda del backend:
  toda función de acá devuelve datos ya "limpios" (ej. el user)
  o lanza un error normalizado con la forma:

    { code: string, message: string, fields?: object, status?: number }

  Contrato de API coordinado con el server (lyon), server real
  en http://localhost:4000, expuesto en el browser vía el proxy
  de /api configurado en vite.config.js (mismo origen -> las
  cookies HttpOnly de sesión viajan sin fricción).

  Seguridad: nunca se guarda token/sesión en localStorage ni
  sessionStorage. La sesión vive 100% en la cookie HttpOnly que
  maneja el server; acá solo se pregunta getSession() al montar
  la app para saber si ya hay una sesión activa.
*/

const ERROR_MESSAGES = {
  invalid_input: "Revisá los datos ingresados.",
  email_taken: "Ese correo ya está registrado.",
  invalid_credentials: "Correo o contraseña incorrectos.",
  too_many_attempts: "Demasiados intentos. Probá de nuevo en unos minutos.",
  no_session: "No hay una sesión activa.",
  // Usado hoy por Google OAuth (falta configurar credenciales reales de
  // Google Cloud Console). Genérico a propósito: cualquier método social
  // que todavía no tenga credenciales reales puede reusar este código.
  not_configured: "Ingresar con Google todavía no está disponible.",
  // El backend gatea métodos por AUTH_METHODS_ENABLED (VITE_AUTH_METHODS acá
  // en el front) -- este código es la defensa en profundidad para cuando
  // ambas listas quedan desalineadas (el front no debería ni mostrar un tab
  // apagado, pero un .env desactualizado es un escenario real).
  method_disabled: "Este método para ingresar no está disponible en este momento.",
  invalid_or_expired_token:
    "Este link o código venció o ya fue usado. Pedí uno nuevo.",
  network_error: "No se pudo conectar con el servidor. Revisá tu conexión.",
  unknown: "Ocurrió un error inesperado. Probá de nuevo.",
};

// Códigos de error POR CAMPO que devuelve el server en `fields` (ej.
// { email: "required" }) -- distintos de ERROR_MESSAGES de arriba, que son
// el error de nivel de formulario/petición. Sin este mapeo, la UI mostraba
// el código crudo tal cual (hallazgo de la pasada de QA: "required" o
// "invalid_format" en pantalla en vez de un mensaje en español).
const FIELD_ERROR_MESSAGES = {
  required: "Este campo es obligatorio.",
  invalid_format: "El formato no es válido.",
};

/**
 * Traduce un código de error de campo (ej. "required", "min_length_8") a
 * un mensaje en español. Los códigos "min_length_N" son dinámicos (N viene
 * del server, hoy 8) así que se resuelven con un patrón en vez de listarlos
 * todos a mano -- si el mínimo cambia del lado del server, este mensaje se
 * actualiza solo, sin tocar el frontend.
 */
export function translateFieldError(code) {
  if (!code) return undefined;
  if (FIELD_ERROR_MESSAGES[code]) return FIELD_ERROR_MESSAGES[code];
  const minLengthMatch = /^min_length_(\d+)$/.exec(code);
  if (minLengthMatch) {
    return `Tiene que tener al menos ${minLengthMatch[1]} caracteres.`;
  }
  return code;
}

function buildError(code, overrides = {}) {
  return {
    code: code || "unknown",
    message: ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown,
    ...overrides,
  };
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Wrapper de fetch para /api/auth/*. Siempre manda credentials:
 * 'include' (cookies same-origin vía el proxy de Vite) y siempre
 * lanza un error con la forma { code, message, fields?, status? }
 * cuando la respuesta no es 2xx o cuando falla la red.
 */
async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
  } catch {
    throw buildError("network_error");
  }

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    const code = data?.error || "unknown";
    throw buildError(code, {
      message: data?.message || ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown,
      fields: data?.fields,
      status: response.status,
    });
  }

  return data ?? {};
}

// ============ EMAIL + CONTRASEÑA ============

export async function login({ email, password }) {
  const data = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return data.user;
}

export async function register({ email, password }) {
  const data = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return data.user;
}

export async function logout() {
  await request("/api/auth/logout", { method: "POST" });
  return true;
}

/**
 * Se llama al montar la app para saber si ya hay sesión activa
 * (persistencia real vía cookie HttpOnly, nunca localStorage).
 * Devuelve el user si hay sesión, o null si no (no_session no se
 * trata como error "visible": es el estado normal de "deslogueado").
 */
export async function getSession() {
  try {
    const data = await request("/api/auth/session", { method: "GET" });
    return data.user ?? null;
  } catch (err) {
    if (err.code === "no_session") return null;
    throw err;
  }
}

// ============ RECUPERACIÓN DE CONTRASEÑA ============

/**
 * Pide el link de reseteo por email. Contrato anti-enumeración: el
 * server SIEMPRE devuelve 200 { ok: true } sin importar si el email
 * existe o no, así que esta función nunca lanza un error "no existe" —
 * el único error posible acá es invalid_input (formato de email) o
 * network_error. El componente que llama a esto tiene que mostrar
 * siempre el mismo mensaje genérico de éxito, sin condicionarlo a
 * nada de la respuesta.
 */
export async function forgotPassword({ email }) {
  await request("/api/auth/password/forgot", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return true;
}

/**
 * Define una contraseña nueva a partir del token del link de reseteo.
 * invalid_or_expired_token es un único código genérico por diseño: el
 * contrato no distingue (ni el frontend debe intentar adivinar) si el
 * token no existe, ya se usó, o expiró.
 */
export async function resetPassword({ token, password }) {
  await request("/api/auth/password/reset", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
  return true;
}

// ============ GOOGLE OAUTH ============

/**
 * Hoy el server siempre devuelve 501 not_configured (sin credenciales
 * reales de Google Cloud Console todavía). Esta función igual existe y
 * respeta el contrato: el componente que la llama debe mostrar el
 * error de forma visible pero SIN bloquear los otros métodos de login.
 * `credential` es el ID token que devuelve el flujo de Google.
 */
export async function googleSignIn({ credential }) {
  const data = await request("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential }),
  });
  return data.user;
}

// ============ TELÉFONO / SMS ============

/**
 * Pide el código por SMS. Contrato anti-enumeración, igual criterio
 * que forgotPassword(): el server SIEMPRE devuelve 200 { ok: true }
 * sin importar si el teléfono ya tiene cuenta o no. El único error
 * posible acá es invalid_input (formato) o network_error.
 */
export async function requestPhoneCode({ phone }) {
  await request("/api/auth/phone/request-code", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
  return true;
}

/**
 * Verifica el código de 6 dígitos. Sirve tanto para loguear un
 * teléfono ya existente como para crear la cuenta la primera vez —
 * el server decide cuál de los dos casos es, acá no hace falta
 * distinguirlos. invalid_or_expired_token es un único código
 * genérico por diseño (igual que en reset de contraseña): no
 * distingue código incorrecto / usado / vencido.
 */
export async function verifyPhoneCode({ phone, code }) {
  const data = await request("/api/auth/phone/verify-code", {
    method: "POST",
    body: JSON.stringify({ phone, code }),
  });
  return data.user;
}
