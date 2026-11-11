import { describe, expect, it } from "vitest";
import { emailOnlySchema, passwordSignInSchema, setPasswordSchema, switchOperatorSchema } from "./auth";

function issues(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}:${issue.message}`);
}

describe("auth schemas", () => {
  it("normalizes the email and keeps any non-empty sign-in password", () => {
    const parsed = passwordSignInSchema.parse({ email: "  Admin-A@Cupo.Test ", password: "x" });
    expect(parsed).toEqual({ email: "admin-a@cupo.test", password: "x" });
  });

  it("rejects malformed or missing emails with message keys", () => {
    expect(issues(emailOnlySchema.safeParse({ email: "not-an-email" }))).toEqual(["email:validation.emailInvalid"]);
    expect(issues(emailOnlySchema.safeParse({ email: "" }))).toContain("email:validation.emailRequired");
    expect(issues(emailOnlySchema.safeParse({}))).toEqual(["email:validation.emailRequired"]);
  });

  it("enforces the password policy of config.toml on new passwords", () => {
    expect(issues(setPasswordSchema.safeParse({ password: "short1", confirmPassword: "short1" }))).toEqual([
      "password:validation.passwordTooShort",
    ]);
    expect(issues(setPasswordSchema.safeParse({ password: "onlyletterss", confirmPassword: "onlyletterss" }))).toEqual([
      "password:validation.passwordNeedsDigit",
    ]);
    expect(issues(setPasswordSchema.safeParse({ password: "1234567890", confirmPassword: "1234567890" }))).toEqual([
      "password:validation.passwordNeedsLetter",
    ]);
    expect(setPasswordSchema.safeParse({ password: "Valid12345", confirmPassword: "Valid12345" }).success).toBe(true);
  });

  it("requires the confirmation to match", () => {
    expect(issues(setPasswordSchema.safeParse({ password: "Valid12345", confirmPassword: "Valid123456" }))).toEqual([
      "confirmPassword:validation.passwordMismatch",
    ]);
  });

  it("accepts only a uuid as the requested operator", () => {
    expect(switchOperatorSchema.safeParse({ operatorId: "0b000000-0000-4000-8000-00000000000b" }).success).toBe(true);
    expect(issues(switchOperatorSchema.safeParse({ operatorId: "operator-b" }))).toEqual([
      "operatorId:validation.operatorInvalid",
    ]);
  });
});
