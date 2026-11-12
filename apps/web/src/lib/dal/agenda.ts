// Guide agenda (plan U7, R11, R20; KTD4, KTD13). The guía's future assigned
// departures with their reservations and masked customer names, nothing else.
// Three reads with the caller's session, each restricted again by RLS: the
// departures (a guía reads only their future assigned ones), the
// non-cancelled reservations on them, then `customer_display` for those
// customer ids (the KTD4 two-query pattern; PostgREST cannot embed it from
// reservations). No notes, amounts or contact data are requested. Takes
// `ctx`, never resolves it (KTD3). Customer names are never logged.
import "server-only";
import { normalizeLocalTime, todayIn } from "@cupo/shared/local-date";
import type { ReservationStatus } from "@cupo/shared/schemas/reservations";
import type { DepartureStatus } from "@cupo/shared/schemas/tours";
import { createClient } from "@/lib/supabase/server";
import type { OperatorContext } from "./context";
import { getCustomerDisplays } from "./customers";

export type AgendaReservation = {
  id: string;
  code: string;
  status: Exclude<ReservationStatus, "cancelled">;
  people: number;
  /** The masked display name (first name plus last initial), or null when unavailable. */
  customerName: string | null;
};

export type AgendaDeparture = {
  id: string;
  tourName: string | null;
  meetingPoint: string | null;
  /** Local wall-clock time `HH:MM` in the operator's zone (KTD7). */
  startTime: string;
  /** The UTC instant; the agenda groups by its local date. */
  startsAt: string;
  status: DepartureStatus;
  capacity: number;
  /** People on the reservations listed below. */
  people: number;
  reservations: AgendaReservation[];
};

export type AgendaDay = { date: string; departures: AgendaDeparture[] };

/** Departures shown at most; one row past it reports `hasMore`. */
export const AGENDA_LIMIT = 100;

type DepartureRow = {
  id: string;
  start_time: string;
  starts_at: string;
  status: DepartureStatus;
  capacity: number;
  tour: { name: string; meeting_point: string | null } | null;
};

type ReservationRow = {
  id: string;
  code: string;
  status: ReservationStatus;
  people: number;
  departure_id: string;
  customer_id: string;
};

/**
 * Groups departures by the calendar date of `startsAt` in the operator's zone,
 * days and departures in chronological order. A 23:30 UTC start in Costa Rica
 * (UTC-6) belongs to that day's 17:30, not to the UTC date.
 */
export function groupByLocalDate<T extends { startsAt: string }>(
  departures: readonly T[],
  timeZone: string,
): Array<{ date: string; departures: T[] }> {
  const days = new Map<string, T[]>();
  const ordered = [...departures].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (const departure of ordered) {
    const date = todayIn(timeZone, new Date(departure.startsAt));
    const day = days.get(date);
    if (day) day.push(departure);
    else days.set(date, [departure]);
  }
  return [...days].map(([date, items]) => ({ date, departures: items }));
}

/**
 * The agenda of the context's guide: their departures from now on (also a
 * closed or cancelled one, with its status), by local day. A context without
 * a guide (staff, or a guía whose guide link failed to load) gets an empty
 * agenda.
 */
export async function getAgenda(ctx: OperatorContext): Promise<{ days: AgendaDay[]; hasMore: boolean }> {
  if (!ctx.guideId) return { days: [], hasMore: false };
  const supabase = await createClient();

  const { data: departureRows, error: departureError } = await supabase
    .from("tour_departures")
    .select("id, start_time, starts_at, status, capacity, tour:tours!tour_departures_tour_fkey(name, meeting_point)")
    .eq("operator_id", ctx.operator.id)
    .eq("guide_id", ctx.guideId)
    .gte("starts_at", new Date().toISOString())
    .order("starts_at")
    .order("id")
    .limit(AGENDA_LIMIT + 1)
    .overrideTypes<DepartureRow[], { merge: false }>();
  if (departureError) throw departureError;
  const rows = departureRows.slice(0, AGENDA_LIMIT);
  if (rows.length === 0) return { days: [], hasMore: false };

  const { data: reservationRows, error: reservationError } = await supabase
    .from("reservations")
    .select("id, code, status, people, departure_id, customer_id")
    .eq("operator_id", ctx.operator.id)
    .in("departure_id", rows.map((row) => row.id))
    .neq("status", "cancelled")
    .order("code")
    .overrideTypes<ReservationRow[], { merge: false }>();
  if (reservationError) throw reservationError;

  const names = await getCustomerDisplays(ctx, reservationRows.map((row) => row.customer_id));
  const byDeparture = new Map<string, AgendaReservation[]>();
  for (const row of reservationRows) {
    // RLS and the filter already drop cancelled rows; this narrows the type.
    if (row.status === "cancelled") continue;
    const list = byDeparture.get(row.departure_id) ?? [];
    list.push({ id: row.id, code: row.code, status: row.status, people: row.people, customerName: names.get(row.customer_id) ?? null });
    byDeparture.set(row.departure_id, list);
  }

  const departures = rows.map((row): AgendaDeparture => {
    const reservations = byDeparture.get(row.id) ?? [];
    return {
      id: row.id,
      tourName: row.tour?.name ?? null,
      meetingPoint: row.tour?.meeting_point ?? null,
      startTime: normalizeLocalTime(row.start_time) ?? row.start_time,
      startsAt: row.starts_at,
      status: row.status,
      capacity: row.capacity,
      people: reservations.reduce((sum, reservation) => sum + reservation.people, 0),
      reservations,
    };
  });
  return { days: groupByLocalDate(departures, ctx.operator.timezone), hasMore: departureRows.length > AGENDA_LIMIT };
}
