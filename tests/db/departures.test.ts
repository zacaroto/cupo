// U5 departures against the local stack (plan U5 test scenarios; R16 to R18,
// R20, R21; KTD5, KTD7, KTD13): column grants, composite foreign keys (AE11),
// the capacity backstop and its action state, the derived starts_at and the
// timezone recompute, private.materialize_departure (including two concurrent
// calls), the departure state machine and cancel_departure, the guía policy
// (AE10), the guide-deactivation clear, and the departure actions and slot
// DAL through the real server code.
//
// Every departure here hangs off a throwaway tour (or operator) with a random
// tag; afterAll removes them with the secret key.
import { randomBytes } from "node:crypto";
import { createTranslator } from "next-intl";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TablesInsert } from "@cupo/shared/database.types";
import { addDays, todayIn, weekdayOf } from "@cupo/shared/local-date";
import es from "../../apps/web/messages/es.json";
import { GUIDES, OPERATORS, TOURS } from "./fixtures.ts";
import {
  adminClient,
  anonClient,
  asRole,
  clientFor,
  closeSql,
  expectSqlState,
  expectTypedError,
  expectZeroRows,
  seedUser,
  sql,
  type Client,
} from "./helpers.ts";
import { CookieJar, expectRedirect, form, requestHeaders } from "./next-harness.ts";

let jar = new CookieJar();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => requestHeaders() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

const { loginAction } = await import("../../apps/web/src/app/[locale]/(auth)/login/actions.ts");
const { cancelDepartureAction, closeDepartureAction, createDepartureAction, updateDepartureAction } = await import(
  "../../apps/web/src/app/[locale]/(app)/departures/actions.ts"
);
const { ACTIVE_OPERATOR_COOKIE, getOperatorContext, requireOperatorContext } = await import(
  "../../apps/web/src/lib/dal/context.ts"
);
const { listDepartureSlots } = await import("../../apps/web/src/lib/dal/departures.ts");

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const admin = adminClient();
const IDLE = { status: "idle" } as const;
const TAG = randomBytes(3).toString("hex");
const TODAY = todayIn(OPERATORS.a.timezone);
const PAST = "2025-01-07";

const cleanupTours: string[] = [];
const cleanupGuides: string[] = [];
const cleanupOperators: string[] = [];

afterAll(async () => {
  if (cleanupTours.length) {
    await admin.from("tour_departures").delete().in("tour_id", cleanupTours);
    await admin.from("tours").delete().in("id", cleanupTours);
  }
  if (cleanupGuides.length) await admin.from("guides").delete().in("id", cleanupGuides);
  if (cleanupOperators.length) await admin.from("operators").delete().in("id", cleanupOperators);
  await closeSql();
});

/** The first date on or after `TODAY + minDays` that falls on `weekday` (0 = Sunday). */
function nextWeekday(weekday: number, minDays = 7): string {
  let date = addDays(TODAY, minDays);
  while (weekdayOf(date) !== weekday) date = addDays(date, 1);
  return date;
}

async function insertTour(operatorId: string, name: string, fields: { archived?: boolean; capacity?: number } = {}): Promise<string> {
  const { data, error } = await admin
    .from("tours")
    .insert({
      operator_id: operatorId,
      name: `${name} ${TAG}`,
      duration_minutes: 120,
      default_capacity: fields.capacity ?? 10,
      ...(fields.archived && { archived_at: new Date().toISOString() }),
    })
    .select("id")
    .single();
  if (error) throw error;
  cleanupTours.push(data.id);
  return data.id;
}

async function insertGuide(operatorId: string, name: string): Promise<string> {
  const { data, error } = await admin.from("guides").insert({ operator_id: operatorId, name: `${name} ${TAG}` }).select("id").single();
  if (error) throw error;
  cleanupGuides.push(data.id);
  return data.id;
}

