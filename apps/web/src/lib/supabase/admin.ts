// Admin Supabase client: the secret key, bypasses RLS. The only reader of
// SUPABASE_SECRET_KEY (REVIEW.md). Use it solely for `auth.admin.*` and the
// service-role `admin_*` RPCs that carry the acting user's id (KTD6); never
// for business reads or writes on behalf of a user.
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@cupo/shared";
import { supabaseUrl } from "./env";

export function createAdminClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is not set (see apps/web/.env.local.example)");

  return createClient<Database>(supabaseUrl(), secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
