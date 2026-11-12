// U10 reservation detail and change history against the local stack (plan
// U10 test scenarios; R23, R28, R29; KTD4, KTD6, KTD9): the history DAL over
// audit.events (administrador only, per operator, actors resolved through
// profiles, "Sistema" and "Usuario eliminado"), the detail read by role, and
// the edit and cancel actions through the real server code.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays, weekdayOf } from "@cupo/shared/local-date";
import { FUTURE, BookingFixtures, auditMark, book, heldOn, reservationRow, seatsOf } from "./booking.ts";
import { OPERATORS } from "./fixtures.ts";
import {
  adminClient,
  clientFor,
  closeSql,
  createTestUser,
  deleteTestUser,
  expectZeroRows,
  reconcileSeats,
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
const { cancelReservationAction, updateReservationAction } = await import("../../apps/web/src/app/[locale]/(app)/reservations/actions.ts");
const { ACTIVE_OPERATOR_COOKIE, getOperatorContext, requireOperatorContext } = await import("../../apps/web/src/lib/dal/context.ts");
const { getReservation } = await import("../../apps/web/src/lib/dal/reservations.ts");
const { getReservationHistory } = await import("../../apps/web/src/lib/dal/audit.ts");
const { ForbiddenError } = await import("../../apps/web/src/lib/dal/errors.ts");

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const admin = adminClient();
const fx = new BookingFixtures();
const IDLE = { status: "idle" } as const;
const throwaway: Array<{ id: string; email: string }> = [];

afterAll(async () => {
  await fx.cleanup();
  for (const user of throwaway) await deleteTestUser(admin, user.id, user.email);
  await closeSql();
});

type Credentials = { id: string; email: string; password: string };

async function signIn(user: Credentials, operatorId: string): Promise<void> {
  jar = new CookieJar();
  expect(await expectRedirect(() => loginAction(IDLE, form({ locale: "es", intent: "password", email: user.email, password: user.password })))).toBe(
    "/es",
  );
  jar.set(ACTIVE_OPERATOR_COOKIE, `${user.id}:${operatorId}`);
  expect((await getOperatorContext())?.operator.id).toBe(operatorId);
}

/** Books and returns the new reservation's id (throws on failure). */
async function booked(client: Client, args: Parameters<typeof book>[1]): Promise<string> {
  const { data, error } = await book(client, args);
  if (error) throw new Error(`${error.code} ${error.message}`);
  return data.id;
}

async function notesOf(reservationId: string): Promise<string | null> {
  const { data, error } = await admin.from("reservation_notes").select("notes").eq("reservation_id", reservationId).maybeSingle();
  if (error) throw error;
  return data?.notes ?? null;
}

/** The first date on or after `from` that falls on `weekday` (0 = Sunday). */
function nextWeekday(from: string, weekday: number): string {
  let date = from;
  while (weekdayOf(date) !== weekday) date = addDays(date, 1);
  return date;
}

describe("change history (R28, R29, KTD6)", () => {
  const date = addDays(FUTURE, 5);
  const nextDate = addDays(date, 1);
  let tour: string;
  let departure: string;
  let laterDeparture: string;
  let customer: string;

  beforeAll(async () => {
    tour = await fx.tour(A, { capacity: 10, price: 5000, name: "Historia" });
    departure = await fx.departure(A, tour, { date, startTime: "08:00" });
    laterDeparture = await fx.departure(A, tour, { date: nextDate, startTime: "13:30" });
    customer = await fx.customer(A, { name: `Ana ${fx.tag} Pérez` });
  });

  it("administrador of A reads the history of an A reservation: create, edit and cancel with actor, labels and only the changed keys", async () => {
    const adminA = seedUser("adminA");
    await signIn(adminA, A);
    const id = await booked(await clientFor("adminA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 2 });
    expect(
      await updateReservationAction(IDLE, form({ reservationId: id, date: nextDate, slot: `departure:${laterDeparture}`, people: "3", notes: "" })),
    ).toEqual({ status: "ok", data: { changed: true } });
    expect(await cancelReservationAction(IDLE, form({ reservationId: id, reason: "El cliente no viaja" }))).toEqual({ status: "ok" });

    const { data: raw } = await (await clientFor("adminA")).schema("audit").from("events").select("table_name, op").eq("record_id", id);
    expect(raw?.map((row) => `${row.table_name} ${row.op}`).sort()).toEqual([
      "reservation_amounts insert",
      "reservation_amounts update",
      "reservations insert",
      "reservations update",
      "reservations update",
    ]);

    const history = await getReservationHistory(await requireOperatorContext("audit.read"), id);
    expect(history.map((entry) => entry.action)).toEqual(["cancelled", "updated", "created"]);
    for (const entry of history) expect(entry.actor).toEqual({ kind: "user", name: "Admin A" });
    const [cancelled, updated, created] = history;

    expect(cancelled.changes).toEqual([
      { subject: "reservation", field: "status", before: { kind: "status", value: "confirmed" }, after: { kind: "status", value: "cancelled" } },
      { subject: "reservation", field: "cancel_reason", before: { kind: "empty" }, after: { kind: "reason", value: "El cliente no viaja" } },
    ]);
    expect(updated.changes).toEqual([
      {
        subject: "reservation",
        field: "departure_id",
        before: { kind: "departure", label: { tourName: `Historia ${fx.tag}`, date, startTime: "08:00" } },
        after: { kind: "departure", label: { tourName: `Historia ${fx.tag}`, date: nextDate, startTime: "13:30" } },
      },
      { subject: "reservation", field: "people", before: { kind: "number", value: 2 }, after: { kind: "number", value: 3 } },
      {
        subject: "amount",
        field: "total_minor",
        before: { kind: "money", minor: 10000, currency: "USD" },
        after: { kind: "money", minor: 15000, currency: "USD" },
      },
    ]);
    expect(created.changes.find((change) => change.field === "customer_id")?.after).toEqual({ kind: "customer", name: `Ana ${fx.tag} Pérez` });
    expect(created.changes.map((change) => change.field)).not.toEqual(expect.arrayContaining(["updated_at", "created_at", "operator_id", "id"]));
    // Entries are newest first; timestamps are the database's.
    expect(Date.parse(cancelled.at)).toBeGreaterThan(Date.parse(created.at));
  });

  it("reservas gets zero rows from audit.events; an administrador of B gets zero rows for A's reservation", async () => {
    const id = await booked(await clientFor("reservasA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 1 });
    const read = (client: Client) => client.schema("audit").from("events").select("id").eq("record_id", id);

    expect((await read(await clientFor("adminA"))).data?.length).toBe(2);
    expectZeroRows(await read(await clientFor("reservasA")));
    expectZeroRows(await read(await clientFor("contabilidadA")));
    expectZeroRows(await read(await clientFor("reservasB")));

    const adminB = await createTestUser(admin, { email: uniqueEmail("admin-b-history"), memberships: [{ operatorId: B, role: "administrador" }] });
    throwaway.push(adminB);
    expectZeroRows(await read(await clientFor(adminB)));

    await signIn(seedUser("reservasA"), A);
    await expect(getReservationHistory(await requireOperatorContext("reservations.read"), id)).rejects.toBeInstanceOf(ForbiddenError);
    // An administrador of A and B with B active: the DAL scopes to B, so nothing.
    await signIn(seedUser("adminAB"), B);
    expect(await getReservationHistory(await requireOperatorContext("audit.read"), id)).toEqual([]);
  });

  it("shows Sistema for secret-key writes and Usuario eliminado once the actor's user is deleted", async () => {
    const booker = await createTestUser(admin, { email: uniqueEmail("reservas-history"), fullName: "Reservas Temporal", memberships: [{ operatorId: A, role: "reservas" }] });
    throwaway.push(booker);
    const id = await booked(await clientFor(booker), { operator_id: A, departure_id: departure, customer_id: customer, people: 1 });
    expect((await admin.from("reservations").update({ people: 2 }).eq("id", id)).error).toBeNull();

    await signIn(seedUser("adminA"), A);
    const before = await getReservationHistory(await requireOperatorContext("audit.read"), id);
    expect(before.map((entry) => [entry.action, entry.actor])).toEqual([
      ["updated", { kind: "system" }],
      ["created", { kind: "user", name: "Reservas Temporal" }],
    ]);

    // Deleting the user also nulls created_by (a system update of a hidden key only, so no entry).
    await deleteTestUser(admin, booker.id, booker.email);
    const after = await getReservationHistory(await requireOperatorContext("audit.read"), id);
    expect(after.map((entry) => [entry.action, entry.actor])).toEqual([
      ["updated", { kind: "system" }],
      ["created", { kind: "deleted_user" }],
    ]);
    expect(after[0].changes.map((change) => `${change.subject}.${change.field}`)).toEqual(["reservation.people", "amount.total_minor"]);
  });
});

describe("detail read and actions (U10, R11, R23, KTD9)", () => {
  const date = addDays(FUTURE, 8);
  let tour: string;
  let departure: string;
  let customer: string;

  beforeAll(async () => {
    tour = await fx.tour(A, { capacity: 4, price: 2000, name: "Detalle" });
    departure = await fx.departure(A, tour, { capacity: 4, date, startTime: "10:00" });
    customer = await fx.customer(A, { name: `Bruno ${fx.tag} Salas`, email: null, phone: "8888-0000" });
  });

  it("getReservation follows the role rules: full customer for reservas, masked customer, amount and notes for contabilidad, null for another operator", async () => {
    const id = await booked(await clientFor("reservasA"), {
      operator_id: A,
      departure_id: departure,
      customer_id: customer,
      people: 1,
      notes: "Llega tarde",
    });

    await signIn(seedUser("reservasA"), A);
    expect(await getReservation(await requireOperatorContext("reservations.read"), id)).toMatchObject({
      id,
      tourId: tour,
      departureId: departure,
      departureStatus: "scheduled",
      date,
      startTime: "10:00",
      tourName: `Detalle ${fx.tag}`,
      customerName: `Bruno ${fx.tag} Salas`,
      customerContact: { email: null, phone: "8888-0000" },
      amount: null,
      notes: "Llega tarde",
    });

    await signIn(seedUser("contabilidadA"), A);
    expect(await getReservation(await requireOperatorContext("reservations.read"), id)).toMatchObject({
      customerName: "Bruno S.",
      customerContact: null,
      amount: { totalMinor: 2000, currency: "USD", overridden: false },
      notes: "Llega tarde",
    });

    const tourB = await fx.tour(B, { currency: "MXN" });
    const foreign = await booked(await clientFor("reservasB"), {
      operator_id: B,
      departure_id: await fx.departure(B, tourB),
      customer_id: await fx.customer(B),
      people: 1,
    });
    expect(await getReservation(await requireOperatorContext("reservations.read"), foreign)).toBeNull();
    await expect(updateReservationAction(IDLE, form({ reservationId: id, date, slot: `departure:${departure}`, people: "2", notes: "" }))).resolves.toMatchObject({
      status: "error",
      error: "forbidden",
    });
  });

  it("edits people and notes, sends nothing when unchanged, and keeps the values on capacity and validation errors", async () => {
    await signIn(seedUser("reservasA"), A);
    const id = await booked(await clientFor("reservasA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 1 });
    const edit = (fields: Record<string, string>) =>
      updateReservationAction(IDLE, form({ reservationId: id, date, slot: `departure:${departure}`, people: "1", notes: "", ...fields }));

    expect(await edit({ people: "2", notes: "  Silla de ruedas " })).toEqual({ status: "ok", data: { changed: true } });
    expect((await reservationRow(id)).people).toBe(2);
    expect(await notesOf(id)).toBe("Silla de ruedas");

    const mark = await auditMark();
    expect(await edit({ people: "2", notes: "Silla de ruedas" })).toEqual({ status: "ok", data: { changed: false } });
    expect(await auditMark()).toBe(mark);

    expect(await edit({ people: "2", notes: "" })).toEqual({ status: "ok", data: { changed: true } });
    expect(await notesOf(id)).toBe("");
    expect(await edit({ people: "2", notes: "" })).toEqual({ status: "ok", data: { changed: false } });

    const seats = (await seatsOf(departure)).seats_booked;
    expect(await edit({ people: String(2 + 4 - seats + 1), notes: "Grupo" })).toMatchObject({
      status: "error",
      error: "capacity_exceeded",
      values: { people: String(2 + 4 - seats + 1), notes: "Grupo", slot: `departure:${departure}`, date },
    });
    expect(await edit({ people: "0", slot: "nope" })).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: { people: "validation.peopleInvalid", slot: "validation.slotRequired" },
      values: { people: "0", slot: "nope" },
    });
    expect((await reservationRow(id)).people).toBe(2);
    expect(await heldOn(departure)).toBe((await seatsOf(departure)).seats_booked);
  });

  it("moves to a schedule slot of the same tour (materialized) and refuses a departure of another tour", async () => {
    await signIn(seedUser("adminA"), A);
    const id = await booked(await clientFor("adminA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 1 });
    const weekday = 3;
    const slotDate = nextWeekday(addDays(date, 1), weekday);
    expect((await admin.from("tour_schedules").insert({ operator_id: A, tour_id: tour, weekday, start_time: "07:45", valid_from: FUTURE })).error).toBeNull();

    expect(await updateReservationAction(IDLE, form({ reservationId: id, date: slotDate, slot: "time:07:45", people: "1", notes: "" }))).toEqual({
      status: "ok",
      data: { changed: true },
    });
    const moved = await reservationRow(id);
    const { data: target } = await admin.from("tour_departures").select("tour_id, date, start_time, origin, seats_booked").eq("id", moved.departure_id).single();
    expect(target).toEqual({ tour_id: tour, date: slotDate, start_time: "07:45:00", origin: "schedule", seats_booked: 1 });

    const otherTour = await fx.tour(A, { name: "Otro" });
    const otherDeparture = await fx.departure(A, otherTour, { date });
    expect(
      await updateReservationAction(IDLE, form({ reservationId: id, date, slot: `departure:${otherDeparture}`, people: "1", notes: "" })),
    ).toMatchObject({ status: "error", error: "forbidden_transition" });
    expect((await reservationRow(id)).departure_id).toBe(moved.departure_id);
    expect(await reconcileSeats()).toEqual([]);
  });

  it("editing a cancelled reservation returns forbidden_transition; cancel without a reason returns the validation state; found-checks", async () => {
    await signIn(seedUser("reservasA"), A);
    const id = await booked(await clientFor("reservasA"), { operator_id: A, departure_id: departure, customer_id: customer, people: 1 });

    expect(await cancelReservationAction(IDLE, form({ reservationId: id, reason: "  " }))).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: { reason: "validation.reasonRequired" },
    });
    expect((await reservationRow(id)).status).toBe("confirmed");
    expect(await cancelReservationAction(IDLE, form({ reservationId: id, reason: "No viaja" }))).toEqual({ status: "ok" });

    const mark = await auditMark();
    for (const fields of [{ people: "2", notes: "" }, { people: "1", notes: "Nota tardía" }]) {
      expect(await updateReservationAction(IDLE, form({ reservationId: id, date, slot: `departure:${departure}`, ...fields }))).toEqual({
        status: "error",
        error: "forbidden_transition",
        values: { date, slot: `departure:${departure}`, ...fields },
      });
    }
    expect(await reservationRow(id)).toMatchObject({ status: "cancelled", people: 1 });
    expect(await notesOf(id)).toBeNull();
    expect(await auditMark()).toBe(mark);

    const unknown = "00000000-0000-4000-8000-000000000000";
    expect(await updateReservationAction(IDLE, form({ reservationId: unknown, date, slot: `departure:${departure}`, people: "1", notes: "" }))).toMatchObject({
      status: "error",
      error: "not_found",
    });
    expect(await updateReservationAction(IDLE, form({ reservationId: "nope", date, slot: `departure:${departure}`, people: "1", notes: "" }))).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: { reservationId: "validation.idInvalid" },
    });
    expect(await reconcileSeats()).toEqual([]);
  });
});
