// U5 tours, channel prices and weekly schedules against the local stack:
// AE2 (cross-operator reads) and AE4 (price privacy) for the catalog tables,
// the column grants, schedule constraints, and the tour, price and schedule
// server actions through the real DAL (same harness as guides.test.ts:
// `next/headers`, `next/cache` and `server-only` replaced).
//
// Every row created here belongs to a throwaway tour with a random tag, and
// afterAll removes them with the secret key (authenticated has no delete
// grant on tours).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OPERATORS, TOURS } from "./fixtures.ts";
import {
  adminClient,
  clientFor,
  closeSql,
  createTestUser,
  deleteTestUser,
  expectSqlState,
  expectZeroRows,
  seedUser,
  uniqueEmail,
} from "./helpers.ts";
import { CookieJar, expectRedirect, form, requestHeaders } from "./next-harness.ts";

let jar = new CookieJar();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => requestHeaders() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

const { loginAction } = await import("../../apps/web/src/app/[locale]/(auth)/login/actions.ts");
const { createScheduleAction, createTourAction, deleteScheduleAction, setTourArchivedAction, setTourPriceAction, updateTourAction } =
  await import("../../apps/web/src/app/[locale]/(app)/tours/actions.ts");
const { ACTIVE_OPERATOR_COOKIE, getOperatorContext, requireOperatorContext } = await import(
  "../../apps/web/src/lib/dal/context.ts"
);
const { listTourPrices, listTours } = await import("../../apps/web/src/lib/dal/tours.ts");

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const admin = adminClient();
const IDLE = { status: "idle" } as const;
const TAG = randomBytes(3).toString("hex");
const cleanupTours: string[] = [];
const cleanupUsers: Array<{ id: string; email: string }> = [];

/** A throwaway tour created with the service role. */
async function insertTour(operatorId: string, name: string, fields: { archived?: boolean } = {}): Promise<string> {
  const { data, error } = await admin
    .from("tours")
    .insert({
      operator_id: operatorId,
      name: `${name} ${TAG}`,
      duration_minutes: 120,
      default_capacity: 10,
      ...(fields.archived && { archived_at: new Date().toISOString() }),
    })
    .select("id")
    .single();
  if (error) throw error;
  cleanupTours.push(data.id);
  return data.id;
}

afterAll(async () => {
  if (cleanupTours.length) {
    await admin.from("tour_departures").delete().in("tour_id", cleanupTours);
    await admin.from("tours").delete().in("id", cleanupTours);
  }
  for (const user of cleanupUsers) await deleteTestUser(admin, user.id, user.email);
  await closeSql();
});

async function signIn(user: { id: string; email: string; password: string }, operatorId: string): Promise<void> {
  jar = new CookieJar();
  expect(await expectRedirect(() => loginAction(IDLE, form({ locale: "es", intent: "password", email: user.email, password: user.password })))).toBe(
    "/es",
  );
  jar.set(ACTIVE_OPERATOR_COOKIE, `${user.id}:${operatorId}`);
  expect((await getOperatorContext())?.operator.id).toBe(operatorId);
}

describe("seeded catalog", () => {
  it("matches the fixtures: one tour per operator with a direct price and a weekly schedule", async () => {
    for (const tour of Object.values(TOURS)) {
      const { data } = await admin.from("tours").select("operator_id, name, default_capacity, archived_at").eq("id", tour.id).single();
      expect(data).toEqual({ operator_id: OPERATORS[tour.operator].id, name: tour.name, default_capacity: tour.defaultCapacity, archived_at: null });
      const price = await admin.from("tour_prices").select("channel, price_minor, currency").eq("tour_id", tour.id);
      expect(price.data).toEqual([{ channel: "direct", price_minor: tour.directPrice.priceMinor, currency: tour.directPrice.currency }]);
      const schedule = await admin.from("tour_schedules").select("weekday, start_time").eq("tour_id", tour.id);
      expect(schedule.data).toEqual([{ weekday: tour.schedule.weekday, start_time: `${tour.schedule.startTime}:00` }]);
    }
  });
});

