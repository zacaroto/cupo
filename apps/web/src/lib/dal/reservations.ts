// Reservations of the active operator (plan U6, R11, R22 to R26; KTD3 to
// KTD5). Every read and write runs with the caller's session, so RLS and the
// role-gated tables decide what comes back: reservas get no amounts,
// contabilidad gets amounts and masked customers, nobody but administrador
// and reservas writes. Seats, codes, the amount snapshot, the incomplete flag
// and the state machine are database triggers; this module never re-checks
// them, and their errors reach result.ts by name. Takes `ctx`, never resolves
// it (KTD3). Customer data is never logged.
import "server-only";
import { can } from "@cupo/shared/permissions";
import type { ReservationCreateInput, ReservationStatus } from "@cupo/shared/schemas/reservations";
import { normalizeLocalTime } from "@cupo/shared/local-date";
import { createClient } from "@/lib/supabase/server";
import type { OperatorContext } from "./context";
import { getCustomerDisplays, hasFullCustomerAccess } from "./customers";
import { ForbiddenError, NotFoundError } from "./errors";

export type ReservationListItem = {
  id: string;
  code: string;
  status: ReservationStatus;
  people: number;
  hasIncompleteData: boolean;
  cancelReason: string | null;
  departureId: string;
  /** Local date `YYYY-MM-DD` and time `HH:MM` of the departure (KTD7). */
  date: string;
  startTime: string;
  tourName: string | null;
  customerId: string;
  /** Full name for administrador and reservas; the masked display for everyone else (KTD4). */
  customerName: string | null;
  /** Contact data, full-access roles only. */
  customerContact: { email: string | null; phone: string | null } | null;
  /** The amount snapshot, `amounts.read` roles only (R11). */
  amount: { totalMinor: number; currency: string; overridden: boolean } | null;
};

export type ReservationFilter = {
  /** Inclusive local date range of the departures. */
  from: string;
  to: string;
  status?: ReservationStatus;
};

/** Reservations listed per page. */
export const RESERVATION_LIST_LIMIT = 200;

type ReservationRow = {
  id: string;
  code: string;
  status: ReservationStatus;
  people: number;
  has_incomplete_data: boolean;
  cancel_reason: string | null;
  departure_id: string;
  customer_id: string;
  departure: { date: string; start_time: string; tour: { name: string } | null } | null;
  customer?: { name: string; email: string | null; phone: string | null } | null;
  amount?: { total_minor: number; currency: string; amount_overridden: boolean } | null;
};

const BASE_COLUMNS =
  "id, code, status, people, has_incomplete_data, cancel_reason, departure_id, customer_id, " +
  "departure:tour_departures!reservations_departure_fkey!inner(date, start_time, tour:tours!tour_departures_tour_fkey(name))";
const CUSTOMER_COLUMNS = "customer:customers!reservations_customer_fkey(name, email, phone)";
const AMOUNT_COLUMNS = "amount:reservation_amounts!reservation_amounts_reservation_fkey(total_minor, currency, amount_overridden)";

function requireWrite(ctx: OperatorContext): void {
  if (!can(ctx.role, "reservations.write")) throw new ForbiddenError("reservations.write");
}

/**
 * Reservations whose departure falls in a local date range, by departure date
 * and time. Full-access roles get names and contact data in the same query;
 * other roles get the masked names from `customer_display` in a second query
 * (KTD4). Amounts are only requested for `amounts.read` roles. One row past
 * the limit reports `hasMore`.
 */
