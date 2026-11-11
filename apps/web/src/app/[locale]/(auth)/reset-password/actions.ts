"use server";

// Password reset request (R13). Always answers "sent": the response never
// reveals whether the email has an account. The recovery email links to
// /auth/confirm?type=recovery, which lands on set-password.
import { emailOnlySchema } from "@cupo/shared/schemas/auth";
import { field, requestOrigin } from "@/lib/auth/request";
import { logger } from "@/lib/logger";
import { validationState, type ErrorState } from "@/lib/result";
import { createClient } from "@/lib/supabase/server";

export type ResetPasswordState = { status: "idle" } | { status: "sent" } | ErrorState;

export async function resetPasswordAction(_previous: ResetPasswordState, formData: FormData): Promise<ResetPasswordState> {
  const parsed = emailOnlySchema.safeParse({ email: field(formData, "email") });
  if (!parsed.success) return validationState(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: await requestOrigin() });
  if (error) {
    logger.warn("password reset request failed", { extra: { code: error.code ?? "unknown", status: error.status } });
  }
  return { status: "sent" };
}
