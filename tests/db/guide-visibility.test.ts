// U7 guide visibility against the local stack (plan U7 test scenarios; AE10,
// R11, R20; KTD4, KTD13): the full Data API matrix of what the seeded guía
// (linked to guide a1) reads with their own session, the guía policies on
// tours and customer_display added by the guide_agenda migration, and the
// agenda DAL through the real server code. Fixtures are throwaway rows
// created with the secret key and booked by reservasA; afterAll removes them.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays } from "@cupo/shared/local-date";
import { FUTURE, BookingFixtures, book } from "./booking.ts";
import { GUIDES, OPERATORS, SEED_USERS } from "./fixtures.ts";
import {
  adminClient,
  clientFor,
  closeSql,
  createTestUser,
  deleteTestUser,
  expectZeroRows,
  seedUser,
  uniqueEmail,
  type Client,
} from "./helpers.ts";
import { CookieJar, expectRedirect, form, requestHeaders } from "./next-harness.ts";

let jar = new CookieJar();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => requestHeaders() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

const { loginAction } = await import("../../apps/web/src/app/[locale]/(auth)/login/actions.ts");
const { ACTIVE_OPERATOR_COOKIE, requireOperatorContext } = await import("../../apps/web/src/lib/dal/context.ts");
const { getAgenda } = await import("../../apps/web/src/lib/dal/agenda.ts");
const { ForbiddenError } = await import("../../apps/web/src/lib/dal/errors.ts");
const { cancelReservationAction } = await import("../../apps/web/src/app/[locale]/(app)/reservations/actions.ts");

const A = OPERATORS.a.id;
const PAST = "2025-03-04";
const admin = adminClient();
const fx = new BookingFixtures();
const IDLE = { status: "idle" } as const;

// tours: mine (two future departures of a1), later (one future departure of
// a1, unassigned by a test), past (a1, in the past), other (a2), none (no guide).
const tours: Record<"mine" | "later" | "past" | "other" | "none", string> = {} as never;
const departures: Record<"mine" | "mine2" | "later" | "past" | "other" | "none", string> = {} as never;
const customers: Record<"mine" | "mine2" | "cancelled" | "later" | "past" | "other", string> = {} as never;
const reservations: Record<"mine" | "mine2" | "cancelled" | "later" | "past" | "other", { id: string; code: string }> = {} as never;

let guia: Client;

async function booked(args: Parameters<typeof book>[1]): Promise<{ id: string; code: string }> {
  const { data, error } = await book(await clientFor("reservasA"), args);
  if (error) throw new Error(`${error.code} ${error.message}`);
  return data;
}

async function signIn(user: { id: string; email: string; password: string }): Promise<void> {
  jar = new CookieJar();
  expect(
    await expectRedirect(() => loginAction(IDLE, form({ locale: "es", intent: "password", email: user.email, password: user.password }))),
  ).toBe("/es");
  jar.set(ACTIVE_OPERATOR_COOKIE, `${user.id}:${A}`);
}

/** Ids the guía reads from a table, as a sorted list. */
async function idsOf(table: "tours" | "tour_departures" | "reservations", column = "id"): Promise<string[]> {
  const { data, error } = await guia.from(table).select(column).overrideTypes<Array<Record<string, string>>, { merge: false }>();
  expect(error).toBeNull();
  return [...new Set((data ?? []).map((row) => row[column]))].sort();
}

async function displayIds(): Promise<string[]> {
  const { data, error } = await guia.from("customer_display").select("customer_id");
  expect(error).toBeNull();
  return (data ?? []).map((row) => row.customer_id).sort();
}

/** Customer ids of every reservation the guía reads. */
async function reservationCustomerIds(): Promise<string[]> {
  const { data, error } = await guia.from("reservations").select("customer_id");
  expect(error).toBeNull();
  return [...new Set((data ?? []).map((row) => row.customer_id))].sort();
}

