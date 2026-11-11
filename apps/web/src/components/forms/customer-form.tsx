"use client";

// Create or edit one customer (plan U9). Used by the customers page; the
// reservation form's inline create (U6) reuses it with `mode="create"`.
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  createCustomerAction,
  updateCustomerAction,
  type CustomerFormState,
} from "@/app/[locale]/(app)/customers/actions";
import { FormMessage } from "@/components/auth/form-message";
import { TextField } from "@/components/auth/text-field";
import { Link } from "@/i18n/navigation";

export type CustomerFormDefaults = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  preferredLocale: "es" | "en" | null;
};

type Props =
  | { mode: "create"; locale: string; customer?: undefined }
  | { mode: "edit"; locale: string; customer: CustomerFormDefaults };

const initialState: CustomerFormState = { status: "idle" };

const FIELD_NAMES = ["name", "email", "phone", "preferredLocale"] as const;

export function CustomerForm({ mode, locale, customer }: Props) {
  const t = useTranslations("customers");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(
    mode === "create" ? createCustomerAction : updateCustomerAction,
    initialState,
  );

  const values = state.status === "error" ? state.values : undefined;
  const defaults = {
    name: values?.name ?? customer?.name ?? "",
    email: values?.email ?? customer?.email ?? "",
    phone: values?.phone ?? customer?.phone ?? "",
    preferredLocale: values?.preferredLocale ?? customer?.preferredLocale ?? "",
  };
  const fieldError = (name: string) => {
    const key = state.status === "error" ? state.fieldErrors?.[name] : undefined;
    return key ? t(key) : undefined;
  };
  const hasFieldErrors =
    state.status === "error" && FIELD_NAMES.some((name) => state.fieldErrors?.[name] !== undefined);
  const prefix = mode === "create" ? "new-customer" : "edit-customer";

  return (
    <form
      action={formAction}
      noValidate
      aria-labelledby={`${prefix}-title`}
      className="flex flex-col gap-4 rounded border border-border bg-surface p-4"
    >
      <h2 id={`${prefix}-title`} className="text-small font-semibold text-text">
        {mode === "create" ? t("form.createTitle") : t("form.editTitle")}
      </h2>
      <input type="hidden" name="locale" value={locale} />
      {mode === "edit" ? <input type="hidden" name="id" value={customer.id} /> : null}
      {state.status === "error" ? (
        <FormMessage tone="error">{hasFieldErrors ? te("invalid") : te(state.error)}</FormMessage>
      ) : null}
      {state.status === "ok" ? <FormMessage tone="status">{t("form.created", { name: state.data.name })}</FormMessage> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="name"
          label={t("fields.name")}
          autoComplete="off"
          required
          defaultValue={defaults.name}
          error={fieldError("name")}
        />
        <TextField
          name="email"
          type="email"
          label={t("fields.emailOptional")}
          autoComplete="off"
          defaultValue={defaults.email}
          error={fieldError("email")}
        />
        <TextField
          name="phone"
          type="tel"
          label={t("fields.phoneOptional")}
          autoComplete="off"
          defaultValue={defaults.phone}
          error={fieldError("phone")}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="preferredLocale" className="text-small font-medium text-text">
            {t("fields.preferredLocale")}
          </label>
          <select
            id="preferredLocale"
            name="preferredLocale"
            defaultValue={defaults.preferredLocale}
            aria-invalid={fieldError("preferredLocale") ? true : undefined}
            className="field"
          >
            <option value="">{t("locales.operatorDefault")}</option>
            <option value="es">{t("locales.es")}</option>
            <option value="en">{t("locales.en")}</option>
          </select>
          {fieldError("preferredLocale") ? (
            <p className="text-label text-negative">{fieldError("preferredLocale")}</p>
          ) : null}
        </div>
      </div>
      <p className="text-label text-muted">{t("form.incompleteHint")}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="submit" className="btn-primary text-small" disabled={pending}>
          {mode === "create" ? t("form.create") : t("form.save")}
        </button>
        {mode === "edit" ? (
          <Link href="/customers" className="btn-secondary text-small">
            {t("form.cancel")}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
