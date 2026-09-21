import { useState, useEffect, useRef } from "react";
import { getSession, logout } from "../../services/authService.js";
import { ENABLED_AUTH_METHODS, HOME_URL, getNextUrl } from "../../config/authConfig.js";
import AuthTabs from "./AuthTabs.jsx";
import EmailPasswordForm from "./EmailPasswordForm.jsx";
import GoogleSignInButton from "./GoogleSignInButton.jsx";
import PhoneSignInForm from "./PhoneSignInForm.jsx";
import ForgotPasswordForm from "./ForgotPasswordForm.jsx";
import "./AuthContainer.css";

// Con un solo método habilitado no tiene sentido un tablist ARIA de un
// elemento -- VITE_AUTH_METHODS=google (valor real de hoy) cae acá.
const INITIAL_TAB = ENABLED_AUTH_METHODS[0];
const SHOW_TABS = ENABLED_AUTH_METHODS.length > 1;

// Permite llegar directo a "olvidé mi contraseña" con un link propio
// (?view=forgot-password), ej. desde el botón "pedí uno nuevo" que se
// muestra cuando un link de reset ya venció (ver ResetPasswordForm).
// Esto es una convención interna del frontend, no forma parte del
// contrato de API coordinado con el server: no agrega ni cambia
// ningún endpoint, solo decide qué vista mostrar al montar.
function getInitialAuthView() {
  if (typeof window === "undefined") return "auth";
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "forgot-password" ? "forgot-password" : "auth";
}

const TAB_COPY = {
  password: {
    title: "Accedé a tu cuenta",
    description: "Ingresá o creá una cuenta con tu email y contraseña.",
  },
  google: {
    title: "Continuar con Google",
    description: "Accedé usando tu cuenta de Google.",
  },
  phone: {
    title: "Ingresá con tu teléfono",
    description: "Te mandamos un código por SMS para entrar o crear tu cuenta.",
  },
};

