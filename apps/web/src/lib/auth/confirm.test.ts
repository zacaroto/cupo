import { describe, expect, it } from "vitest";
import { confirmDestination, confirmFailureDestination, parseOtpType, resolveConfirmLocale, safeNext } from "./confirm";

describe("confirm route rules (KTD8)", () => {
  it("accepts only the four email OTP types", () => {
    for (const type of ["invite", "recovery", "magiclink", "email"]) expect(parseOtpType(type)).toBe(type);
    for (const type of ["signup", "email_change", "sms", "", null, "INVITE", "magiclink "]) {
      expect(parseOtpType(type), String(type)).toBeNull();
    }
  });

  it("replaces open-redirect and auth-route `next` values with null", () => {
    for (const next of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/%2F%2Fevil.example",
      "/auth/confirm",
      "/auth/confirm?token_hash=x",
      "/es/login",
      "/en/set-password",
      "/es/reset-password?x=1",
      "/es/no-access",
      "javascript:alert(1)",
      "",
      "/",
      "es/reservations",
      "/es/reservations\nSet-Cookie: x=1",
      null,
    ]) {
      expect(safeNext(next), JSON.stringify(next)).toBeNull();
    }
  });

  it("keeps same-origin app paths", () => {
    expect(safeNext("/es/reservations")).toBe("/es/reservations");
    expect(safeNext("/en/agenda?day=2026-11-12")).toBe("/en/agenda?day=2026-11-12");
  });

  it("resolves the locale from next, then the NEXT_LOCALE cookie, then es", () => {
    expect(resolveConfirmLocale("/en/reservations", "es")).toBe("en");
    expect(resolveConfirmLocale(null, "en")).toBe("en");
    expect(resolveConfirmLocale(null, "fr")).toBe("es");
    expect(resolveConfirmLocale("/reservations", undefined)).toBe("es");
  });

  it("derives the destination from the verified type, never from next, for invite and recovery", () => {
    expect(confirmDestination({ type: "invite", next: "/es/reservations", locale: "es" })).toBe("/es/set-password");
    expect(confirmDestination({ type: "recovery", next: null, locale: "en" })).toBe("/en/set-password");
  });

  it("sends magic links to next or home (home routes a guía to the agenda)", () => {
    expect(confirmDestination({ type: "magiclink", next: "/es/agenda", locale: "es" })).toBe("/es/agenda");
    expect(confirmDestination({ type: "magiclink", next: null, locale: "es" })).toBe("/es");
    expect(confirmDestination({ type: "email", next: null, locale: "en" })).toBe("/en");
  });

  it("sends failures to the login page with a generic error", () => {
    expect(confirmFailureDestination("es")).toBe("/es/login?error=link_invalid");
  });
});