type DepartureFields = {
  operator_id: string;
  tour_id: string;
  date: string;
  start_time: string;
  capacity?: number;
  guide_id?: string | null;
  [column: string]: unknown;
};

/** The client insert the app sends: no starts_at (t30 derives it) and an optional capacity (t20 defaults it). */
function departureInsert(fields: DepartureFields): TablesInsert<"tour_departures"> {
  return fields as unknown as TablesInsert<"tour_departures">;
}

async function insertDeparture(client: Client, fields: DepartureFields): Promise<string> {
  const { data, error } = await client.from("tour_departures").insert(departureInsert(fields)).select("id").single();
  if (error) throw error;
  return data.id;
}

async function departureRow(id: string) {
  const { data, error } = await admin
    .from("tour_departures")
    .select("id, operator_id, tour_id, date, start_time, capacity, seats_booked, status, origin, guide_id, starts_at, updated_at")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

/** Instant of a local date and time in a zone, computed by Postgres (the reference for starts_at). */
async function localInstant(date: string, time: string, timezone: string): Promise<string> {
  const [row] = await sql()`select ((${date}::date + ${time}::time) at time zone ${timezone}) as at`;
  return (row.at as Date).toISOString();
}

const iso = (value: string) => new Date(value).toISOString();

async function signIn(user: { id: string; email: string; password: string }, operatorId: string): Promise<void> {
  jar = new CookieJar();
  expect(await expectRedirect(() => loginAction(IDLE, form({ locale: "es", intent: "password", email: user.email, password: user.password })))).toBe(
    "/es",
  );
  jar.set(ACTIVE_OPERATOR_COOKIE, `${user.id}:${operatorId}`);
  expect((await getOperatorContext())?.operator.id).toBe(operatorId);
}

describe("departure inserts and grants (R17, KTD4, KTD13)", () => {
  let tourId: string;
  const date = addDays(TODAY, 20);

  beforeAll(async () => {
    tourId = await insertTour(A, "Grants", { capacity: 9 });
  });

  it("reservas creates an ad hoc departure without capacity: scheduled, ad_hoc, tour capacity, no seats", async () => {
    const reservas = await clientFor("reservasA");
    const id = await insertDeparture(reservas, { operator_id: A, tour_id: tourId, date, start_time: "09:00" });
    expect(await departureRow(id)).toMatchObject({ status: "scheduled", origin: "ad_hoc", capacity: 9, seats_booked: 0, guide_id: null });
  });

  it("reservas cannot name a guide, edit or delete a departure", async () => {
    const reservas = await clientFor("reservasA");
    expectSqlState(
      await reservas.from("tour_departures").insert(departureInsert({ operator_id: A, tour_id: tourId, date, start_time: "09:30", guide_id: GUIDES.a2.id })),
      "42501",
    );
    const id = await insertDeparture(await clientFor("adminA"), { operator_id: A, tour_id: tourId, date, start_time: "09:45" });
    expectZeroRows(await reservas.from("tour_departures").update({ capacity: 3 }).eq("id", id).select("id"));
    expectSqlState(await (await clientFor("adminA")).from("tour_departures").delete().eq("id", id), "42501");
    expect((await departureRow(id)).capacity).toBe(9);
  });

  it("server-owned columns are refused: seats_booked, starts_at, status and origin on insert; seats_booked on update", async () => {
    const adminA = await clientFor("adminA");
    for (const extra of [{ seats_booked: 5 }, { starts_at: "2030-01-01T00:00:00Z" }, { status: "closed" }, { origin: "schedule" }]) {
      expectSqlState(
        await adminA.from("tour_departures").insert(departureInsert({ operator_id: A, tour_id: tourId, date, start_time: "10:00", capacity: 9, ...extra })),
        "42501",
        "permission denied",
      );
    }
    const id = await insertDeparture(adminA, { operator_id: A, tour_id: tourId, date, start_time: "10:00", capacity: 9 });
    expectSqlState(await adminA.from("tour_departures").update({ seats_booked: 5 }).eq("id", id), "42501", "permission denied");
    expectSqlState(await adminA.from("tour_departures").update({ starts_at: "2030-01-01T00:00:00Z" }).eq("id", id), "42501", "permission denied");
    expectSqlState(await adminA.from("tour_departures").update({ origin: "schedule" }).eq("id", id), "42501", "permission denied");
    expectSqlState(await (await clientFor("adminAB")).from("tour_departures").update({ operator_id: B }).eq("id", id), "42501", "permission denied");
    expect(await departureRow(id)).toMatchObject({ seats_booked: 0, origin: "ad_hoc", operator_id: A });
  });

  it("a slot holds one live departure (partial unique index)", async () => {
    const adminA = await clientFor("adminA");
    await insertDeparture(adminA, { operator_id: A, tour_id: tourId, date, start_time: "11:00" });
    expectSqlState(await adminA.from("tour_departures").insert(departureInsert({ operator_id: A, tour_id: tourId, date, start_time: "11:00" })), "23505");
  });

  it("covers AE11 (catalog): another operator's tour or guide fails with a foreign-key violation", async () => {
    const adminAB = await clientFor("adminAB");
    expectSqlState(
      await adminAB.from("tour_departures").insert(departureInsert({ operator_id: A, tour_id: TOURS.b1.id, date, start_time: "12:00", capacity: 5 })),
      "23503",
    );
    const id = await insertDeparture(adminAB, { operator_id: A, tour_id: tourId, date, start_time: "12:00" });
    expectSqlState(await adminAB.from("tour_departures").update({ guide_id: GUIDES.b1.id }).eq("id", id), "23503");
    expect((await departureRow(id)).guide_id).toBeNull();
    const { count } = await admin.from("tour_departures").select("id", { count: "exact", head: true }).eq("tour_id", TOURS.b1.id).eq("date", date);
    expect(count).toBe(0);
  });

  it("archived tour: a direct departure insert fails with tour_archived (R21)", async () => {
    const archived = await insertTour(A, "Archived", { archived: true });
    for (const key of ["adminA", "reservasA"] as const) {
      expectTypedError(
        await (await clientFor(key)).from("tour_departures").insert(departureInsert({ operator_id: A, tour_id: archived, date, start_time: "08:00" })),
        "tour_archived",
      );
    }
  });
});

describe("capacity backstop (KTD5)", () => {
  let departureId: string;

  beforeAll(async () => {
    const tourId = await insertTour(A, "Capacity");
    departureId = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date: addDays(TODAY, 21), start_time: "08:00", capacity: 10 });
    // U6's triggers own seats_booked; the service role stands in for three sold seats.
    const { error } = await admin.from("tour_departures").update({ seats_booked: 3 }).eq("id", departureId);
    if (error) throw error;
  });

  it("lowering capacity below seats_booked fails with 23514 naming tour_departures_seats_within_capacity", async () => {
    const adminA = await clientFor("adminA");
    expectSqlState(
      await adminA.from("tour_departures").update({ capacity: 2 }).eq("id", departureId),
      "23514",
      "tour_departures_seats_within_capacity",
    );
    const ok = await adminA.from("tour_departures").update({ capacity: 3 }).eq("id", departureId).select("capacity");
    expect(ok.data).toEqual([{ capacity: 3 }]);
  });

  it("the action state reads «Hay 3 lugares vendidos»", async () => {
    await signIn(seedUser("adminA"), A);
    const row = await departureRow(departureId);
    const state = await updateDepartureAction(
      IDLE,
      form({ locale: "es", departureId, date: row.date, startTime: "08:00", capacity: "2", guideId: "" }),
    );
    expect(state).toMatchObject({ status: "error", error: "capacity_below_booked", seatsBooked: 3, values: { capacity: "2" } });
    const t = createTranslator({ locale: "es", messages: es, namespace: "departures" });
    expect(t("form.capacityBelowBooked", { count: 3 })).toBe("Hay 3 lugares vendidos: la capacidad no puede ser menor.");
    expect((await departureRow(departureId)).capacity).toBe(3);
  });
});

