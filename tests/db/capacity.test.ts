// U6 capacity and counters against the local stack (plan U6 test scenarios;
// R18, R22 to R24, R27, R28; KTD5). The seat rule lives in definer triggers,
// so every scenario here writes through the Data API exactly as the app or a
// direct client would: the create_reservation rpc, direct updates, the
// admin client. The acceptance tests (AE1 and the cancel under load) run
// three times each; every block ends with the reconciliation gate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATORS } from "./fixtures.ts";
import { BookingFixtures, auditMark, book, heldOn, reservationRow, seatsOf, sleep } from "./booking.ts";
import {
  adminClient,
  asRole,
  clientFor,
  closeSql,
  createTestUser,
  deleteTestUser,
  expectSqlState,
  expectTypedError,
  reconcileSeats,
  seedUser,
  sql,
  uniqueEmail,
  type Client,
} from "./helpers.ts";

const A = OPERATORS.a.id;
const admin = adminClient();
const fx = new BookingFixtures();
const throwawayUsers: Array<{ id: string; email: string }> = [];

afterAll(async () => {
  // Users first: their memberships hold the throwaway operators.
  for (const user of throwawayUsers) await deleteTestUser(admin, user.id, user.email);
  await fx.cleanup();
  await closeSql();
});

type Outcome = { id: string; code: string } | { error: string };

/** A booking call's result as `{id, code}` or `{error: <message or code>}`. */
async function attempt(client: Client, args: Parameters<typeof book>[1]): Promise<Outcome> {
  const { data, error } = await book(client, args);
  if (error) return { error: error.code === "P0001" ? error.message : `${error.code}` };
  return data;
}

function succeeded(outcome: Outcome): outcome is { id: string; code: string } {
  return !("error" in outcome);
}

describe("AE1: the last seat (R24)", () => {
  it.each([1, 2, 3])("run %i: capacity 10, 9 booked, 10 concurrent creates of 1: exactly one succeeds", async () => {
    const tour = await fx.tour(A, { capacity: 10 });
    const departure = await fx.departure(A, tour, { capacity: 10 });
    const customer = await fx.customer(A);
    const reservas = await clientFor("reservasA");
    expect(succeeded(await attempt(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 9 }))).toBe(true);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => attempt(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 1 })),
    );
    const outcomes = results.map((result) => (result.status === "fulfilled" ? result.value : { error: "rejected" }));
    expect(outcomes.filter(succeeded)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !succeeded(outcome) && outcome.error === "capacity_exceeded")).toHaveLength(9);
    expect((await seatsOf(departure)).seats_booked).toBe(10);
    expect(await heldOn(departure)).toBe(10);
    expect(await reconcileSeats()).toEqual([]);
  });
});

describe("cancel under load (R18, KTD5)", () => {
  it.each([1, 2, 3])("run %i: cancelling a departure while 10 creates target it leaves every reservation cancelled or refused", async () => {
    const tour = await fx.tour(A, { capacity: 30 });
    const departure = await fx.departure(A, tour, { capacity: 30 });
    const customer = await fx.customer(A);
    const reservas = await clientFor("reservasA");
    const adminA = await clientFor("adminA");

    const creates = Array.from({ length: 10 }, (_, index) =>
      sleep(index * 8).then(() => attempt(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 1 })),
    );
    await sleep(30);
    const cancel = adminA.rpc("cancel_departure", { departure_id: departure });
    const [cancelled, ...outcomes] = await Promise.all([cancel, ...creates]);
    expect(cancelled.error).toBeNull();

    for (const outcome of outcomes) {
      if (succeeded(outcome)) {
        expect(await reservationRow(outcome.id)).toMatchObject({ status: "cancelled", cancel_reason: "departure_cancelled" });
      } else {
        expect(outcome.error).toBe("departure_not_open");
      }
    }
    expect(await seatsOf(departure)).toMatchObject({ seats_booked: 0, status: "cancelled" });
    expect(await heldOn(departure)).toBe(0);
    expect(await reconcileSeats()).toEqual([]);
  });
});

