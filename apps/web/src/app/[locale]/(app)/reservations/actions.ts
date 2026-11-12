"use server";

// Reservation actions (plan U6, R22 to R26, KTD5, KTD9). Context and
// permission first, Zod on a plain object, the operator id from `ctx`, a
// found-check on every targeted write. Capacity, departure state, archived
// tours, codes and amounts are database rules; their errors arrive here by
// name and are mapped by result.ts. Customer data is never logged.
import { reservationCancelSchema, reservationCreateSchema } from "@cupo/shared/schemas/reservations";
import { refresh } from "next/cache";
import { redirect } from "@/i18n/navigation";
import { field, localeFrom } from "@/lib/auth/request";
import { requireOperatorContext } from "@/lib/dal/context";
import { listCustomers } from "@/lib/dal/customers";
import { cancelReservation, createReservation } from "@/lib/dal/reservations";
import { errorState, validationState, withValues, type ActionState, type ErrorState } from "@/lib/result";

const OK = { status: "ok" } as const;

const CREATE_FIELDS = [
  "tourId",
  "date",
  "slot",
  "people",
  "status",
  "customerMode",
  "customerId",
  "customerName",
  "customerEmail",
  "customerPhone",
  "notes",
] as const;

/**
 * Books a reservation (F3) and returns to the list on the departure's date
 * with the new code. Every failure keeps what the user typed.
 */
export async function createReservationAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const locale = localeFrom(formData);
  const values = Object.fromEntries(CREATE_FIELDS.map((name) => [name, field(formData, name)])) as Record<
    (typeof CREATE_FIELDS)[number],
    string
  >;
  let code: string;
  let date: string;
  try {
    const ctx = await requireOperatorContext("reservations.write");
    const parsed = reservationCreateSchema.safeParse(values);
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    ({ code } = await createReservation(ctx, parsed.data));
    date = parsed.data.date;
  } catch (error) {
    return withValues(errorState(error), values);
  }
  const query = new URLSearchParams({ from: date, to: date, created: code });
  return redirect({ href: `/reservations?${query.toString()}`, locale });
}

/** Cancels a reservation with a reason (R23); the seats return to the departure. */
export async function cancelReservationAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const values = { reason: field(formData, "reason") };
  try {
    const ctx = await requireOperatorContext("reservations.write");
    const parsed = reservationCancelSchema.safeParse({ reservationId: field(formData, "reservationId"), ...values });
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    await cancelReservation(ctx, parsed.data.reservationId, parsed.data.reason);
  } catch (error) {
    return withValues(errorState(error), values);
  }
  refresh();
  return OK;
}

/** One match of the reservation form's customer search. */
export type CustomerOption = { id: string; name: string; email: string | null; phone: string | null };

export type CustomerSearchState = { status: "idle" } | { status: "ok"; data: CustomerOption[] } | ErrorState;

/** Matches shown by the picker; refine the search past that. */
const PICKER_LIMIT = 10;

/**
 * The customer picker's search (name, email or phone), for the roles that
 * read full customer data and book (administrador and reservas).
 */
export async function searchCustomersAction(_previous: CustomerSearchState, query: string): Promise<CustomerSearchState> {
  try {
    const ctx = await requireOperatorContext("reservations.write");
    const list = await listCustomers(ctx, { query: typeof query === "string" ? query.slice(0, 100) : "" });
    if (list.access !== "full") return { status: "error", error: "forbidden" };
    return {
      status: "ok",
      data: list.customers.slice(0, PICKER_LIMIT).map((customer) => ({
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      })),
    };
  } catch (error) {
    return errorState(error);
  }
}
