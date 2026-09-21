import { useState, useRef, useEffect } from "react";
import { forgotPassword, translateFieldError } from "../../services/authService.js";
import FormField from "./FormField.jsx";
import "./ForgotPasswordForm.css";

// Mensaje ÚNICO de éxito, sin importar si el email existe o no en el
// sistema (anti-enumeración, mismo criterio que el server — ver el
// comentario en forgotPassword() de authService.js). Nunca se muestra
// un mensaje distinto tipo "ese email no existe".
const GENERIC_SUCCESS_MESSAGE =
  "Si el correo existe en nuestro sistema, te enviamos un link para restablecer tu contraseña.";

function extractFieldError(fields, name) {
  if (!fields || fields[name] === undefined || fields[name] === null) return undefined;
  const value = fields[name];
  const code = Array.isArray(value) ? value[0] : String(value);
  return translateFieldError(code);
}

/*
  4 estados: idle -> loading -> error | success.
  - error: SOLO por formato de email inválido o problema de red. El
    contrato no tiene un código "email no encontrado" (a propósito),
    así que ese estado no existe acá.
  - success: mensaje genérico fijo, no depende de la respuesta real
    del server más que de que no haya sido un error.
*/
export default function ForgotPasswordForm({ onBack }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | error | success
  const [formError, setFormError] = useState(null);

  const emailRef = useRef(null);
  const errorRef = useRef(null);
  const successRef = useRef(null);

  useEffect(() => {
    if (status === "error") {
      if (extractFieldError(formError?.fields, "email")) {
        emailRef.current?.focus();
      } else {
        errorRef.current?.focus();
      }
    } else if (status === "success") {
      successRef.current?.focus();
    }
  }, [status, formError]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (status === "loading") return; // protección de doble submit

    setStatus("loading");
    setFormError(null);

    try {
      await forgotPassword({ email });
      setStatus("success");
    } catch (err) {
      // Solo llega acá por invalid_input (formato) o network_error.
      setStatus("error");
      setFormError(err);
    }
  }

  const isLoading = status === "loading";
  const emailFieldError = extractFieldError(formError?.fields, "email");
  const generalError = formError && !emailFieldError ? formError.message : null;

  if (status === "success") {
    return (
      <div className="forgot-password">
        <p
          className="forgot-password__success focus-ring-always"
          role="status"
          tabIndex={-1}
          ref={successRef}
        >
          {GENERIC_SUCCESS_MESSAGE}
        </p>
        <button type="button" className="btn btn--secondary btn--full" onClick={onBack}>
          Volver a ingresar
        </button>
      </div>
    );
  }

  return (
    <form className="forgot-password" onSubmit={handleSubmit} noValidate>
      {generalError && (
        <p
          className="forgot-password__error focus-ring-always"
          role="alert"
          tabIndex={-1}
          ref={errorRef}
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

      <button
        className="btn btn--primary btn--full"
        type="submit"
        disabled={isLoading}
        aria-busy={isLoading}
      >
        {isLoading ? "Enviando…" : "Enviar link de recuperación"}
      </button>

      <button
        type="button"
        className="forgot-password__back"
        onClick={onBack}
        disabled={isLoading}
      >
        Volver a ingresar
      </button>
    </form>
  );
}