beforeAll(async () => {
  guia = await clientFor("guiaA");
  tours.mine = await fx.tour(A, { name: "Agenda mine" });
  tours.later = await fx.tour(A, { name: "Agenda later" });
  tours.past = await fx.tour(A, { name: "Agenda past" });
  tours.other = await fx.tour(A, { name: "Agenda other" });
  tours.none = await fx.tour(A, { name: "Agenda none" });

  departures.mine = await fx.departure(A, tours.mine, { guideId: GUIDES.a1.id, startTime: "08:00" });
  departures.mine2 = await fx.departure(A, tours.mine, { guideId: GUIDES.a1.id, date: addDays(FUTURE, 1), startTime: "09:30" });
  departures.later = await fx.departure(A, tours.later, { guideId: GUIDES.a1.id, date: addDays(FUTURE, 2) });
  departures.past = await fx.departure(A, tours.past, { guideId: GUIDES.a1.id, date: PAST });
  departures.other = await fx.departure(A, tours.other, { guideId: GUIDES.a2.id });
  departures.none = await fx.departure(A, tours.none);

  customers.mine = await fx.customer(A, { name: `Lucía ${fx.tag} Fernández`, phone: "+506 8222 2222" });
  customers.mine2 = await fx.customer(A, { name: `Mateo ${fx.tag} Quirós` });
  customers.cancelled = await fx.customer(A, { name: `Carla ${fx.tag} Solís` });
  customers.later = await fx.customer(A, { name: `Diego ${fx.tag} Mora` });
  customers.past = await fx.customer(A, { name: `Elena ${fx.tag} Vargas` });
  customers.other = await fx.customer(A, { name: `Franco ${fx.tag} Rojas` });

  reservations.mine = await booked({ operator_id: A, departure_id: departures.mine, customer_id: customers.mine, people: 2, notes: "Alergia al maní" });
  reservations.cancelled = await booked({ operator_id: A, departure_id: departures.mine, customer_id: customers.cancelled, people: 1 });
  const cancel = await (await clientFor("reservasA"))
    .from("reservations")
    .update({ status: "cancelled", cancel_reason: "No viaja" })
    .eq("id", reservations.cancelled.id);
  expect(cancel.error).toBeNull();
  reservations.mine2 = await booked({
    operator_id: A,
    departure_id: departures.mine2,
    customer_id: customers.mine2,
    people: 3,
    status: "pending_review",
  });
  reservations.later = await booked({ operator_id: A, departure_id: departures.later, customer_id: customers.later, people: 1 });
  reservations.past = await booked({ operator_id: A, departure_id: departures.past, customer_id: customers.past, people: 1 });
  reservations.other = await booked({ operator_id: A, departure_id: departures.other, customer_id: customers.other, people: 1 });
});

afterAll(async () => {
  await fx.cleanup();
  await closeSql();
});

describe("AE10 the guía's Data API matrix (R11, R20, KTD4, KTD13)", () => {
  it("tour_departures: only their future departures", async () => {
    const { data, error } = await guia.from("tour_departures").select("id, guide_id, starts_at");
    expect(error).toBeNull();
    const ids = new Set(data?.map((row) => row.id));
    for (const id of [departures.mine, departures.mine2, departures.later]) expect(ids.has(id)).toBe(true);
    for (const id of [departures.past, departures.other, departures.none]) expect(ids.has(id)).toBe(false);
    const now = Date.now();
    for (const row of data ?? []) {
      expect(row.guide_id).toBe(GUIDES.a1.id);
      expect(new Date(row.starts_at).getTime()).toBeGreaterThanOrEqual(now - 60_000);
    }
  });

  it("reservations: only the non-cancelled ones on those departures", async () => {
    const ours = Object.values(reservations).map((r) => r.id);
    const { data, error } = await guia.from("reservations").select("id, status, departure_id").in("id", ours);
    expect(error).toBeNull();
    expect(data?.map((row) => row.id).sort()).toEqual([reservations.mine.id, reservations.mine2.id, reservations.later.id].sort());
    const visibleDepartures = new Set(await idsOf("tour_departures"));
    const all = await guia.from("reservations").select("status, departure_id");
    for (const row of all.data ?? []) {
      expect(row.status).not.toBe("cancelled");
      expect(visibleDepartures.has(row.departure_id)).toBe(true);
    }
  });

  it("reservation_notes, customers, reservation_amounts, tour_prices and audit.events: zero rows", async () => {
    expectZeroRows(await guia.from("reservation_notes").select("reservation_id"));
    expectZeroRows(await guia.from("customers").select("id, name, email, phone"));
    expectZeroRows(await guia.from("reservation_amounts").select("reservation_id"));
    expectZeroRows(await guia.from("tour_prices").select("id"));
    expectZeroRows(await guia.schema("audit").from("events").select("id"));
    expectZeroRows(await guia.from("tour_schedules").select("id"));
  });

  it("customer_display: the masked names of the customers on those reservations, and no others", async () => {
    expect(await displayIds()).toEqual(await reservationCustomerIds());
    const { data, error } = await guia
      .from("customer_display")
      .select("customer_id, display_name")
      .in("customer_id", Object.values(customers))
      .order("display_name");
    expect(error).toBeNull();
    expect(data).toEqual([
      { customer_id: customers.later, display_name: "Diego M." },
      { customer_id: customers.mine, display_name: "Lucía F." },
      { customer_id: customers.mine2, display_name: "Mateo Q." },
    ]);
  });

  it("memberships and profiles: only their own row", async () => {
    const user = seedUser("guiaA");
    const memberships = await guia.from("memberships").select("user_id, operator_id, role");
    expect(memberships.error).toBeNull();
    expect(memberships.data).toEqual([{ user_id: user.id, operator_id: A, role: "guia" }]);
    const profiles = await guia.from("profiles").select("id, email");
    expect(profiles.error).toBeNull();
    expect(profiles.data).toEqual([{ id: user.id, email: SEED_USERS.guiaA.email }]);
  });

  it("tours: only the tours of their future departures", async () => {
    const visible = await idsOf("tours");
    expect(visible).toEqual(await idsOf("tour_departures", "tour_id"));
    expect(visible).toEqual(expect.arrayContaining([tours.mine, tours.later]));
    for (const id of [tours.past, tours.other, tours.none]) expect(visible).not.toContain(id);
  });

  it("staff still read every masked name of the operator", async () => {
    for (const key of ["contabilidadA", "reservasA", "adminA"] as const) {
      const { data, error } = await (await clientFor(key)).from("customer_display").select("customer_id").in("customer_id", Object.values(customers));
      expect(error).toBeNull();
      expect(data?.map((row) => row.customer_id).sort()).toEqual(Object.values(customers).sort());
    }
  });
});