describe("AE8: cancelling a departure cascades (R18, R28)", () => {
  it("cancels the 3 active reservations with reason departure_cancelled, frees the seats and audits each as the administrador", async () => {
    const tour = await fx.tour(A);
    const departure = await fx.departure(A, tour, { capacity: 10 });
    const customer = await fx.customer(A);
    const reservas = await clientFor("reservasA");
    const ids: string[] = [];
    for (const people of [1, 2, 3]) {
      const outcome = await attempt(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people });
      if (!succeeded(outcome)) throw new Error(outcome.error);
      ids.push(outcome.id);
    }
    // An already cancelled one stays as it is.
    const old = await attempt(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 1 });
    if (!succeeded(old)) throw new Error(old.error);
    await reservas.from("reservations").update({ status: "cancelled", cancel_reason: "cliente" }).eq("id", old.id);
    expect((await seatsOf(departure)).seats_booked).toBe(6);

    const since = await auditMark();
    expect((await (await clientFor("adminA")).rpc("cancel_departure", { departure_id: departure })).error).toBeNull();
    for (const id of ids) {
      expect(await reservationRow(id)).toMatchObject({ status: "cancelled", cancel_reason: "departure_cancelled" });
    }
    expect((await reservationRow(old.id)).cancel_reason).toBe("cliente");
    expect(await seatsOf(departure)).toMatchObject({ seats_booked: 0, status: "cancelled" });

    const { data: events, error } = await admin
      .schema("audit")
      .from("events")
      .select("record_id, actor_id, actor_source, op")
      .eq("table_name", "reservations")
      .in("record_id", [...ids, old.id])
      .eq("op", "update")
      .gt("id", since);
    expect(error).toBeNull();
    expect(events?.map((event) => event.record_id).sort()).toEqual([...ids].sort());
    for (const event of events ?? []) {
      expect(event).toMatchObject({ actor_id: seedUser("adminA").id, actor_source: "jwt" });
    }
    expect(await reconcileSeats()).toEqual([]);
  });
});

