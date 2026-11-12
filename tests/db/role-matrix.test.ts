// U8 role and RPC matrices (plan U8 approach step 2; R10, R11, R20, R29, R30;
// AE4, AE5; KTD4, KTD5, KTD6, KTD13). Through the Data API with each caller's
// own session:
// - visibility: for every role of operator A, which fixture rows of A each
//   table returns (prices and amounts for administrador and contabilidad,
//   full customers for administrador and reservas, masked names for the rest,
//   notes for staff, the history for administradores, and the guía's scope);
// - RPCs: every public function × caller (the four roles of A, anon and the
//   secret key). A caller outside the allowed set gets `forbidden` (42501,
//   mapped by lib/result.ts) and nothing changes: never a success and never
//   an empty update. A guard compares the RPC list with `pg_proc`.
// - another operator's ids: `cancel_departure`, `update_reservation` and
//   `create_reservation` answer `not_found` and the foreign rows stay as they
//   were.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FUTURE, BookingFixtures, reservationRow, seatsOf } from "./booking.ts";
import { GUIDES, OPERATORS, type SeedUserKey } from "./fixtures.ts";
import { adminClient, anonClient, clientFor, closeSql, createTestUser, deleteTestUser, seedUser, sql, uniqueEmail, type Client } from "./helpers.ts";

vi.mock("server-only", () => ({}));

const { errorState } = await import("../../apps/web/src/lib/result.ts");

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const C = OPERATORS.c.id;
const admin = adminClient();
const fx = new BookingFixtures();

type Role = "administrador" | "reservas" | "contabilidad" | "guia";
type Caller = Role | "anon" | "service_role";

const ROLE_USERS: Record<Role, SeedUserKey> = {
  administrador: "adminA",
  reservas: "reservasA",
  contabilidad: "contabilidadA",
  guia: "guiaA",
};
const ROLES = Object.keys(ROLE_USERS) as Role[];
const CALLERS: Caller[] = [...ROLES, "anon", "service_role"];

async function callerClient(caller: Caller): Promise<Client> {
  if (caller === "anon") return anonClient();
  if (caller === "service_role") return admin;
  return clientFor(ROLE_USERS[caller]);
}

// supabase-js types table and function names statically; the matrices walk them dynamically.
function from(client: Client, schema: "public" | "audit", table: string) {
  return (client as unknown as SupabaseClient).schema(schema).from(table);
}

function rpc(client: Client, name: string, args: Record<string, unknown>) {
  return (client as unknown as SupabaseClient).rpc(name, args);
}

async function must<T = Record<string, unknown>>(request: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await request;
  if (error) throw error;
  return data as T;
}

/** Operator A rows every role is checked against, plus a departure of the other guide (a2). */
type Fixture = {
  tour: string;
  price: string;
  schedule: string;
  departure: string;
  otherDeparture: string;
  customer: string;
  otherCustomer: string;
  reservation: string;
  otherReservation: string;
  event: number;
  customerName: string;
};

let f: Fixture;
const throwaway: Array<{ id: string; email: string }> = [];
const operatorsToDrop: string[] = [];

async function insertReservation(operatorId: string, departureId: string, customerId: string): Promise<string> {
  return (
    await must<{ id: string }>(
      admin
        .from("reservations")
        .insert({ operator_id: operatorId, departure_id: departureId, customer_id: customerId, people: 1 } as never)
        .select("id")
        .single(),
    )
  ).id;
}

