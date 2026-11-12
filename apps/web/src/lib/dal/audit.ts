// Change history of a reservation (plan U10, R28, R29, KTD6). The database
// writes `audit.events` on every write path; administradores of the operator
// read them (RLS), nobody writes them. A reservation's history is every event
// with `record_id = <reservation id>` from `reservations` and
// `reservation_amounts` (U6 points the amount rows' record_id at their
// reservation). The diff is pure and unit-tested: only changed keys, minus
// noise; departure and customer ids resolved to labels; the actor resolved
// through `profiles`. Takes `ctx`, never resolves it (KTD3). Audit rows carry
// customer data and amounts, so nothing here logs them.
import "server-only";
import type { Json } from "@cupo/shared/database.types";
import { normalizeLocalTime } from "@cupo/shared/local-date";
import { can } from "@cupo/shared/permissions";
import { createClient } from "@/lib/supabase/server";
import type { OperatorContext } from "./context";
import { getCustomerDisplays, hasFullCustomerAccess } from "./customers";
import { ForbiddenError } from "./errors";

/** The audit columns the history reads. */
export type AuditEvent = {
  id: number;
  table_name: string;
  op: string;
  old_record: Json | null;
  new_record: Json | null;
  actor_id: string | null;
  actor_source: string;
  at: string;
};

export type HistorySubject = "reservation" | "amount";

const SUBJECTS: Readonly<Record<string, HistorySubject>> = { reservations: "reservation", reservation_amounts: "amount" };

/** Keys that change on every write or never mean anything to a reader. `created_by` repeats the actor. */
export const HIDDEN_KEYS: ReadonlySet<string> = new Set(["id", "operator_id", "created_at", "updated_at", "reservation_id", "created_by"]);

/** Display order of the keys a reader cares about most; any other key follows, alphabetically. */
const KEY_ORDER = [
  "status",
  "cancel_reason",
  "departure_id",
  "people",
  "customer_id",
  "has_incomplete_data",
  "code",
  "channel",
  "external_code",
  "total_minor",
  "unit_price_minor",
  "currency",
  "amount_overridden",
];

export type DepartureLabel = { tourName: string | null; date: string; startTime: string };

export type HistoryValue =
  | { kind: "empty" }
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "status"; value: string }
  | { kind: "reason"; value: string }
  | { kind: "money"; minor: number; currency: string }
  /** `label` is null when the departure cannot be read any more. */
  | { kind: "departure"; label: DepartureLabel | null }
  /** `name` is null when the customer cannot be read any more. */
  | { kind: "customer"; name: string | null };

export type HistoryChange = { subject: HistorySubject; field: string; before: HistoryValue; after: HistoryValue };

/** "Sistema" for system writes, "Usuario eliminado" for an actor without a readable profile. */
export type HistoryActor = { kind: "user"; name: string } | { kind: "system" } | { kind: "deleted_user" };

export type HistoryAction = "created" | "updated" | "cancelled" | "deleted";

export type HistoryEntry = {
  /** The first event id of the entry. */
  id: number;
  at: string;
  action: HistoryAction;
  actor: HistoryActor;
  changes: HistoryChange[];
};

export type HistoryLabels = {
  departures: ReadonlyMap<string, DepartureLabel>;
  customers: ReadonlyMap<string, string>;
  /** Display name per profile id the reader may see. */
  actors: ReadonlyMap<string, string>;
};

type JsonRecord = { [key: string]: Json | undefined };

function asRecord(value: Json | null): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function sameValue(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function keyRank(key: string): number {
  const index = KEY_ORDER.indexOf(key);
  return index === -1 ? KEY_ORDER.length : index;
}

/**
 * The keys that changed between two row images, without the noise keys and
 * in display order. An insert (no old row) lists its non-null values; a
 * delete (no new row) lists the non-null values it removed.
 */
export function changedKeys(oldRecord: Json | null, newRecord: Json | null): string[] {
  const before = asRecord(oldRecord) ?? {};
  const after = asRecord(newRecord) ?? {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => !HIDDEN_KEYS.has(key) && !sameValue(before[key], after[key]))
    .sort((a, b) => keyRank(a) - keyRank(b) || a.localeCompare(b));
}

function toValue(key: string, value: Json | undefined, row: JsonRecord, other: JsonRecord, labels: HistoryLabels): HistoryValue {
  if (value === null || value === undefined) return { kind: "empty" };
  if (key === "departure_id" && typeof value === "string") return { kind: "departure", label: labels.departures.get(value) ?? null };
  if (key === "customer_id" && typeof value === "string") return { kind: "customer", name: labels.customers.get(value) ?? null };
  if (key === "status" && typeof value === "string") return { kind: "status", value };
  if (key === "cancel_reason" && typeof value === "string") return { kind: "reason", value };
  if ((key === "total_minor" || key === "unit_price_minor") && typeof value === "number") {
    const currency = row.currency ?? other.currency;
    if (typeof currency === "string") return { kind: "money", minor: value, currency };
  }
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "string") return { kind: "text", value };
  return { kind: "text", value: JSON.stringify(value) };
}

function eventChanges(event: AuditEvent, subject: HistorySubject, labels: HistoryLabels): HistoryChange[] {
  const before = asRecord(event.old_record) ?? {};
  const after = asRecord(event.new_record) ?? {};
  return changedKeys(event.old_record, event.new_record).map((field) => ({
    subject,
    field,
    before: toValue(field, before[field], before, after, labels),
    after: toValue(field, after[field], after, before, labels),
  }));
}