describe("moves between departures (KTD5 seat rule)", () => {
  let tour: string;
  let customer: string;

  beforeAll(async () => {
    tour = await fx.tour(A, { capacity: 5 });
    customer = await fx.customer(A);
  });

  async function reservationOf(departure: string, people: number): Promise<string> {
    const outcome = await attempt(await clientFor("reservasA"), { operator_id: A, departure_id: departure, customer_id: customer, people });
    if (!succeeded(outcome)) throw new Error(outcome.error);
    return outcome.id;
  }

  async function fill(departure: string, people: number): Promise<void> {
    await reservationOf(departure, people);
  }

  it("2 people to a departure with 1 seat left fails and both counters stay; with 2 seats left both counters move", async () => {
    const from = await fx.departure(A, tour, { capacity: 5 });
    const tight = await fx.departure(A, tour, { capacity: 5 });
    const roomy = await fx.departure(A, tour, { capacity: 5 });
    const id = await reservationOf(from, 2);
    await fill(tight, 4);
    await fill(roomy, 3);
    const reservas = await clientFor("reservasA");

    expectTypedError(await reservas.from("reservations").update({ departure_id: tight }).eq("id", id), "capacity_exceeded");
    expectTypedError(await reservas.rpc("update_reservation", { reservation_id: id, departure_id: tight }), "capacity_exceeded");
    expect([(await seatsOf(from)).seats_booked, (await seatsOf(tight)).seats_booked]).toEqual([2, 4]);

    const moved = await reservas.from("reservations").update({ departure_id: roomy }).eq("id", id).select("departure_id");
    expect(moved.error).toBeNull();
    expect([(await seatsOf(from)).seats_booked, (await seatsOf(roomy)).seats_booked]).toEqual([0, 5]);
    expect(await reconcileSeats()).toEqual([]);
  });

  it("a move to a departure of another tour fails with forbidden_transition", async () => {
    const otherTour = await fx.tour(A, { capacity: 5 });
    const from = await fx.departure(A, tour);
    const elsewhere = await fx.departure(A, otherTour);
    const id = await reservationOf(from, 1);
    expectTypedError(
      await (await clientFor("reservasA")).from("reservations").update({ departure_id: elsewhere }).eq("id", id),
      "forbidden_transition",
    );
    expect([(await seatsOf(from)).seats_booked, (await seatsOf(elsewhere)).seats_booked]).toEqual([1, 0]);
  });

  it("a move into a closed or cancelled departure fails with departure_not_open", async () => {
    const from = await fx.departure(A, tour);
    const closed = await fx.departure(A, tour);
    const cancelled = await fx.departure(A, tour);
    const adminA = await clientFor("adminA");
    await adminA.from("tour_departures").update({ status: "closed" }).eq("id", closed);
    await adminA.rpc("cancel_departure", { departure_id: cancelled });
    const id = await reservationOf(from, 1);
    const reservas = await clientFor("reservasA");
    for (const target of [closed, cancelled]) {
      expectTypedError(await reservas.from("reservations").update({ departure_id: target }).eq("id", id), "departure_not_open");
    }
    expect((await seatsOf(from)).seats_booked).toBe(1);
  });

  it("one update that cancels and moves releases the old departure and takes nothing on the new one", async () => {
    const from = await fx.departure(A, tour);
    const to = await fx.departure(A, tour);
    const id = await reservationOf(from, 3);
    const result = await (await clientFor("reservasA"))
      .from("reservations")
      .update({ status: "cancelled", cancel_reason: "cambio", departure_id: to })
      .eq("id", id)
      .select("status, departure_id");
    expect(result.data).toEqual([{ status: "cancelled", departure_id: to }]);
    expect([(await seatsOf(from)).seats_booked, (await seatsOf(to)).seats_booked]).toEqual([0, 0]);
    expect(await reconcileSeats()).toEqual([]);
  });

  it("two concurrent opposite moves both complete (rows locked in id order) and the counters agree", async () => {
    const first = await fx.departure(A, tour);
    const second = await fx.departure(A, tour);
    const one = await reservationOf(first, 2);
    const two = await reservationOf(second, 1);
    const reservas = seedUser("reservasA").id;

    const forward = asRole("authenticated", reservas, async (tx) => {
      await tx`update public.reservations set departure_id = ${second} where id = ${one}`;
      // Hold both departure locks so the opposite move has to wait.
      await tx`select pg_sleep(0.4)`;
    });
    await sleep(120);
    const backward = asRole("authenticated", reservas, async (tx) => {
      await tx`update public.reservations set departure_id = ${first} where id = ${two}`;
    });
    const settled = await Promise.allSettled([forward, backward]);
    for (const result of settled) {
      if (result.status === "rejected") {
        // The only acceptable failure is one the result mapper turns into `retry`.
        expect(["40P01", "40001"]).toContain((result.reason as { code?: string }).code);
      }
    }
    const [a, b] = [await seatsOf(first), await seatsOf(second)];
    expect(a.seats_booked).toBe(await heldOn(first));
    expect(b.seats_booked).toBe(await heldOn(second));
    expect(await reconcileSeats()).toEqual([]);
  });
});

describe("people changes (R24)", () => {
  let tour: string;
  let customer: string;

  beforeAll(async () => {
    tour = await fx.tour(A, { capacity: 5 });
    customer = await fx.customer(A);
  });

  it("2 to 4 with 1 seat left fails; 4 to 2 succeeds; a closed departure takes an increase within capacity", async () => {
    const departure = await fx.departure(A, tour, { capacity: 5 });
    const reservas = await clientFor("reservasA");
    const first = await attempt(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 2 });
    const second = await attempt(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 2 });
    if (!succeeded(first) || !succeeded(second)) throw new Error("setup failed");
    expect((await seatsOf(departure)).seats_booked).toBe(4);

    expectTypedError(await reservas.from("reservations").update({ people: 4 }).eq("id", first.id), "capacity_exceeded");
    expectTypedError(await reservas.rpc("update_reservation", { reservation_id: first.id, people: 4 }), "capacity_exceeded");
    expect((await seatsOf(departure)).seats_booked).toBe(4);

    expect((await reservas.rpc("update_reservation", { reservation_id: second.id, people: 1 })).error).toBeNull();
    expect((await seatsOf(departure)).seats_booked).toBe(3);

    await (await clientFor("adminA")).from("tour_departures").update({ status: "closed" }).eq("id", departure);
    const grown = await reservas.from("reservations").update({ people: 3 }).eq("id", first.id).select("people");
    expect(grown.data).toEqual([{ people: 3 }]);
    expect((await seatsOf(departure)).seats_booked).toBe(4);
    expectTypedError(await reservas.from("reservations").update({ people: 5 }).eq("id", first.id), "capacity_exceeded");
    expect(await reconcileSeats()).toEqual([]);
  });

  it("people must be at least 1", async () => {
    const departure = await fx.departure(A, tour);
    const outcome = await attempt(await clientFor("reservasA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 0 });
    expect(outcome).toEqual({ error: "23514" });
    expect((await seatsOf(departure)).seats_booked).toBe(0);
  });
});

