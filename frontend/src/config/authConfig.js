/*
  authConfig.js — único lugar que lee las env vars de gating/config de auth.

  AuthTabs.jsx y AuthContainer.jsx necesitan la MISMA lista de métodos
  habilitados (para renderizar los tabs y para elegir el tab inicial) --
  centralizar el parseo acá evita que se desincronicen si mañana cambia el
  criterio de validación/orden/fallback en un solo lugar y no en el otro.

  Mismo nombre/semántica que AUTH_METHODS_ENABLED del backend (lyon,
  server/src/lib/authMethods.js): lista separada por comas, default a todos
  los métodos si la env var no está seteada, fail-closed ante un nombre
  desconocido (un typo nunca "activa de más").
*/

// Orden canónico de la UI -- independiente del orden en que alguien haya
// escrito VITE_AUTH_METHODS en el .env, para que los tabs siempre aparezcan
// en el mismo orden.
const METHOD_ORDER = ["password", "google", "phone"];

function parseEnabledMethods() {
  const raw = String(import.meta.env.VITE_AUTH_METHODS || "").trim();
  if (!raw) return METHOD_ORDER;

  const requested = new Set(
    raw
      .split(",")
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean)
  );
  const filtered = METHOD_ORDER.filter((m) => requested.has(m));

  // Si todo lo que vino en la env var era inválido (typos), no dejamos la
  // pantalla de login sin ningún método -- mismo default que el backend.
  return filtered.length > 0 ? filtered : METHOD_ORDER;
}

export const ENABLED_AUTH_METHODS = parseEnabledMethods();

export const GOOGLE_CLIENT_ID = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();

// URL de la home del sitio vanilla para el redirect post-login. null (no
// string vacío) cuando no está seteada, así el resto del código puede hacer
// `if (HOME_URL)` sin distinguir "" de undefined.
const rawHomeUrl = String(import.meta.env.VITE_HOME_URL || "").trim();
export const HOME_URL = rawHomeUrl.length > 0 ? rawHomeUrl : null;

/**
 * `?next=` -- a dónde volver después de loguearse cuando quien mandó acá
 * fue otra pantalla del sitio (hoy: checkout.html, que redirige a
 * `/login?next=/checkout.html` ante un 401, ver js/checkout-page.js y
 * CLAUDE.md / plan de checkout, Etapa 2). Tiene prioridad sobre HOME_URL
 * -- si alguien te mandó a loguearte para volver a un lugar puntual, ese
 * lugar gana por sobre la home genérica.
 *
 * Validación estricta contra open redirect: solo se acepta un path
 * relativo propio del mismo origen ("/checkout.html", "/algo?x=1"). Se
 * rechaza cualquier cosa que no empiece con exactamente un "/" (una URL
 * absoluta como "https://evil.com" o un path protocol-relative como
 * "//evil.com" -- ambos interpretables por el browser como "andá a otro
 * host" si se los pasara tal cual a window.location.href).
 */
export function getNextUrl() {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("next");
  if (!raw) return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return null;
}