beforeAll(async () => {
  const tour = await fx.tour(A, { name: "Roles" });
  const price = (await must<{ id: string }>(admin.from("tour_prices").select("id").eq("tour_id", tour).single())).id;
  const schedule = (
    await must<{ id: string }>(
      admin.from("tour_schedules").insert({ operator_id: A, tour_id: tour, weekday: 4, start_time: "05:45", valid_from: FUTURE }).select("id").single(),
    )
  ).id;
  const departure = await fx.departure(A, tour, { guideId: GUIDES.a1.id });
  const otherDeparture = await fx.departure(A, tour, { guideId: GUIDES.a2.id });
  const customerName = `Ana${fx.tag} Pérez`;
  const customer = await fx.customer(A, { name: customerName, phone: "8888-1111" });
  const otherCustomer = await fx.customer(A, { name: `Otro${fx.tag} Cliente` });
  const reservation = await insertReservation(A, departure, customer);
  const otherReservation = await insertReservation(A, otherDeparture, otherCustomer);
  await must(admin.from("reservation_notes").insert({ operator_id: A, reservation_id: reservation, notes: "Nota de roles" }).select("reservation_id"));
  const event = (
    await must<{ id: number }>(
      admin.schema("audit").from("events").select("id").eq("table_name", "reservations").eq("record_id", reservation).eq("op", "insert").single(),
    )
  ).id;
  f = { tour, price, schedule, departure, otherDeparture, customer, otherCustomer, reservation, otherReservation, event, customerName };
}, 60_000);

afterAll(async () => {
  // The bootstrapped operator first: its administrador is a throwaway user, and an
  // active operator keeps its last administrador (R12).
  for (const id of operatorsToDrop) {
    await admin.from("operators").update({ status: "inactive" }).eq("id", id);
    await admin.from("memberships").delete().eq("operator_id", id);
    await admin.from("operators").delete().eq("id", id);
  }
  for (const user of throwaway) await deleteTestUser(admin, user.id, user.email);
  await fx.cleanup();
  await closeSql();
}, 60_000);

// ============================================================================
// visibility (R11, R20, R29; KTD4, KTD13)
// ============================================================================

type VisibilityCase = {
  schema: "public" | "audit";
  table: string;
  key: string;
  row: () => string | number;
  label: string;
  /** Roles of A that read the row; every other role reads zero rows, without an error. */
  readers: Role[];
};

const STAFF: Role[] = ["administrador", "reservas", "contabilidad"];

const VISIBILITY: VisibilityCase[] = [
  { schema: "public", table: "operators", key: "id", row: () => A, label: "operator A", readers: ROLES },
  { schema: "public", table: "tours", key: "id", row: () => f.tour, label: "a tour with a departure of the guía", readers: ROLES },
  { schema: "public", table: "tour_prices", key: "id", row: () => f.price, label: "its price (R11)", readers: ["administrador", "contabilidad"] },
  { schema: "public", table: "tour_schedules", key: "id", row: () => f.schedule, label: "its schedule", readers: STAFF },
  { schema: "public", table: "tour_departures", key: "id", row: () => f.departure, label: "a future departure of the guía (R20)", readers: ROLES },
  { schema: "public", table: "tour_departures", key: "id", row: () => f.otherDeparture, label: "a departure of another guide", readers: STAFF },
  { schema: "public", table: "guides", key: "id", row: () => GUIDES.a1.id, label: "the guía's own guide", readers: ROLES },
  { schema: "public", table: "guides", key: "id", row: () => GUIDES.a2.id, label: "another guide", readers: STAFF },
  { schema: "public", table: "customers", key: "id", row: () => f.customer, label: "a customer (full data, R11)", readers: ["administrador", "reservas"] },
  { schema: "public", table: "customer_display", key: "customer_id", row: () => f.customer, label: "the masked name of a customer of the guía", readers: ROLES },
  { schema: "public", table: "customer_display", key: "customer_id", row: () => f.otherCustomer, label: "the masked name of another guide's customer", readers: STAFF },
  { schema: "public", table: "reservations", key: "id", row: () => f.reservation, label: "a reservation of the guía", readers: ROLES },
  { schema: "public", table: "reservations", key: "id", row: () => f.otherReservation, label: "a reservation of another guide", readers: STAFF },
  { schema: "public", table: "reservation_notes", key: "reservation_id", row: () => f.reservation, label: "its notes (R11)", readers: STAFF },
  { schema: "public", table: "reservation_amounts", key: "reservation_id", row: () => f.reservation, label: "its amount (R11)", readers: ["administrador", "contabilidad"] },
  { schema: "audit", table: "events", key: "id", row: () => f.event, label: "its history (R29)", readers: ["administrador"] },
  { schema: "public", table: "memberships", key: "user_id", row: () => seedUser("reservasA").id, label: "the reservas membership", readers: ["administrador", "reservas"] },
  { schema: "public", table: "profiles", key: "id", row: () => seedUser("reservasA").id, label: "the reservas profile (KTD6)", readers: STAFF },
];

