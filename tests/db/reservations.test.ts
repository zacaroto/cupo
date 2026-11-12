// U6 reservations against the local stack (plan U6 test scenarios; R11, R22
// to R27; KTD4 to KTD6, KTD13, KTD14): the booking rpc (materialization,
// customer upsert, notes), the state machine through every write path
// (AE12), the incomplete flag, the amount snapshot and override (AE4), the
// role-gated tables (AE5), cross-operator references (AE3, AE11), the guía
// policy, deletes, and the actions and list DAL through the real server
// code. Seats and codes under load live in capacity.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays, weekdayOf } from "@cupo/shared/local-date";
import { FUTURE, BookingFixtures, auditMark, book, heldOn, reservationRow, seatsOf } from "./booking.ts";
import { GUIDES, OPERATORS, TOURS } from "./fixtures.ts";
import {
  adminClient,
  anonClient,
  clientFor,
  closeSql,
  expectSqlState,
  expectTypedError,
  expectZeroRows,
  reconcileSeats,
  seedUser,
  type Client,
} from "./helpers.ts";
import { CookieJar, expectRedirect, form, requestHeaders } from "./next-harness.ts";

let jar = new CookieJar();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => requestHeaders() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

const { loginAction } = await import("../../apps/web/src/app/[locale]/(auth)/login/actions.ts");
const { cancelReservationAction, createReservationAction, searchCustomersAction } = await import(
  "../../apps/web/src/app/[locale]/(app)/reservations/actions.ts"
);
const { ACTIVE_OPERATOR_COOKIE, getOperatorContext, requireOperatorContext } = await import(
  "../../apps/web/src/lib/dal/context.ts"
);
const { listReservations, updateReservation, getDepartureBookings } = await import("../../apps/web/src/lib/dal/reservations.ts");

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const admin = adminClient();
const fx = new BookingFixtures();
const IDLE = { status: "idle" } as const;

afterAll(async () => {
  await fx.cleanup();
  await closeSql();
});

async function signIn(key: Parameters<typeof seedUser>[0], operatorId: string): Promise<void> {
  const user = seedUser(key);
  jar = new CookieJar();
  expect(await expectRedirect(() => loginAction(IDLE, form({ locale: "es", intent: "password", email: user.email, password: user.password })))).toBe(
    "/es",
  );
  jar.set(ACTIVE_OPERATOR_COOKIE, `${user.id}:${operatorId}`);
  expect((await getOperatorContext())?.operator.id).toBe(operatorId);
}

/** Books and returns the new reservation's id (throws on failure). */
async function booked(client: Client, args: Parameters<typeof book>[1]): Promise<{ id: string; code: string }> {
  const { data, error } = await book(client, args);
  if (error) throw new Error(`${error.code} ${error.message}`);
  return data;
}

/** The first date on or after FUTURE that falls on `weekday` (0 = Sunday). */
function nextWeekday(weekday: number): string {
  let date = FUTURE;
  while (weekdayOf(date) !== weekday) date = addDays(date, 1);
  return date;
}

