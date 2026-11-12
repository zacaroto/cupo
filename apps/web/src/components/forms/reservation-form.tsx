"use client";

// New reservation (plan U6, F3): slot -> people -> status -> customer ->
// notes for the tour and date picked above the form. The server action books
// through `create_reservation`; capacity, departure state and archived tours
// come back as database errors and show as the form message. On success the
// action redirects to the list.
import { CREATE_STATUSES } from "@cupo/shared/schemas/reservations";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { createReservationAction } from "@/app/[locale]/(app)/reservations/actions";
import { FormMessage } from "@/components/auth/form-message";
import { TextField } from "@/components/auth/text-field";
import { CustomerPicker, type CustomerPickerDefaults } from "@/components/forms/customer-picker";
import { SelectField } from "@/components/forms/select-field";
import type { ActionState } from "@/lib/result";

/** One bookable time of the tour on the date (an existing departure or a schedule slot). */
export type SlotOption = {
  /** `slotValue()` of the slot. */
  value: string;
  startTime: string;
  available: number;
  closed: boolean;
};

type Props = {
  locale: string;
  tourId: string;
  date: string;
  slots: readonly SlotOption[];
};

const initialState: ActionState = { status: "idle" };

const CUSTOMER_FIELDS = ["customerName", "customerEmail", "customerPhone"] as const;

export function ReservationForm({ locale, tourId, date, slots }: Props) {
  const t = useTranslations("reservations");
  const tc = useTranslations("customers");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(createReservationAction, initialState);
  const error = state.status === "error" ? state : undefined;
  const values = {
    slot: "",
    people: "1",
    status: "confirmed",
    notes: "",
    customerMode: "existing",
    customerId: "",
    customerName: "",
    customerEmail: "",
    customerPhone: "",
    ...error?.values,
  };
  // New-customer fields carry the customer schema's keys (`customers` namespace).
  const fieldError = (name: string) => {
    const key = error?.fieldErrors?.[name];
    if (!key) return undefined;
    return (CUSTOMER_FIELDS as readonly string[]).includes(name) ? tc(key) : t(key);
  };
  const message = error ? (error.fieldErrors ? te("invalid") : te(error.error)) : undefined;
  const pickerDefaults: CustomerPickerDefaults = {
    customerMode: values.customerMode,
    customerId: values.customerId,
    customerName: values.customerName,
    customerEmail: values.customerEmail,
    customerPhone: values.customerPhone,
  };

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5 rounded border border-border bg-surface p-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="tourId" value={tourId} />
      <input type="hidden" name="date" value={date} />
      {message ? <FormMessage tone="error">{message}</FormMessage> : null}

      <fieldset className="flex flex-col gap-2" aria-describedby={fieldError("slot") ? "reservation-slot-error" : undefined}>
        <legend className="pb-1 text-small font-medium text-text">{t("form.slot")}</legend>
        <div className="flex flex-wrap gap-2">
          {slots.map((slot) => {
            const full = slot.available === 0;
            const label = slot.closed
              ? t("form.slotClosed", { time: slot.startTime })
              : full
                ? t("form.slotFull", { time: slot.startTime })
                : t("form.slotOpen", { time: slot.startTime, available: slot.available });
            return (
              <label
                key={slot.value}
                className={`inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-small ${
                  slot.closed || full ? "text-faint" : "text-text"
                }`}
              >
                <input
                  type="radio"
                  name="slot"
                  value={slot.value}
                  disabled={slot.closed || full}
                  defaultChecked={values.slot === slot.value}
                />
                {label}
              </label>
            );
          })}
        </div>
        {fieldError("slot") ? (
          <p id="reservation-slot-error" className="text-label text-negative">
            {fieldError("slot")}
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="reservation-people"
          name="people"
          inputMode="numeric"
          label={t("form.people")}
          required
          defaultValue={values.people}
          error={fieldError("people")}
        />
        <SelectField
          id="reservation-status"
          name="status"
          label={t("form.status")}
          defaultValue={values.status}
          options={CREATE_STATUSES.map((status) => ({ value: status, label: t(`status.${status}`) }))}
          error={fieldError("status")}
        />
      </div>

      <CustomerPicker
        defaults={pickerDefaults}
        errors={{
          customerId: fieldError("customerId"),
          customerName: fieldError("customerName"),
          customerEmail: fieldError("customerEmail"),
          customerPhone: fieldError("customerPhone"),
        }}
      />

      <div className="flex flex-col gap-1">
        <label htmlFor="reservation-notes" className="text-small font-medium text-text">
          {t("form.notes")}
        </label>
        <textarea
          id="reservation-notes"
          name="notes"
          rows={3}
          maxLength={2000}
          defaultValue={values.notes}
          aria-describedby="reservation-notes-hint"
          aria-invalid={fieldError("notes") ? true : undefined}
          className="field"
        />
        <p id="reservation-notes-hint" className="text-label text-muted">
          {t("form.notesHint")}
        </p>
        {fieldError("notes") ? <p className="text-label text-negative">{fieldError("notes")}</p> : null}
      </div>

      <div>
        <button type="submit" className="btn-primary text-small" disabled={pending}>
          {t("form.submit")}
        </button>
      </div>
    </form>
  );
}
