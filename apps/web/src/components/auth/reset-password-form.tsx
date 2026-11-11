"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { resetPasswordAction, type ResetPasswordState } from "@/app/[locale]/(auth)/reset-password/actions";
import { FormMessage } from "./form-message";
import { TextField } from "./text-field";

const initialState: ResetPasswordState = { status: "idle" };

export function ResetPasswordForm() {
  const t = useTranslations("auth");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(resetPasswordAction, initialState);
  const emailError = state.status === "error" ? state.fieldErrors?.email : undefined;

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      {state.status === "error" && !state.fieldErrors ? <FormMessage tone="error">{te(state.error)}</FormMessage> : null}
      {state.status === "sent" ? <FormMessage tone="status">{t("resetPassword.sent")}</FormMessage> : null}
      <TextField
        name="email"
        type="email"
        label={t("fields.email")}
        autoComplete="username"
        required
        error={emailError ? t(emailError) : undefined}
      />
      <button type="submit" className="btn-primary text-small" disabled={pending}>
        {t("resetPassword.submit")}
      </button>
    </form>
  );
}
