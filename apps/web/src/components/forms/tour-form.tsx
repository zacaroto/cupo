"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { createTourAction, updateTourAction } from "@/app/[locale]/(app)/tours/actions";
import { FormMessage } from "@/components/auth/form-message";
import { TextField } from "@/components/auth/text-field";
import type { ActionState } from "@/lib/result";

export type TourFormValues = {
  name: string;
  description: string;
  durationMinutes: string;
  defaultCapacity: string;
  meetingPoint: string;
};

type Props =
  | { mode: "create"; locale: string; tourId?: undefined; initial?: undefined }
  | { mode: "edit"; locale: string; tourId: string; initial: TourFormValues };

const initialState: ActionState = { status: "idle" };

const EMPTY: TourFormValues = { name: "", description: "", durationMinutes: "", defaultCapacity: "", meetingPoint: "" };

// Create or edit a tour (R15). Create opens the new tour; edit stays here.
export function TourForm({ mode, locale, tourId, initial }: Props) {
  const t = useTranslations("tours");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(mode === "create" ? createTourAction : updateTourAction, initialState);
  const error = state.status === "error" ? state : undefined;
  const values = { ...EMPTY, ...initial, ...error?.values };
  const fieldError = (name: string) => {
    const key = error?.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };
  const descriptionError = fieldError("description");

  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      <input type="hidden" name="locale" value={locale} />
      {tourId ? <input type="hidden" name="tourId" value={tourId} /> : null}
      {error ? <FormMessage tone="error">{te(error.error)}</FormMessage> : null}
      {state.status === "ok" ? <FormMessage tone="status">{t("saved")}</FormMessage> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField name="name" label={t("fields.name")} required defaultValue={values.name} error={fieldError("name")} />
        <TextField
          name="meetingPoint"
          label={t("fields.meetingPoint")}
          defaultValue={values.meetingPoint}
          error={fieldError("meetingPoint")}
        />
        <TextField
          name="durationMinutes"
          inputMode="numeric"
          label={t("fields.durationMinutes")}
          hint={t("fields.durationHint")}
          required
          defaultValue={values.durationMinutes}
          error={fieldError("durationMinutes")}
        />
        <TextField
          name="defaultCapacity"
          inputMode="numeric"
          label={t("fields.defaultCapacity")}
          hint={t("fields.defaultCapacityHint")}
          required
          defaultValue={values.defaultCapacity}
          error={fieldError("defaultCapacity")}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="description" className="text-small font-medium text-text">
          {t("fields.description")}
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          defaultValue={values.description}
          aria-invalid={descriptionError ? true : undefined}
          aria-describedby={descriptionError ? "description-error" : undefined}
          className="field"
        />
        {descriptionError ? (
          <p id="description-error" className="text-label text-negative">
            {descriptionError}
          </p>
        ) : null}
      </div>
      <div>
        <button type="submit" className="btn-primary text-small" disabled={pending}>
          {mode === "create" ? t("create") : t("save")}
        </button>
      </div>
    </form>
  );
}