describe("AE2 for tours, prices, schedules and departures (R2, R30)", () => {
  let departureA: string;
  let contabilidadB: { id: string; email: string; password: string };

  beforeAll(async () => {
    const { data, error } = await admin
      .from("tour_departures")
      .insert({ operator_id: A, tour_id: TOURS.a1.id, date: "2030-01-08", start_time: "08:00", capacity: 12, starts_at: "2030-01-08T14:00:00Z" })
      .select("id")
      .single();
    if (error) throw error;
    departureA = data.id;
    contabilidadB = await createTestUser(admin, { email: uniqueEmail("contabilidad-b"), memberships: [{ operatorId: B, role: "contabilidad" }] });
    cleanupUsers.push(contabilidadB);
  });

  afterAll(async () => {
    await admin.from("tour_departures").delete().eq("id", departureA);
  });

  it("a user of B sees none of A's tours, prices, schedules or departures, and no error", async () => {
    for (const client of [await clientFor("reservasB"), await clientFor(contabilidadB)]) {
      for (const table of ["tours", "tour_prices", "tour_schedules", "tour_departures"] as const) {
        expectZeroRows(await client.from(table).select("id").eq("operator_id", A));
      }
      const tours = await client.from("tours").select("id, operator_id");
      expect(tours.data?.map((t) => t.operator_id)).not.toContain(A);
      expect(tours.data?.map((t) => t.id)).toContain(TOURS.b1.id);
    }
    // contabilidad of B reads B's prices only.
    const prices = await (await clientFor(contabilidadB)).from("tour_prices").select("tour_id, operator_id");
    expect(prices.data?.length).toBeGreaterThan(0);
    expect(new Set(prices.data?.map((p) => p.operator_id))).toEqual(new Set([B]));
  });

  it("a user of A sees A's catalog and none of B's", async () => {
    const adminA = await clientFor("adminA");
    for (const table of ["tours", "tour_prices", "tour_schedules", "tour_departures"] as const) {
      expectZeroRows(await adminA.from(table).select("id").eq("operator_id", B));
    }
    const departures = await adminA.from("tour_departures").select("id").eq("id", departureA);
    expect(departures.data).toEqual([{ id: departureA }]);
  });

  it("a guía reads no tours, prices or schedules", async () => {
    const guia = await clientFor("guiaA");
    for (const table of ["tours", "tour_prices", "tour_schedules"] as const) {
      expectZeroRows(await guia.from(table).select("id"));
    }
  });
});

