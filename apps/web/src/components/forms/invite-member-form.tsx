"use client";

import { STAFF_ROLES } from "@cupo/shared/permissions";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { inviteMemberAction } from "@/app/[locale]/(app)/members/actions";
import { FormMessage } from "@/components/auth/form-message";
import { TextField } from "@/components/auth/text-field";
import type { ActionState } from "@/lib/result";

const initialState: ActionState = { status: "idle" };

// Staff invite (R9). Guías are not invited here: they get access from their
// guide record. The answer is the same whether the email had an account.
export function InviteMemberForm() {
  const t = useTranslations("members");
  const te = useTranslations("errors");
  const common = useTranslations("common");
  const [state, formAction, pending] = useActionState(inviteMemberAction, initialState);
  const error = state.status === "error" ? state : undefined;
  const fieldError = (name: string) => {
    const key = error?.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      {error && !error.fieldErrors ? <FormMessage tone="error">{te(error.error)}</FormMessage> : null}
      {state.status === "ok" ? <FormMessage tone="status">{t("invite.sent")}</FormMessage> : null}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-start">
        <TextField
          name="email"
          type="email"
          label={t("fields.email")}
          autoComplete="off"
          required
          defaultValue={error?.values?.email ?? ""}
          error={fieldError("email")}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="invite-role" className="text-small font-medium text-text">
            {t("fields.role")}
          </label>
          <select
            id="invite-role"
            name="role"
            defaultValue={error?.values?.role ?? "reservas"}
            aria-invalid={fieldError("role") ? true : undefined}
            className="field"
          >
            {STAFF_ROLES.map((role) => (
              <option key={role} value={role}>
                {common(`roles.${role}`)}
              </option>
            ))}
          </select>
          {fieldError("role") ? <p className="text-label text-negative">{fieldError("role")}</p> : null}
        </div>
        <button type="submit" className="btn-primary text-small sm:mt-6" disabled={pending}>
          {t("invite.submit")}
        </button>
      </div>
    </form>
  );
}
