// Labelled input with an optional hint and an inline, translated validation message.
type Props = {
  name: string;
  label: string;
  type?: "email" | "password" | "text" | "tel";
  inputMode?: "text" | "numeric" | "email" | "tel";
  autoComplete?: string;
  required?: boolean;
  defaultValue?: string;
  hint?: string;
  error?: string;
};

export function TextField({ name, label, type = "text", inputMode, autoComplete, required, defaultValue, hint, error }: Props) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-small font-medium text-text">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
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
