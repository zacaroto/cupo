// Booking fixtures for the U6 suites (reservations.test.ts, capacity.test.ts):
// throwaway tours with a direct price, departures, customers and operators
// created with the secret key, plus the `create_reservation` call the app
// makes. Every row carries a random tag; `cleanup()` removes reservations
// first (the counter triggers release their seats), then departures, tours,
// customers and operators.
import { randomBytes } from "node:crypto";
import type { Database, TablesInsert } from "@cupo/shared/database.types";
import { addDays, todayIn } from "@cupo/shared/local-date";
import { OPERATORS } from "./fixtures.ts";
import { adminClient, type Client } from "./helpers.ts";

type CreateArgs = Database["public"]["Functions"]["create_reservation"]["Args"];

/** A local date far enough ahead that every departure is in the future. */
export const FUTURE = addDays(todayIn(OPERATORS.a.timezone), 40);

export class BookingFixtures {
  readonly tag = randomBytes(3).toString("hex");
  readonly admin = adminClient();
  private readonly tours: string[] = [];
  private readonly customers: string[] = [];
  private readonly operators: string[] = [];
  private slot = 0;

  /** A tour with a direct price (unless `price` is null). */
  async tour(
    operatorId: string,
    options: { capacity?: number; price?: number | null; currency?: string; name?: string } = {},
  ): Promise<string> {
    const { data, error } = await this.admin
      .from("tours")
      .insert({
        operator_id: operatorId,
        name: `${options.name ?? "Booking"} ${this.tag}`,
        duration_minutes: 120,
        default_capacity: options.capacity ?? 10,
      })
      .select("id")
      .single();
    if (error) throw error;
    this.tours.push(data.id);
    if (options.price !== null) {
      const price = await this.admin.from("tour_prices").insert({
        operator_id: operatorId,
        tour_id: data.id,
        channel: "direct",
        price_minor: options.price ?? 12500,
        currency: options.currency ?? "USD",
      });
      if (price.error) throw price.error;
    }
    return data.id;
  }

  /** A departure of `tourId`; each call gets its own start time unless one is given. */
  async departure(
    operatorId: string,
    tourId: string,
    options: { capacity?: number; date?: string; startTime?: string; guideId?: string } = {},
  ): Promise<string> {
    this.slot += 1;
    const minutes = 6 * 60 + this.slot;
    const startTime =
      options.startTime ?? `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const row = {
      operator_id: operatorId,
      tour_id: tourId,
      date: options.date ?? FUTURE,
      start_time: startTime,
      capacity: options.capacity ?? 10,
      ...(options.guideId && { guide_id: options.guideId }),
    };
    const { data, error } = await this.admin
      .from("tour_departures")
      .insert(row as unknown as TablesInsert<"tour_departures">)
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async customer(operatorId: string, fields: { name?: string; email?: string | null; phone?: string | null } = {}): Promise<string> {
    const { data, error } = await this.admin
      .from("customers")
      .insert({
        operator_id: operatorId,
        name: fields.name ?? `Cliente Prueba ${this.tag}`,
        email: fields.email === undefined ? `cliente-${this.tag}-${randomBytes(3).toString("hex")}@cupo.test` : fields.email,
        phone: fields.phone ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    this.customers.push(data.id);
    return data.id;
  }

  /** A throwaway active operator (for per-operator codes). */
  async operator(): Promise<string> {
    const slug = `booking-${this.tag}-${this.operators.length}`;
    const { data, error } = await this.admin
      .from("operators")
      .insert({ name: `Booking ${slug}`, slug, timezone: "America/Costa_Rica", currency: "USD" })
      .select("id")
      .single();
    if (error) throw error;
    this.operators.push(data.id);
    return data.id;
  }

  /** Remembers a customer created outside the fixtures (by an action or the rpc) for cleanup. */
  trackCustomer(id: string): void {
    this.customers.push(id);
  }

  async cleanup(): Promise<void> {
    const departures = this.tours.length
      ? ((await this.admin.from("tour_departures").select("id").in("tour_id", this.tours)).data ?? []).map((row) => row.id)
      : [];
    if (departures.length) await this.must(this.admin.from("reservations").delete().in("departure_id", departures));
    if (this.customers.length) await this.must(this.admin.from("reservations").delete().in("customer_id", this.customers));
    if (this.tours.length) {
      await this.must(this.admin.from("tour_departures").delete().in("tour_id", this.tours));
      await this.must(this.admin.from("tours").delete().in("id", this.tours));
    }
    if (this.customers.length) await this.must(this.admin.from("customers").delete().in("id", this.customers));
    if (this.operators.length) await this.must(this.admin.from("operators").delete().in("id", this.operators));
  }

  private async must(request: PromiseLike<{ error: unknown }>): Promise<void> {
    const { error } = await request;
    if (error) throw error;
  }
}

/** The app's booking call (KTD5): one rpc, one transaction. */
export function book(client: Client, args: CreateArgs) {
  return client.rpc("create_reservation", args).single();
}

/** Current counter of a departure, read with the secret key. */
export async function seatsOf(id: string): Promise<{ seats_booked: number; status: string; capacity: number }> {
  const { data, error } = await adminClient().from("tour_departures").select("seats_booked, status, capacity").eq("id", id).single();
  if (error) throw error;
  return data;
}

/** Sum of people over the non-cancelled reservations of a departure (the R24 invariant). */
export async function heldOn(id: string): Promise<number> {
  const { data, error } = await adminClient().from("reservations").select("people").eq("departure_id", id).neq("status", "cancelled");
  if (error) throw error;
  return data.reduce((sum, row) => sum + row.people, 0);
}

export async function reservationRow(id: string) {
  const { data, error } = await adminClient()
    .from("reservations")
    .select("id, operator_id, code, departure_id, customer_id, people, status, cancel_reason, has_incomplete_data, created_by, channel")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The highest audit event id so far. A test's own events are the ones with a
 * greater id; comparing `at` with the host clock is flaky (the database
 * container's clock can lag the host).
 */
export async function auditMark(): Promise<number> {
  const { data, error } = await adminClient().schema("audit").from("events").select("id").order("id", { ascending: false }).limit(1);
  if (error) throw error;
  return data[0]?.id ?? 0;
}
