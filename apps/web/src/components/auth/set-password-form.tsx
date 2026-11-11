"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { setPasswordAction, type SetPasswordState } from "@/app/[locale]/(auth)/set-password/actions";
import { FormMessage } from "./form-message";
import { TextField } from "./text-field";

const initialState: SetPasswordState = { status: "idle" };

export function SetPasswordForm({ locale, email }: { locale: string; email: string | null }) {
  const t = useTranslations("auth");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(setPasswordAction, initialState);
  const fieldError = (name: string) => {
    const key = state.status === "error" ? state.fieldErrors?.[name] : undefined;
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      {/* Lets password managers attach the new password to the right account. */}
      <input type="hidden" name="username" autoComplete="username" value={email ?? ""} readOnly />
      {state.status === "error" && !state.fieldErrors ? <FormMessage tone="error">{te(state.error)}</FormMessage> : null}
      <TextField
        name="password"
        type="password"
        label={t("fields.newPassword")}
        autoComplete="new-password"
        required
        error={fieldError("password")}
      />
      <TextField
        name="confirmPassword"
        type="password"
        label={t("fields.confirmPassword")}
        autoComplete="new-password"
        required
        error={fieldError("confirmPassword")}
      />
      <button type="submit" className="btn-primary text-small" disabled={pending}>
        {t("setPassword.submit")}
      </button>
    </form>
  );
}
