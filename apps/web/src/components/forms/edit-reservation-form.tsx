"use client";

// Edit one reservation (plan U10): people, a slot of the same tour on the
// date picked above the form, and the notes. The server action sends only
// what changed to `update_reservation`; capacity, departure state and the
// cancelled freeze come back as database errors and show as the form message.
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { updateReservationAction, type ReservationUpdateState } from "@/app/[locale]/(app)/reservations/actions";
import { FormMessage } from "@/components/auth/form-message";
import { TextField } from "@/components/auth/text-field";
import type { SlotOption } from "@/components/forms/reservation-form";

/** A slot of the edit; the reservation's own departure is always selectable. */
export type EditSlotOption = SlotOption & { current: boolean };

type Props = {
  reservationId: string;
  date: string;
  slots: readonly EditSlotOption[];
  initial: { people: string; notes: string };
};

const initialState: ReservationUpdateState = { status: "idle" };

export function EditReservationForm({ reservationId, date, slots, initial }: Props) {
  const t = useTranslations("reservationDetail.edit");
  const tr = useTranslations("reservations");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(updateReservationAction, initialState);
  const error = state.status === "error" ? state : undefined;
  const values = {
    slot: slots.find((slot) => slot.current)?.value ?? "",
    people: initial.people,
    notes: initial.notes,
    ...error?.values,
  };
  const fieldError = (name: string) => {
    const key = error?.fieldErrors?.[name];
    return key ? tr(key) : undefined;
  };
  const message = error ? (error.fieldErrors ? te("invalid") : te(error.error)) : undefined;

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4" aria-label={t("title")}>
      <input type="hidden" name="reservationId" value={reservationId} />
      <input type="hidden" name="date" value={date} />
      {message ? <FormMessage tone="error">{message}</FormMessage> : null}
      {state.status === "ok" ? <FormMessage tone="status">{state.data.changed ? t("saved") : t("unchanged")}</FormMessage> : null}

      {slots.length === 0 ? (
        <p className="text-small text-muted">{t("noSlots")}</p>
      ) : (
        <fieldset className="flex flex-col gap-2" aria-describedby={fieldError("slot") ? "edit-slot-error" : undefined}>
          <legend className="pb-1 text-small font-medium text-text">{t("slot")}</legend>
          <div className="flex flex-wrap gap-2">
            {slots.map((slot) => {
              const full = slot.available === 0;
              const disabled = !slot.current && (slot.closed || full);
              const label = slot.current
                ? t("slotCurrent", { time: slot.startTime })
                : slot.closed
                  ? tr("form.slotClosed", { time: slot.startTime })
                  : full
                    ? tr("form.slotFull", { time: slot.startTime })
                    : tr("form.slotOpen", { time: slot.startTime, available: slot.available });
              return (
                <label
                  key={slot.value}
                  className={`inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-small ${
                    disabled ? "text-faint" : "text-text"
                  }`}
                >
                  <input type="radio" name="slot" value={slot.value} disabled={disabled} defaultChecked={values.slot === slot.value} />
                  {label}
                </label>
              );
            })}
          </div>
          {fieldError("slot") ? (
            <p id="edit-slot-error" className="text-label text-negative">
              {fieldError("slot")}
            </p>
          ) : null}
        </fieldset>
      )}

      <div className="max-w-40">
        <TextField
          id="edit-reservation-people"
          name="people"
          inputMode="numeric"
          label={t("people")}
          required
          defaultValue={values.people}
          error={fieldError("people")}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="edit-reservation-notes" className="text-small font-medium text-text">
          {t("notes")}
        </label>
        <textarea
          id="edit-reservation-notes"
          name="notes"
          rows={3}
          maxLength={2000}
          defaultValue={values.notes}
          aria-describedby="edit-reservation-notes-hint"
          aria-invalid={fieldError("notes") ? true : undefined}
          className="field"
        />
        <p id="edit-reservation-notes-hint" className="text-label text-muted">
          {t("notesHint")}
        </p>
        {fieldError("notes") ? <p className="text-label text-negative">{fieldError("notes")}</p> : null}
      </div>

      <div>
        <button type="submit" className="btn-primary text-small" disabled={pending || slots.length === 0}>
          {t("submit")}
        </button>
      </div>
    </form>
  );
}