export async function listReservations(
  ctx: OperatorContext,
  filter: ReservationFilter,
): Promise<{ reservations: ReservationListItem[]; hasMore: boolean }> {
  const full = hasFullCustomerAccess(ctx);
  const amounts = can(ctx.role, "amounts.read");
  const columns = [BASE_COLUMNS, full ? CUSTOMER_COLUMNS : null, amounts ? AMOUNT_COLUMNS : null].filter(Boolean).join(", ");

  const supabase = await createClient();
  let request = supabase
    .from("reservations")
    .select(columns)
    .eq("operator_id", ctx.operator.id)
    .gte("departure.date", filter.from)
    .lte("departure.date", filter.to)
    .order("departure(date)")
    .order("departure(start_time)")
    .order("code")
    .limit(RESERVATION_LIST_LIMIT + 1);
  if (filter.status) request = request.eq("status", filter.status);
  const { data, error } = await request.overrideTypes<ReservationRow[], { merge: false }>();
  if (error) throw error;

  const rows = data.slice(0, RESERVATION_LIST_LIMIT);
  const displays = full ? new Map<string, string>() : await getCustomerDisplays(ctx, rows.map((row) => row.customer_id));
  return {
    reservations: rows.map((row) => ({
      id: row.id,
      code: row.code,
      status: row.status,
      people: row.people,
      hasIncompleteData: row.has_incomplete_data,
      cancelReason: row.cancel_reason,
      departureId: row.departure_id,
      date: row.departure?.date ?? "",
      startTime: normalizeLocalTime(row.departure?.start_time ?? "") ?? row.departure?.start_time ?? "",
      tourName: row.departure?.tour?.name ?? null,
      customerId: row.customer_id,
      customerName: full ? (row.customer?.name ?? null) : (displays.get(row.customer_id) ?? null),
      customerContact: full && row.customer ? { email: row.customer.email, phone: row.customer.phone } : null,
      amount: row.amount
        ? { totalMinor: row.amount.total_minor, currency: row.amount.currency, overridden: row.amount.amount_overridden }
        : null,
    })),
    hasMore: data.length > RESERVATION_LIST_LIMIT,
  };
}

/**
 * Books through `create_reservation` (F3): the database materializes the slot
 * when needed, creates the customer when it is new, takes the seats, assigns
 * the code and snapshots the amount in one transaction. The operator comes
 * from `ctx` only.
 */
export async function createReservation(ctx: OperatorContext, input: ReservationCreateInput): Promise<{ id: string; code: string }> {
  requireWrite(ctx);
  const customer =
    "id" in input.customer
      ? { customer_id: input.customer.id }
      : {
          customer_name: input.customer.name,
          ...(input.customer.email !== null && { customer_email: input.customer.email }),
          ...(input.customer.phone !== null && { customer_phone: input.customer.phone }),
        };
  const departure =
    input.departureId !== null
      ? { departure_id: input.departureId }
      : { tour_id: input.tourId, date: input.date, start_time: input.startTime };
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("create_reservation", {
      operator_id: ctx.operator.id,
      people: input.people,
      status: input.status,
      ...departure,
      ...customer,
      ...(input.notes !== null && { notes: input.notes }),
    })
    .single();
  if (error) throw error;
  return data;
}

export type ReservationUpdateInput = {
  reservationId: string;
  /** Null keeps the current value. */
  people: number | null;
  /** An existing departure of the same tour, or null. */
  departureId: string | null;
  /** A slot of the same tour to move to (materialized when needed), or null. */
  slot: { date: string; startTime: string } | null;
  /** Null keeps the notes; "" clears them. */
  notes: string | null;
};

/** Edits people, moves within the tour and sets notes through `update_reservation` (KTD5). */
export async function updateReservation(ctx: OperatorContext, input: ReservationUpdateInput): Promise<void> {
  requireWrite(ctx);
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_reservation", {
    reservation_id: input.reservationId,
    ...(input.people !== null && { people: input.people }),
    ...(input.departureId !== null && { departure_id: input.departureId }),
    ...(input.slot !== null && { date: input.slot.date, start_time: input.slot.startTime }),
    ...(input.notes !== null && { notes: input.notes }),
  });
  if (error) throw error;
}

/**
 * Cancels with a reason (R23). A plain update: the triggers release the seats
 * and refuse a reservation that is already cancelled (`forbidden_transition`).
 * Zero affected rows is `NotFoundError` (found-check, KTD9).
 */
export async function cancelReservation(ctx: OperatorContext, reservationId: string, reason: string): Promise<void> {
  requireWrite(ctx);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("reservations")
    .update({ status: "cancelled", cancel_reason: reason })
    .eq("operator_id", ctx.operator.id)
    .eq("id", reservationId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new NotFoundError("reservation");
}

/** Active (non-cancelled) reservations of a departure and the people they hold, for the cancel confirmation (F4). */
export async function getDepartureBookings(ctx: OperatorContext, departureId: string): Promise<{ reservations: number; people: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("reservations")
    .select("people")
    .eq("operator_id", ctx.operator.id)
    .eq("departure_id", departureId)
    .neq("status", "cancelled");
  if (error) throw error;
  return { reservations: data.length, people: data.reduce((sum, row) => sum + row.people, 0) };
}
