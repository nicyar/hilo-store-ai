import { useState, useRef, useEffect } from "react";
import { googleSignIn } from "../../services/authService.js";
import { GOOGLE_CLIENT_ID } from "../../config/authConfig.js";
import "./GoogleSignInButton.css";

const GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

// El script de Google Identity Services es el mismo para toda la app -- se
// carga una sola vez y la promesa se comparte entre montajes/remontajes del
// componente (ej. si se cambia de tab y se vuelve a "Google").
let gsiScriptPromise = null;
function loadGsiScript() {
  if (gsiScriptPromise) return gsiScriptPromise;
  gsiScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve(window.google);
      return;
    }
    const script = document.createElement("script");
    script.src = GSI_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error("gsi_load_error"));
    document.head.appendChild(script);
  });
  return gsiScriptPromise;
}

/*
  Integración real con Google Identity Services (GSI).

  El SDK se carga siempre, incluso sin VITE_GOOGLE_CLIENT_ID todavía real --
  así se puede verificar en el navegador que la carga del script funciona
  de forma independiente de tener credenciales (ver CLAUDE.md, Google OAuth
  sigue pendiente de credenciales reales).

  El botón mantiene su estilo propio (btn btn--secondary, igual que el
  resto de los métodos) en vez de usar el botón que renderiza Google
  (accounts.id.renderButton), que vive en un iframe y no se puede estilar
  al nivel del resto de la UI. En su lugar se llama a accounts.id.prompt()
  dentro del handler de click: al dispararse en respuesta directa a un
  gesto del usuario, el navegador igual muestra el selector de cuenta de
  Google (FedCM/One Tap).

  Limitación conocida de este approach (documentada por Google): si la
  persona ya cerró el selector antes sin elegir cuenta, prompt() puede
  quedar en cooldown y no volver a mostrarse por un rato. Se cubre: si el
  selector nunca llega a mostrarse, se sale de "loading" con un mensaje en
  vez de dejar el botón colgado en "Conectando con Google...".

  Mientras VITE_GOOGLE_CLIENT_ID esté vacío, initialize()/prompt() no tienen
  sentido -- Google los rechaza sin client_id real. En ese caso el click
  llama directo al backend con credential vacío (mismo comportamiento que
  tenía el stub original), lo que alcanza para verificar en el navegador
  que la petición llega a POST /api/auth/google y vuelve 501
  not_configured. Cuando se cargue el Client ID real (tiene que ser
  IDÉNTICO a GOOGLE_CLIENT_ID en server/.env), este componente pasa solo al
  flujo completo sin tocar código.
*/
export default function GoogleSignInButton({ onAuthenticated }) {
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [error, setError] = useState(null);
  const errorRef = useRef(null);
  const googleRef = useRef(null);
  const onAuthenticatedRef = useRef(onAuthenticated);
  onAuthenticatedRef.current = onAuthenticated;

  useEffect(() => {
    if (status === "error") errorRef.current?.focus();
  }, [status]);

  // Se define una sola vez (deps []) porque solo usa refs y los setters de
  // useState, ambos estables entre renders -- no necesita "verse" cada
  // cambio de props para seguir siendo correcta.
  useEffect(() => {
    let cancelled = false;

    async function handleCredentialResponse(response) {
      try {
        const user = await googleSignIn({ credential: response.credential });
        setStatus("idle");
        onAuthenticatedRef.current(user);
      } catch (err) {
        setStatus("error");
        setError(err);
      }
    }

    loadGsiScript()
      .then((google) => {
        if (cancelled || !GOOGLE_CLIENT_ID) return;
        google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleCredentialResponse,
        });
        googleRef.current = google;
      })
      .catch(() => {
        // No bloquea la pantalla al montar -- el error recién se muestra
        // si la persona intenta usar este método (mismo criterio que el
        // resto de los errores acá).
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleClick() {
    if (status === "loading") return; // protección de doble submit

    setStatus("loading");
    setError(null);

    if (!GOOGLE_CLIENT_ID || !googleRef.current) {
      // Ver comentario de arriba del componente.
      try {
        const user = await googleSignIn({ credential: null });
        setStatus("idle");
        onAuthenticated(user);
      } catch (err) {
        setStatus("error");
        setError(err);
      }
      return;
    }

    googleRef.current.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        setStatus("error");
        setError({
          message: "No se pudo abrir el selector de cuentas de Google. Probá de nuevo.",
        });
      }
    });
  }

  const isLoading = status === "loading";

  return (
    <div className="google-signin">
      <button
        type="button"
        className="btn btn--secondary btn--full google-signin__btn"
        onClick={handleClick}
        disabled={isLoading}
        aria-busy={isLoading}
      >
        <GoogleGlyph />
        {isLoading ? "Conectando con Google…" : "Continuar con Google"}
      </button>

      {error && (
        <p
          className="google-signin__error focus-ring-always"
          role="alert"
          tabIndex={-1}
          ref={errorRef}
        >
          {error.message}
        </p>
      )}
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg className="btn__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.47c-.28 1.5-1.13 2.78-2.4 3.63v3.02h3.89c2.27-2.09 3.58-5.17 3.58-8.84z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.89-3.02c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.73-4.95H1.26v3.11C3.24 21.3 7.28 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.37-2.28V6.61H1.26A11.98 11.98 0 0 0 0 12c0 1.94.46 3.77 1.26 5.39l4.01-3.11z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.77 0 3.35.61 4.6 1.8l3.45-3.45C17.95 1.19 15.24 0 12 0 7.28 0 3.24 2.7 1.26 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77z"
      />
    </svg>
  );
}