describe("starts_at and the timezone recompute (KTD7)", () => {
  it("equals the UTC instant of the local date and time for America/Costa_Rica, and follows edits", async () => {
    const tourId = await insertTour(A, "Instant");
    const id = await insertDeparture(await clientFor("adminA"), { operator_id: A, tour_id: tourId, date: "2030-12-03", start_time: "08:00" });
    // Costa Rica is UTC-6 all year.
    expect(iso((await departureRow(id)).starts_at)).toBe("2030-12-03T14:00:00.000Z");
    await (await clientFor("adminA")).from("tour_departures").update({ start_time: "17:30" }).eq("id", id);
    expect(iso((await departureRow(id)).starts_at)).toBe("2030-12-03T23:30:00.000Z");
  });

  it("a timezone change rewrites exactly the future departure; an unrelated operators update touches none", async () => {
    const { data: operator, error } = await admin
      .from("operators")
      .insert({ name: `Zone ${TAG}`, slug: `zone-${TAG}`, timezone: "America/Costa_Rica", currency: "USD" })
      .select("id")
      .single();
    if (error) throw error;
    cleanupOperators.push(operator.id);
    const tourId = await insertTour(operator.id, "Zone");
    const futureDate = addDays(TODAY, 30);
    const future = await insertDeparture(admin, { operator_id: operator.id, tour_id: tourId, date: futureDate, start_time: "09:00", capacity: 5 });
    const past = await insertDeparture(admin, { operator_id: operator.id, tour_id: tourId, date: PAST, start_time: "09:00", capacity: 5 });
    const before = { future: await departureRow(future), past: await departureRow(past) };
    expect(iso(before.past.starts_at)).toBe(await localInstant(PAST, "09:00", "America/Costa_Rica"));

    await admin.from("operators").update({ timezone: "Europe/Madrid" }).eq("id", operator.id);
    const after = { future: await departureRow(future), past: await departureRow(past) };
    expect(iso(after.future.starts_at)).toBe(await localInstant(futureDate, "09:00", "Europe/Madrid"));
    expect(after.future.starts_at).not.toBe(before.future.starts_at);
    expect(after.past).toEqual(before.past);

    await admin.from("operators").update({ name: `Zone renamed ${TAG}` }).eq("id", operator.id);
    expect(await departureRow(future)).toEqual(after.future);
    expect(await departureRow(past)).toEqual(before.past);
  });
});

