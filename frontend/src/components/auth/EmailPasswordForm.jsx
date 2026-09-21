import { useState, useRef, useEffect } from "react";
import { login, register, translateFieldError } from "../../services/authService.js";
import FormField from "./FormField.jsx";
import "./EmailPasswordForm.css";

/*
  Decisión de diseño: login y registro comparten UNA sola pestaña
  ("Email") con un toggle interno ("Ingresar" / "Crear cuenta") en
  vez de dos pestañas separadas. Motivo: ambos flujos comparten
  exactamente los mismos dos campos (email, password) y el mismo
  contrato de error; separarlos en pestañas hubiera duplicado el
  formulario sin ganar claridad, y hubiera competido por espacio
  con las pestañas de método (Google/teléfono) que sí son métodos
  distintos entre sí.
*/

function extractFieldError(fields, name) {
  if (!fields || fields[name] === undefined || fields[name] === null) return undefined;
  const value = fields[name];
  const code = Array.isArray(value) ? value[0] : String(value);
  return translateFieldError(code);
}

export default function EmailPasswordForm({ onAuthenticated, onForgotPassword }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | error | success
  const [formError, setFormError] = useState(null);

  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const errorSummaryRef = useRef(null);

  // Al cambiar de modo, el formulario se siente "nuevo": se limpia
  // el error del modo anterior y se devuelve el foco al primer campo.
  useEffect(() => {
    setFormError(null);
    setStatus("idle");
  }, [mode]);

  // Gestión de foco al mostrar un error: si el error es de un campo
  // puntual, el foco va a ese campo; si es general (credenciales
  // inválidas, demasiados intentos, red), va al resumen de error.
  useEffect(() => {
    if (status !== "error" || !formError) return;
    if (extractFieldError(formError.fields, "email")) {
      emailRef.current?.focus();
    } else if (extractFieldError(formError.fields, "password")) {
      passwordRef.current?.focus();
    } else {
      errorSummaryRef.current?.focus();
    }
  }, [status, formError]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (status === "loading") return; // protección de doble submit

    setStatus("loading");
    setFormError(null);

    try {
      const action = mode === "login" ? login : register;
      const user = await action({ email, password });
      setStatus("success");
      onAuthenticated(user);
    } catch (err) {
      setStatus("error");
      setFormError(err);
    }
  }

  const isLoading = status === "loading";
  const emailFieldError = extractFieldError(formError?.fields, "email");
  const passwordFieldError = extractFieldError(formError?.fields, "password");
  const generalError = formError && !emailFieldError && !passwordFieldError ? formError.message : null;

  return (
    <div className="email-form-wrap">
      <div className="email-form__mode-toggle" role="group" aria-label="Elegí si querés ingresar o crear una cuenta">
        <button
          type="button"
          className={`email-form__mode-btn${mode === "login" ? " email-form__mode-btn--active" : ""}`}
          aria-pressed={mode === "login"}
          onClick={() => setMode("login")}
          disabled={isLoading}
        >
          Ingresar
        </button>
        <button
          type="button"
          className={`email-form__mode-btn${mode === "register" ? " email-form__mode-btn--active" : ""}`}
          aria-pressed={mode === "register"}
          onClick={() => setMode("register")}
          disabled={isLoading}
        >
          Crear cuenta
        </button>
      </div>

      <form className="email-form" onSubmit={handleSubmit} noValidate>
        {generalError && (
          <p
            className="email-form__error focus-ring-always"
            role="alert"
            tabIndex={-1}
            ref={errorSummaryRef}
          >
            {generalError}
          </p>
        )}

        <FormField
          label="Correo electrónico"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
          disabled={isLoading}
          inputRef={emailRef}
          error={emailFieldError}
        />

        <FormField
          label="Contraseña"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          disabled={isLoading}
          inputRef={passwordRef}
          error={passwordFieldError}
        />

        {mode === "login" && (
          <button
            type="button"
            className="email-form__forgot-link"
            onClick={onForgotPassword}
            disabled={isLoading}
          >
            ¿Olvidaste tu contraseña?
          </button>
        )}

        <button
          className="btn btn--primary btn--full"
          type="submit"
          disabled={isLoading}
          aria-busy={isLoading}
        >
          {isLoading
            ? mode === "login"
              ? "Ingresando…"
              : "Creando cuenta…"
            : mode === "login"
              ? "Ingresar"
              : "Crear cuenta"}
        </button>
      </form>
    </div>
  );
}
