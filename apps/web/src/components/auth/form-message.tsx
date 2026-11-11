// Form-level status line: errors are announced as alerts, successes politely.
type Props = { tone: "error" | "status"; children: React.ReactNode };

export function FormMessage({ tone, children }: Props) {
  return tone === "error" ? (
    <p role="alert" className="rounded border border-negative px-3 py-2 text-small text-negative">
      {children}
    </p>
  ) : (
    <p role="status" className="rounded border border-border bg-accent-soft px-3 py-2 text-small text-accent-ink">
      {children}
    </p>
  );
}