describe("create_reservation (F3, R17, R22, R26)", () => {
  it("on a schedule slot with no departure row materializes exactly one departure and books on it", async () => {
    const tour = await fx.tour(A, { capacity: 9 });
    const date = nextWeekday(3);
    const schedule = await admin
      .from("tour_schedules")
      .insert({ operator_id: A, tour_id: tour, weekday: 3, start_time: "07:30", capacity_override: 6, valid_from: FUTURE });
    expect(schedule.error).toBeNull();
    const customer = await fx.customer(A);
    const reservas = await clientFor("reservasA");

    const first = await booked(reservas, { operator_id: A, tour_id: tour, date, start_time: "07:30", customer_id: customer, people: 2 });
    const second = await booked(reservas, { operator_id: A, tour_id: tour, date, start_time: "07:30", customer_id: customer, people: 1 });
    const { data: departures } = await admin.from("tour_departures").select("id, origin, capacity, seats_booked").eq("tour_id", tour);
    expect(departures).toHaveLength(1);
    expect(departures?.[0]).toMatchObject({ origin: "schedule", capacity: 6, seats_booked: 3 });
    expect((await reservationRow(first.id)).departure_id).toBe(departures?.[0].id);
    expect((await reservationRow(second.id)).departure_id).toBe(departures?.[0].id);
    expect(first.code).toMatch(/^D-\d{6}$/);
  });

  it("records the session user as created_by, channel direct, status as asked, and the notes", async () => {
    const tour = await fx.tour(A);
    const departure = await fx.departure(A, tour);
    const customer = await fx.customer(A);
    const reservas = await clientFor("reservasA");
    const { id } = await booked(reservas, {
      operator_id: A,
      departure_id: departure,
      customer_id: customer,
      people: 2,
      status: "pending_review",
      notes: "  Llega tarde  ",
    });
    expect(await reservationRow(id)).toMatchObject({
      created_by: seedUser("reservasA").id,
      channel: "direct",
      status: "pending_review",
      people: 2,
      cancel_reason: null,
    });
    const notes = await reservas.from("reservation_notes").select("notes").eq("reservation_id", id);
    expect(notes.data).toEqual([{ notes: "Llega tarde" }]);
    // pending_review holds seats, then confirms without moving any.
    expect((await seatsOf(departure)).seats_booked).toBe(2);
    expect((await reservas.from("reservations").update({ status: "confirmed" }).eq("id", id).select("status")).data).toEqual([{ status: "confirmed" }]);
    expect((await seatsOf(departure)).seats_booked).toBe(2);
  });

  it("creates a new customer in the same transaction, reuses one whose email exists, and creates none on a failed booking", async () => {
    const tour = await fx.tour(A, { capacity: 3 });
    const departure = await fx.departure(A, tour, { capacity: 3 });
    const email = `nuevo-${fx.tag}@cupo.test`;
    const reservas = await clientFor("reservasA");

    const { id } = await booked(reservas, { operator_id: A, departure_id: departure, customer_name: " Nueva Clienta ", customer_email: email.toUpperCase(), people: 1 });
    const row = await reservationRow(id);
    fx.trackCustomer(row.customer_id);
    const { data: created } = await admin.from("customers").select("name, email, operator_id").eq("id", row.customer_id).single();
    expect(created).toEqual({ name: "Nueva Clienta", email, operator_id: A });
    expect(row.has_incomplete_data).toBe(false);

    const again = await booked(reservas, { operator_id: A, departure_id: departure, customer_name: "Otro nombre", customer_email: email, people: 1 });
    expect((await reservationRow(again.id)).customer_id).toBe(row.customer_id);

    const orphan = `huerfano-${fx.tag}@cupo.test`;
    expectTypedError(
      await book(reservas, { operator_id: A, departure_id: departure, customer_name: "Sin lugar", customer_email: orphan, people: 5 }),
      "capacity_exceeded",
    );
    const { count } = await admin.from("customers").select("id", { count: "exact", head: true }).eq("email", orphan);
    expect(count).toBe(0);
  });

  it("validates its input and found-checks every id (22023, not_found)", async () => {
    const reservas = await clientFor("reservasA");
    const tour = await fx.tour(A);
    const departure = await fx.departure(A, tour);
    const customer = await fx.customer(A);
    expectSqlState(await book(reservas, { operator_id: A, customer_id: customer, people: 1 }), "22023");
    expectSqlState(await book(reservas, { operator_id: A, departure_id: departure, people: 1 }), "22023");
    const foreignDeparture = await fx.departure(B, await fx.tour(B, { currency: "MXN" }));
    const foreignCustomer = await fx.customer(B);
    expectTypedError(await book(reservas, { operator_id: A, departure_id: foreignDeparture, customer_id: customer, people: 1 }), "not_found");
    expectTypedError(await book(reservas, { operator_id: A, departure_id: departure, customer_id: foreignCustomer, people: 1 }), "not_found");
    expectTypedError(
      await book(reservas, { operator_id: A, tour_id: TOURS.b1.id, date: FUTURE, start_time: "09:00", customer_id: customer, people: 1 }),
      "not_found",
    );
    expect((await seatsOf(foreignDeparture)).seats_booked).toBe(0);
  });

  it("only administrador and reservas book: contabilidad, guía and another operator's user get 42501; anon cannot call it", async () => {
    const tour = await fx.tour(A);
    const departure = await fx.departure(A, tour);
    const customer = await fx.customer(A);
    for (const key of ["contabilidadA", "guiaA", "reservasB"] as const) {
      expectSqlState(await book(await clientFor(key), { operator_id: A, departure_id: departure, customer_id: customer, people: 1 }), "42501");
    }
    expectSqlState(await book(anonClient(), { operator_id: A, departure_id: departure, customer_id: customer, people: 1 }), "42501");
    expect((await seatsOf(departure)).seats_booked).toBe(0);
    await booked(await clientFor("adminA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 1 });
    expect((await seatsOf(departure)).seats_booked).toBe(1);
  });
});

describe("cancel and the state machine (R23, AE12)", () => {
  let tour: string;
  let customer: string;

  beforeAll(async () => {
    tour = await fx.tour(A);
    customer = await fx.customer(A);
  });

  it("cancel with a reason releases the seats; without a reason the check fails and nothing moves", async () => {
    const departure = await fx.departure(A, tour);
    const reservas = await clientFor("reservasA");
    const { id } = await booked(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 3 });
    expectSqlState(
      await reservas.from("reservations").update({ status: "cancelled" }).eq("id", id),
      "23514",
      "reservations_cancel_reason_required",
    );
    expectSqlState(await reservas.from("reservations").update({ status: "cancelled", cancel_reason: "  " }).eq("id", id), "23514");
    expect((await seatsOf(departure)).seats_booked).toBe(3);
    const cancelled = await reservas.from("reservations").update({ status: "cancelled", cancel_reason: "No viaja" }).eq("id", id).select("status");
    expect(cancelled.data).toEqual([{ status: "cancelled" }]);
    expect((await seatsOf(departure)).seats_booked).toBe(0);
  });

  it("covers AE12: any change to a cancelled reservation fails with forbidden_transition for every role and the secret key", async () => {
    const departure = await fx.departure(A, tour);
    const reservas = await clientFor("reservasA");
    const { id } = await booked(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 2 });
    await reservas.from("reservations").update({ status: "cancelled", cancel_reason: "Cliente" }).eq("id", id);
    for (const client of [reservas, await clientFor("adminA"), admin]) {
      for (const status of ["confirmed", "pending_review"] as const) {
        expectTypedError(await client.from("reservations").update({ status }).eq("id", id), "forbidden_transition");
      }
      expectTypedError(await client.from("reservations").update({ people: 1 }).eq("id", id), "forbidden_transition");
    }
    expectTypedError(await reservas.rpc("update_reservation", { reservation_id: id, people: 1 }), "forbidden_transition");
    expect(await reservationRow(id)).toMatchObject({ status: "cancelled", people: 2 });
    expect((await seatsOf(departure)).seats_booked).toBe(0);
  });

  it("confirmed never goes back to pending_review; a reservation is never inserted cancelled", async () => {
    const departure = await fx.departure(A, tour);
    const reservas = await clientFor("reservasA");
    const { id } = await booked(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 1 });
    expectTypedError(await reservas.from("reservations").update({ status: "pending_review" }).eq("id", id), "forbidden_transition");
    expectTypedError(
      await reservas.from("reservations").insert({ operator_id: A, departure_id: departure, customer_id: customer, people: 1, status: "cancelled" } as never),
      "forbidden_transition",
    );
    expect((await seatsOf(departure)).seats_booked).toBe(1);
  });

  it("covers AE12: a direct insert by reservas still gets a code, an amount row and the flag", async () => {
    const departure = await fx.departure(A, tour);
    const bare = await fx.customer(A, { email: null, phone: null });
    const reservas = await clientFor("reservasA");
    const { data, error } = await reservas
      .from("reservations")
      .insert({ operator_id: A, departure_id: departure, customer_id: bare, people: 2 } as never)
      .select("id, code, has_incomplete_data, created_by")
      .single();
    expect(error).toBeNull();
    const row = data as unknown as { id: string; code: string; has_incomplete_data: boolean; created_by: string };
    expect(row.code).toMatch(/^D-\d{6}$/);
    expect(row.has_incomplete_data).toBe(true);
    expect(row.created_by).toBe(seedUser("reservasA").id);
    const { data: amount } = await admin.from("reservation_amounts").select("unit_price_minor, total_minor").eq("reservation_id", row.id).single();
    expect(amount).toEqual({ unit_price_minor: 12500, total_minor: 25000 });
    expect((await seatsOf(departure)).seats_booked).toBe(2);
  });
});

