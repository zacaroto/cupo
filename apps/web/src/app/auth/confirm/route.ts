// Token-hash confirm route (KTD8). Email templates link here with
// `?token_hash=...&type=invite|recovery|magiclink`; it lives outside [locale]
// and outside the proxy matcher so the link works from any preview origin.
//
// verifyOtp() sets the session cookies through the server client; the
// destination comes from the verified type (invite and recovery always go to
// set-password). Failures never say why: an expired, reused or forged token
// all land on the login page with the same generic error.
import { NextResponse, type NextRequest } from "next/server";
import { confirmDestination, confirmFailureDestination, parseOtpType, resolveConfirmLocale, safeNext } from "@/lib/auth/confirm";
import { primeActiveOperatorCookie } from "@/lib/dal/context";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

function redirectTo(path: string, request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url), 303);
  // The response sets session cookies; it must never be cached.
  response.headers.set("cache-control", "private, no-cache, no-store, must-revalidate, max-age=0");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = parseOtpType(params.get("type"));
  const next = safeNext(params.get("next"));
  const locale = resolveConfirmLocale(next, request.cookies.get("NEXT_LOCALE")?.value);

  if (!tokenHash || !type) {
    return redirectTo(confirmFailureDestination(locale), request);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) {
    logger.warn("otp verification failed", { extra: { code: error.code ?? "unknown", type } });
    return redirectTo(confirmFailureDestination(locale), request);
  }

  await primeActiveOperatorCookie(supabase);
  return redirectTo(confirmDestination({ type, next, locale }), request);
}
