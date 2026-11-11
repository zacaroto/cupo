// Browser Supabase client for Client Components. Holds the same session as the
// server (cookies), so RLS is the boundary for everything it can read.
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@cupo/shared";
import { supabasePublishableKey, supabaseUrl } from "./env";

export function createClient() {
  return createBrowserClient<Database>(supabaseUrl(), supabasePublishableKey());
}
