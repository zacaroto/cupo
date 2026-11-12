"use client";

// The reservation form's customer step (plan U6, R26): search the operator's
// customers and pick one, or type a new one that the booking rpc creates in
// the same transaction. Lives inside the reservation <form>, so the search
// runs as a server function call from the button (not a nested form) and
// its input has no name: only `customerMode`, `customerId` and the new
// customer's fields are submitted.
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useState } from "react";
import { searchCustomersAction, type CustomerSearchState } from "@/app/[locale]/(app)/reservations/actions";
import { TextField } from "@/components/auth/text-field";

export type CustomerPickerDefaults = {
  customerMode: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
};

type Props = {
  defaults: CustomerPickerDefaults;
  /** Translated field errors keyed by form field name. */
  errors: Partial<Record<keyof CustomerPickerDefaults, string>>;
};

const initialSearch: CustomerSearchState = { status: "idle" };

export function CustomerPicker({ defaults, errors }: Props) {
  const t = useTranslations("reservations.picker");
  const te = useTranslations("errors");
  const [mode, setMode] = useState<"existing" | "new">(defaults.customerMode === "new" ? "new" : "existing");
  const [query, setQuery] = useState("");
  const [results, search, searching] = useActionState(searchCustomersAction, initialSearch);
  const runSearch = () => startTransition(() => search(query));

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="pb-1 text-small font-medium text-text">{t("legend")}</legend>
      <div className="flex flex-wrap gap-4 text-small">
        {(["existing", "new"] as const).map((value) => (
          <label key={value} className="inline-flex items-center gap-2 text-text">
            <input type="radio" name="customerMode" value={value} checked={mode === value} onChange={() => setMode(value)} />
            {t(value)}
          </label>
        ))}
      </div>

      {mode === "existing" ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="reservation-customer-query" className="text-small font-medium text-text">
            {t("search")}
          </label>
          <div className="flex gap-2">
            <input
              id="reservation-customer-query"
              type="search"
              value={query}
              maxLength={100}
              autoComplete="off"
              placeholder={t("searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runSearch();
                }
              }}
              className="field flex-1"
            />
            <button type="button" className="btn-secondary text-small" onClick={runSearch} disabled={searching}>
              {searching ? t("searching") : t("searchSubmit")}
            </button>
          </div>
          {results.status === "error" ? (
            <p role="alert" className="text-label text-negative">
              {te(results.error)}
            </p>
          ) : null}
          {results.status === "ok" && results.data.length === 0 ? <p className="text-label text-muted">{t("noResults")}</p> : null}
          {results.status === "ok" && results.data.length > 0 ? (
            <div role="radiogroup" aria-label={t("results")} className="flex flex-col divide-y divide-rule rounded border border-border">
              {results.data.map((customer) => (
                <label key={customer.id} className="flex items-center gap-3 px-3 py-2 text-small text-text">
                  <input type="radio" name="customerId" value={customer.id} defaultChecked={customer.id === defaults.customerId} />
                  <span className="font-medium">{customer.name}</span>
                  <span className="text-muted">{customer.email ?? customer.phone ?? t("noContact")}</span>
                </label>
              ))}
            </div>
          ) : null}
          {errors.customerId ? <p className="text-label text-negative">{errors.customerId}</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              id="reservation-customer-name"
              name="customerName"
              label={t("name")}
              autoComplete="off"
              required
              defaultValue={defaults.customerName}
              error={errors.customerName}
            />
            <TextField
              id="reservation-customer-email"
              name="customerEmail"
              type="email"
              label={t("email")}
              autoComplete="off"
              defaultValue={defaults.customerEmail}
              error={errors.customerEmail}
            />
            <TextField
              id="reservation-customer-phone"
              name="customerPhone"
              type="tel"
              label={t("phone")}
              autoComplete="off"
              defaultValue={defaults.customerPhone}
              error={errors.customerPhone}
            />
          </div>
          <p className="text-label text-muted">{t("newHint")}</p>
        </div>
      )}
    </fieldset>
  );
}
