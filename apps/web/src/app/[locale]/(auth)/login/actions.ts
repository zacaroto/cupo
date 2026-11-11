"use server";

// Sign-in actions (R8, KTD8). One form, two submit buttons: `intent=password`
// signs staff in; `intent=link` mails a one-time access link (guides, or
// staff without their password). The link answer never reveals whether the
// email has an account, and the Supabase error for an unknown email is
// swallowed here and never logged with the email.
import { emailOnlySchema, passwordSignInSchema } from "@cupo/shared/schemas/auth";
import { redirect } from "@/i18n/navigation";
import { field, localeFrom, requestOrigin } from "@/lib/auth/request";
import { primeActiveOperatorCookie } from "@/lib/dal/context";
import { logger } from "@/lib/logger";
import { validationState, type ErrorState } from "@/lib/result";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { status: "idle" } | { status: "sent" } | ErrorState;

const RATE_LIMIT_CODES = new Set(["over_request_rate_limit", "over_email_send_rate_limit"]);

export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const locale = localeFrom(formData);
  const supabase = await createClient();

  if (field(formData, "intent") === "link") {
    const parsed = emailOnlySchema.safeParse({ email: field(formData, "email") });
    if (!parsed.success) return validationState(parsed.error);

    const { error } = await supabase.auth.signInWithOtp({
      email: parsed.data.email,
      options: { shouldCreateUser: false, emailRedirectTo: await requestOrigin() },
    });
    if (error && error.code !== "otp_disabled") {
      // otp_disabled is "no such user" with signups off: expected, not logged.
      logger.warn("magic link request failed", { extra: { code: error.code ?? "unknown", status: error.status } });
    }
    return { status: "sent" };
  }

  const parsed = passwordSignInSchema.safeParse({ email: field(formData, "email"), password: field(formData, "password") });
  if (!parsed.success) return validationState(parsed.error);

  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    if (error.code && RATE_LIMIT_CODES.has(error.code)) return { status: "error", error: "rate_limited" };
    return { status: "error", error: "invalid_credentials" };
  }

  await primeActiveOperatorCookie(supabase);
  return redirect({ href: "/", locale });
}
