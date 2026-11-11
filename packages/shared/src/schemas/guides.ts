// Zod 4 schemas for the guide registry (U4, R19). The form posts strings; the
// schema turns them into the column values (null for empty optionals, arrays
// for the comma-separated lists). Message keys are translated under the
// `guides` namespace.
import { z } from "zod";

export const GUIDE_NAME_MAX = 120;
export const GUIDE_PHONE_MAX = 40;
export const GUIDE_LIST_MAX_ITEMS = 20;
export const GUIDE_LIST_ITEM_MAX = 40;

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, { error: "validation.emailInvalid" })
  .refine((value) => value === "" || z.email().safeParse(value).success, { error: "validation.emailInvalid" })
  .transform((value) => (value === "" ? null : value));

const optionalPhone = z
  .string()
  .trim()
  .max(GUIDE_PHONE_MAX, { error: "validation.phoneInvalid" })
  .regex(/^[0-9+()\-.\s]*$/, { error: "validation.phoneInvalid" })
  .transform((value) => (value === "" ? null : value));

/** "es, en ,es" -> ["es", "en"]: trimmed, de-duplicated, empty items dropped. */
const commaList = z
  .string()
  .transform((value) => [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))])
  .pipe(
    z
      .array(z.string().max(GUIDE_LIST_ITEM_MAX, { error: "validation.listItemTooLong" }))
      .max(GUIDE_LIST_MAX_ITEMS, { error: "validation.listTooLong" }),
  );

const optionalHours = z
  .string()
  .trim()
  .refine((value) => value === "" || /^\d{1,2}$/.test(value), { error: "validation.hoursInvalid" })
  .transform((value) => (value === "" ? null : Number(value)))
  .refine((value) => value === null || (value >= 1 && value <= 24), { error: "validation.hoursInvalid" });

export const guideSchema = z.object({
  name: z
    .string({ error: "validation.nameRequired" })
    .trim()
    .min(1, { error: "validation.nameRequired" })
    .max(GUIDE_NAME_MAX, { error: "validation.nameTooLong" }),
  email: optionalEmail,
  phone: optionalPhone,
  languages: commaList,
  specialties: commaList,
  maxDailyHours: optionalHours,
});

export const guideIdSchema = z.object({
  guideId: z.uuid({ error: "validation.idInvalid" }),
});

export const guideUpdateSchema = guideIdSchema.extend(guideSchema.shape);

export const guideActiveSchema = guideIdSchema.extend({
  active: z.enum(["true", "false"], { error: "validation.idInvalid" }).transform((value) => value === "true"),
});

/** Parsed guide fields, ready for the `guides` columns. */
export type GuideInput = z.infer<typeof guideSchema>;
export type GuideUpdateInput = z.infer<typeof guideUpdateSchema>;
export type GuideActiveInput = z.infer<typeof guideActiveSchema>;