describe("AE4 prices are role-gated (R11, KTD4, KTD14)", () => {
  it("reservas gets zero rows from tour_prices; contabilidad and administrador get rows", async () => {
    expectZeroRows(await (await clientFor("reservasA")).from("tour_prices").select("id"));
    for (const key of ["contabilidadA", "adminA"] as const) {
      const { data, error } = await (await clientFor(key)).from("tour_prices").select("tour_id, price_minor").eq("tour_id", TOURS.a1.id);
      expect(error).toBeNull();
      expect(data).toEqual([{ tour_id: TOURS.a1.id, price_minor: TOURS.a1.directPrice.priceMinor }]);
    }
  });

  it("only administradores write prices; the tour and channel of a price never change", async () => {
    const tourId = await insertTour(A, "Prices");
    const reservas = await clientFor("reservasA");
    expectSqlState(await reservas.from("tour_prices").insert({ operator_id: A, tour_id: tourId, channel: "direct", price_minor: 1, currency: "USD" }), "42501");
    const contabilidad = await clientFor("contabilidadA");
    expectSqlState(await contabilidad.from("tour_prices").insert({ operator_id: A, tour_id: tourId, channel: "direct", price_minor: 1, currency: "USD" }), "42501");
    expectZeroRows(await contabilidad.from("tour_prices").update({ price_minor: 1 }).eq("tour_id", TOURS.a1.id).select("id"));

    const adminA = await clientFor("adminA");
    const inserted = await adminA
      .from("tour_prices")
      .insert({ operator_id: A, tour_id: tourId, channel: "viator", price_minor: 9900, currency: "USD" })
      .select("id")
      .single();
    expect(inserted.error).toBeNull();
    expectSqlState(await adminA.from("tour_prices").update({ channel: "direct" }).eq("id", inserted.data?.id as string), "42501");
    expectSqlState(await adminA.from("tour_prices").update({ tour_id: TOURS.a1.id }).eq("id", inserted.data?.id as string), "42501");
    expectSqlState(await adminA.from("tour_prices").delete().eq("id", inserted.data?.id as string), "42501");
    // Money checks: non-negative minor units and an ISO code.
    expectSqlState(await adminA.from("tour_prices").update({ price_minor: -1 }).eq("id", inserted.data?.id as string), "23514");
    expectSqlState(await adminA.from("tour_prices").update({ currency: "usd" }).eq("id", inserted.data?.id as string), "23514");
    // One price per channel.
    expectSqlState(await adminA.from("tour_prices").insert({ operator_id: A, tour_id: tourId, channel: "viator", price_minor: 1, currency: "USD" }), "23505");
  });

  it("the DAL does not query prices for roles without amounts.read", async () => {
    await signIn(seedUser("reservasA"), A);
    const ctx = await requireOperatorContext("tours.read");
    expect((await listTourPrices(ctx, [TOURS.a1.id])).size).toBe(0);
    await signIn(seedUser("contabilidadA"), A);
    const prices = await listTourPrices(await requireOperatorContext("tours.read"), [TOURS.a1.id]);
    expect(prices.get(TOURS.a1.id)).toEqual([{ channel: "direct", priceMinor: 12500, currency: "USD" }]);
  });
});

describe("tours and schedules: grants and constraints (R2, R15, R16, R21)", () => {
  it("only administradores of the operator insert or edit tours; operator_id never changes; no delete", async () => {
    const reservas = await clientFor("reservasA");
    expectSqlState(await reservas.from("tours").insert({ operator_id: A, name: "Nope", duration_minutes: 60, default_capacity: 5 }), "42501");
    const adminA = await clientFor("adminA");
    expectSqlState(await adminA.from("tours").insert({ operator_id: B, name: "Foreign", duration_minutes: 60, default_capacity: 5 }), "42501");
    expectSqlState(await adminA.from("tours").insert({ operator_id: A, name: "Zero", duration_minutes: 60, default_capacity: 0 }), "23514");
    const adminAB = await clientFor("adminAB");
    expectSqlState(await adminAB.from("tours").update({ operator_id: B }).eq("id", TOURS.a1.id), "42501");
    expectSqlState(await adminA.from("tours").delete().eq("id", TOURS.a1.id), "42501");
    expectZeroRows(await reservas.from("tours").update({ name: "Renamed" }).eq("id", TOURS.a1.id).select("id"));
    const { data } = await admin.from("tours").select("operator_id, name").eq("id", TOURS.a1.id).single();
    expect(data).toEqual({ operator_id: A, name: TOURS.a1.name });
  });

  it("schedules: one per weekday and time, a valid window, whole minutes, administradores only", async () => {
    const tourId = await insertTour(A, "Schedules");
    const adminA = await clientFor("adminA");
    const first = await adminA
      .from("tour_schedules")
      .insert({ operator_id: A, tour_id: tourId, weekday: 3, start_time: "09:30", valid_from: "2026-01-01" })
      .select("id")
      .single();
    expect(first.error).toBeNull();
    expectSqlState(
      await adminA.from("tour_schedules").insert({ operator_id: A, tour_id: tourId, weekday: 3, start_time: "09:30", valid_from: "2026-06-01" }),
      "23505",
    );
    expectSqlState(
      await adminA
        .from("tour_schedules")
        .insert({ operator_id: A, tour_id: tourId, weekday: 3, start_time: "10:00", valid_from: "2026-06-01", valid_to: "2026-05-31" }),
      "23514",
    );
    expectSqlState(
      await adminA.from("tour_schedules").insert({ operator_id: A, tour_id: tourId, weekday: 7, start_time: "10:00", valid_from: "2026-06-01" }),
      "23514",
    );
    expectSqlState(
      await adminA.from("tour_schedules").insert({ operator_id: A, tour_id: tourId, weekday: 3, start_time: "10:00:30", valid_from: "2026-06-01" }),
      "23514",
    );
    // A schedule cannot point at another operator's tour (composite foreign key).
    const adminAB = await clientFor("adminAB");
    expectSqlState(
      await adminAB.from("tour_schedules").insert({ operator_id: A, tour_id: TOURS.b1.id, weekday: 3, start_time: "10:00", valid_from: "2026-06-01" }),
      "23503",
    );
    const reservas = await clientFor("reservasA");
    expectSqlState(
      await reservas.from("tour_schedules").insert({ operator_id: A, tour_id: tourId, weekday: 4, start_time: "10:00", valid_from: "2026-06-01" }),
      "42501",
    );
    expectZeroRows(await reservas.from("tour_schedules").delete().eq("id", first.data?.id as string).select("id"));
    const removed = await adminA.from("tour_schedules").delete().eq("id", first.data?.id as string).select("id");
    expect(removed.data).toEqual([{ id: first.data?.id }]);
  });
});