describe("visibility by role of operator A (R11)", () => {
  for (const role of ROLES) {
    describe(role, () => {
      for (const visibility of VISIBILITY) {
        const reads = visibility.readers.includes(role);
        it(`${reads ? "reads" : "does not read"} ${visibility.schema}.${visibility.table}: ${visibility.label}`, async () => {
          const client = await clientFor(ROLE_USERS[role]);
          const { data, error } = await from(client, visibility.schema, visibility.table).select(visibility.key).eq(visibility.key, visibility.row());
          expect(error).toBeNull();
          expect(data).toHaveLength(reads ? 1 : 0);
        });
      }
    });
  }

  it("roles without full customer access read the masked name only (AE5): first name plus last initial, no contact", async () => {
    const masked = `Ana${fx.tag} P.`;
    for (const role of ["contabilidad", "guia"] as const) {
      const client = await clientFor(ROLE_USERS[role]);
      expect((await client.from("customer_display").select("display_name").eq("customer_id", f.customer)).data).toEqual([{ display_name: masked }]);
      expect((await client.from("customers").select("name, email, phone").eq("id", f.customer)).data).toEqual([]);
    }
    expect((await (await clientFor("reservasA")).from("customers").select("name, phone").eq("id", f.customer)).data).toEqual([
      { name: f.customerName, phone: "8888-1111" },
    ]);
  });

  it("every membership and profile a non-administrador reads is their own (or, for staff, a member of their operator)", async () => {
    for (const role of ["reservas", "contabilidad", "guia"] as const) {
      const user = seedUser(ROLE_USERS[role]);
      const client = await clientFor(ROLE_USERS[role]);
      expect((await client.from("memberships").select("user_id")).data).toEqual([{ user_id: user.id }]);
    }
    const guia = await clientFor("guiaA");
    expect((await guia.from("profiles").select("id")).data).toEqual([{ id: seedUser("guiaA").id }]);
  });
});

// ============================================================================
// rpc × caller (R10; KTD5, KTD6)
// ============================================================================

type RpcCell = {
  /** Calls the function as `client`; `caller` lets a cell pick per-caller arguments. */
  call: (client: Client, caller: Caller) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
  /** What the call must not have changed when it was refused. */
  state: () => Promise<unknown>;
  /** Runs after an allowed call succeeded. */
  verify: (data: unknown, caller: Caller) => Promise<void>;
};

type RpcSpec = { name: string; allowed: Caller[]; cell: () => RpcCell };

let freeUser: { id: string; email: string };
let freeGuide: string;
let cancelTargets: Partial<Record<Caller, string>> = {};

