import { useId } from "react";
import "./FormField.css";

/**
 * Input con label real asociado (nunca placeholder-como-label) y
 * error de campo anunciado vía aria-describedby + role="alert".
 * El error también se marca con aria-invalid y un borde distinto,
 * nunca solo con color.
 */
export default function FormField({
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  error,
  required = false,
  disabled = false,
  inputRef,
  hint,
  ...rest
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="form-field">
      <label className="form-field__label" htmlFor={id}>
        {label}
        {required && (
          <span className="form-field__required" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      <input
        id={id}
        ref={inputRef}
        className={`form-field__input${error ? " form-field__input--error" : ""}`}
        type={type}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && !error && (
        <p className="form-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="form-field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
