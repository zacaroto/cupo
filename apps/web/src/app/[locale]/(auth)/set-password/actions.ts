"use server";

// Set-password action (R13, KTD8): updateUser({ password }) with the user's
// own session, then `app_metadata.password_set_at` through the admin client
// (users cannot write app_metadata), then refreshSession() so the cookies
// carry the new claim before redirecting; without the refresh the (app)
// layout would read the stale JWT and send the user back here.
import { setPasswordSchema } from "@cupo/shared/schemas/auth";
import { redirect } from "@/i18n/navigation";
import { field, localeFrom } from "@/lib/auth/request";
import { getSessionUser } from "@/lib/dal/context";
import { logger } from "@/lib/logger";
import { validationState, type ErrorState } from "@/lib/result";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type SetPasswordState = { status: "idle" } | ErrorState;

const AUTH_ERROR_STATES: Readonly<Record<string, ErrorState["error"]>> = {
  weak_password: "weak_password",
  same_password: "same_password",
  over_request_rate_limit: "rate_limited",
};

export async function setPasswordAction(_previous: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
  const locale = localeFrom(formData);
  const parsed = setPasswordSchema.safeParse({
    password: field(formData, "password"),
    confirmPassword: field(formData, "confirmPassword"),
  });
  if (!parsed.success) return validationState(parsed.error);

  const user = await getSessionUser();
  if (!user) return { status: "error", error: "unauthenticated" };

  const supabase = await createClient();
  const { error: updateError } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (updateError) {
    const mapped = updateError.code ? AUTH_ERROR_STATES[updateError.code] : undefined;
    if (!mapped) logger.error("password update failed", { userId: user.id, extra: { code: updateError.code ?? "unknown" } });
    return { status: "error", error: mapped ?? "unexpected" };
  }

  const admin = createAdminClient();
  const { error: metadataError } = await admin.auth.admin.updateUserById(user.id, {
    app_metadata: { password_set_at: new Date().toISOString() },
  });
  if (metadataError) {
    logger.error("password_set_at update failed", { userId: user.id, extra: { code: metadataError.code ?? "unknown" } });
    return { status: "error", error: "unexpected" };
  }

  const { error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError) {
    logger.error("session refresh after set-password failed", { userId: user.id, extra: { code: refreshError.code ?? "unknown" } });
    return { status: "error", error: "unexpected" };
  }

  return redirect({ href: "/", locale });
}