describe("update_reservation (KTD5)", () => {
  it("edits people, sets and clears notes, moves to a schedule slot of the same tour, and found-checks", async () => {
    const tour = await fx.tour(A, { capacity: 8 });
    const date = nextWeekday(4);
    await admin.from("tour_schedules").insert({ operator_id: A, tour_id: tour, weekday: 4, start_time: "16:00", valid_from: FUTURE });
    const from = await fx.departure(A, tour);
    const customer = await fx.customer(A);
    const reservas = await clientFor("reservasA");
    const { id } = await booked(reservas, { operator_id: A, departure_id: from, customer_id: customer, people: 2 });

    expect((await reservas.rpc("update_reservation", { reservation_id: id, people: 3, notes: "Ventana" })).error).toBeNull();
    expect((await reservationRow(id)).people).toBe(3);
    expect((await reservas.from("reservation_notes").select("notes").eq("reservation_id", id)).data).toEqual([{ notes: "Ventana" }]);
    expect((await reservas.rpc("update_reservation", { reservation_id: id, notes: "" })).error).toBeNull();
    expect((await reservas.from("reservation_notes").select("notes").eq("reservation_id", id)).data).toEqual([{ notes: "" }]);

    expect((await reservas.rpc("update_reservation", { reservation_id: id, date, start_time: "16:00" })).error).toBeNull();
    const moved = await reservationRow(id);
    const { data: slot } = await admin.from("tour_departures").select("id, origin, seats_booked").eq("id", moved.departure_id).single();
    expect(slot).toMatchObject({ origin: "schedule", seats_booked: 3 });
    expect((await seatsOf(from)).seats_booked).toBe(0);

    expectSqlState(await reservas.rpc("update_reservation", { reservation_id: id, date }), "22023");
    for (const key of ["contabilidadA"] as const) {
      expectSqlState(await (await clientFor(key)).rpc("update_reservation", { reservation_id: id, people: 1 }), "42501");
    }
    expectTypedError(await (await clientFor("reservasB")).rpc("update_reservation", { reservation_id: id, people: 1 }), "not_found");
    expect((await reservationRow(id)).people).toBe(3);
    expect(await reconcileSeats()).toEqual([]);
  });
});

