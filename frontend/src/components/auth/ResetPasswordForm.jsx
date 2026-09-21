import { useState, useRef, useEffect } from "react";
import { resetPassword, translateFieldError } from "../../services/authService.js";
import FormField from "./FormField.jsx";
import "./ResetPasswordForm.css";

function extractFieldError(fields, name) {
  if (!fields || fields[name] === undefined || fields[name] === null) return undefined;
  const value = fields[name];
  const code = Array.isArray(value) ? value[0] : String(value);
  return translateFieldError(code);
}

function getTokenFromUrl() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("token");
}

// Limpia ?view=reset-password&token=... de la URL visible sin navegar
// ni recargar. Se llama después de un reset exitoso para que un
// refresh (o volver atrás) no vuelva a mostrar este formulario con un
// token que ya se usó.
function clearResetQueryParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("view");
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

/*
  Se monta cuando App.jsx detecta ?view=reset-password en la URL (ver
  comentario ahí). El token viaja en la URL, no en el body de ningún
  otro pedido previo, así que se lee UNA sola vez al montar con
  useState(getTokenFromUrl) — no hace falta releerlo después.

  4 estados: idle -> loading -> error | success.
  - Sin token en la URL: no se muestra un formulario roto, se muestra
    directamente un mensaje de link inválido.
  - error invalid_or_expired_token: mensaje genérico único (el
    contrato no distingue token inexistente / usado / vencido) más un
    link para volver a pedir uno nuevo.
  - Antes de mandar nada al server, se valida en el cliente que las
    dos contraseñas coincidan (la validación de longitud mínima la
    hace el server, igual que en registro).
*/
export default function ResetPasswordForm() {
  const [token] = useState(getTokenFromUrl);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | error | success
  const [formError, setFormError] = useState(null);
  const [mismatch, setMismatch] = useState(false);

  const passwordRef = useRef(null);
  const confirmRef = useRef(null);
  const errorRef = useRef(null);
  const successRef = useRef(null);

  useEffect(() => {
    if (status === "error") {
      if (mismatch) {
        confirmRef.current?.focus();
      } else if (extractFieldError(formError?.fields, "password")) {
        passwordRef.current?.focus();
      } else {
        errorRef.current?.focus();
      }
    } else if (status === "success") {
      successRef.current?.focus();
    }
  }, [status, formError, mismatch]);

  if (!token) {
    return (
      <main className="auth-card">
        <div className="auth-card__brand">HILO</div>
        <h1 className="auth-card__title">Link inválido</h1>
        <p className="auth-card__error" role="alert">
          Link inválido o incompleto. Pedí un link nuevo desde la pantalla de ingreso.
        </p>
        <a className="btn btn--secondary btn--full" href="/?view=forgot-password">
          Pedir un link nuevo
        </a>
      </main>
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (status === "loading") return; // protección de doble submit

    setFormError(null);

    if (password !== confirmPassword) {
      setMismatch(true);
      setStatus("error");
      return;
    }

    setMismatch(false);
    setStatus("loading");

    try {
      await resetPassword({ token, password });
      setStatus("success");
      clearResetQueryParams();
    } catch (err) {
      setStatus("error");
      setFormError(err);
    }
  }

  const isLoading = status === "loading";
  const passwordFieldError = mismatch ? undefined : extractFieldError(formError?.fields, "password");
  const confirmFieldError = mismatch ? "Las contraseñas no coinciden." : undefined;
  const isTokenExpired = formError?.code === "invalid_or_expired_token";
  const generalError = formError && !passwordFieldError && !isTokenExpired ? formError.message : null;

  if (status === "success") {
    return (
      <main className="auth-card">
        <div className="auth-card__brand">HILO</div>
        <div role="status">
          <h1 className="auth-card__title focus-ring-always" ref={successRef} tabIndex={-1}>
            Contraseña actualizada
          </h1>
          <p className="auth-card__copy">Ya podés ingresar con tu nueva contraseña.</p>
        </div>
        <a className="btn btn--primary btn--full" href="/">
          Ir a iniciar sesión
        </a>
      </main>
    );
  }

  return (
    <main className="auth-card">
      <div className="auth-card__brand">HILO</div>
      <h1 className="auth-card__title">Definí tu nueva contraseña</h1>
      <p className="auth-card__copy">Ingresá y confirmá tu nueva contraseña.</p>

      <form className="reset-password" onSubmit={handleSubmit} noValidate>
        {isTokenExpired && (
          <div
            className="reset-password__expired focus-ring-always"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
          >
            <p>{formError.message}</p>
            <a className="reset-password__link" href="/?view=forgot-password">
              Pedir un link nuevo
            </a>
          </div>
        )}

        {!isTokenExpired && generalError && (
          <p
            className="reset-password__error focus-ring-always"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
          >
            {generalError}
          </p>
        )}

        <FormField
          label="Contraseña nueva"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
          disabled={isLoading}
          inputRef={passwordRef}
          error={passwordFieldError}
        />

        <FormField
          label="Confirmar contraseña"
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
          required
          disabled={isLoading}
          inputRef={confirmRef}
          error={confirmFieldError}
        />

        <button
          className="btn btn--primary btn--full"
          type="submit"
          disabled={isLoading}
          aria-busy={isLoading}
        >
          {isLoading ? "Guardando…" : "Guardar nueva contraseña"}
        </button>
      </form>
    </main>
  );
}