describe("departure state and archived tours on create (R18, R21)", () => {
  it("a closed or cancelled departure answers departure_not_open; an archived tour answers tour_archived", async () => {
    const tour = await fx.tour(A);
    const customer = await fx.customer(A);
    const closed = await fx.departure(A, tour);
    const cancelled = await fx.departure(A, tour);
    const open = await fx.departure(A, tour);
    const adminA = await clientFor("adminA");
    await adminA.from("tour_departures").update({ status: "closed" }).eq("id", closed);
    await adminA.rpc("cancel_departure", { departure_id: cancelled });
    const reservas = await clientFor("reservasA");
    for (const departure of [closed, cancelled]) {
      expect(await attempt(reservas, { operator_id: A, departure_id: departure, customer_id: customer, people: 1 })).toEqual({
        error: "departure_not_open",
      });
      expect((await seatsOf(departure)).seats_booked).toBe(0);
    }
    // A full closed departure still reads as not open rather than full.
    expect(await attempt(reservas, { operator_id: A, departure_id: closed, customer_id: customer, people: 50 })).toEqual({
      error: "departure_not_open",
    });

    await admin.from("tours").update({ archived_at: new Date().toISOString() }).eq("id", tour);
    expect(await attempt(reservas, { operator_id: A, departure_id: open, customer_id: customer, people: 1 })).toEqual({ error: "tour_archived" });
    expect((await seatsOf(open)).seats_booked).toBe(0);
  });
});

describe("deletes (R27)", () => {
  it("a delete with the secret key releases the seats; authenticated cannot delete reservations or departures", async () => {
    const tour = await fx.tour(A);
    const departure = await fx.departure(A, tour);
    const customer = await fx.customer(A);
    const outcome = await attempt(await clientFor("reservasA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 4 });
    if (!succeeded(outcome)) throw new Error(outcome.error);

    const reservas = await clientFor("reservasA");
    expectSqlState(await reservas.from("reservations").delete().eq("id", outcome.id), "42501");
    expectSqlState(await reservas.from("tour_departures").delete().eq("id", departure), "42501");
    expect((await reservationRow(outcome.id)).people).toBe(4);
    expect((await seatsOf(departure)).seats_booked).toBe(4);

    const { error } = await admin.from("reservations").delete().eq("id", outcome.id);
    expect(error).toBeNull();
    expect((await seatsOf(departure)).seats_booked).toBe(0);
    expect(await reconcileSeats()).toEqual([]);
  });
});

describe("reservation codes (R22)", () => {
  let first: string;
  let second: string;
  let client: Client;

  beforeAll(async () => {
    first = await fx.operator();
    second = await fx.operator();
    const user = await createTestUser(admin, {
      email: uniqueEmail("codes"),
      memberships: [
        { operatorId: first, role: "reservas" },
        { operatorId: second, role: "reservas" },
      ],
    });
    throwawayUsers.push(user);
    client = await clientFor(user);
  });

  it("two operators each start at D-000001; 10 concurrent creates get distinct consecutive codes; a failure consumes none", async () => {
    const tours = { first: await fx.tour(first, { capacity: 20 }), second: await fx.tour(second) };
    const departures = {
      first: await fx.departure(first, tours.first, { capacity: 12 }),
      second: await fx.departure(second, tours.second),
    };
    const customers = { first: await fx.customer(first), second: await fx.customer(second) };

    const opening = await attempt(client, { operator_id: first, departure_id: departures.first, customer_id: customers.first, people: 1 });
    const other = await attempt(client, { operator_id: second, departure_id: departures.second, customer_id: customers.second, people: 1 });
    expect(succeeded(opening) && opening.code).toBe("D-000001");
    expect(succeeded(other) && other.code).toBe("D-000001");

    expect(await attempt(client, { operator_id: first, departure_id: departures.first, customer_id: customers.first, people: 12 })).toEqual({
      error: "capacity_exceeded",
    });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        attempt(client, { operator_id: first, departure_id: departures.first, customer_id: customers.first, people: 1 }),
      ),
    );
    const codes = outcomes.map((outcome) => (succeeded(outcome) ? outcome.code : outcome.error)).sort();
    expect(codes).toEqual(Array.from({ length: 10 }, (_, index) => `D-${String(index + 2).padStart(6, "0")}`));
  });

  it("a client-supplied code is refused by the column grant", async () => {
    const tour = await fx.tour(first);
    const departure = await fx.departure(first, tour);
    const customer = await fx.customer(first);
    expectSqlState(
      await client
        .from("reservations")
        .insert({ operator_id: first, departure_id: departure, customer_id: customer, people: 1, code: "D-999999" } as never),
      "42501",
      "permission denied",
    );
    expect((await seatsOf(departure)).seats_booked).toBe(0);
  });
});