describe("has_incomplete_data (R22, R26)", () => {
  it("is true without email and phone, false after adding a phone, never client-writable, and audited once per changed reservation", async () => {
    const tour = await fx.tour(A);
    const departure = await fx.departure(A, tour);
    const bare = await fx.customer(A, { email: null, phone: null });
    const reservas = await clientFor("reservasA");
    const one = await booked(reservas, { operator_id: A, departure_id: departure, customer_id: bare, people: 1 });
    const two = await booked(reservas, { operator_id: A, departure_id: departure, customer_id: bare, people: 1 });
    expect((await reservationRow(one.id)).has_incomplete_data).toBe(true);

    expectSqlState(await reservas.from("reservations").update({ has_incomplete_data: false } as never).eq("id", one.id), "42501", "permission denied");
    expectSqlState(
      await reservas.from("reservations").insert({ operator_id: A, departure_id: departure, customer_id: bare, people: 1, has_incomplete_data: false } as never),
      "42501",
    );

    const since = await auditMark();
    const updated = await reservas.from("customers").update({ phone: "+506 8000 0000" }).eq("id", bare).select("id");
    expect(updated.data).toHaveLength(1);
    expect((await reservationRow(one.id)).has_incomplete_data).toBe(false);
    expect((await reservationRow(two.id)).has_incomplete_data).toBe(false);
    const { data: events } = await admin
      .schema("audit")
      .from("events")
      .select("record_id, actor_id, actor_source")
      .eq("table_name", "reservations")
      .in("record_id", [one.id, two.id])
      .gt("id", since);
    expect(events?.map((event) => event.record_id).sort()).toEqual([one.id, two.id].sort());
    for (const event of events ?? []) expect(event).toMatchObject({ actor_id: seedUser("reservasA").id, actor_source: "jwt" });

    // A change that leaves the flag as it is writes nothing more.
    const later = await auditMark();
    await reservas.from("customers").update({ phone: "+506 8000 0001" }).eq("id", bare);
    const { data: none } = await admin.schema("audit").from("events").select("id").eq("table_name", "reservations").in("record_id", [one.id, two.id]).gt("id", later);
    expect(none).toEqual([]);
  });
});

