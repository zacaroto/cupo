// Session refresh for src/proxy.ts (KTD9). Creates a Supabase client bound to
// the incoming request, calls getClaims() immediately (which refreshes an
// expired access token), and writes refreshed cookies both onto the request
// (so the rest of the proxy and the render see them) and onto a response.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@cupo/shared";
import { supabasePublishableKey, supabaseUrl } from "./env";

export type SessionResult = {
  /** Carries the refreshed `Set-Cookie` headers and the cache headers @supabase/ssr requires. */
  response: NextResponse;
  /** The verified user id, or null without a valid session. */
  userId: string | null;
};

export async function updateSession(request: NextRequest): Promise<SessionResult> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Nothing may run between creating the client and getClaims(): it is what
  // refreshes the session and triggers setAll above.
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;

  return { response, userId: typeof sub === "string" && sub.length > 0 ? sub : null };
}
