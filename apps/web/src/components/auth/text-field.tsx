// Labelled input with an optional hint and an inline, translated validation message.
type Props = {
  name: string;
  /** Defaults to `name`; set it when the same field name appears in several forms on one page. */
  id?: string;
  label: string;
  type?: "email" | "password" | "text" | "tel" | "date" | "time";
  inputMode?: "text" | "numeric" | "decimal" | "email" | "tel";
  autoComplete?: string;
  required?: boolean;
  defaultValue?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
};

export function TextField({
  name,
  id = name,
  label,
  type = "text",
  inputMode,
  autoComplete,
  required,
  defaultValue,
  hint,
  error,
  placeholder,
}: Props) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-small font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        required={required}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="field"
      />
      {hint ? (
        <p id={hintId} className="text-label text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-label text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}