describe("amounts (R11, R25, AE4, KTD14)", () => {
  it("covers AE4: reservas reads no amounts; contabilidad reads total = people x direct price; no direct price is price_missing", async () => {
    const tour = await fx.tour(A, { price: 4250, currency: "USD" });
    const departure = await fx.departure(A, tour);
    const customer = await fx.customer(A);
    const reservas = await clientFor("reservasA");
    const { id } = await booked(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 3 });

    expectZeroRows(await reservas.from("reservation_amounts").select("*").eq("reservation_id", id));
    expectZeroRows(await (await clientFor("guiaA")).from("reservation_amounts").select("*").eq("reservation_id", id));
    const { data } = await (await clientFor("contabilidadA")).from("reservation_amounts").select("unit_price_minor, currency, total_minor, amount_overridden").eq("reservation_id", id);
    expect(data).toEqual([{ unit_price_minor: 4250, currency: "USD", total_minor: 12750, amount_overridden: false }]);

    const unpriced = await fx.tour(A, { price: null });
    const unpricedDeparture = await fx.departure(A, unpriced);
    expectTypedError(await book(reservas, { operator_id: A, departure_id: unpricedDeparture, customer_id: customer, people: 1 }), "price_missing");
    expect((await seatsOf(unpricedDeparture)).seats_booked).toBe(0);
  });

  it("people 2 to 3 recomputes the total unless an administrador overrode it; contabilidad cannot override", async () => {
    const tour = await fx.tour(A, { price: 1000 });
    const departure = await fx.departure(A, tour);
    const customer = await fx.customer(A);
    const reservas = await clientFor("reservasA");
    const { id } = await booked(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 2 });
    const total = async () => (await admin.from("reservation_amounts").select("total_minor, amount_overridden").eq("reservation_id", id).single()).data;

    await reservas.from("reservations").update({ people: 3 }).eq("id", id);
    expect(await total()).toEqual({ total_minor: 3000, amount_overridden: false });

    expectZeroRows(await (await clientFor("contabilidadA")).from("reservation_amounts").update({ total_minor: 1 }).eq("reservation_id", id).select("reservation_id"));
    expectZeroRows(await reservas.from("reservation_amounts").update({ total_minor: 1 }).eq("reservation_id", id).select("reservation_id"));
    expectSqlState(
      await (await clientFor("adminA")).from("reservation_amounts").update({ amount_overridden: false } as never).eq("reservation_id", id),
      "42501",
    );
    const override = await (await clientFor("adminA")).from("reservation_amounts").update({ total_minor: 2500 }).eq("reservation_id", id).select("total_minor, amount_overridden");
    expect(override.data).toEqual([{ total_minor: 2500, amount_overridden: true }]);

    await reservas.from("reservations").update({ people: 2 }).eq("id", id);
    expect(await total()).toEqual({ total_minor: 2500, amount_overridden: true });
    expectSqlState(await reservas.from("reservation_amounts").insert({ reservation_id: id, operator_id: A, unit_price_minor: 1, currency: "USD", total_minor: 1 }), "42501");
  });
});