describe("the agenda DAL (U7)", () => {
  it("lists the seeded guía's future departures by local day with masked names and nothing else", async () => {
    await signIn(seedUser("guiaA"));
    const ctx = await requireOperatorContext("agenda.read");
    expect(ctx).toMatchObject({ role: "guia", guideId: GUIDES.a1.id });
    const agenda = await getAgenda(ctx);
    const all = agenda.days.flatMap((day) => day.departures.map((departure) => ({ ...departure, date: day.date })));
    const ids = all.map((departure) => departure.id);
    for (const id of [departures.mine, departures.mine2, departures.later]) expect(ids).toContain(id);
    for (const id of [departures.past, departures.other, departures.none]) expect(ids).not.toContain(id);

    const mine = all.find((departure) => departure.id === departures.mine);
    expect(mine).toMatchObject({ date: FUTURE, startTime: "08:00", tourName: `Agenda mine ${fx.tag}`, people: 2, capacity: 10 });
    expect(mine?.reservations).toEqual([
      { id: reservations.mine.id, code: reservations.mine.code, status: "confirmed", people: 2, customerName: "Lucía F." },
    ]);
    const mine2 = all.find((departure) => departure.id === departures.mine2);
    expect(mine2).toMatchObject({ date: addDays(FUTURE, 1), startTime: "09:30" });
    expect(mine2?.reservations).toEqual([
      { id: reservations.mine2.id, code: reservations.mine2.code, status: "pending_review", people: 3, customerName: "Mateo Q." },
    ]);

    // Days in order, departures in order within each day.
    const dates = agenda.days.map((day) => day.date);
    expect(dates).toEqual([...dates].sort());
    for (const day of agenda.days) {
      const starts = day.departures.map((departure) => Date.parse(departure.startsAt));
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    }
    expect(agenda.hasMore).toBe(false);
  });

  it("refuses the guía every other section's permission and action (the forbidden state behind the layout redirect)", async () => {
    await signIn(seedUser("guiaA"));
    for (const action of ["reservations.read", "departures.read", "tours.read", "customers.read", "guides.read", "members.read"] as const) {
      await expect(requireOperatorContext(action)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await cancelReservationAction(IDLE, form({ reservationId: reservations.mine.id, reason: "No" }))).toMatchObject({
      status: "error",
      error: "forbidden",
    });
    const { data } = await admin.from("reservations").select("status").eq("id", reservations.mine.id).single();
    expect(data?.status).toBe("confirmed");
  });

  it("gives a guía with no assigned departures an empty agenda and no error", async () => {
    const { data: guide, error } = await admin.from("guides").insert({ operator_id: A, name: `Agenda vacía ${fx.tag}` }).select("id").single();
    expect(error).toBeNull();
    const user = await createTestUser(admin, {
      email: uniqueEmail("agenda-empty"),
      staff: false,
      guideId: guide!.id,
      memberships: [{ operatorId: A, role: "guia" }],
    });
    try {
      await signIn(user);
      const ctx = await requireOperatorContext("agenda.read");
      expect(ctx).toMatchObject({ role: "guia", guideId: guide!.id });
      expect(await getAgenda(ctx)).toEqual({ days: [], hasMore: false });
      const client = await clientFor(user);
      expectZeroRows(await client.from("tour_departures").select("id"));
      expectZeroRows(await client.from("tours").select("id"));
      expectZeroRows(await client.from("customer_display").select("customer_id"));
    } finally {
      await deleteTestUser(admin, user.id, user.email);
      await admin.from("guides").delete().eq("id", guide!.id);
    }
  });
});

describe("unassigning a departure (KTD13)", () => {
  it("takes its tour, reservations and masked names out of the guía's reach", async () => {
    const unassigned = await admin.from("tour_departures").update({ guide_id: null }).eq("id", departures.later).select("id");
    expect(unassigned.data).toEqual([{ id: departures.later }]);

    expect(await idsOf("tours")).not.toContain(tours.later);
    expect(await idsOf("tours")).toContain(tours.mine);
    expectZeroRows(await guia.from("reservations").select("id").eq("id", reservations.later.id));
    expectZeroRows(await guia.from("customer_display").select("customer_id").eq("customer_id", customers.later));
    expect(await displayIds()).toEqual(await reservationCustomerIds());
  });
});
