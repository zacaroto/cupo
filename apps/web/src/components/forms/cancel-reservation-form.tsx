"use client";

// Cancel one reservation with a reason (R23), from a row of the list. The
// server action re-checks permission and ownership; the triggers release the
// seats and refuse an already cancelled reservation.
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { cancelReservationAction } from "@/app/[locale]/(app)/reservations/actions";
import { TextField } from "@/components/auth/text-field";
import type { ActionState } from "@/lib/result";

type Props = { reservationId: string; code: string };

const initialState: ActionState = { status: "idle" };

export function CancelReservationForm({ reservationId, code }: Props) {
  const t = useTranslations("reservations");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(cancelReservationAction, initialState);
  const error = state.status === "error" ? state : undefined;
  const reasonKey = error?.fieldErrors?.reason;

  return (
    <details className="text-left">
      <summary className="cursor-pointer text-small font-medium text-negative">{t("cancel.open")}</summary>
      <form
        action={formAction}
        noValidate
        aria-label={t("cancel.label", { code })}
        className="mt-2 flex min-w-56 flex-col gap-2"
        onSubmit={(event) => {
          if (!window.confirm(t("cancel.confirm"))) event.preventDefault();
        }}
      >
        <input type="hidden" name="reservationId" value={reservationId} />
        <TextField
          id={`cancel-reason-${reservationId}`}
          name="reason"
          label={t("cancel.reason")}
          placeholder={t("cancel.reasonPlaceholder")}
          defaultValue={error?.values?.reason ?? ""}
          error={reasonKey ? t(reasonKey) : undefined}
        />
        <div>
          <button type="submit" className="btn-danger px-3 py-1.5 text-small" disabled={pending}>
            {t("cancel.submit")}
          </button>
        </div>
        {error && !reasonKey ? (
          <span role="alert" className="text-label text-negative">
            {te(error.error)}
          </span>
        ) : null}
      </form>
    </details>
  );
}
