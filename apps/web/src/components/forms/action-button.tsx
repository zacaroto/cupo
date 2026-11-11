"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import type { ActionState } from "@/lib/result";

type Props = {
  /** A server action taking (state, formData). */
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  /** Hidden fields posted with the button (ids, flags). Never an operator id. */
  fields: Record<string, string>;
  label: string;
  /** Shown after a successful run. */
  doneMessage?: string;
  /** Asks the browser to confirm first (destructive actions). */
  confirmMessage?: string;
  tone?: "secondary" | "danger";
};

const initialState: ActionState = { status: "idle" };

// One-button form for row and record actions (remove, resend, deactivate).
// The server action re-checks permission and ownership; the button is UX only.
export function ActionButton({ action, fields, label, doneMessage, confirmMessage, tone = "secondary" }: Props) {
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form
      action={formAction}
      className="inline-flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        className={`${tone === "danger" ? "btn-danger" : "btn-secondary"} px-3 py-1.5 text-small`}
        disabled={pending}
      >
        {label}
      </button>
      {state.status === "error" ? (
        <span role="alert" className="text-label text-negative">
          {te(state.error)}
        </span>
      ) : null}
      {state.status === "ok" && doneMessage ? (
        <span role="status" className="text-label text-positive">
          {doneMessage}
        </span>
      ) : null}
    </form>
  );
}
