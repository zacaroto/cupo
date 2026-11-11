// Public Supabase settings. The names are written out literally so Next can
// inline them into client bundles; the secret key is read only in admin.ts.
export function supabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set (see apps/web/.env.local.example)");
  return value;
}

export function supabasePublishableKey(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!value) throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set (see apps/web/.env.local.example)");
  return value;
}