describe("tour actions", () => {
  let tourId: string;

  it("creates a tour and opens it; validation answers carry the input back", async () => {
    await signIn(seedUser("adminA"), A);
    const invalid = await createTourAction(
      IDLE,
      form({ locale: "es", name: " ", description: "", durationMinutes: "abc", defaultCapacity: "0", meetingPoint: "" }),
    );
    expect(invalid).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: {
        name: "validation.nameRequired",
        durationMinutes: "validation.durationInvalid",
        defaultCapacity: "validation.capacityInvalid",
      },
      values: { durationMinutes: "abc" },
    });

    const target = await expectRedirect(() =>
      createTourAction(
        IDLE,
        form({ locale: "es", name: `Volcán ${TAG}`, description: "Subida al cráter", durationMinutes: "240", defaultCapacity: "14", meetingPoint: "" }),
      ),
    );
    const match = /^\/es\/tours\/([0-9a-f-]{36})$/.exec(target);
    expect(match).not.toBeNull();
    tourId = match?.[1] as string;
    cleanupTours.push(tourId);
    const { data } = await admin.from("tours").select("operator_id, name, description, duration_minutes, default_capacity, meeting_point").eq("id", tourId).single();
    expect(data).toEqual({
      operator_id: A,
      name: `Volcán ${TAG}`,
      description: "Subida al cráter",
      duration_minutes: 240,
      default_capacity: 14,
      meeting_point: null,
    });
  });

  it("edits a tour and found-checks the target, including another operator's tour", async () => {
    const fields = { locale: "es", name: `Volcán Arenal ${TAG}`, description: "", durationMinutes: "240", defaultCapacity: "16", meetingPoint: "Hotel" };
    expect(await updateTourAction(IDLE, form({ tourId, ...fields }))).toEqual({ status: "ok" });
    const { data } = await admin.from("tours").select("name, default_capacity, meeting_point").eq("id", tourId).single();
    expect(data).toEqual({ name: `Volcán Arenal ${TAG}`, default_capacity: 16, meeting_point: "Hotel" });

    expect(await updateTourAction(IDLE, form({ tourId: TOURS.b1.id, ...fields }))).toMatchObject({ status: "error", error: "not_found" });
    expect(await updateTourAction(IDLE, form({ tourId: "not-a-uuid", ...fields }))).toMatchObject({ status: "error", error: "invalid" });
    const b = await admin.from("tours").select("name").eq("id", TOURS.b1.id).single();
    expect(b.data?.name).toBe(TOURS.b1.name);
  });

  it("sets the direct price in minor units, then updates it in place", async () => {
    const price = (amount: string, extra: Record<string, string> = {}) =>
      setTourPriceAction(IDLE, form({ tourId, channel: "direct", currency: "USD", amount, ...extra }));
    expect(await price("125.50")).toEqual({ status: "ok" });
    expect(await price("130")).toEqual({ status: "ok" });
    const { data } = await admin.from("tour_prices").select("channel, price_minor, currency").eq("tour_id", tourId);
    expect(data).toEqual([{ channel: "direct", price_minor: 13000, currency: "USD" }]);

    expect(await price("12.345")).toMatchObject({ status: "error", error: "invalid", fieldErrors: { amount: "validation.priceInvalid" }, values: { amount: "12.345" } });
    expect(await price("10", { tourId: TOURS.b1.id })).toMatchObject({ status: "error", error: "not_found" });
    expect(await price("10", { channel: "airbnb" })).toMatchObject({ status: "error", error: "invalid" });
  });

  it("adds a schedule, reports a duplicate on the time field and removes it", async () => {
    const schedule = (extra: Record<string, string> = {}) =>
      createScheduleAction(
        IDLE,
        form({ tourId, weekday: "2", startTime: "07:30", capacityOverride: "8", validFrom: "2026-01-01", validTo: "", ...extra }),
      );
    expect(await schedule()).toEqual({ status: "ok" });
    expect(await schedule()).toMatchObject({ status: "error", error: "invalid", fieldErrors: { startTime: "validation.scheduleTaken" } });
    expect(await schedule({ tourId: TOURS.b1.id, startTime: "06:00" })).toMatchObject({ status: "error", error: "not_found" });
    const { data } = await admin.from("tour_schedules").select("id, weekday, start_time, capacity_override, valid_to").eq("tour_id", tourId);
    expect(data).toEqual([{ id: expect.any(String), weekday: 2, start_time: "07:30:00", capacity_override: 8, valid_to: null }]);

    const scheduleB = await admin.from("tour_schedules").select("id").eq("tour_id", TOURS.b1.id).single();
    expect(await deleteScheduleAction(IDLE, form({ scheduleId: scheduleB.data?.id as string }))).toMatchObject({ status: "error", error: "not_found" });
    expect(await deleteScheduleAction(IDLE, form({ scheduleId: data?.[0].id as string }))).toEqual({ status: "ok" });
  });

  it("archives and restores a tour; archived tours leave the default list (R21)", async () => {
    const ctx = await requireOperatorContext("tours.read");
    expect(await setTourArchivedAction(IDLE, form({ tourId, archived: "true" }))).toEqual({ status: "ok" });
    expect((await listTours(ctx)).map((t) => t.id)).not.toContain(tourId);
    expect((await listTours(ctx, { includeArchived: true })).find((t) => t.id === tourId)?.archived).toBe(true);
    expect(await setTourArchivedAction(IDLE, form({ tourId, archived: "false" }))).toEqual({ status: "ok" });
    expect((await listTours(ctx)).map((t) => t.id)).toContain(tourId);
  });

  it("refuses reservas and contabilidad on every write action", async () => {
    for (const key of ["reservasA", "contabilidadA"] as const) {
      await signIn(seedUser(key), A);
      const tourFields = { locale: "es", name: "Nope", description: "", durationMinutes: "60", defaultCapacity: "5", meetingPoint: "" };
      expect(await createTourAction(IDLE, form(tourFields))).toMatchObject({ status: "error", error: "forbidden" });
      expect(await updateTourAction(IDLE, form({ tourId, ...tourFields }))).toMatchObject({ status: "error", error: "forbidden" });
      expect(await setTourArchivedAction(IDLE, form({ tourId, archived: "true" }))).toEqual({ status: "error", error: "forbidden" });
      expect(await setTourPriceAction(IDLE, form({ tourId, channel: "direct", currency: "USD", amount: "1" }))).toMatchObject({
        status: "error",
        error: "forbidden",
      });
      expect(
        await createScheduleAction(IDLE, form({ tourId, weekday: "1", startTime: "05:00", capacityOverride: "", validFrom: "2026-01-01", validTo: "" })),
      ).toMatchObject({ status: "error", error: "forbidden" });
    }
    const { data } = await admin.from("tour_prices").select("price_minor").eq("tour_id", tourId);
    expect(data).toEqual([{ price_minor: 13000 }]);
  });
});
