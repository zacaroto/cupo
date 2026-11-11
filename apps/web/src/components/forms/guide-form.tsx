"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { createGuideAction, updateGuideAction } from "@/app/[locale]/(app)/guides/actions";
import { FormMessage } from "@/components/auth/form-message";
import { TextField } from "@/components/auth/text-field";
import type { ActionState } from "@/lib/result";

export type GuideFormValues = {
  name: string;
  email: string;
  phone: string;
  languages: string;
  specialties: string;
  maxDailyHours: string;
};

type Props =
  | { mode: "create"; locale: string; guideId?: undefined; initial?: undefined }
  | { mode: "edit"; locale: string; guideId: string; initial: GuideFormValues };

const initialState: ActionState = { status: "idle" };

const EMPTY: GuideFormValues = { name: "", email: "", phone: "", languages: "", specialties: "", maxDailyHours: "" };

// Create or edit a guide (R19). Create opens the new record; edit stays here.
export function GuideForm({ mode, locale, guideId, initial }: Props) {
  const t = useTranslations("guides");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(mode === "create" ? createGuideAction : updateGuideAction, initialState);
  const error = state.status === "error" ? state : undefined;
  const values = { ...EMPTY, ...initial, ...error?.values };
  // List items report as `languages.3`; show them on the list field.
  const fieldError = (name: string) => {
    const entries = Object.entries(error?.fieldErrors ?? {});
    const key = entries.find(([path]) => path === name || path.startsWith(`${name}.`))?.[1];
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      <input type="hidden" name="locale" value={locale} />
      {guideId ? <input type="hidden" name="guideId" value={guideId} /> : null}
      {error && !error.fieldErrors ? <FormMessage tone="error">{te(error.error)}</FormMessage> : null}
      {state.status === "ok" ? <FormMessage tone="status">{t("saved")}</FormMessage> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField name="name" label={t("fields.name")} required defaultValue={values.name} error={fieldError("name")} />
        <TextField
          name="email"
          type="email"
          label={t("fields.email")}
          autoComplete="off"
          defaultValue={values.email}
          error={fieldError("email")}
        />
        <TextField name="phone" type="tel" label={t("fields.phone")} defaultValue={values.phone} error={fieldError("phone")} />
        <TextField
          name="maxDailyHours"
          inputMode="numeric"
          label={t("fields.maxDailyHours")}
          defaultValue={values.maxDailyHours}
          error={fieldError("maxDailyHours")}
        />
        <TextField
          name="languages"
          label={t("fields.languages")}
          hint={t("fields.languagesHint")}
          defaultValue={values.languages}
          error={fieldError("languages")}
        />
        <TextField
          name="specialties"
          label={t("fields.specialties")}
          hint={t("fields.specialtiesHint")}
          defaultValue={values.specialties}
          error={fieldError("specialties")}
        />
      </div>
      <div>
        <button type="submit" className="btn-primary text-small" disabled={pending}>
          {mode === "create" ? t("create") : t("save")}
        </button>
      </div>
    </form>
  );
}
