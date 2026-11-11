// Request proxy (KTD9; Next 16 renamed middleware to proxy, Node runtime).
//
// 1. Supabase first: updateSession() verifies the session with getClaims()
//    and writes refreshed cookies onto the request and a response.
// 2. Optimistic redirect: no session on an app path goes to /{locale}/login.
//    The DAL (requireOperatorContext) is the authority; this only saves a
//    render. Auth pages are allowlisted so nothing loops.
// 3. next-intl second, on the same mutated request, so the forwarded request
//    headers carry the refreshed cookies; the session cookies (with their
//    options) and the no-cache headers are copied onto its response.
import { hasLocale } from "next-intl";
import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";
import { updateSession } from "@/lib/supabase/proxy";

const handleI18nRouting = createMiddleware(routing);

/** Locale-relative paths that render without a session (they check it themselves). */
const PUBLIC_PATHS = new Set(["/login", "/set-password", "/reset-password", "/no-access"]);

/** Headers @supabase/ssr sets whenever it writes auth cookies. */
const CACHE_HEADERS = ["cache-control", "expires", "pragma"] as const;

function splitLocale(pathname: string): { locale: string; rest: string; prefixed: boolean } {
  const [, first = "", ...rest] = pathname.split("/");
  if (hasLocale(routing.locales, first)) {
    return { locale: first, rest: `/${rest.join("/")}`.replace(/\/+$/, "") || "/", prefixed: true };
  }
  return { locale: routing.defaultLocale, rest: pathname, prefixed: false };
}

/** Route handlers outside [locale]; the matcher excludes them, this guards a matcher change. */
function isLocaleFreeRoute(pathname: string): boolean {
  return pathname === "/auth/confirm" || pathname.startsWith("/auth/confirm/");
}

export function requiresSession(pathname: string): boolean {
  if (isLocaleFreeRoute(pathname)) return false;
  const { rest, prefixed } = splitLocale(pathname);
  // "/" without a prefix only redirects to the default locale.
  if (!prefixed && rest === "/") return false;
  return !PUBLIC_PATHS.has(rest);
}

function carrySession(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  for (const name of CACHE_HEADERS) {
    const value = from.headers.get(name);
    if (value !== null) to.headers.set(name, value);
  }
  return to;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { response: session, userId } = await updateSession(request);
  const { pathname } = request.nextUrl;

  if (!userId && requiresSession(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${splitLocale(pathname).locale}/login`;
    url.search = "";
    return carrySession(session, NextResponse.redirect(url));
  }

  // next-intl would prefix a locale-free route with a locale; pass it through.
  if (isLocaleFreeRoute(pathname)) return session;

  // For layouts that need the current section (read with headers()).
  request.headers.set("x-pathname", pathname);
  return carrySession(session, handleI18nRouting(request));
}

export const config = {
  // Everything except API routes, Next and Vercel internals, the token-hash
  // confirm route (it sets the session itself) and files with an extension.
  matcher: ["/((?!api|_next|_vercel|auth/confirm|.*\\..*).*)"],
};
