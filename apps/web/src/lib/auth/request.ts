// Request helpers for the auth server actions.
import "server-only";
import { hasLocale } from "next-intl";
import { headers } from "next/headers";
import { routing, type Locale } from "@/i18n/routing";

/** Server actions receive the locale explicitly (KTD12); anything unknown is the default. */
export function localeFrom(formData: FormData): Locale {
  const value = formData.get("locale");
  return typeof value === "string" && hasLocale(routing.locales, value) ? value : routing.defaultLocale;
}

/** A FormData field as a string ("" when absent or a file). */
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * The origin the browser used, for `emailRedirectTo` / `redirectTo`. Email
 * templates build `{{ .RedirectTo }}/auth/confirm?...`, so this is the bare
 * origin. Supabase Auth only honours it when it matches the configured
 * redirect allowlist and falls back to `site_url` otherwise, so a forged
 * Origin header cannot send a link elsewhere.
 */
export async function requestOrigin(): Promise<string | undefined> {
  const h = await headers();
  const candidates = [
    h.get("origin"),
    h.get("x-forwarded-host") && `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host")}`,
    h.get("host") && `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // try the next header
    }
  }
  return undefined;
}