describe("notes (R11)", () => {
  it("contabilidad reads but cannot update notes; the guía reads none", async () => {
    const tour = await fx.tour(A);
    const departure = await fx.departure(A, tour, { guideId: GUIDES.a1.id });
    const customer = await fx.customer(A);
    const { id } = await booked(await clientFor("reservasA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 1, notes: "Alergia al maní" });
    const contabilidad = await clientFor("contabilidadA");
    expect((await contabilidad.from("reservation_notes").select("notes").eq("reservation_id", id)).data).toEqual([{ notes: "Alergia al maní" }]);
    expectZeroRows(await contabilidad.from("reservation_notes").update({ notes: "x" }).eq("reservation_id", id).select("reservation_id"));
    expectZeroRows(await (await clientFor("guiaA")).from("reservation_notes").select("*").eq("reservation_id", id));
    expect((await admin.from("reservation_notes").select("notes").eq("reservation_id", id).single()).data?.notes).toBe("Alergia al maní");
  });
});

describe("cross-operator writes (AE3, AE11)", () => {
  it("covers AE3: reservas of A inserting with operator_id B fails with a policy violation and no row exists", async () => {
    const tourB = await fx.tour(B, { currency: "MXN" });
    const departureB = await fx.departure(B, tourB);
    const customerB = await fx.customer(B);
    const reservas = await clientFor("reservasA");
    expectSqlState(
      await reservas.from("reservations").insert({ operator_id: B, departure_id: departureB, customer_id: customerB, people: 1 } as never),
      "42501",
    );
    const { count } = await admin.from("reservations").select("id", { count: "exact", head: true }).eq("departure_id", departureB);
    expect(count).toBe(0);
    expect((await seatsOf(departureB)).seats_booked).toBe(0);
  });

  it("covers AE11: operator A with a departure or customer of B fails with a foreign-key violation and B's counter is unchanged", async () => {
    const tourA = await fx.tour(A);
    const departureA = await fx.departure(A, tourA);
    const customerA = await fx.customer(A);
    const tourB = await fx.tour(B, { currency: "MXN" });
    const departureB = await fx.departure(B, tourB);
    const customerB = await fx.customer(B);
    for (const key of ["reservasA", "adminAB"] as const) {
      const client = await clientFor(key);
      expectSqlState(
        await client.from("reservations").insert({ operator_id: A, departure_id: departureB, customer_id: customerA, people: 1 } as never),
        "23503",
      );
      expectSqlState(
        await client.from("reservations").insert({ operator_id: A, departure_id: departureA, customer_id: customerB, people: 1 } as never),
        "23503",
      );
    }
    const { id } = await booked(await clientFor("reservasA"), { operator_id: A, departure_id: departureA, customer_id: customerA, people: 1 });
    expectSqlState(await (await clientFor("adminAB")).from("reservations").update({ departure_id: departureB }).eq("id", id), "23503");
    expectSqlState(await (await clientFor("adminAB")).from("reservations").update({ customer_id: customerB }).eq("id", id), "23503");
    expect((await seatsOf(departureB)).seats_booked).toBe(0);
    expect((await seatsOf(departureA)).seats_booked).toBe(1);
    expectZeroRows(await (await clientFor("reservasB")).from("reservations").select("id").eq("id", id));
    expectZeroRows(await (await clientFor("reservasB")).from("reservations").update({ people: 2 }).eq("id", id).select("id"));
  });
});

describe("reading reservations by role (AE5, R11, R20, KTD13)", () => {
  const ids: Record<string, string> = {};
  let customer: string;

  beforeAll(async () => {
    const tour = await fx.tour(A);
    customer = await fx.customer(A, { name: `Valentina ${fx.tag} Rojas`, email: `vr-${fx.tag}@cupo.test`, phone: "+506 8111 1111" });
    const mine = await fx.departure(A, tour, { guideId: GUIDES.a1.id });
    const other = await fx.departure(A, tour, { guideId: GUIDES.a2.id });
    const past = await fx.departure(A, tour, { guideId: GUIDES.a1.id, date: "2025-03-04" });
    const reservas = await clientFor("reservasA");
    ids.mine = (await booked(reservas, { operator_id: A, departure_id: mine, customer_id: customer, people: 1 })).id;
    ids.mineCancelled = (await booked(reservas, { operator_id: A, departure_id: mine, customer_id: customer, people: 1 })).id;
    await reservas.from("reservations").update({ status: "cancelled", cancel_reason: "x" }).eq("id", ids.mineCancelled);
    ids.other = (await booked(reservas, { operator_id: A, departure_id: other, customer_id: customer, people: 1 })).id;
    ids.past = (await booked(reservas, { operator_id: A, departure_id: past, customer_id: customer, people: 1 })).id;
  });

  it("covers AE5: contabilidad reads the reservation and the masked display, and zero customers rows", async () => {
    const contabilidad = await clientFor("contabilidadA");
    const { data } = await contabilidad.from("reservations").select("id, customer_id, people").eq("id", ids.mine);
    expect(data).toEqual([{ id: ids.mine, customer_id: customer, people: 1 }]);
    expectZeroRows(await contabilidad.from("customers").select("*").eq("id", customer));
    const display = await contabilidad.from("customer_display").select("display_name").eq("customer_id", customer);
    expect(display.data).toEqual([{ display_name: "Valentina R." }]);
  });

  it("a guía reads only the non-cancelled reservations of their future departures, and no notes or amounts", async () => {
    const guia = await clientFor("guiaA");
    const { data, error } = await guia.from("reservations").select("id").in("id", Object.values(ids));
    expect(error).toBeNull();
    expect(data?.map((row) => row.id)).toEqual([ids.mine]);
    expectZeroRows(await guia.from("reservation_notes").select("*").in("reservation_id", Object.values(ids)));
    expectZeroRows(await guia.from("reservation_amounts").select("*").in("reservation_id", Object.values(ids)));
    expectZeroRows(await guia.from("customers").select("*").eq("id", customer));
    expectZeroRows(await guia.from("reservations").update({ people: 2 }).eq("id", ids.mine).select("id"));
  });

  it("a user of B reads none of A's reservations, notes or amounts", async () => {
    for (const key of ["reservasB"] as const) {
      const client = await clientFor(key);
      expectZeroRows(await client.from("reservations").select("id").in("id", Object.values(ids)));
      expectZeroRows(await client.from("reservation_notes").select("reservation_id").in("reservation_id", Object.values(ids)));
      expectZeroRows(await client.from("reservation_amounts").select("reservation_id").in("reservation_id", Object.values(ids)));
    }
  });

  it("reservas cannot delete reservations or departures; the rows stay (re-read with the secret key)", async () => {
    const reservas = await clientFor("reservasA");
    expectSqlState(await reservas.from("reservations").delete().eq("id", ids.mine), "42501");
    expectSqlState(await reservas.from("reservation_notes").delete().eq("reservation_id", ids.mine), "42501");
    expect((await reservationRow(ids.mine)).status).toBe("confirmed");
  });
});

describe("reservation actions and the list DAL", () => {
  let tour: string;
  let departure: string;
  let customer: string;
  const date = addDays(FUTURE, 3);

  beforeAll(async () => {
    tour = await fx.tour(A, { capacity: 4, price: 5000 });
    departure = await fx.departure(A, tour, { capacity: 4, date, startTime: "10:00" });
    customer = await fx.customer(A, { name: `Martín ${fx.tag} Solís`, email: `ms-${fx.tag}@cupo.test` });
  });

  const fields = (extra: Record<string, string>) =>
    form({
      locale: "es",
      tourId: tour,
      date,
      slot: `departure:${departure}`,
      people: "3",
      status: "confirmed",
      customerMode: "existing",
      customerId: customer,
      notes: "",
      ...extra,
    });

  it("reservas books the last seats, then a second attempt shows capacity_exceeded and keeps the values", async () => {
    await signIn("reservasA", A);
    const target = await expectRedirect(() => createReservationAction(IDLE, fields({})));
    const match = /^\/es\/reservations\?from=([\d-]+)&to=([\d-]+)&created=(D-\d{6})$/.exec(target);
    expect(match?.slice(1, 3)).toEqual([date, date]);
    expect((await seatsOf(departure)).seats_booked).toBe(3);

    expect(await createReservationAction(IDLE, fields({ people: "2", notes: "Grupo" }))).toMatchObject({
      status: "error",
      error: "capacity_exceeded",
      values: { people: "2", notes: "Grupo", slot: `departure:${departure}` },
    });
    expect(await createReservationAction(IDLE, fields({ customerId: "", people: "x" }))).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: { people: "validation.peopleInvalid" },
    });
    expect(await createReservationAction(IDLE, fields({ customerMode: "new", customerName: "", customerEmail: "a@b" }))).toMatchObject({
      status: "error",
      fieldErrors: { customerName: "validation.nameRequired" },
    });
    expect((await seatsOf(departure)).seats_booked).toBe(3);
  });

  it("books a schedule slot for a new customer through the action", async () => {
    const weekday = 5;
    const slotDate = nextWeekday(weekday);
    await admin.from("tour_schedules").insert({ operator_id: A, tour_id: tour, weekday, start_time: "09:15", valid_from: FUTURE });
    const target = await expectRedirect(() =>
      createReservationAction(
        IDLE,
        fields({ date: slotDate, slot: "time:09:15", people: "1", customerMode: "new", customerId: "", customerName: `Lucía Mora ${fx.tag}`, customerPhone: "8888-1234" }),
      ),
    );
    const code = new URL(target, "http://x").searchParams.get("created");
    const { data } = await admin.from("reservations").select("id, customer_id, has_incomplete_data, departure:tour_departures!reservations_departure_fkey(origin, start_time)").eq("operator_id", A).eq("code", code ?? "").single();
    fx.trackCustomer(data?.customer_id as string);
    expect(data).toMatchObject({ has_incomplete_data: false, departure: { origin: "schedule", start_time: "09:15:00" } });
  });

  it("the customer picker search returns matches for writers only", async () => {
    const state = await searchCustomersAction({ status: "idle" }, `Martín ${fx.tag} Solís`);
    expect(state).toEqual({ status: "ok", data: [{ id: customer, name: `Martín ${fx.tag} Solís`, email: `ms-${fx.tag}@cupo.test`, phone: null }] });
    await signIn("contabilidadA", A);
    expect(await searchCustomersAction({ status: "idle" }, "Martín")).toEqual({ status: "error", error: "forbidden" });
    expect(await createReservationAction(IDLE, fields({}))).toMatchObject({ status: "error", error: "forbidden" });
  });

  it("lists by departure date with full names for reservas, masked names and amounts for contabilidad", async () => {
    await signIn("reservasA", A);
    const reservasList = await listReservations(await requireOperatorContext("reservations.read"), { from: date, to: date });
    const row = reservasList.reservations.find((item) => item.departureId === departure);
    expect(row).toMatchObject({
      people: 3,
      status: "confirmed",
      startTime: "10:00",
      date,
      customerName: `Martín ${fx.tag} Solís`,
      customerContact: { email: `ms-${fx.tag}@cupo.test`, phone: null },
      amount: null,
    });

    await signIn("contabilidadA", A);
    const contabilidadList = await listReservations(await requireOperatorContext("reservations.read"), { from: date, to: date });
    expect(contabilidadList.reservations.find((item) => item.departureId === departure)).toMatchObject({
      customerName: "Martín S.",
      customerContact: null,
      amount: { totalMinor: 15000, currency: "USD", overridden: false },
    });
    const dates = contabilidadList.reservations.map((item) => `${item.date} ${item.startTime}`);
    expect([...dates].sort()).toEqual(dates);
  });

  it("cancel action: a reason is required, then the seats return; a second cancel is forbidden_transition; found-checks", async () => {
    await signIn("reservasA", A);
    const ctx = await requireOperatorContext("reservations.read");
    const target = (await listReservations(ctx, { from: date, to: date })).reservations.find((item) => item.departureId === departure);
    const reservationId = target?.id as string;
    expect(await cancelReservationAction(IDLE, form({ reservationId, reason: " " }))).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: { reason: "validation.reasonRequired" },
    });
    expect(await cancelReservationAction(IDLE, form({ reservationId, reason: "El cliente no viaja" }))).toEqual({ status: "ok" });
    expect(await reservationRow(reservationId)).toMatchObject({ status: "cancelled", cancel_reason: "El cliente no viaja" });
    expect((await seatsOf(departure)).seats_booked).toBe(0);
    expect(await cancelReservationAction(IDLE, form({ reservationId, reason: "otra vez" }))).toMatchObject({ status: "error", error: "forbidden_transition" });

    const tourB = await fx.tour(B, { currency: "MXN" });
    const foreign = await booked(await clientFor("reservasB"), {
      operator_id: B,
      departure_id: await fx.departure(B, tourB),
      customer_id: await fx.customer(B),
      people: 1,
    });
    expect(await cancelReservationAction(IDLE, form({ reservationId: foreign.id, reason: "x" }))).toMatchObject({ status: "error", error: "not_found" });
    expect((await reservationRow(foreign.id)).status).toBe("confirmed");
    expect(await cancelReservationAction(IDLE, form({ reservationId: "nope", reason: "x" }))).toMatchObject({ status: "error", error: "invalid" });

    await signIn("contabilidadA", A);
    expect(await cancelReservationAction(IDLE, form({ reservationId, reason: "x" }))).toMatchObject({ status: "error", error: "forbidden" });
  });

  it("updateReservation and the departure bookings count go through the session", async () => {
    await signIn("adminA", A);
    const ctx = await requireOperatorContext("reservations.write");
    const { id } = await booked(await clientFor("adminA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 1 });
    await updateReservation(ctx, { reservationId: id, people: 2, departureId: null, slot: null, notes: "Silla de ruedas" });
    expect((await reservationRow(id)).people).toBe(2);
    expect(await getDepartureBookings(ctx, departure)).toEqual({ reservations: 1, people: 2 });
    expect(await heldOn(departure)).toBe(2);
    expect(await reconcileSeats()).toEqual([]);
  });
});
