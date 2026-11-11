// Labelled input with an inline, translated validation message.
type Props = {
  name: string;
  label: string;
  type?: "email" | "password" | "text";
  autoComplete?: string;
  required?: boolean;
  defaultValue?: string;
  error?: string;
};

export function TextField({ name, label, type = "text", autoComplete, required, defaultValue, error }: Props) {
  const errorId = `${name}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-small font-medium text-text">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="field"
      />
      {error ? (
        <p id={errorId} className="text-label text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}
