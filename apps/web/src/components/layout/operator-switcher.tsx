"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { switchOperatorAction, type SwitchOperatorState } from "@/app/[locale]/(app)/actions";

type Props = {
  locale: string;
  activeOperatorId: string;
  options: ReadonlyArray<{ operatorId: string; label: string }>;
};

const initialState: SwitchOperatorState = { status: "idle" };

// Shown only with two or more memberships (R14). The server action re-checks
// the requested operator against the user's memberships.
export function OperatorSwitcher({ locale, activeOperatorId, options }: Props) {
  const t = useTranslations("shell");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState(switchOperatorAction, initialState);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="locale" value={locale} />
      <label htmlFor="operatorId" className="sr-only">
        {t("switchOperator")}
      </label>
      <select id="operatorId" name="operatorId" defaultValue={activeOperatorId} className="field w-auto py-1.5">
        {options.map((option) => (
          <option key={option.operatorId} value={option.operatorId}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="submit" className="btn-secondary px-3 py-1.5 text-small" disabled={pending}>
        {t("switch")}
      </button>
      {state.status === "error" ? (
        <span role="alert" className="text-label text-negative">
          {te(state.error)}
        </span>
      ) : null}
    </form>
  );
}
