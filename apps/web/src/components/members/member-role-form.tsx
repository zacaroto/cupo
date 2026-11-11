"use client";

import { STAFF_ROLES } from "@cupo/shared/permissions";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { changeRoleAction } from "@/app/[locale]/(app)/members/actions";
import type { ActionState } from "@/lib/result";

type Props = { membershipId: string; role: string; memberName: string };

const initialState: ActionState = { status: "idle" };

// Staff role change. The database keeps the last administrador (R12) and
// answers `last_administrador`; guía access is managed from the guide record.
export function MemberRoleForm({ membershipId, role, memberName }: Props) {
  const t = useTranslations("members.actions");
  const te = useTranslations("errors");
  const common = useTranslations("common");
  const [state, formAction, pending] = useActionState(changeRoleAction, initialState);
  const selectId = `role-${membershipId}`;

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="membershipId" value={membershipId} />
      <label htmlFor={selectId} className="sr-only">
        {t("roleLabel", { name: memberName })}
      </label>
      <select id={selectId} name="role" defaultValue={role} className="field w-auto py-1.5">
        {STAFF_ROLES.map((option) => (
          <option key={option} value={option}>
            {common(`roles.${option}`)}
          </option>
        ))}
      </select>
      <button type="submit" className="btn-secondary px-3 py-1.5 text-small" disabled={pending}>
        {t("changeRole")}
      </button>
      {state.status === "error" ? (
        <span role="alert" className="text-label text-negative">
          {te(state.error)}
        </span>
      ) : null}
      {state.status === "ok" ? (
        <span role="status" className="text-label text-positive">
          {t("roleChanged")}
        </span>
      ) : null}
    </form>
  );
}
