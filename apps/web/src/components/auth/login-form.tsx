"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { loginAction, type LoginState } from "@/app/[locale]/(auth)/login/actions";
import { FormMessage } from "./form-message";
import { TextField } from "./text-field";

type Props = { locale: string; linkInvalid: boolean };

const initialState: LoginState = { status: "idle" };

export function LoginForm({ locale, linkInvalid }: Props) {
  const t = useTranslations("auth");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const fieldError = (name: string) => {
    const key = state.status === "error" ? state.fieldErrors?.[name] : undefined;
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      {linkInvalid && state.status === "idle" ? <FormMessage tone="error">{t("login.linkInvalid")}</FormMessage> : null}
      {state.status === "error" && !state.fieldErrors ? <FormMessage tone="error">{te(state.error)}</FormMessage> : null}
      {state.status === "sent" ? <FormMessage tone="status">{t("login.linkSent")}</FormMessage> : null}
      <TextField name="email" type="email" label={t("fields.email")} autoComplete="username" required error={fieldError("email")} />
      <TextField
        name="password"
        type="password"
        label={t("fields.password")}
        autoComplete="current-password"
        error={fieldError("password")}
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="submit" name="intent" value="password" className="btn-primary text-small" disabled={pending}>
          {t("login.signInWithPassword")}
        </button>
        <button type="submit" name="intent" value="link" className="btn-secondary text-small" disabled={pending}>
          {t("login.sendLink")}
        </button>
      </div>
    </form>
  );
}
