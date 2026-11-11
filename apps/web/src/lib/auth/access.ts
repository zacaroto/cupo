// Account and email side of the members and guides flows (KTD8, R9). The
// only module of U4 that holds the secret key, and only for `auth.admin.*`
// plus the `profiles` lookup by email. Business rows (memberships, guides)
// are written by the callers under the administrador's own session.
//
// What this module never does: mint links (`generateLink` returns a live
// sign-in token for a user who may belong to another operator, so no
// `action_link` or `hashed_token` ever reaches the app), or log an email
// address. Failures are reported by Supabase error code only.
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@cupo/shared";
import { createAdminClient } from "@/lib/supabase/admin";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/env";
import { logger } from "@/lib/logger";

/**
 * An `ilike` pattern that matches `email` exactly, case-insensitively: the
 * LIKE wildcards `%`, `_` and the escape `\` are escaped. Callers pass
 * Zod-validated emails, which cannot contain PostgREST's `*` wildcard alias.
 */
export function exactEmailPattern(email: string): string {
  return email.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The auth user id for an email, from the `profiles` mirror by
 * `lower(email)` (KTD8), or null. Throws when the lookup itself fails.
 */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const wanted = email.toLowerCase();
  const { data, error } = await createAdminClient()
    .from("profiles")
    .select("id, email")
    .ilike("email", exactEmailPattern(wanted))
    .limit(2);
  if (error) throw error;
  // Belt and braces over the escaped pattern: keep only the exact match.
  const match = (data ?? []).find((profile) => profile.email.toLowerCase() === wanted);
  return match?.id ?? null;
}

export type InviteOutcome =
  /** A new user was created and the invite mail sent, or an unconfirmed invitee got it again. */
  | { kind: "invited"; userId: string }
  /** The email already belongs to a confirmed account: no mail was sent. */
  | { kind: "exists" }
  /** No mail went out (rate limit, SMTP, anything else). */
  | { kind: "failed" };

/** Staff invite: `inviteUserByEmail` with the app origin as `redirectTo` (the templates build `{{ .RedirectTo }}/auth/confirm`). */
export async function inviteStaffByEmail(email: string, redirectTo: string | undefined): Promise<InviteOutcome> {
  const { data, error } = await createAdminClient().auth.admin.inviteUserByEmail(email, { redirectTo });
  if (!error && data.user) return { kind: "invited", userId: data.user.id };
  if (error?.code === "email_exists") return { kind: "exists" };
  logger.warn("invite email failed", { extra: { code: error?.code ?? "no_user", status: error?.status } });
  return { kind: "failed" };
}

/**
 * Sends a one-time sign-in link to an existing account
 * (`signInWithOtp({ shouldCreateUser: false })`). Uses a stateless client
 * with the publishable key: the endpoint is public, and the administrador's
 * own session cookies stay untouched. True when the mail was accepted.
 */
export async function sendSignInLink(email: string, redirectTo: string | undefined): Promise<boolean> {
  const client = createClient<Database>(supabaseUrl(), supabasePublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "implicit" },
  });
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
  });
  if (error) {
    logger.warn("sign-in link email failed", { extra: { code: error.code ?? "unknown", status: error.status } });
    return false;
  }
  return true;
}

/**
 * The account a guide signs in with: the existing user for the email, or a
 * new one created with `email_confirm: true` and no password, so no invite
 * mail is sent and the guide only ever receives magic links (KTD8).
 * `created` tells the caller it may delete the account on a later failure.
 */
export async function ensureGuideAccount(
  email: string,
  fullName: string,
): Promise<{ userId: string; created: boolean } | null> {
  const existing = await findUserIdByEmail(email);
  if (existing) return { userId: existing, created: false };

  const { data, error } = await createAdminClient().auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (!error && data.user) return { userId: data.user.id, created: true };
  if (error?.code === "email_exists") {
    // Created concurrently since the lookup.
    const raced = await findUserIdByEmail(email);
    if (raced) return { userId: raced, created: false };
  }
  logger.error("guide account creation failed", { extra: { code: error?.code ?? "no_user", status: error?.status } });
  return null;
}

/** Removes an account this request created, when a later step failed. Best effort. */
export async function deleteCreatedAccount(userId: string): Promise<void> {
  const { error } = await createAdminClient().auth.admin.deleteUser(userId);
  if (error) logger.error("cleanup of a created account failed", { userId, extra: { code: error.code ?? "unknown" } });
}