describe("private.materialize_departure (R17)", () => {
  let tourId: string;
  const weekday = 4;
  let date: string;

  const materialize = (userId: string, tour: string, day: string, time: string) =>
    asRole("authenticated", userId, async (tx) => {
      const [row] = await tx`select private.materialize_departure(${tour}::uuid, ${day}::date, ${time}::time) as id`;
      return row.id as string;
    });

  beforeAll(async () => {
    tourId = await insertTour(A, "Materialize", { capacity: 10 });
    date = nextWeekday(weekday);
    const { error } = await admin
      .from("tour_schedules")
      .insert({ operator_id: A, tour_id: tourId, weekday, start_time: "10:00", capacity_override: 6, valid_from: TODAY });
    if (error) throw error;
  });

  it("two concurrent materializations of the same slot return the same id and create one row", async () => {
    const reservas = seedUser("reservasA").id;
    const first = asRole("authenticated", reservas, async (tx) => {
      const [row] = await tx`select private.materialize_departure(${tourId}::uuid, ${date}::date, ${"10:00"}::time) as id`;
      // Hold the uncommitted insert so the second call has to wait on it.
      await tx`select pg_sleep(0.5)`;
      return row.id as string;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = materialize(seedUser("adminA").id, tourId, date, "10:00");
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    const { data } = await admin.from("tour_departures").select("id, origin, capacity, status").eq("tour_id", tourId).eq("date", date);
    expect(data).toEqual([{ id: a, origin: "schedule", capacity: 6, status: "scheduled" }]);
  });

  it("a time that matches no schedule yields origin ad_hoc and the tour default capacity", async () => {
    const id = await materialize(seedUser("reservasA").id, tourId, date, "11:15");
    expect(await departureRow(id)).toMatchObject({ origin: "ad_hoc", capacity: 10, start_time: "11:15:00" });
    // The same weekday and time before the schedule's validity window starts is not the schedule either.
    let before = addDays(TODAY, -1);
    while (weekdayOf(before) !== weekday) before = addDays(before, -1);
    const early = await materialize(seedUser("reservasA").id, tourId, before, "10:00");
    expect((await departureRow(early)).origin).toBe("ad_hoc");
  });

  it("after the departure is cancelled, materializing the same slot creates a new row", async () => {
    const adminA = seedUser("adminA").id;
    const original = await materialize(adminA, tourId, date, "10:00");
    expect((await (await clientFor("adminA")).rpc("cancel_departure", { departure_id: original })).error).toBeNull();
    const fresh = await materialize(adminA, tourId, date, "10:00");
    expect(fresh).not.toBe(original);
    expect((await departureRow(original)).status).toBe("cancelled");
    expect(await departureRow(fresh)).toMatchObject({ status: "scheduled", origin: "schedule", capacity: 6 });
  });

  it("contabilidad, another operator's user and an unknown tour get not_found", async () => {
    for (const userId of [seedUser("contabilidadA").id, seedUser("reservasB").id, seedUser("guiaA").id]) {
      await expect(materialize(userId, tourId, date, "12:00")).rejects.toMatchObject({ code: "P0001", message: "not_found" });
    }
    await expect(materialize(seedUser("adminA").id, "00000000-0000-4000-8000-000000000000", date, "12:00")).rejects.toMatchObject({
      message: "not_found",
    });
    const { count } = await admin.from("tour_departures").select("id", { count: "exact", head: true }).eq("tour_id", tourId).eq("start_time", "12:00");
    expect(count).toBe(0);
  });
});

describe("departure state machine and cancel_departure (KTD5, R18)", () => {
  let tourId: string;
  const date = addDays(TODAY, 22);

  beforeAll(async () => {
    tourId = await insertTour(A, "States");
  });

  it("close, then a direct update back to scheduled fails; cancel from closed succeeds", async () => {
    const adminA = await clientFor("adminA");
    const id = await insertDeparture(adminA, { operator_id: A, tour_id: tourId, date, start_time: "08:00" });
    const closed = await adminA.from("tour_departures").update({ status: "closed" }).eq("id", id).select("status");
    expect(closed.data).toEqual([{ status: "closed" }]);
    expectTypedError(await adminA.from("tour_departures").update({ status: "scheduled" }).eq("id", id), "forbidden_transition");
    expect((await adminA.rpc("cancel_departure", { departure_id: id })).error).toBeNull();
    expect((await departureRow(id)).status).toBe("cancelled");
  });

  it("cancel on a scheduled departure with no reservations succeeds; a direct update to cancelled fails", async () => {
    const adminA = await clientFor("adminA");
    const direct = await insertDeparture(adminA, { operator_id: A, tour_id: tourId, date, start_time: "09:00" });
    expectTypedError(await adminA.from("tour_departures").update({ status: "cancelled" }).eq("id", direct), "forbidden_transition");
    expect((await departureRow(direct)).status).toBe("scheduled");
    expect((await adminA.rpc("cancel_departure", { departure_id: direct })).error).toBeNull();
    expect((await departureRow(direct)).status).toBe("cancelled");
  });

  it("any transition out of cancelled fails with forbidden_transition, including a second cancel", async () => {
    const adminA = await clientFor("adminA");
    const id = await insertDeparture(adminA, { operator_id: A, tour_id: tourId, date, start_time: "10:00" });
    expect((await adminA.rpc("cancel_departure", { departure_id: id })).error).toBeNull();
    for (const status of ["scheduled", "closed"] as const) {
      expectTypedError(await adminA.from("tour_departures").update({ status }).eq("id", id), "forbidden_transition");
    }
    expectTypedError(await adminA.rpc("cancel_departure", { departure_id: id }), "forbidden_transition");
    // The service role obeys the same trigger.
    expectTypedError(await admin.from("tour_departures").update({ status: "scheduled" }).eq("id", id), "forbidden_transition");
    expect((await departureRow(id)).status).toBe("cancelled");
  });

  it("only an administrador of the departure's operator cancels; anon cannot call the rpc", async () => {
    const id = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date, start_time: "11:00", capacity: 5 });
    expectSqlState(await (await clientFor("reservasA")).rpc("cancel_departure", { departure_id: id }), "42501");
    expectSqlState(await (await clientFor("contabilidadA")).rpc("cancel_departure", { departure_id: id }), "42501");
    expectTypedError(await (await clientFor("reservasB")).rpc("cancel_departure", { departure_id: id }), "not_found");
    expectSqlState(await anonClient().rpc("cancel_departure", { departure_id: id }), "42501");
    expect((await departureRow(id)).status).toBe("scheduled");
  });

  it("the cancel setting names one row: a direct cancel of another departure in the same transaction still fails", async () => {
    const first = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date, start_time: "12:00", capacity: 5 });
    const second = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date, start_time: "13:00", capacity: 5 });
    await expect(
      asRole("authenticated", seedUser("adminA").id, async (tx) => {
        await tx`select public.cancel_departure(${first}::uuid)`;
        await tx`update public.tour_departures set status = 'cancelled' where id = ${second}`;
      }),
    ).rejects.toMatchObject({ code: "P0001", message: "forbidden_transition" });
    expect((await departureRow(first)).status).toBe("scheduled");
    expect((await departureRow(second)).status).toBe("scheduled");
  });
});

