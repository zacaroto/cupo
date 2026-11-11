"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { createScheduleAction } from "@/app/[locale]/(app)/tours/actions";
import { FormMessage } from "@/components/auth/form-message";
import { TextField } from "@/components/auth/text-field";
import { SelectField } from "@/components/forms/select-field";
import { weekdayName } from "@/lib/format";
import type { ActionState } from "@/lib/result";

type Props = {
  tourId: string;
  /** Today in the operator's zone, the default start of the validity window. */
  today: string;
};

const initialState: ActionState = { status: "idle" };

// Monday first, as operators read a week.
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

// Adds a weekly schedule to a tour (R16): weekday, local start time, an
// optional capacity override and a validity window.
export function ScheduleForm({ tourId, today }: Props) {
  const t = useTranslations("tours");
  const te = useTranslations("errors");
  const locale = useLocale();
  const [state, formAction, pending] = useActionState(createScheduleAction, initialState);
  const error = state.status === "error" ? state : undefined;
  const values = { weekday: "1", startTime: "", capacityOverride: "", validFrom: today, validTo: "", ...error?.values };
  const fieldError = (name: string) => {
    const key = error?.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} noValidate aria-label={t("schedules.add")} className="flex flex-col gap-3">
      <input type="hidden" name="tourId" value={tourId} />
      {error ? <FormMessage tone="error">{te(error.error)}</FormMessage> : null}
      {state.status === "ok" ? <FormMessage tone="status">{t("schedules.added")}</FormMessage> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          name="weekday"
          label={t("schedules.weekday")}
          defaultValue={values.weekday}
          options={WEEKDAYS.map((day) => ({ value: String(day), label: weekdayName(day, locale) }))}
          error={fieldError("weekday")}
        />
        <TextField
          name="startTime"
          type="time"
          label={t("schedules.startTime")}
          required
          defaultValue={values.startTime}
          error={fieldError("startTime")}
        />
        <TextField
          name="capacityOverride"
          inputMode="numeric"
          label={t("schedules.capacityOverride")}
          hint={t("schedules.capacityOverrideHint")}
          defaultValue={values.capacityOverride}
          error={fieldError("capacityOverride")}
        />
        <TextField
          name="validFrom"
          type="date"
          label={t("schedules.validFrom")}
          required
          defaultValue={values.validFrom}
          error={fieldError("validFrom")}
        />
        <TextField
          name="validTo"
          type="date"
          label={t("schedules.validTo")}
          hint={t("schedules.validToHint")}
          defaultValue={values.validTo}
          error={fieldError("validTo")}
        />
      </div>
      <div>
        <button type="submit" className="btn-primary text-small" disabled={pending}>
          {t("schedules.add")}
        </button>
      </div>
    </form>
  );
}
