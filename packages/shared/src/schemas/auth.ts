// Zod 4 schemas for the authentication flows (KTD9, KTD15). They validate
// plain objects (the server action converts FormData first) and carry message
// keys, translated by the caller under the `auth` namespace.
import { z } from "zod";

/** Mirrors supabase/config.toml: minimum_password_length = 10, letters and digits. */
export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt ignores bytes past 72; reject instead of silently truncating. */
export const PASSWORD_MAX_LENGTH = 72;

export const emailField = z
  .string({ error: "validation.emailRequired" })
  .trim()
  .toLowerCase()
  .min(1, { error: "validation.emailRequired" })
  .max(254, { error: "validation.emailInvalid" })
  .pipe(z.email({ error: "validation.emailInvalid" }));

export const newPasswordField = z
  .string({ error: "validation.passwordRequired" })
  .min(PASSWORD_MIN_LENGTH, { error: "validation.passwordTooShort" })
  .max(PASSWORD_MAX_LENGTH, { error: "validation.passwordTooLong" })
  .regex(/[A-Za-z]/, { error: "validation.passwordNeedsLetter" })
  .regex(/[0-9]/, { error: "validation.passwordNeedsDigit" });

export const passwordSignInSchema = z.object({
  email: emailField,
  // Never re-validate the policy on sign-in: old passwords must still work.
  password: z.string({ error: "validation.passwordRequired" }).min(1, { error: "validation.passwordRequired" }),
});

/** Magic link and password reset requests: an email and nothing else. */
export const emailOnlySchema = z.object({ email: emailField });

export const setPasswordSchema = z
  .object({
    password: newPasswordField,
    confirmPassword: z.string({ error: "validation.passwordRequired" }),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    error: "validation.passwordMismatch",
  });

/** The operator id is only a request; the action checks it against the user's memberships. */
export const switchOperatorSchema = z.object({
  operatorId: z.uuid({ error: "validation.operatorInvalid" }),
});

export type PasswordSignInInput = z.infer<typeof passwordSignInSchema>;
export type EmailOnlyInput = z.infer<typeof emailOnlySchema>;
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
export type SwitchOperatorInput = z.infer<typeof switchOperatorSchema>;