const RPCS: RpcSpec[] = [
  {
    name: "create_reservation",
    allowed: ["administrador", "reservas"],
    cell: () => ({
      call: (client) => rpc(client, "create_reservation", { operator_id: A, departure_id: f.departure, customer_id: f.customer, people: 1 }),
      state: async () => [(await seatsOf(f.departure)).seats_booked, (await must<unknown[]>(admin.from("reservations").select("id").eq("departure_id", f.departure))).length],
      verify: async (data) => {
        const [row] = data as Array<{ id: string; code: string }>;
        expect(row.code).toMatch(/^D-\d{6}$/);
        expect((await reservationRow(row.id)).departure_id).toBe(f.departure);
      },
    }),
  },
  {
    name: "update_reservation",
    allowed: ["administrador", "reservas"],
    cell: () => ({
      call: (client, caller) => rpc(client, "update_reservation", { reservation_id: f.reservation, people: caller === "administrador" ? 2 : 3 }),
      state: async () => [(await reservationRow(f.reservation)).people, (await seatsOf(f.departure)).seats_booked],
      verify: async (_data, caller) => expect((await reservationRow(f.reservation)).people).toBe(caller === "administrador" ? 2 : 3),
    }),
  },
  {
    name: "cancel_departure",
    allowed: ["administrador"],
    cell: () => ({
      // Refused callers aim at the guía's departure (which the guía can see, so the role check answers).
      call: (client, caller) => rpc(client, "cancel_departure", { departure_id: cancelTargets[caller] ?? f.departure }),
      state: async () => (await seatsOf(f.departure)).status,
      verify: async (_data, caller) => expect((await seatsOf(cancelTargets[caller] ?? "")).status).toBe("cancelled"),
    }),
  },
  {
    name: "admin_seat_drift",
    allowed: ["service_role"],
    cell: () => ({
      call: (client) => rpc(client, "admin_seat_drift", {}),
      state: async () => null,
      verify: async (data) => expect(data).toEqual([]),
    }),
  },
  {
    name: "admin_reconcile_seats",
    allowed: ["service_role"],
    cell: () => ({
      call: (client) => rpc(client, "admin_reconcile_seats", { actor_id: seedUser("adminA").id }),
      state: async () => (await seatsOf(f.departure)).seats_booked,
      verify: async (data) => expect(data).toBe(0),
    }),
  },
  {
    name: "admin_bootstrap_operator",
    allowed: ["service_role"],
    cell: () => ({
      call: (client) =>
        rpc(client, "admin_bootstrap_operator", {
          actor_id: null,
          name: `Matriz ${fx.tag}`,
          slug: `matriz-${fx.tag}`,
          timezone: "America/Costa_Rica",
          currency: "USD",
          locale: "es",
          admin_user_id: freeUser.id,
        }),
      state: async () => must(admin.from("operators").select("id").eq("slug", `matriz-${fx.tag}`)),
      verify: async (data) => {
        operatorsToDrop.push(data as string);
        expect(await must(admin.from("memberships").select("role").eq("operator_id", data as string).eq("user_id", freeUser.id))).toEqual([
          { role: "administrador" },
        ]);
      },
    }),
  },
  {
    name: "admin_seed_membership",
    allowed: ["service_role"],
    cell: () => ({
      call: (client) => rpc(client, "admin_seed_membership", { actor_id: null, user_id: freeUser.id, operator_id: C, role: "contabilidad" }),
      state: async () => must(admin.from("memberships").select("role").eq("user_id", freeUser.id).eq("operator_id", C)),
      verify: async () =>
        expect(await must(admin.from("memberships").select("role").eq("user_id", freeUser.id).eq("operator_id", C))).toEqual([{ role: "contabilidad" }]),
    }),
  },
  {
    name: "admin_seed_guide_user",
    allowed: ["service_role"],
    cell: () => ({
      call: (client) => rpc(client, "admin_seed_guide_user", { actor_id: null, guide_id: freeGuide, user_id: freeUser.id }),
      state: async () => must(admin.from("guides").select("user_id").eq("id", freeGuide).single()),
      verify: async () => expect(await must(admin.from("guides").select("user_id").eq("id", freeGuide).single())).toEqual({ user_id: freeUser.id }),
    }),
  },
];

