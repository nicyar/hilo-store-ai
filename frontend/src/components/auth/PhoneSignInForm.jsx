import { useState, useRef, useEffect } from "react";
import { requestPhoneCode, verifyPhoneCode, translateFieldError } from "../../services/authService.js";
import FormField from "./FormField.jsx";
import "./PhoneSignInForm.css";

// Validación básica de E.164 en el cliente: "+", código de país sin
// empezar en 0, y entre 8 y 15 dígitos en total (rango real de E.164).
// El server vuelve a validar esto (invalid_input/fields.phone) — este
// chequeo es solo para no hacer un viaje de red con un formato que ya
// se sabe inválido.
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

function extractFieldError(fields, name) {
  if (!fields || fields[name] === undefined || fields[name] === null) return undefined;
  const value = fields[name];
  const code = Array.isArray(value) ? value[0] : String(value);
  return translateFieldError(code);
}

/*
  Dos pasos, mismo criterio que ForgotPasswordForm/ResetPasswordForm:
  1. "phone": pide el teléfono, pide el código. Por anti-enumeración
     (igual que "olvidé mi contraseña") SIEMPRE se pasa al paso 2 si
     la petición fue 200, sin importar si el teléfono ya tenía cuenta.
  2. "code": pide el código de 6 dígitos. Si es válido, sesión iniciada
     (mismo callback onAuthenticated que el resto de los métodos). Si
     no, error genérico con opción de volver al paso 1 a pedir otro.

  Estados por paso: idle -> loading -> error | (avanza de paso).
*/
export default function PhoneSignInForm({ onAuthenticated }) {
  const [step, setStep] = useState("phone"); // "phone" | "code"
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [formError, setFormError] = useState(null);
  const [phoneFormatError, setPhoneFormatError] = useState(null);

  const phoneRef = useRef(null);
  const codeRef = useRef(null);
  const errorRef = useRef(null);
  const stepHeadingRef = useRef(null);

  // Foco gestionado entre pasos: al entrar a "code" el foco va al
  // encabezado de ese paso (lo que la persona está leyendo), no queda
  // "perdido" en el botón que ya desapareció.
  useEffect(() => {
    if (step === "code") {
      stepHeadingRef.current?.focus();
    }
  }, [step]);

  useEffect(() => {
    if (status !== "error") return;
    if (step === "phone" && (phoneFormatError || extractFieldError(formError?.fields, "phone"))) {
      phoneRef.current?.focus();
    } else {
      errorRef.current?.focus();
    }
  }, [status, formError, phoneFormatError, step]);

  async function handlePhoneSubmit(event) {
    event.preventDefault();
    if (status === "loading") return; // protección de doble submit

    setFormError(null);
    setPhoneFormatError(null);

    const trimmed = phone.trim();
    if (!E164_PATTERN.test(trimmed)) {
      setPhoneFormatError("Ingresá tu teléfono en formato internacional, ej. +5491122334455.");
      setStatus("error");
      return;
    }

    setStatus("loading");
    try {
      await requestPhoneCode({ phone: trimmed });
      setPhone(trimmed);
      setStatus("idle");
      setStep("code");
    } catch (err) {
      // Solo llega acá por invalid_input (formato, el server puede ser
      // más estricto) o network_error — nunca "teléfono no existe"
      // (anti-enumeración).
      setStatus("error");
      setFormError(err);
    }
  }

  async function handleCodeSubmit(event) {
    event.preventDefault();
    if (status === "loading") return; // protección de doble submit

    setStatus("loading");
    setFormError(null);
    try {
      const user = await verifyPhoneCode({ phone, code: code.trim() });
      setStatus("idle");
      onAuthenticated(user);
    } catch (err) {
      setStatus("error");
      setFormError(err);
    }
  }

  function handleBackToPhone() {
    setStep("phone");
    setCode("");
    setFormError(null);
    setStatus("idle");
  }

  const isLoading = status === "loading";

  if (step === "code") {
    const isInvalidCode = formError?.code === "invalid_or_expired_token";
    const generalError = formError && !isInvalidCode ? formError.message : null;

    return (
      <form className="phone-signin" onSubmit={handleCodeSubmit} noValidate>
        <h2
          className="phone-signin__step-title focus-ring-always"
          ref={stepHeadingRef}
          tabIndex={-1}
        >
          Ingresá el código
        </h2>
        <p className="phone-signin__copy">
          Te enviamos un código de 6 dígitos por SMS a <strong>{phone}</strong>.
        </p>

        {isInvalidCode && (
          <div
            className="phone-signin__expired focus-ring-always"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
          >
            <p>El código no es válido o venció, pedí uno nuevo.</p>
            <button type="button" className="phone-signin__link" onClick={handleBackToPhone}>
              Pedir un código nuevo
            </button>
          </div>
        )}

        {!isInvalidCode && generalError && (
          <p
            className="phone-signin__error focus-ring-always"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
          >
            {generalError}
          </p>
        )}

        <FormField
          label="Código de verificación"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          required
          disabled={isLoading}
          inputRef={codeRef}
        />

        <button
          className="btn btn--primary btn--full"
          type="submit"
          disabled={isLoading || code.length !== 6}
          aria-busy={isLoading}
        >
          {isLoading ? "Verificando…" : "Verificar"}
        </button>

        <button
          type="button"
          className="phone-signin__back"
          onClick={handleBackToPhone}
          disabled={isLoading}
        >
          Volver a ingresar el teléfono
        </button>
      </form>
    );
  }

  const phoneFieldError = phoneFormatError || extractFieldError(formError?.fields, "phone");
  const generalError = formError && !phoneFieldError ? formError.message : null;

  return (
    <form className="phone-signin" onSubmit={handlePhoneSubmit} noValidate>
      {generalError && (
        <p className="phone-signin__error focus-ring-always" role="alert" tabIndex={-1} ref={errorRef}>
          {generalError}
        </p>
      )}

      <FormField
        label="Teléfono"
        type="tel"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        autoComplete="tel"
        required
        disabled={isLoading}
        inputRef={phoneRef}
        error={phoneFieldError}
        hint="Formato internacional, ej. +5491122334455."
      />

      <button
        className="btn btn--primary btn--full"
        type="submit"
        disabled={isLoading || !phone}
        aria-busy={isLoading}
      >
        {isLoading ? "Enviando código…" : "Enviar código"}
      </button>
    </form>
  );
}
