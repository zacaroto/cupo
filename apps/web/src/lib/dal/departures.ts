// Departures of the active operator (plan U5, R16 to R18, R20; KTD5, KTD13).
// Reads and writes run with the caller's session. RLS lets staff read every
// departure and a guía only their future assigned ones; administradores edit,
// close and cancel; administradores and reservas create ad hoc departures.
// The state machine, the archived-tour rule and the capacity backstop live in
// the database (t20_departure_rules, tour_departures_seats_within_capacity);
// this module never re-checks them. Takes `ctx`, never resolves it (KTD3).
import "server-only";
import type { TablesInsert } from "@cupo/shared/database.types";
import { addDays, normalizeLocalTime, weekdayOf } from "@cupo/shared/local-date";
import { can } from "@cupo/shared/permissions";
import type {
  DepartureCreateInput,
  DepartureOrigin,
  DepartureStatus,
  DepartureUpdateInput,
} from "@cupo/shared/schemas/tours";
import { createClient } from "@/lib/supabase/server";
import type { OperatorContext } from "./context";
import { ForbiddenError, NotFoundError } from "./errors";
import { toSchedule, type TourSchedule } from "./tours";

export type DepartureRecord = {
  id: string;
  tourId: string;
  tourName: string | null;
  /** Local date `YYYY-MM-DD` and time `HH:MM` in the operator's zone (KTD7). */
  date: string;
  startTime: string;
  /** The UTC instant derived by the database. */
  startsAt: string;
  capacity: number;
  seatsBooked: number;
  status: DepartureStatus;
  origin: DepartureOrigin;
  guideId: string | null;
  guideName: string | null;
};

/** One bookable time of a tour on a date: an existing departure, or a schedule not materialized yet. */
export type DepartureSlot = {
  startTime: string;
  /** Null until the first reservation (or an ad hoc create) materializes it. */
  departureId: string | null;
  status: Exclude<DepartureStatus, "cancelled"> | null;
  origin: DepartureOrigin;
  capacity: number;
  seatsBooked: number;
  available: number;
};

const COLUMNS =
  "id, tour_id, date, start_time, starts_at, capacity, seats_booked, status, origin, guide_id, " +
  "tour:tours!tour_departures_tour_fkey(name), guide:guides!tour_departures_guide_fkey(name)";

type DepartureRow = {
  id: string;
  tour_id: string;
  date: string;
  start_time: string;
  starts_at: string;
  capacity: number;
  seats_booked: number;
  status: DepartureStatus;
  origin: DepartureOrigin;
  guide_id: string | null;
  tour: { name: string } | null;
  guide: { name: string } | null;
};

function toDeparture(row: DepartureRow): DepartureRecord {
  return {
    id: row.id,
    tourId: row.tour_id,
    tourName: row.tour?.name ?? null,
    date: row.date,
    startTime: normalizeLocalTime(row.start_time) ?? row.start_time,
    startsAt: row.starts_at,
    capacity: row.capacity,
    seatsBooked: row.seats_booked,
    status: row.status,
    origin: row.origin,
    guideId: row.guide_id,
    guideName: row.guide?.name ?? null,
  };
}

/** Departures listed per page. */
export const DEPARTURE_LIST_LIMIT = 200;

export type DepartureFilter = {
  /** Inclusive local date range. */
  from: string;
  to: string;
  tourId?: string;
  status?: DepartureStatus;
};

/** Departures in a local date range, by date and time; one row past the limit reports `hasMore`. */
export async function listDepartures(
  ctx: OperatorContext,
  filter: DepartureFilter,
): Promise<{ departures: DepartureRecord[]; hasMore: boolean }> {
  const supabase = await createClient();
  let request = supabase
    .from("tour_departures")
    .select(COLUMNS)
    .eq("operator_id", ctx.operator.id)
    .gte("date", filter.from)
    .lte("date", filter.to)
    .order("date")
    .order("start_time")
    .order("id")
    .limit(DEPARTURE_LIST_LIMIT + 1);
  if (filter.tourId) request = request.eq("tour_id", filter.tourId);
  if (filter.status) request = request.eq("status", filter.status);
  const { data, error } = await request.overrideTypes<DepartureRow[], { merge: false }>();
  if (error) throw error;
  return {
    departures: data.slice(0, DEPARTURE_LIST_LIMIT).map(toDeparture),
    hasMore: data.length > DEPARTURE_LIST_LIMIT,
  };
}

export async function getDeparture(ctx: OperatorContext, departureId: string): Promise<DepartureRecord | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tour_departures")
    .select(COLUMNS)
    .eq("operator_id", ctx.operator.id)
    .eq("id", departureId)
    .overrideTypes<DepartureRow[], { merge: false }>();
  if (error) throw error;
  const [row] = data;
  return row ? toDeparture(row) : null;
}

/**
 * The insert a client may send: `starts_at` comes from t30 and an omitted
 * `capacity` from the tour default (t20), so neither is required here even
 * though the generated type lists both.
 */
type DepartureInsert = Omit<TablesInsert<"tour_departures">, "starts_at" | "capacity" | "seats_booked" | "status" | "origin"> & {
  capacity?: number;
};

/**
 * Creates an ad hoc departure (R17) under the departure insert policy. Only
 * administradores may name a guide (KTD13); the database rejects an archived
 * tour (`tour_archived`), a taken slot (23505) and another operator's tour or
 * guide (23503).
 */