describe("AE10 guía scope (R20, KTD13)", () => {
  const created: Record<string, string> = {};

  beforeAll(async () => {
    const tourId = await insertTour(A, "Guide scope");
    const future = addDays(TODAY, 23);
    created.futureMine = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date: future, start_time: "08:00", capacity: 5, guide_id: GUIDES.a1.id });
    created.pastMine = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date: PAST, start_time: "08:00", capacity: 5, guide_id: GUIDES.a1.id });
    created.futureOther = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date: future, start_time: "09:00", capacity: 5, guide_id: GUIDES.a2.id });
    created.futureNone = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date: future, start_time: "10:00", capacity: 5 });
  });

  it("a guía linked to guide a1 lists only future departures assigned to a1", async () => {
    const guia = await clientFor("guiaA");
    const { data, error } = await guia.from("tour_departures").select("id, guide_id, starts_at");
    expect(error).toBeNull();
    const ids = new Set(data?.map((row) => row.id));
    expect(ids.has(created.futureMine)).toBe(true);
    expect(ids.has(created.pastMine)).toBe(false);
    expect(ids.has(created.futureOther)).toBe(false);
    expect(ids.has(created.futureNone)).toBe(false);
    const now = Date.now();
    for (const row of data ?? []) {
      expect(row.guide_id).toBe(GUIDES.a1.id);
      expect(new Date(row.starts_at).getTime()).toBeGreaterThanOrEqual(now - 60_000);
    }
  });

  it("staff of the operator read every departure", async () => {
    const { data } = await (await clientFor("contabilidadA")).from("tour_departures").select("id").in("id", Object.values(created));
    expect(data?.length).toBe(4);
  });
});

