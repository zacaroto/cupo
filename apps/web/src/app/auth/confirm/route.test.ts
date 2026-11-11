import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { verifyOtp, primeActiveOperatorCookie } = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  primeActiveOperatorCookie: vi.fn(async () => {}),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp } }) }));
vi.mock("@/lib/dal/context", () => ({ primeActiveOperatorCookie }));

import { GET } from "./route";

function get(query: string, cookie?: string) {
  return GET(
    new NextRequest(new URL(`/auth/confirm${query}`, "http://localhost:3000"), {
      headers: cookie ? { cookie } : {},
    }),
  );
}

beforeEach(() => {
  primeActiveOperatorCookie.mockClear();
  verifyOtp.mockReset();
  verifyOtp.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
});

describe("GET /auth/confirm", () => {
  it("redirects a missing token_hash to login with an error, without calling Supabase", async () => {
    const response = await get("?type=magiclink");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/es/login?error=link_invalid");
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("rejects an unknown type without calling Supabase", async () => {
    const response = await get("?token_hash=abc&type=signup");
    expect(response.headers.get("location")).toBe("http://localhost:3000/es/login?error=link_invalid");
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("verifies the token with the requested type and lands an invite on set-password, ignoring next", async () => {
    const response = await get("?token_hash=abc&type=invite&next=/es/reservations");
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "abc", type: "invite" });
    expect(primeActiveOperatorCookie).toHaveBeenCalledTimes(1);
    expect(response.headers.get("location")).toBe("http://localhost:3000/es/set-password");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("replaces hostile next values by home", async () => {
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "/auth/confirm"]) {
      const response = await get(`?token_hash=abc&type=magiclink&next=${encodeURIComponent(next)}`);
      expect(response.headers.get("location"), next).toBe("http://localhost:3000/es");
    }
  });

  it("follows a safe next for a magic link and takes its locale", async () => {
    const response = await get(`?token_hash=abc&type=magiclink&next=${encodeURIComponent("/en/agenda")}`);
    expect(response.headers.get("location")).toBe("http://localhost:3000/en/agenda");
  });

  it("uses the NEXT_LOCALE cookie when next has no locale", async () => {
    const response = await get("?token_hash=abc&type=recovery", "NEXT_LOCALE=en");
    expect(response.headers.get("location")).toBe("http://localhost:3000/en/set-password");
  });

  it("sends a failed verification (expired, reused, wrong type) to login with the generic error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { code: "otp_expired", message: "Email link is invalid or has expired" } });
    const response = await get("?token_hash=abc&type=magiclink");
    expect(response.headers.get("location")).toBe("http://localhost:3000/es/login?error=link_invalid");
    expect(primeActiveOperatorCookie).not.toHaveBeenCalled();
  });
});
