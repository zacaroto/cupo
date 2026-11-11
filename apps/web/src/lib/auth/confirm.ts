// Rules of the token-hash confirm route (KTD8), kept pure for unit tests.
import { hasLocale } from "next-intl";
import { routing, type Locale } from "@/i18n/routing";

export const OTP_TYPES = ["invite", "recovery", "magiclink", "email"] as const;
export type ConfirmOtpType = (typeof OTP_TYPES)[number];

/** Locale-relative auth pages; a `next` pointing at one would loop or confuse. */
const AUTH_PAGES = new Set(["login", "set-password", "reset-password", "no-access"]);

export function parseOtpType(value: string | null | undefined): ConfirmOtpType | null {
  return (OTP_TYPES as readonly string[]).includes(value ?? "") ? (value as ConfirmOtpType) : null;
}

/**
 * `next` only when it is a same-origin app path: starts with `/` plus a letter
 * or digit (rules out `//host`, `/\host` and schemes), has no control
 * characters or encoded slashes, and is not an auth route.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || !/^\/[A-Za-z0-9]/.test(value)) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value) || /%(2f|5c)/i.test(value)) return null;

  const url = new URL(value, "http://cupo.invalid");
  if (url.origin !== "http://cupo.invalid") return null;

  const [first = "", second = ""] = url.pathname.split("/").filter(Boolean);
  if (first === "auth") return null;
  if (hasLocale(routing.locales, first) && AUTH_PAGES.has(second)) return null;
  if (AUTH_PAGES.has(first)) return null;

  return `${url.pathname}${url.search}`;
}

/** Locale for the destination: the `next` prefix, then the NEXT_LOCALE cookie, then the default. */
export function resolveConfirmLocale(next: string | null, cookieLocale: string | undefined): Locale {
  const fromNext = next?.split("/")[1];
  if (hasLocale(routing.locales, fromNext)) return fromNext;
  if (hasLocale(routing.locales, cookieLocale)) return cookieLocale;
  return routing.defaultLocale;
}

/**
 * Where a verified link lands. Invite and recovery always set a password,
 * whatever `next` says; magic links and email OTPs go to `next` or home.
 */
export function confirmDestination(input: { type: ConfirmOtpType; next: string | null; locale: Locale }): string {
  if (input.type === "invite" || input.type === "recovery") return `/${input.locale}/set-password`;
  return input.next ?? `/${input.locale}`;
}

export function confirmFailureDestination(locale: Locale): string {
  return `/${locale}/login?error=link_invalid`;
}