function toActor(event: AuditEvent, labels: HistoryLabels): HistoryActor {
  if (event.actor_source === "system" || event.actor_id === null) return { kind: "system" };
  const name = labels.actors.get(event.actor_id);
  return name ? { kind: "user", name } : { kind: "deleted_user" };
}

function entryAction(events: readonly AuditEvent[]): HistoryAction {
  const reservation = events.filter((event) => event.table_name === "reservations");
  if (reservation.some((event) => event.op === "insert")) return "created";
  if (reservation.some((event) => event.op === "delete")) return "deleted";
  const cancelled = reservation.some((event) => {
    const before = asRecord(event.old_record);
    const after = asRecord(event.new_record);
    return after?.status === "cancelled" && before?.status !== "cancelled";
  });
  return cancelled ? "cancelled" : "updated";
}

/**
 * Events grouped into history entries, newest first. Events of one
 * transaction share `at` (`now()` is the transaction start) and the actor, so
 * one change (a people edit and the amount it recomputes, a create and its
 * amount snapshot) is one entry, reservation changes before amount changes.
 * Events of other tables are ignored, and an entry left without visible
 * changes is dropped.
 */
export function buildHistory(events: readonly AuditEvent[], labels: HistoryLabels): HistoryEntry[] {
  const groups = new Map<string, AuditEvent[]>();
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (!SUBJECTS[event.table_name]) continue;
    const key = `${event.at}|${event.actor_source}|${event.actor_id ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  const entries: HistoryEntry[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (a, b) => Number(SUBJECTS[a.table_name] === "amount") - Number(SUBJECTS[b.table_name] === "amount") || a.id - b.id,
    );
    const changes = ordered.flatMap((event) => eventChanges(event, SUBJECTS[event.table_name], labels));
    if (changes.length === 0) continue;
    entries.push({ id: group[0].id, at: group[0].at, action: entryAction(group), actor: toActor(group[0], labels), changes });
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id);
}

/** The departure, customer and actor ids the events mention, to resolve in one query each. */
export function historyReferences(events: readonly AuditEvent[]): { departureIds: string[]; customerIds: string[]; actorIds: string[] } {
  const departures = new Set<string>();
  const customers = new Set<string>();
  const actors = new Set<string>();
  for (const event of events) {
    for (const record of [asRecord(event.old_record), asRecord(event.new_record)]) {
      if (typeof record?.departure_id === "string") departures.add(record.departure_id);
      if (typeof record?.customer_id === "string") customers.add(record.customer_id);
    }
    if (event.actor_source !== "system" && event.actor_id) actors.add(event.actor_id);
  }
  return { departureIds: [...departures], customerIds: [...customers], actorIds: [...actors] };
}

/** Events read per reservation; a reservation that reaches it shows its latest ones. */
export const HISTORY_EVENT_LIMIT = 500;

/**
 * The history of one reservation of the active operator, newest first, for
 * `audit.read` (administrador). RLS returns nothing to other roles and for
 * other operators' reservations.
 */
export async function getReservationHistory(ctx: OperatorContext, reservationId: string): Promise<HistoryEntry[]> {
  if (!can(ctx.role, "audit.read")) throw new ForbiddenError("audit.read");
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("audit")
    .from("events")
    .select("id, table_name, op, old_record, new_record, actor_id, actor_source, at")
    .eq("operator_id", ctx.operator.id)
    .eq("record_id", reservationId)
    .in("table_name", Object.keys(SUBJECTS))
    .order("id", { ascending: false })
    .limit(HISTORY_EVENT_LIMIT);
  if (error) throw error;
  if (data.length === 0) return [];

  const refs = historyReferences(data);
  const [departures, customers, actors] = await Promise.all([
    departureLabels(ctx, refs.departureIds),
    customerLabels(ctx, refs.customerIds),
    actorLabels(refs.actorIds),
  ]);
  return buildHistory(data, { departures, customers, actors });
}

async function departureLabels(ctx: OperatorContext, ids: readonly string[]): Promise<Map<string, DepartureLabel>> {
  const labels = new Map<string, DepartureLabel>();
  if (ids.length === 0) return labels;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tour_departures")
    .select("id, date, start_time, tour:tours!tour_departures_tour_fkey(name)")
    .eq("operator_id", ctx.operator.id)
    .in("id", ids);
  if (error) throw error;
  for (const row of data) {
    labels.set(row.id, {
      tourName: row.tour?.name ?? null,
      date: row.date,
      startTime: normalizeLocalTime(row.start_time) ?? row.start_time,
    });
  }
  return labels;
}

/** Full names for full-access roles, the masked display for everyone else (KTD4). */
async function customerLabels(ctx: OperatorContext, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  if (!hasFullCustomerAccess(ctx)) return getCustomerDisplays(ctx, ids);
  const supabase = await createClient();
  const { data, error } = await supabase.from("customers").select("id, name").eq("operator_id", ctx.operator.id).in("id", ids);
  if (error) throw error;
  return new Map(data.map((row) => [row.id, row.name]));
}

/**
 * Names of the actors whose profile the reader may see (KTD6 profile policy).
 * A deleted user, or one no longer in any of the reader's operators, is absent.
 */
async function actorLabels(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const supabase = await createClient();
  const { data, error } = await supabase.from("profiles").select("id, email, full_name").in("id", ids);
  if (error) throw error;
  return new Map(data.map((row) => [row.id, row.full_name?.trim() || row.email]));
}
