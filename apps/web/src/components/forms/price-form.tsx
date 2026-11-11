"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { setTourPriceAction } from "@/app/[locale]/(app)/tours/actions";
import { TextField } from "@/components/auth/text-field";
import { SelectField } from "@/components/forms/select-field";
import type { ActionState } from "@/lib/result";

type Props = {
  tourId: string;
  channel: string;
  channelLabel: string;
  /** Currency codes offered, the operator's first. */
  currencies: readonly string[];
  /** The stored price as form text (`125.50`) and its currency, if any. */
  initial?: { amount: string; currency: string };
};

const initialState: ActionState = { status: "idle" };

// One channel price of a tour (R15, KTD14), administradores only. The amount
// is typed in major units; the server stores minor units.
export function PriceForm({ tourId, channel, channelLabel, currencies, initial }: Props) {
  const t = useTranslations("tours");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(setTourPriceAction, initialState);
  const error = state.status === "error" ? state : undefined;
  const amount = error?.values?.amount ?? initial?.amount ?? "";
  const currency = error?.values?.currency ?? initial?.currency ?? currencies[0];
  const fieldError = (name: string) => {
    const key = error?.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} noValidate aria-label={t("prices.formLabel", { channel: channelLabel })} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="tourId" value={tourId} />
      <input type="hidden" name="channel" value={channel} />
      <div className="w-36">
        <TextField
          id={`price-${channel}-amount`}
          name="amount"
          inputMode="decimal"
          label={t("prices.amount")}
          placeholder="0.00"
          defaultValue={amount}
          error={fieldError("amount")}
        />
      </div>
      <div className="w-28">
        <SelectField
          id={`price-${channel}-currency`}
          name="currency"
          label={t("prices.currency")}
          defaultValue={currency}
          options={currencies.map((code) => ({ value: code, label: code }))}
          error={fieldError("currency")}
        />
      </div>
      <button type="submit" className="btn-secondary px-3 py-2 text-small" disabled={pending}>
        {t("prices.save")}
      </button>
      {error && !error.fieldErrors ? (
        <span role="alert" className="text-label text-negative">
          {te(error.error)}
        </span>
      ) : null}
      {state.status === "ok" ? (
        <span role="status" className="text-label text-positive">
          {t("prices.saved")}
        </span>
      ) : null}
    </form>
  );
}