describe("admin_seat_drift and admin_reconcile_seats (KTD5, KTD6)", () => {
  it("finds a corrupted counter, the reconcile restores it and audits the given actor; authenticated gets a privilege error", async () => {
    const tour = await fx.tour(A);
    const departure = await fx.departure(A, tour, { capacity: 10 });
    const customer = await fx.customer(A);
    const outcome = await attempt(await clientFor("reservasA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 2 });
    if (!succeeded(outcome)) throw new Error(outcome.error);

    // The secret key bypasses the column grants; it stands in for a bug that skipped the trigger.
    const corrupt = await admin.from("tour_departures").update({ seats_booked: 7 }).eq("id", departure);
    expect(corrupt.error).toBeNull();
    expect(await reconcileSeats()).toEqual([{ departure_id: departure, operator_id: A, seats_booked: 7, held: 2 }]);

    const actor = seedUser("adminA").id;
    const since = await auditMark();
    const reconciled = await admin.rpc("admin_reconcile_seats", { actor_id: actor });
    expect(reconciled.error).toBeNull();
    expect(reconciled.data).toBe(1);
    expect(await reconcileSeats()).toEqual([]);
    expect((await seatsOf(departure)).seats_booked).toBe(2);

    const { data: events } = await admin
      .schema("audit")
      .from("events")
      .select("table_name, op, actor_id, actor_source, old_record, new_record")
      .eq("record_id", departure)
      .gt("id", since);
    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({ table_name: "tour_departures", op: "update", actor_id: actor, actor_source: "app" });
    expect((events?.[0].old_record as { seats_booked: number }).seats_booked).toBe(7);
    expect((events?.[0].new_record as { seats_booked: number }).seats_booked).toBe(2);

    for (const key of ["adminA", "reservasA"] as const) {
      const client = await clientFor(key);
      expectSqlState(await client.rpc("admin_seat_drift"), "42501");
      expectSqlState(await client.rpc("admin_reconcile_seats", { actor_id: actor }), "42501");
    }
  });

  it("a counter update outside the reconcile writes no audit row", async () => {
    const [{ count }] = await sql()`
      select count(*)::int as count from pg_trigger
      where tgrelid = 'public.tour_departures'::regclass and tgname = 't90_audit_seat_reconcile'`;
    expect(count).toBe(1);
    const tour = await fx.tour(A);
    const departure = await fx.departure(A, tour);
    const since = await auditMark();
    await admin.from("tour_departures").update({ seats_booked: 1 }).eq("id", departure);
    await admin.from("tour_departures").update({ seats_booked: 0 }).eq("id", departure);
    const { data } = await admin.schema("audit").from("events").select("id").eq("record_id", departure).gt("id", since);
    expect(data).toEqual([]);
  });
});