describe("deactivating a guide (KTD13)", () => {
  it("clears guide_id on the guide's future departures and leaves past ones; an inactive guide cannot be assigned", async () => {
    const tourId = await insertTour(A, "Deactivate");
    const guideId = await insertGuide(A, "Leaving");
    const future = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date: addDays(TODAY, 24), start_time: "08:00", capacity: 5, guide_id: guideId });
    const past = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date: PAST, start_time: "08:00", capacity: 5, guide_id: guideId });
    const other = await insertDeparture(admin, { operator_id: A, tour_id: tourId, date: addDays(TODAY, 24), start_time: "09:00", capacity: 5, guide_id: GUIDES.a2.id });

    const adminA = await clientFor("adminA");
    const deactivated = await adminA.from("guides").update({ active: false }).eq("id", guideId).select("active");
    expect(deactivated.data).toEqual([{ active: false }]);
    expect((await departureRow(future)).guide_id).toBeNull();
    expect((await departureRow(past)).guide_id).toBe(guideId);
    expect((await departureRow(other)).guide_id).toBe(GUIDES.a2.id);

    expectTypedError(await adminA.from("tour_departures").update({ guide_id: guideId }).eq("id", future), "guide_inactive");
    expectTypedError(
      await adminA.from("tour_departures").insert(departureInsert({ operator_id: A, tour_id: tourId, date: addDays(TODAY, 25), start_time: "08:00", guide_id: guideId })),
      "guide_inactive",
    );
    // A past departure keeps its (now inactive) guide through unrelated edits.
    const edited = await adminA.from("tour_departures").update({ capacity: 6 }).eq("id", past).select("guide_id, capacity");
    expect(edited.data).toEqual([{ guide_id: guideId, capacity: 6 }]);
  });
});