describe("rpc × caller matrix (R10)", () => {
  beforeAll(async () => {
    freeUser = await createTestUser(admin, { email: uniqueEmail("matrix-rpc") });
    throwaway.push(freeUser);
    freeGuide = (await must<{ id: string }>(admin.from("guides").insert({ operator_id: C, name: `Guía rpc ${fx.tag}` }).select("id").single())).id;
    cancelTargets = { administrador: await fx.departure(A, f.tour, { guideId: GUIDES.a1.id }) };
  });

  afterAll(async () => {
    await admin.from("guides").update({ user_id: null }).eq("id", freeGuide);
    await admin.from("memberships").delete().eq("user_id", freeUser.id).eq("operator_id", C);
    await admin.from("guides").delete().eq("id", freeGuide);
  });

  it("guard: the matrix lists every function in public", async () => {
    const rows = await sql()`
      select p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'audit')
      order by 1`;
    expect(rows.map((row) => row.name as string)).toEqual(RPCS.map((spec) => spec.name).sort());
  });

  for (const spec of RPCS) {
    describe(spec.name, () => {
      // Refused callers first, so their "nothing changed" check sees the fixture as it was.
      const ordered = [...CALLERS].sort((a, b) => Number(spec.allowed.includes(a)) - Number(spec.allowed.includes(b)));
      for (const caller of ordered) {
        const allowed = spec.allowed.includes(caller);
        it(`${caller}: ${allowed ? "succeeds" : "forbidden, nothing changes"}`, async () => {
          const cell = spec.cell();
          const client = await callerClient(caller);
          const before = await cell.state();
          const { data, error } = await cell.call(client, caller);
          if (allowed) {
            expect(error, `${spec.name} as ${caller}: ${error?.code} ${error?.message}`).toBeNull();
            await cell.verify(data, caller);
          } else {
            expect(error, `${spec.name} as ${caller} must be refused, got ${JSON.stringify(data)}`).not.toBeNull();
            expect(error?.code, `${spec.name} as ${caller}: ${error?.message}`).toBe("42501");
            expect(errorState(error)).toEqual({ status: "error", error: "forbidden" });
            expect(await cell.state()).toEqual(before);
          }
        });
      }
    });
  }
});

// ============================================================================
// another operator's ids (R30; KTD5 found-checks)
// ============================================================================

describe("rpcs with another operator's ids answer not_found and change nothing", () => {
  const foreign: Record<string, { departure: string; customer: string; reservation: string }> = {};

  beforeAll(async () => {
    for (const operatorId of [B, C]) {
      const tour = await fx.tour(operatorId, { name: "Ajeno", currency: operatorId === B ? "MXN" : "EUR" });
      const departure = await fx.departure(operatorId, tour);
      const customer = await fx.customer(operatorId);
      foreign[operatorId] = { departure, customer, reservation: await insertReservation(operatorId, departure, customer) };
    }
  });

  const cases: Array<{ user: SeedUserKey; operatorId: string; label: string }> = [
    { user: "adminA", operatorId: B, label: "an administrador of A with B's ids" },
    { user: "reservasA", operatorId: B, label: "a reservas of A with B's ids" },
    { user: "adminAB", operatorId: C, label: "an administrador of A and B with C's ids" },
  ];

  for (const { user, operatorId, label } of cases) {
    it(label, async () => {
      const client = await clientFor(user);
      const target = foreign[operatorId];
      const departureBefore = await seatsOf(target.departure);
      const reservationBefore = await reservationRow(target.reservation);

      const notFound = (result: { error: { code?: string; message: string } | null }, what: string) => {
        expect(result.error, `${what} must fail`).not.toBeNull();
        expect(`${result.error?.code} ${result.error?.message}`, what).toBe("P0001 not_found");
        expect(errorState(result.error)).toEqual({ status: "error", error: "not_found" });
      };
      notFound(await rpc(client, "cancel_departure", { departure_id: target.departure }), "cancel_departure");
      notFound(await rpc(client, "update_reservation", { reservation_id: target.reservation, people: 2 }), "update_reservation");
      notFound(
        await rpc(client, "create_reservation", { operator_id: A, departure_id: target.departure, customer_id: f.customer, people: 1 }),
        "create_reservation with a foreign departure",
      );
      notFound(
        await rpc(client, "create_reservation", { operator_id: A, departure_id: f.departure, customer_id: target.customer, people: 1 }),
        "create_reservation with a foreign customer",
      );
      // Naming the foreign operator itself is the role check's 42501.
      const asForeign = await rpc(client, "create_reservation", { operator_id: operatorId, departure_id: target.departure, customer_id: target.customer, people: 1 });
      expect(asForeign.error?.code).toBe("42501");

      expect(await seatsOf(target.departure)).toEqual(departureBefore);
      expect(await reservationRow(target.reservation)).toEqual(reservationBefore);
    });
  }
});