/*
  Administra: qué pestaña/modo está activo, y al montar llama a
  getSession() para saber si ya hay una sesión activa (persistencia
  real vía cookie HttpOnly — nunca localStorage/sessionStorage).
  El estado de cada formulario (idle/loading/error/success) vive en
  cada componente hijo, más cerca de dónde se usa.
*/
export default function AuthContainer() {
  const [sessionStatus, setSessionStatus] = useState("loading"); // loading | error | ready
  const [sessionError, setSessionError] = useState(null);
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState(INITIAL_TAB);
  const [authView, setAuthView] = useState(getInitialAuthView); // "auth" | "forgot-password"
  const [logoutStatus, setLogoutStatus] = useState("idle");

  const panelHeadingRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((sessionUser) => {
        if (cancelled) return;
        // Si ya había una sesión activa y nos mandaron acá con ?next= (ej.
        // el checkout), no tiene sentido mostrar la pantalla "Hola, {email}"
        // -- se vuelve directo a donde se estaba (ver getNextUrl en
        // config/authConfig.js). Sin ?next= NO se cae a HOME_URL a propósito:
        // esta es la ruta del ícono "Mi cuenta" del header, y rebotar a la
        // home dejaba a quien ya estaba logueado sin ver que tenía sesión ni
        // poder cerrarla. El redirect a HOME_URL queda solo para justo
        // después de loguearse (handleAuthenticated).
        if (sessionUser) {
          const target = getNextUrl();
          if (target) {
            window.location.href = target;
            return;
          }
        }
        setUser(sessionUser);
        setSessionStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setSessionError(err);
        setSessionStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Foco gestionado: al cambiar de pestaña, el foco va al título del
  // panel nuevo (que el usuario ya está leyendo con el lector de
  // pantalla / mirando en pantalla), en vez de quedar "perdido".
  useEffect(() => {
    if (sessionStatus === "ready" && !user) {
      panelHeadingRef.current?.focus();
    }
  }, [activeTab, authView, sessionStatus, user]);

  function handleAuthenticated(authenticatedUser) {
    // ?next= (ej. "/checkout.html", ver checkout-page.js) gana por sobre
    // la home genérica: si algo puntual mandó a loguearse para volver,
    // ese es el destino. Sin next, cae al comportamiento de siempre --
    // si hay una home configurada (VITE_HOME_URL), el login exitoso manda
    // directo para allá en vez de mostrar la pantalla "Hola, {email}" --
    // ver comentario largo en config/authConfig.js sobre por qué no hay
    // un default fijo para esa variable.
    const target = getNextUrl() || HOME_URL;
    if (target) {
      window.location.href = target;
      return;
    }
    setUser(authenticatedUser);
  }

  async function handleLogout() {
    setLogoutStatus("loading");
    try {
      await logout();
    } catch {
      // Si el logout falla en el server (red, 5xx), igual limpiamos
      // el estado local: no tiene sentido dejar a la persona
      // "atrapada" en la pantalla logueada por un error transitorio.
    } finally {
      setUser(null);
      setLogoutStatus("idle");
      setActiveTab(INITIAL_TAB);
      setAuthView("auth");
    }
  }

  if (sessionStatus === "loading") {
    return (
      <main className="auth-card" aria-busy="true">
        <p className="auth-card__loading" role="status">
          Comprobando tu sesión…
        </p>
      </main>
    );
  }

  if (sessionStatus === "error") {
    return (
      <main className="auth-card">
        <p className="auth-card__error" role="alert">
          {sessionError?.message || "No pudimos comprobar tu sesión."}
        </p>
        <button
          className="btn btn--secondary btn--full"
          type="button"
          onClick={() => window.location.reload()}
        >
          Reintentar
        </button>
      </main>
    );
  }

  if (user) {
    // Esta pantalla se muestra cuando getSession() encuentra una sesión ya
    // activa al montar sin ?next= (ej. tocar "Mi cuenta" estando logueado):
    // el redirect automático a HOME_URL solo dispara justo después de
    // loguearse (handleAuthenticated). Por eso el link manual a la tienda
    // sigue teniendo sentido acá.
    return (
      <main className="auth-card">
        <div className="auth-card__brand">HILO</div>
        <h1 className="auth-card__title">Hola, {user.email}</h1>
        <p className="auth-card__copy">Ya tenés una sesión activa en HILO Store.</p>

        {HOME_URL && (
          <a className="btn btn--secondary btn--full" href={HOME_URL}>
            Volver a la tienda
          </a>
        )}

        <button
          className="btn btn--outline btn--full"
          type="button"
          onClick={handleLogout}
          disabled={logoutStatus === "loading"}
          aria-busy={logoutStatus === "loading"}
        >
          {logoutStatus === "loading" ? "Saliendo…" : "Cerrar sesión"}
        </button>
      </main>
    );
  }

  if (authView === "forgot-password") {
    return (
      <main className="auth-card">
        <div className="auth-card__brand">HILO</div>
        <h1 className="auth-card__title focus-ring-always" ref={panelHeadingRef} tabIndex={-1}>
          Recuperar contraseña
        </h1>
        <p className="auth-card__copy">
          Ingresá tu correo y, si existe una cuenta con ese email, te enviamos un link para
          elegir una contraseña nueva.
        </p>
        <ForgotPasswordForm onBack={() => setAuthView("auth")} />
      </main>
    );
  }

  const copy = TAB_COPY[activeTab];

  return (
    <main className="auth-card">
      <div className="auth-card__brand">HILO</div>

      {SHOW_TABS && <AuthTabs activeTab={activeTab} onChange={setActiveTab} />}

      <div
        // El rol/atributos de tabpanel solo tienen sentido si el tablist
        // (AuthTabs) está montado -- con un solo método no hay tabs a los
        // que asociar el panel, así que es un <div> común.
        role={SHOW_TABS ? "tabpanel" : undefined}
        id={SHOW_TABS ? `auth-panel-${activeTab}` : undefined}
        aria-labelledby={SHOW_TABS ? `auth-tab-${activeTab}` : undefined}
      >
        <h1 className="auth-card__title focus-ring-always" ref={panelHeadingRef} tabIndex={-1}>
          {copy.title}
        </h1>
        <p className="auth-card__copy">{copy.description}</p>

        {activeTab === "password" && (
          <EmailPasswordForm
            onAuthenticated={handleAuthenticated}
            onForgotPassword={() => setAuthView("forgot-password")}
          />
        )}
        {activeTab === "google" && <GoogleSignInButton onAuthenticated={handleAuthenticated} />}
        {activeTab === "phone" && <PhoneSignInForm onAuthenticated={handleAuthenticated} />}
      </div>
    </main>
  );
}
