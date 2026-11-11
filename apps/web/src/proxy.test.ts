import { NextRequest } from "next/server";
import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The Supabase server client is replaced by a fake whose getClaims() reads a
// test cookie: `sb-test-auth-token=valid` is a session, `=expired` is a
// session that refreshes (setAll with a new token plus the cache headers),
// anything else is no session. Everything else (next-intl, NextResponse) is real.
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: {
      cookies: {
        getAll: () => Array<{ name: string; value: string }>;
        setAll: (cookies: Array<{ name: string; value: string; options: Record<string, unknown> }>, headers: Record<string, string>) => void;
      };
    },
  ) => ({
    auth: {
      getClaims: async () => {
        const token = options.cookies.getAll().find((c) => c.name === "sb-test-auth-token")?.value;
        if (token === "expired") {
          options.cookies.setAll(
            [{ name: "sb-test-auth-token", value: "refreshed", options: { path: "/", sameSite: "lax", httpOnly: false, maxAge: 400 } }],
            { "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0", expires: "0", pragma: "no-cache" },
          );
          return { data: { claims: { sub: "11111111-1111-4111-8111-111111111111" } }, error: null };
        }
        if (token === "valid" || token === "refreshed") {
          return { data: { claims: { sub: "11111111-1111-4111-8111-111111111111" } }, error: null };
        }
        return { data: null, error: null };
      },
    },
  }),
}));

let proxy: typeof import("./proxy").proxy;
let config: typeof import("./proxy").config;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  ({ proxy, config } = await import("./proxy"));
});

function request(path: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers: { ...(cookieHeader && { cookie: cookieHeader }), ...headers },
  });
}

describe("proxy redirects (KTD9)", () => {
  it("redirects /es/reservations without a session to /es/login", async () => {
    const response = await proxy(request("/es/reservations"));
    expect(getRedirectUrl(response)).toBe("http://localhost:3000/es/login");
  });

  it("redirects /en/reservations without a session to /en/login", async () => {
    const response = await proxy(request("/en/reservations"));
    expect(getRedirectUrl(response)).toBe("http://localhost:3000/en/login");
  });

  it("uses the default locale for a path without a locale prefix", async () => {
    const response = await proxy(request("/reservations"));
    expect(getRedirectUrl(response)).toBe("http://localhost:3000/es/login");
  });

  it("redirects / to /es (next-intl), keeping the previous next.config redirect behaviour", async () => {
    const response = await proxy(request("/", {}, { "accept-language": "en-US,en;q=0.9" }));
    expect(getRedirectUrl(response)).toBe("http://localhost:3000/es");
  });

  it("does not redirect the allowlisted auth pages", async () => {
    for (const path of ["/es/login", "/en/login", "/es/no-access", "/es/set-password", "/es/reset-password"]) {
      const response = await proxy(request(path));
      expect(getRedirectUrl(response), path).toBeNull();
    }
  });

  it("does not redirect /auth/confirm even if it reaches the proxy", async () => {
    const response = await proxy(request("/auth/confirm?token_hash=x&type=magiclink"));
    expect(getRedirectUrl(response)).toBeNull();
  });

  it("lets a signed-in request through to the page", async () => {
    const response = await proxy(request("/es/reservations", { "sb-test-auth-token": "valid" }));
    expect(getRedirectUrl(response)).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("forwards x-pathname to the render", async () => {
    const response = await proxy(request("/es/reservations", { "sb-test-auth-token": "valid" }));
    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/es/reservations");
    expect(response.headers.get("x-middleware-override-headers")).toContain("x-pathname");
  });

  it("after a refresh, the forwarded request cookies carry the new token, not only Set-Cookie", async () => {
    const response = await proxy(request("/es/reservations", { "sb-test-auth-token": "expired", other: "1" }));
    expect(getRedirectUrl(response)).toBeNull();
    // What the Server Components will read through cookies():
    const forwarded = response.headers.get("x-middleware-request-cookie") ?? "";
    expect(forwarded).toContain("sb-test-auth-token=refreshed");
    expect(forwarded).not.toContain("sb-test-auth-token=expired");
    expect(forwarded).toContain("other=1");
    // What the browser stores, with the options @supabase/ssr chose:
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sb-test-auth-token=refreshed");
    expect(setCookie).toMatch(/Max-Age=400/i);
    // Auth responses must never be cached by a CDN.
    expect(response.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
  });

  it("keeps refreshed cookies on a login redirect too", async () => {
    // The fake refreshes `expired` into a session, so use a path that needs none
    // to check the merge on next-intl's own redirect of "/".
    const response = await proxy(request("/", { "sb-test-auth-token": "expired" }));
    expect(getRedirectUrl(response)).toBe("http://localhost:3000/es");
    expect(response.headers.get("set-cookie") ?? "").toContain("sb-test-auth-token=refreshed");
  });
});

describe("proxy matcher", () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it("runs on pages and the root", () => {
    for (const url of ["/", "/es", "/es/reservations", "/en/login", "/reservations"]) {
      expect(matches(url), url).toBe(true);
    }
  });

  it("skips auth/confirm, api, Next internals, Vercel internals and files", () => {
    for (const url of ["/auth/confirm", "/auth/confirm?token_hash=x", "/api/health", "/_next/static/chunk.js", "/_vercel/insights/script.js", "/favicon.ico", "/robots.txt"]) {
      expect(matches(url), url).toBe(false);
    }
  });
});
