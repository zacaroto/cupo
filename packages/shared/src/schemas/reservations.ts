// Zod 4 schemas for reservations (plan U6, R22 to R26, KTD9). They validate
// plain objects (the server action converts FormData first) and carry message
// keys translated under `reservations`, except the new-customer fields, which
// reuse the customer rules and keys (`customers` namespace). Seats, codes,
// amounts, the incomplete flag and every state rule are the database's; these
// schemas only shape input.
import { z } from "zod";
import { Constants, type Database } from "../database.types";
import { isIsoDate, normalizeLocalTime } from "../local-date";
import { customerInputSchema } from "./customers";
import { CAPACITY_MAX } from "./tours";

export type ReservationStatus = Database["public"]["Enums"]["reservation_status"];

export const RESERVATION_STATUSES: readonly ReservationStatus[] = Constants.public.Enums.reservation_status;

/** Statuses a new reservation may start in (R23: never cancelled). */
export const CREATE_STATUSES = ["confirmed", "pending_review"] as const satisfies readonly ReservationStatus[];

export const PEOPLE_MAX = CAPACITY_MAX;
export const NOTES_MAX = 2000;
export const CANCEL_REASON_MAX = 500;

/** The reason the database writes when a departure cancel cascades (KTD5). */
export const DEPARTURE_CANCELLED_REASON = "departure_cancelled";

/** A bookable slot: an existing departure, or a start time to materialize on the tour and date. */
export type SlotChoice = { departureId: string; startTime: null } | { departureId: null; startTime: string };

/** The radio value of a slot: `departure:<id>` when it exists, else `time:<HH:MM>`. */
export function slotValue(slot: { departureId: string | null; startTime: string }): string {
  return slot.departureId ? `departure:${slot.departureId}` : `time:${slot.startTime}`;
}

/** Reads a slot radio value back, or null when it is not one. */
export function parseSlotValue(value: string): SlotChoice | null {
  const [kind, rest] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
  if (kind === "departure" && z.uuid().safeParse(rest).success) return { departureId: rest, startTime: null };
  if (kind === "time") {
    const time = normalizeLocalTime(rest);
    if (time !== null) return { departureId: null, startTime: time };
  }
  return null;
}

const id = (key: string) => z.uuid({ error: key });

const dateField = z
  .string({ error: "validation.dateInvalid" })
  .trim()
  .refine(isIsoDate, { error: "validation.dateInvalid" });

const peopleField = z
  .string({ error: "validation.peopleInvalid" })
  .trim()
  .regex(/^\d{1,5}$/, { error: "validation.peopleInvalid" })
  .transform(Number)
  .refine((value) => value >= 1 && value <= PEOPLE_MAX, { error: "validation.peopleInvalid" });

const notesField = z
  .string()
  .trim()
  .max(NOTES_MAX, { error: "validation.notesTooLong" })
  .transform((value) => (value === "" ? null : value));

/** The customer of a new reservation: an existing one, or a new one created with it. */
export type ReservationCustomer = { id: string } | { name: string; email: string | null; phone: string | null };

/** New-customer fields map to these form names (their keys are the customer schema's). */
const NEW_CUSTOMER_FIELDS = { name: "customerName", email: "customerEmail", phone: "customerPhone" } as const;

/**
 * The new-reservation form (F3): tour and date, a slot, people, status, a
 * customer (picked or typed) and notes.
 */
export const reservationCreateSchema = z
  .object({
    tourId: id("validation.tourRequired"),
    date: dateField,
    slot: z.string({ error: "validation.slotRequired" }).transform((value, ctx) => {
      const slot = parseSlotValue(value);
      if (slot === null) {
        ctx.issues.push({ code: "custom", message: "validation.slotRequired", input: value });
        return z.NEVER;
      }
      return slot;
    }),
    people: peopleField,
    status: z.enum(CREATE_STATUSES, { error: "validation.statusInvalid" }),
    customerMode: z.enum(["existing", "new"], { error: "validation.customerRequired" }),
    customerId: z.string().optional(),
    customerName: z.string().optional(),
    customerEmail: z.string().optional(),
    customerPhone: z.string().optional(),
    notes: notesField,
  })
  .transform((value, ctx) => {
    let customer: ReservationCustomer | null = null;
    if (value.customerMode === "existing") {
      if (z.uuid().safeParse(value.customerId ?? "").success) {
        customer = { id: value.customerId as string };
      } else {
        ctx.issues.push({ code: "custom", message: "validation.customerRequired", path: ["customerId"], input: value.customerId });
      }
    } else {
      const parsed = customerInputSchema.safeParse({
        name: value.customerName ?? "",
        email: value.customerEmail ?? "",
        phone: value.customerPhone ?? "",
        preferredLocale: "",
      });
      if (parsed.success) {
        customer = { name: parsed.data.name, email: parsed.data.email, phone: parsed.data.phone };
      } else {
        for (const issue of parsed.error.issues) {
          const field = NEW_CUSTOMER_FIELDS[issue.path[0] as keyof typeof NEW_CUSTOMER_FIELDS];
          ctx.issues.push({ code: "custom", message: issue.message, path: [field ?? "customerName"], input: undefined });
        }
      }
    }

    if (customer === null) return z.NEVER;
    return {
      tourId: value.tourId,
      date: value.date,
      ...value.slot,
      people: value.people,
      status: value.status,
      customer,
      notes: value.notes,
    };
  });

/** Cancelling needs a reason (R23); the database checks it too. */
export const reservationCancelSchema = z.object({
  reservationId: id("validation.idInvalid"),
  reason: z
    .string({ error: "validation.reasonRequired" })
    .trim()
    .min(1, { error: "validation.reasonRequired" })
    .max(CANCEL_REASON_MAX, { error: "validation.reasonTooLong" }),
});

/**
 * The detail page's edit (U10): people, a slot of the same tour on `date` (an
 * existing departure or a schedule time to materialize) and the notes. Empty
 * notes are `null`, which the action turns into a clear when there were notes.
 * Whether anything changed, and every state and capacity rule, is decided
 * after parsing (the action and the database).
 */
export const reservationUpdateSchema = z.object({
  reservationId: id("validation.idInvalid"),
  date: dateField,
  slot: z.string({ error: "validation.slotRequired" }).transform((value, ctx) => {
    const slot = parseSlotValue(value);
    if (slot === null) {
      ctx.issues.push({ code: "custom", message: "validation.slotRequired", input: value });
      return z.NEVER;
    }
    return slot;
  }),
  people: peopleField,
  notes: notesField,
});

/** List filters from the query string; anything invalid falls back to the default. */
export const reservationFilterSchema = z.object({
  from: z.string().optional().transform((value) => (value && isIsoDate(value) ? value : null)),
  to: z.string().optional().transform((value) => (value && isIsoDate(value) ? value : null)),
  status: z
    .string()
    .optional()
    .transform((value) => ((RESERVATION_STATUSES as readonly string[]).includes(value ?? "") ? (value as ReservationStatus) : null)),
});

export type ReservationCreateInput = z.infer<typeof reservationCreateSchema>;
export type ReservationCancelInput = z.infer<typeof reservationCancelSchema>;
export type ReservationUpdateFormInput = z.infer<typeof reservationUpdateSchema>;