describe("departure actions and the slot DAL", () => {
  let tourId: string;
  let departureId: string;
  const date = nextWeekday(2);
  const fields = (extra: Record<string, string>) => form({ locale: "es", tourId, date, startTime: "15:00", capacity: "", guideId: "", ...extra });

  beforeAll(async () => {
    tourId = await insertTour(A, "Actions", { capacity: 11 });
    const { error } = await admin.from("tour_schedules").insert({ operator_id: A, tour_id: tourId, weekday: 2, start_time: "08:00", valid_from: TODAY });
    if (error) throw error;
  });

  it("creates an ad hoc departure with a guide and opens it; a taken slot is reported on the time field", async () => {
    await signIn(seedUser("adminA"), A);
    const target = await expectRedirect(() => createDepartureAction(IDLE, fields({ guideId: GUIDES.a2.id })));
    const match = /^\/es\/departures\/([0-9a-f-]{36})$/.exec(target);
    expect(match).not.toBeNull();
    departureId = match?.[1] as string;
    expect(await departureRow(departureId)).toMatchObject({ tour_id: tourId, capacity: 11, guide_id: GUIDES.a2.id, origin: "ad_hoc", status: "scheduled" });

    expect(await createDepartureAction(IDLE, fields({}))).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: { startTime: "validation.slotTaken" },
      values: { startTime: "15:00" },
    });
    expect(await createDepartureAction(IDLE, fields({ tourId: TOURS.b1.id, startTime: "16:00" }))).toMatchObject({ status: "error", error: "invalid_reference" });
    expect(await createDepartureAction(IDLE, fields({ date: "2026-02-30" }))).toMatchObject({ status: "error", fieldErrors: { date: "validation.dateInvalid" } });
  });

  it("lists the schedule slot and the ad hoc departure for the date", async () => {
    const ctx = await requireOperatorContext("departures.read");
    const slots = await listDepartureSlots(ctx, tourId, date);
    expect(slots).toEqual([
      { startTime: "08:00", departureId: null, status: null, origin: "schedule", capacity: 11, seatsBooked: 0, available: 11 },
      { startTime: "15:00", departureId, status: "scheduled", origin: "ad_hoc", capacity: 11, seatsBooked: 0, available: 11 },
    ]);
    expect(await listDepartureSlots(ctx, TOURS.b1.id, date)).toBeNull();
  });

  it("edits, closes and cancels a departure; found-checks another operator's departure", async () => {
    expect(
      await updateDepartureAction(IDLE, form({ locale: "es", departureId, date, startTime: "15:30", capacity: "8", guideId: GUIDES.a1.id })),
    ).toEqual({ status: "ok" });
    expect(await departureRow(departureId)).toMatchObject({ start_time: "15:30:00", capacity: 8, guide_id: GUIDES.a1.id });

    const foreign = await insertDeparture(admin, { operator_id: B, tour_id: TOURS.b1.id, date: addDays(TODAY, 26), start_time: "07:00", capacity: 4 });
    try {
      expect(await updateDepartureAction(IDLE, form({ locale: "es", departureId: foreign, date, startTime: "07:00", capacity: "4", guideId: "" }))).toMatchObject({
        status: "error",
        error: "not_found",
      });
      expect(await closeDepartureAction(IDLE, form({ departureId: foreign }))).toEqual({ status: "error", error: "not_found" });
      expect(await cancelDepartureAction(IDLE, form({ departureId: foreign }))).toEqual({ status: "error", error: "not_found" });
      expect((await departureRow(foreign)).status).toBe("scheduled");
    } finally {
      await admin.from("tour_departures").delete().eq("id", foreign);
    }
    expect(await closeDepartureAction(IDLE, form({ departureId: "nope" }))).toMatchObject({ status: "error", error: "invalid" });

    expect(await closeDepartureAction(IDLE, form({ departureId }))).toEqual({ status: "ok" });
    expect((await departureRow(departureId)).status).toBe("closed");
    expect(await cancelDepartureAction(IDLE, form({ departureId }))).toEqual({ status: "ok" });
    expect((await departureRow(departureId)).status).toBe("cancelled");
    expect(await cancelDepartureAction(IDLE, form({ departureId }))).toEqual({ status: "error", error: "forbidden_transition" });
    expect(await closeDepartureAction(IDLE, form({ departureId }))).toEqual({ status: "error", error: "forbidden_transition" });
  });

  it("an archived tour answers tour_archived", async () => {
    const archived = await insertTour(A, "Archived action", { archived: true });
    expect(await createDepartureAction(IDLE, fields({ tourId: archived }))).toMatchObject({ status: "error", error: "tour_archived" });
  });

  it("reservas creates ad hoc departures without a guide only; contabilidad creates none", async () => {
    await signIn(seedUser("reservasA"), A);
    const target = await expectRedirect(() => createDepartureAction(IDLE, fields({ startTime: "17:00" })));
    expect(target).toMatch(/^\/es\/departures\/[0-9a-f-]{36}$/);
    expect(await createDepartureAction(IDLE, fields({ startTime: "18:00", guideId: GUIDES.a2.id }))).toMatchObject({ status: "error", error: "forbidden" });
    const own = target.split("/").pop() as string;
    expect(await updateDepartureAction(IDLE, form({ locale: "es", departureId: own, date, startTime: "17:00", capacity: "3", guideId: "" }))).toMatchObject({
      status: "error",
      error: "forbidden",
    });
    expect(await closeDepartureAction(IDLE, form({ departureId: own }))).toEqual({ status: "error", error: "forbidden" });
    expect(await cancelDepartureAction(IDLE, form({ departureId: own }))).toEqual({ status: "error", error: "forbidden" });
    expect((await departureRow(own)).status).toBe("scheduled");

    await signIn(seedUser("contabilidadA"), A);
    expect(await createDepartureAction(IDLE, fields({ startTime: "19:00" }))).toMatchObject({ status: "error", error: "forbidden" });
  });
});
