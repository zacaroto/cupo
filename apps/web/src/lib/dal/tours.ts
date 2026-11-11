// Tours, channel prices and weekly schedules of the active operator (plan U5,
// R15, R16, R21). Reads and writes run with the caller's session: RLS lets
// staff read tours and schedules, administradores write them, and only
// administrador and contabilidad read prices (KTD4). Takes `ctx`, never
// resolves it (KTD3); every targeted write is found-checked (KTD9).
import "server-only";
import { can } from "@cupo/shared/permissions";
import type { Channel, ScheduleInput, TourInput, TourPriceInput } from "@cupo/shared/schemas/tours";
import { normalizeLocalTime } from "@cupo/shared/local-date";
import { createClient } from "@/lib/supabase/server";
import type { OperatorContext } from "./context";
import { ForbiddenError, NotFoundError } from "./errors";

export type TourRecord = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  defaultCapacity: number;
  meetingPoint: string | null;
  archived: boolean;
};

export type TourPrice = { channel: Channel; priceMinor: number; currency: string };

export type TourSchedule = {
  id: string;
  weekday: number;
  /** `HH:MM`, local to the operator. */
  startTime: string;
  capacityOverride: number | null;
  validFrom: string;
  validTo: string | null;
};

const TOUR_COLUMNS = "id, name, description, duration_minutes, default_capacity, meeting_point, archived_at";
const SCHEDULE_COLUMNS = "id, weekday, start_time, capacity_override, valid_from, valid_to";

type TourRow = {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  default_capacity: number;
  meeting_point: string | null;
  archived_at: string | null;
};

type ScheduleRow = {
  id: string;
  weekday: number;
  start_time: string;
  capacity_override: number | null;
  valid_from: string;
  valid_to: string | null;
};

function toTour(row: TourRow): TourRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: row.duration_minutes,
    defaultCapacity: row.default_capacity,
    meetingPoint: row.meeting_point,
    archived: row.archived_at !== null,
  };
}

export function toSchedule(row: ScheduleRow): TourSchedule {
  return {
    id: row.id,
    weekday: row.weekday,
    startTime: normalizeLocalTime(row.start_time) ?? row.start_time,
    capacityOverride: row.capacity_override,
    validFrom: row.valid_from,
    validTo: row.valid_to,
  };
}

function tourColumns(input: TourInput) {
  return {
    name: input.name,
    description: input.description,
    duration_minutes: input.durationMinutes,
    default_capacity: input.defaultCapacity,
    meeting_point: input.meetingPoint,
  };
}

/** True when the role reads tour prices (administrador, contabilidad; R11). */
export function canReadPrices(ctx: OperatorContext): boolean {
  return can(ctx.role, "amounts.read");
}

/** Tours of the operator by name; archived ones only when asked (R21: hidden from pickers). */
export async function listTours(ctx: OperatorContext, options: { includeArchived?: boolean } = {}): Promise<TourRecord[]> {
  const supabase = await createClient();
  let request = supabase.from("tours").select(TOUR_COLUMNS).eq("operator_id", ctx.operator.id).order("name").order("id");
  if (!options.includeArchived) request = request.is("archived_at", null);
  const { data, error } = await request;
  if (error) throw error;
  return data.map(toTour);
}

export async function getTour(ctx: OperatorContext, tourId: string): Promise<TourRecord | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tours")
    .select(TOUR_COLUMNS)
    .eq("operator_id", ctx.operator.id)
    .eq("id", tourId)
    .maybeSingle();
  if (error) throw error;
  return data ? toTour(data) : null;
}

export async function createTour(ctx: OperatorContext, input: TourInput): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tours")
    .insert({ operator_id: ctx.operator.id, ...tourColumns(input) })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function updateTourRow(
  ctx: OperatorContext,
  tourId: string,
  values: Partial<ReturnType<typeof tourColumns>> & { archived_at?: string | null },
): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tours")
    .update(values)
    .eq("operator_id", ctx.operator.id)
    .eq("id", tourId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new NotFoundError("tour");
}

export function updateTour(ctx: OperatorContext, tourId: string, input: TourInput): Promise<void> {
  return updateTourRow(ctx, tourId, tourColumns(input));
}

/** R21: archiving keeps every existing row; it only blocks new departures and reservations. */
export function setTourArchived(ctx: OperatorContext, tourId: string, archived: boolean): Promise<void> {
  return updateTourRow(ctx, tourId, { archived_at: archived ? new Date().toISOString() : null });
}

/** Prices per tour id for the roles that read them; an empty map for the others (RLS would return no rows anyway). */
export async function listTourPrices(ctx: OperatorContext, tourIds: readonly string[]): Promise<Map<string, TourPrice[]>> {
  const prices = new Map<string, TourPrice[]>();
  if (!canReadPrices(ctx) || tourIds.length === 0) return prices;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tour_prices")
    .select("tour_id, channel, price_minor, currency")
    .eq("operator_id", ctx.operator.id)
    .in("tour_id", [...new Set(tourIds)]);
  if (error) throw error;
  for (const row of data) {
    const list = prices.get(row.tour_id) ?? [];
    list.push({ channel: row.channel, priceMinor: row.price_minor, currency: row.currency });
    prices.set(row.tour_id, list);
  }
  return prices;
}

/**
 * Sets the price of one channel (administradores, KTD14). The tour and
 * channel of a price never change (no update grant), so this updates the
 * existing row or inserts a new one; a concurrent insert of the same channel
 * is retried as an update.
 */
export async function setTourPrice(ctx: OperatorContext, input: TourPriceInput): Promise<void> {
  if (!can(ctx.role, "amounts.write")) throw new ForbiddenError("amounts.write");
  const supabase = await createClient();
  const values = { price_minor: input.priceMinor, currency: input.currency };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const updated = await supabase
      .from("tour_prices")
      .update(values)
      .eq("operator_id", ctx.operator.id)
      .eq("tour_id", input.tourId)
      .eq("channel", input.channel)
      .select("id");
    if (updated.error) throw updated.error;
    if (updated.data.length > 0) return;

    const inserted = await supabase
      .from("tour_prices")
      .insert({ operator_id: ctx.operator.id, tour_id: input.tourId, channel: input.channel, ...values });
    if (!inserted.error) return;
    if (inserted.error.code !== "23505") throw inserted.error;
  }
  throw new NotFoundError("tour_price");
}

export async function listSchedules(ctx: OperatorContext, tourId: string): Promise<TourSchedule[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tour_schedules")
    .select(SCHEDULE_COLUMNS)
    .eq("operator_id", ctx.operator.id)
    .eq("tour_id", tourId)
    .order("weekday")
    .order("start_time");
  if (error) throw error;
  return data.map(toSchedule);
}

/** Adds a weekly schedule; the same tour, weekday and time twice is 23505 (`duplicate`). */
export async function createSchedule(ctx: OperatorContext, input: ScheduleInput): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tour_schedules")
    .insert({
      operator_id: ctx.operator.id,
      tour_id: input.tourId,
      weekday: input.weekday,
      start_time: input.startTime,
      capacity_override: input.capacityOverride,
      valid_from: input.validFrom,
      valid_to: input.validTo,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** Removes a weekly schedule; departures already created from it stay as they are. */
export async function deleteSchedule(ctx: OperatorContext, scheduleId: string): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tour_schedules")
    .delete()
    .eq("operator_id", ctx.operator.id)
    .eq("id", scheduleId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new NotFoundError("schedule");
}