export async function createDeparture(ctx: OperatorContext, input: DepartureCreateInput): Promise<string> {
  if (input.guideId !== null && !can(ctx.role, "departures.write")) throw new ForbiddenError("departures.write");
  const row: DepartureInsert = {
    operator_id: ctx.operator.id,
    tour_id: input.tourId,
    date: input.date,
    start_time: input.startTime,
    guide_id: input.guideId,
    ...(input.capacity !== null && { capacity: input.capacity }),
  };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tour_departures")
    .insert(row as TablesInsert<"tour_departures">)
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function updateDepartureRow(
  ctx: OperatorContext,
  departureId: string,
  values: { date?: string; start_time?: string; capacity?: number; guide_id?: string | null; status?: DepartureStatus },
): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tour_departures")
    .update(values)
    .eq("operator_id", ctx.operator.id)
    .eq("id", departureId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new NotFoundError("departure");
}

/** The administrador's edit. Capacity below the booked seats fails with `tour_departures_seats_within_capacity`. */
export function updateDeparture(ctx: OperatorContext, input: DepartureUpdateInput): Promise<void> {
  return updateDepartureRow(ctx, input.departureId, {
    date: input.date,
    start_time: input.startTime,
    capacity: input.capacity,
    guide_id: input.guideId,
  });
}

/** `scheduled -> closed` (R18): no new reservations. A cancelled departure answers `forbidden_transition`. */
export function closeDeparture(ctx: OperatorContext, departureId: string): Promise<void> {
  return updateDepartureRow(ctx, departureId, { status: "closed" });
}

/** Cancels through the rpc, the only path the database accepts for `-> cancelled` (KTD5). */
export async function cancelDeparture(_ctx: OperatorContext, departureId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_departure", { departure_id: departureId });
  if (error) throw error;
}

/** Current booked seats of a departure (for the capacity error message), or null. */
export async function getSeatsBooked(ctx: OperatorContext, departureId: string): Promise<number | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tour_departures")
    .select("seats_booked")
    .eq("operator_id", ctx.operator.id)
    .eq("id", departureId)
    .maybeSingle();
  if (error) throw error;
  return data?.seats_booked ?? null;
}

type SlotDeparture = Pick<DepartureRecord, "id" | "startTime" | "status" | "origin" | "capacity" | "seatsBooked">;

/**
 * The slots of a tour on a local date (R16, R17): every weekly schedule of
 * that weekday whose validity window contains the date, plus every existing
 * departure, one slot per start time. An existing departure wins over the
 * schedule at the same time; cancelled departures are ignored (their slot is
 * free again and shows as the schedule, if any). Sorted by time.
 */
export function deriveDepartureSlots(input: {
  date: string;
  defaultCapacity: number;
  schedules: readonly TourSchedule[];
  departures: readonly SlotDeparture[];
}): DepartureSlot[] {
  const weekday = weekdayOf(input.date);
  const slots = new Map<string, DepartureSlot>();
  for (const schedule of input.schedules) {
    if (schedule.weekday !== weekday) continue;
    if (schedule.validFrom > input.date) continue;
    if (schedule.validTo !== null && schedule.validTo < input.date) continue;
    const capacity = schedule.capacityOverride ?? input.defaultCapacity;
    slots.set(schedule.startTime, {
      startTime: schedule.startTime,
      departureId: null,
      status: null,
      origin: "schedule",
      capacity,
      seatsBooked: 0,
      available: capacity,
    });
  }
  for (const departure of input.departures) {
    if (departure.status === "cancelled") continue;
    slots.set(departure.startTime, {
      startTime: departure.startTime,
      departureId: departure.id,
      status: departure.status,
      origin: departure.origin,
      capacity: departure.capacity,
      seatsBooked: departure.seatsBooked,
      available: Math.max(0, departure.capacity - departure.seatsBooked),
    });
  }
  return [...slots.values()].sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** The slots of `tourId` on `date` for the active operator; null when the tour is not visible. */
export async function listDepartureSlots(ctx: OperatorContext, tourId: string, date: string): Promise<DepartureSlot[] | null> {
  const supabase = await createClient();
  const [tour, schedules, departures] = await Promise.all([
    supabase.from("tours").select("default_capacity").eq("operator_id", ctx.operator.id).eq("id", tourId).maybeSingle(),
    supabase
      .from("tour_schedules")
      .select("id, weekday, start_time, capacity_override, valid_from, valid_to")
      .eq("operator_id", ctx.operator.id)
      .eq("tour_id", tourId)
      .eq("weekday", weekdayOf(date)),
    supabase
      .from("tour_departures")
      .select("id, start_time, status, origin, capacity, seats_booked")
      .eq("operator_id", ctx.operator.id)
      .eq("tour_id", tourId)
      .eq("date", date)
      .neq("status", "cancelled"),
  ]);
  if (tour.error) throw tour.error;
  if (schedules.error) throw schedules.error;
  if (departures.error) throw departures.error;
  if (!tour.data) return null;
  return deriveDepartureSlots({
    date,
    defaultCapacity: tour.data.default_capacity,
    schedules: schedules.data.map(toSchedule),
    departures: departures.data.map((row) => ({
      id: row.id,
      startTime: normalizeLocalTime(row.start_time) ?? row.start_time,
      status: row.status,
      origin: row.origin,
      capacity: row.capacity,
      seatsBooked: row.seats_booked,
    })),
  });
}

/** Default list window: today and the next two weeks in the operator's zone. */
export function defaultDepartureWindow(today: string): { from: string; to: string } {
  return { from: today, to: addDays(today, 14) };
}
