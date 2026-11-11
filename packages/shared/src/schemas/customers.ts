// Zod 4 schemas for customers (plan U9, R26, KTD9). They validate plain
// objects (the server action converts FormData first) and carry message keys
// translated under the `customers` namespace. The database checks mirror
// these rules (customers_* constraints), so a direct Data API write meets the
// same limits.
import { z } from "zod";

export const CUSTOMER_NAME_MAX_LENGTH = 200;
export const CUSTOMER_EMAIL_MAX_LENGTH = 254;
export const CUSTOMER_PHONE_MIN_LENGTH = 4;
export const CUSTOMER_PHONE_MAX_LENGTH = 40;
/** Longest search term the customers list accepts; longer input is cut. */
export const CUSTOMER_SEARCH_MAX_LENGTH = 100;

export const CUSTOMER_LOCALES = ["es", "en"] as const;
export type CustomerLocale = (typeof CUSTOMER_LOCALES)[number];

/** "" (an empty form field) and whitespace-only input become null. */
function blankToNull(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

const nameField = z
  .string({ error: "validation.nameRequired" })
  .trim()
  .min(1, { error: "validation.nameRequired" })
  .max(CUSTOMER_NAME_MAX_LENGTH, { error: "validation.nameTooLong" });

const emailField = z.preprocess(
  blankToNull,
  z
    .string({ error: "validation.emailInvalid" })
    .trim()
    .toLowerCase()
    .max(CUSTOMER_EMAIL_MAX_LENGTH, { error: "validation.emailInvalid" })
    .pipe(z.email({ error: "validation.emailInvalid" }))
    .nullable(),
);

const phoneField = z.preprocess(
  blankToNull,
  z
    .string({ error: "validation.phoneInvalid" })
    .trim()
    .min(CUSTOMER_PHONE_MIN_LENGTH, { error: "validation.phoneInvalid" })
    .max(CUSTOMER_PHONE_MAX_LENGTH, { error: "validation.phoneInvalid" })
    .regex(/^[0-9+(). -]+$/, { error: "validation.phoneInvalid" })
    .regex(/[0-9]/, { error: "validation.phoneInvalid" })
    .nullable(),
);

const localeField = z.preprocess(
  blankToNull,
  z.enum(CUSTOMER_LOCALES, { error: "validation.localeInvalid" }).nullable(),
);

/** Fields a user may set on a customer. `operator_id` is never part of it (the server stamps it). */
export const customerInputSchema = z.object({
  name: nameField,
  email: emailField,
  phone: phoneField,
  preferredLocale: localeField,
});

/** An edit: the same fields plus the customer id, validated as a uuid. */
export const customerUpdateSchema = customerInputSchema.extend({
  id: z.uuid({ error: "validation.customerInvalid" }),
});

/** List search: optional free text, trimmed, inner whitespace collapsed, cut to the maximum length. */
export const customerSearchSchema = z.object({
  q: z
    .string()
    .optional()
    .transform((value) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, CUSTOMER_SEARCH_MAX_LENGTH)),
});

export type CustomerInput = z.infer<typeof customerInputSchema>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;
