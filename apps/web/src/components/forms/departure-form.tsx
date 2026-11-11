"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  createDepartureAction,
  updateDepartureAction,
  type DepartureActionState,
} from "@/app/[locale]/(app)/departures/actions";
import { FormMessage } from "@/components/auth/form-message";
import { TextField } from "@/components/auth/text-field";
import { SelectField } from "@/components/forms/select-field";

type Choice = { id: string; name: string };

export type DepartureFormValues = { tourId: string; date: string; startTime: string; capacity: string; guideId: string };

type Props =
  | {
      mode: "create";
      locale: string;
      /** Tours that take new departures (not archived). */
      tours: readonly Choice[];
      /** Active guides; omitted for roles that cannot assign one (KTD13). */
      guides?: readonly Choice[];
      initial?: Partial<DepartureFormValues>;
      departureId?: undefined;
    }
  | {
      mode: "edit";
      locale: string;
      departureId: string;
      guides: readonly Choice[];
      initial: Omit<DepartureFormValues, "tourId">;
      tours?: undefined;
    };

const initialState: DepartureActionState = { status: "idle" };

// Ad hoc departure (R17) or the administrador's edit (date, time, capacity,
// guide). Create opens the new departure; edit stays here.
export function DepartureForm(props: Props) {
  const { mode, locale } = props;
  const t = useTranslations("departures");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(
    mode === "create" ? createDepartureAction : updateDepartureAction,
    initialState,
  );
  const error = state.status === "error" ? state : undefined;
  const values: DepartureFormValues = {
    tourId: "",
    date: "",
    startTime: "",
    capacity: "",
    guideId: "",
    ...props.initial,
    ...error?.values,
  };
  const fieldError = (name: string) => {
    const key = error?.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };
  const message =
    error?.error === "capacity_below_booked" && state.seatsBooked !== undefined
      ? t("form.capacityBelowBooked", { count: state.seatsBooked })
      : error
        ? te(error.error)
        : undefined;
  const prefix = mode === "create" ? "new-departure" : "edit-departure";

  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      <input type="hidden" name="locale" value={locale} />
      {props.departureId ? <input type="hidden" name="departureId" value={props.departureId} /> : null}
      {message ? <FormMessage tone="error">{message}</FormMessage> : null}
      {state.status === "ok" ? <FormMessage tone="status">{t("form.saved")}</FormMessage> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {props.tours ? (
          <SelectField
            id={`${prefix}-tour`}
            name="tourId"
            label={t("fields.tour")}
            required
            defaultValue={values.tourId}
            options={[{ value: "", label: t("form.chooseTour") }, ...props.tours.map((tour) => ({ value: tour.id, label: tour.name }))]}
            error={fieldError("tourId")}
          />
        ) : null}
        <TextField
          id={`${prefix}-date`}
          name="date"
          type="date"
          label={t("fields.date")}
          required
          defaultValue={values.date}
          error={fieldError("date")}
        />
        <TextField
          id={`${prefix}-time`}
          name="startTime"
          type="time"
          label={t("fields.startTime")}
          required
          defaultValue={values.startTime}
          error={fieldError("startTime")}
        />
        <TextField
          id={`${prefix}-capacity`}
          name="capacity"
          inputMode="numeric"
          label={t("fields.capacity")}
          hint={mode === "create" ? t("form.capacityHint") : undefined}
          required={mode === "edit"}
          defaultValue={values.capacity}
          error={fieldError("capacity")}
        />
        {props.guides ? (
          <SelectField
            id={`${prefix}-guide`}
            name="guideId"
            label={t("fields.guide")}
            defaultValue={values.guideId}
            options={[{ value: "", label: t("form.noGuide") }, ...props.guides.map((guide) => ({ value: guide.id, label: guide.name }))]}
            error={fieldError("guideId")}
          />
        ) : null}
      </div>
      <div>
        <button type="submit" className="btn-primary text-small" disabled={pending}>
          {mode === "create" ? t("form.create") : t("form.save")}
        </button>
      </div>
    </form>
  );
}
