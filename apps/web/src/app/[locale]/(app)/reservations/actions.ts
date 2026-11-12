"use server";

// Reservation actions (plan U6, R22 to R26, KTD5, KTD9). Context and
// permission first, Zod on a plain object, the operator id from `ctx`, a
// found-check on every targeted write. Capacity, departure state, archived
// tours, codes and amounts are database rules; their errors arrive here by
// name and are mapped by result.ts. Customer data is never logged.
import { reservationCancelSchema, reservationCreateSchema, reservationUpdateSchema } from "@cupo/shared/schemas/reservations";
import { refresh } from "next/cache";
import { redirect } from "@/i18n/navigation";
import { field, localeFrom } from "@/lib/auth/request";
import { requireOperatorContext } from "@/lib/dal/context";
import { listCustomers } from "@/lib/dal/customers";
import { cancelReservation, createReservation, getReservation, updateReservation, type ReservationUpdateInput } from "@/lib/dal/reservations";
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

const UPDATE_FIELDS = ["date", "slot", "people", "notes"] as const;

/** The edit's outcome: whether anything was written. */
export type ReservationUpdateState = ActionState<{ changed: boolean }>;

/**
 * Edits a reservation from the detail page (U10): people, a move to another
 * departure or slot of the same tour, and the notes, through
 * `update_reservation`. Only what differs from the current row is sent. A
 * cancelled reservation is read-only: the database freezes its people and
 * departure, and this action also refuses a notes-only edit with the same
 * `forbidden_transition`. Every failure keeps what the user typed.
 */
export async function updateReservationAction(_previous: ReservationUpdateState, formData: FormData): Promise<ReservationUpdateState> {
  const values = Object.fromEntries(UPDATE_FIELDS.map((name) => [name, field(formData, name)])) as Record<
    (typeof UPDATE_FIELDS)[number],
    string
  >;
  let changed: boolean;
  try {
    const ctx = await requireOperatorContext("reservations.write");
    const parsed = reservationUpdateSchema.safeParse({ reservationId: field(formData, "reservationId"), ...values });
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    const input = parsed.data;
    const current = await getReservation(ctx, input.reservationId);
    if (!current) return withValues({ status: "error", error: "not_found" }, values);
    if (current.status === "cancelled") return withValues({ status: "error", error: "forbidden_transition" }, values);

    const moved = input.slot.departureId === null || input.slot.departureId !== current.departureId;
    const currentNotes = current.notes ?? null;
    const update: ReservationUpdateInput = {
      reservationId: current.id,
      people: input.people !== current.people ? input.people : null,
      departureId: moved ? input.slot.departureId : null,
      slot: moved && input.slot.startTime !== null ? { date: input.date, startTime: input.slot.startTime } : null,
      // "" clears the notes (update_reservation); null leaves them alone.
      notes: input.notes !== currentNotes ? (input.notes ?? "") : null,
    };
    changed = update.people !== null || update.departureId !== null || update.slot !== null || update.notes !== null;
    if (changed) await updateReservation(ctx, update);
  } catch (error) {
    return withValues(errorState(error), values);
  }
  if (changed) refresh();
  return { status: "ok", data: { changed } };
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
