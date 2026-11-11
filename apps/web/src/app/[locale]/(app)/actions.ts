"use server";

// Session actions of the app shell (R14, KTD3).
import { switchOperatorSchema } from "@cupo/shared/schemas/auth";
import { cookies } from "next/headers";
import { redirect } from "@/i18n/navigation";
import { field, localeFrom } from "@/lib/auth/request";
import {
  ACTIVE_OPERATOR_COOKIE,
  activeOperatorCookieOptions,
  formatActiveOperatorCookie,
  requireOperatorContext,
} from "@/lib/dal/context";
import { logger } from "@/lib/logger";
import { errorState, validationState, type ErrorState } from "@/lib/result";
import { createClient } from "@/lib/supabase/server";

export type SwitchOperatorState = { status: "idle" } | ErrorState;

/**
 * Makes another of the user's memberships active. The operator id is only a
 * request: it must be one of the memberships the DAL just loaded under RLS,
 * otherwise the state is `forbidden` and the cookie is left untouched.
 */
export async function switchOperatorAction(_previous: SwitchOperatorState, formData: FormData): Promise<SwitchOperatorState> {
  const locale = localeFrom(formData);
  const parsed = switchOperatorSchema.safeParse({ operatorId: field(formData, "operatorId") });
  if (!parsed.success) return validationState(parsed.error);

  let userId: string;
  try {
    const ctx = await requireOperatorContext();
    if (!ctx.memberships.some((m) => m.operatorId === parsed.data.operatorId)) {
      return { status: "error", error: "forbidden" };
    }
    userId = ctx.user.id;
  } catch (error) {
    return errorState(error);
  }

  const cookieStore = await cookies();
  cookieStore.set(
    ACTIVE_OPERATOR_COOKIE,
    formatActiveOperatorCookie(userId, parsed.data.operatorId),
    activeOperatorCookieOptions(),
  );
  return redirect({ href: "/", locale });
}

/**
 * Signs out this browser (scope `local`: other devices keep their sessions)
 * and clears the Supabase cookies (through the server client) and the
 * active-operator cookie.
 */
export async function signOutAction(formData: FormData): Promise<void> {
  const locale = localeFrom(formData);
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) logger.warn("sign-out failed", { extra: { code: error.code ?? "unknown" } });

  const cookieStore = await cookies();
  cookieStore.delete(ACTIVE_OPERATOR_COOKIE);
  // signOut() clears the session cookies even when the revoke call fails;
  // delete any leftover chunk so the browser holds no token either way.
  for (const { name } of cookieStore.getAll()) {
    if (/^sb-.+-auth-token(\.\d+)?$/.test(name)) cookieStore.delete(name);
  }
  return redirect({ href: "/login", locale });
}
