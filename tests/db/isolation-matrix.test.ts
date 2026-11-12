// U8 cross-operator isolation matrix (plan U8 approach step 1; R2, R4, R30;
// AE2, AE3, AE11; KTD2). Table-driven: for every table in `public` and
// `audit` and every actor (a user of A, a user of A and B, an administrador
// of A) against every operator the actor does not belong to, through the Data
// API with the actor's own session:
// - select returns only rows of the actor's operators;
// - insert with a foreign `operator_id` fails with 42501;
// - insert with the actor's own `operator_id` and a foreign parent id fails
//   with a foreign-key violation (23503);
// - update and delete of a foreign row affect zero rows (or 42501 where the
//   table grants no update or delete), re-read with the secret key.
// `operators` and `profiles` carry no operator_id and get their own cells. A
// guard compares the matrix list with `information_schema.tables`, so a new
// table fails here until it is added. README, "Fail-ability check", shows how
// to watch this file fail.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FUTURE, BookingFixtures } from "./booking.ts";
import { OPERATORS, type MembershipRole, type SeedUserKey } from "./fixtures.ts";
import { adminClient, anonClient, clientFor, closeSql, createTestUser, deleteTestUser, sql, uniqueEmail, type Client } from "./helpers.ts";

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const C = OPERATORS.c.id;
const ALL = [A, B, C];
const NAMES: Record<string, string> = { [A]: "A", [B]: "B", [C]: "C" };

const admin = adminClient();
const fx = new BookingFixtures();

type Row = Record<string, unknown>;
type Users = { member: { id: string; email: string }; free: { id: string; email: string } };

/** One row in every table for one operator, created with the secret key. */
type Chain = {
  operatorId: string;
  tour: string;
  archivedTour: string;
  price: string;
  schedule: string;
  guide: string;
  inactiveGuide: string;
  departure: string;
  customer: string;
  reservation: string;
  /** A throwaway contabilidad member of this operator (membership and profile targets). */
  member: { id: string; email: string };
  membership: string;
  event: number;
};

type Actor = { key: SeedUserKey; label: string; role: MembershipRole; own: string[] };

const ACTORS: Actor[] = [
  { key: "reservasA", label: "a user of A (reservas)", role: "reservas", own: [A] },
  { key: "adminAB", label: "a user of A and B (administrador of both)", role: "administrador", own: [A, B] },
  { key: "adminA", label: "an administrador of A", role: "administrador", own: [A] },
];

/** Write cells expect zero rows when the table grants the operation, 42501 otherwise. */
type Grant = "granted" | "not granted";

type ParentCase = {
  label: string;
  row: (own: Chain, foreign: Chain) => Row;
  /** Roles that may insert such a row with their own parent; others may also get 42501. */
  roles: MembershipRole[];
};

type TableSpec = {
  schema: "public" | "audit";
  table: string;
  key: string;
  target: (chain: Chain) => string | number;
  /** Rows of the foreign operator (consistent parents); each must fail with 42501. */
  foreignInserts: (foreign: Chain, users: Users) => Row[];
  /** Own operator_id with a foreign parent; absent when the only parent is the operator. */
  parents?: ParentCase[];
  update: Row;
  updateGrant: Grant;
  deleteGrant: Grant;
};

const TABLES: TableSpec[] = [
  {
    schema: "public",
    table: "memberships",
    key: "id",
    target: (c) => c.membership,
    // A guía membership also proves the guide-link trigger answers 42501, not guide_not_linked.
    foreignInserts: (f, u) => [
      { user_id: u.free.id, operator_id: f.operatorId, role: "contabilidad" },
      { user_id: u.free.id, operator_id: f.operatorId, role: "guia" },
    ],
    update: { role: "administrador" },
    updateGrant: "granted",
    deleteGrant: "granted",
  },
  {
    schema: "public",
    table: "guides",
    key: "id",
    target: (c) => c.guide,
    foreignInserts: (f) => [{ operator_id: f.operatorId, name: "Intruso" }],
    update: { name: "Intruso" },
    updateGrant: "granted",
    deleteGrant: "not granted",
  },
  {
    schema: "public",
    table: "tours",
    key: "id",
    target: (c) => c.tour,
    foreignInserts: (f) => [{ operator_id: f.operatorId, name: "Intruso", duration_minutes: 60, default_capacity: 5 }],
    update: { name: "Intruso" },
    updateGrant: "granted",
    deleteGrant: "not granted",
  },
  {
    schema: "public",
    table: "tour_prices",
    key: "id",
    target: (c) => c.price,
    foreignInserts: (f) => [{ operator_id: f.operatorId, tour_id: f.tour, channel: "whatsapp", price_minor: 1, currency: "USD" }],
    parents: [
      {
        label: "tour",
        row: (o, f) => ({ operator_id: o.operatorId, tour_id: f.tour, channel: "whatsapp", price_minor: 1, currency: "USD" }),
        roles: ["administrador"],
      },
    ],
    update: { price_minor: 1 },
    updateGrant: "granted",
    deleteGrant: "not granted",
  },
  {
    schema: "public",
    table: "tour_schedules",
    key: "id",
    target: (c) => c.schedule,
    foreignInserts: (f) => [{ operator_id: f.operatorId, tour_id: f.tour, weekday: 1, start_time: "05:05", valid_from: FUTURE }],
    parents: [
      {
        label: "tour",
        row: (o, f) => ({ operator_id: o.operatorId, tour_id: f.tour, weekday: 1, start_time: "05:05", valid_from: FUTURE }),
        roles: ["administrador"],
      },
    ],
    update: { capacity_override: 3 },
    updateGrant: "granted",
    deleteGrant: "granted",
  },
  {
    schema: "public",
    table: "tour_departures",
    key: "id",
    target: (c) => c.departure,
    // The archived tour and the inactive guide prove the departure trigger answers 42501 first.
    foreignInserts: (f) => [
      { operator_id: f.operatorId, tour_id: f.tour, date: FUTURE, start_time: "05:05", capacity: 5 },
      { operator_id: f.operatorId, tour_id: f.archivedTour, date: FUTURE, start_time: "05:06", capacity: 5 },
      { operator_id: f.operatorId, tour_id: f.tour, date: FUTURE, start_time: "05:07", capacity: 5, guide_id: f.inactiveGuide },
    ],
    parents: [
      {
        label: "tour",
        row: (o, f) => ({ operator_id: o.operatorId, tour_id: f.tour, date: FUTURE, start_time: "05:05", capacity: 5 }),
        roles: ["administrador", "reservas"],
      },
      {
        label: "guide",
        row: (o, f) => ({ operator_id: o.operatorId, tour_id: o.tour, date: FUTURE, start_time: "05:05", capacity: 5, guide_id: f.guide }),
        roles: ["administrador"],
      },
    ],
    update: { capacity: 9 },
    updateGrant: "granted",
    deleteGrant: "not granted",
  },
  {
    schema: "public",
    table: "customers",
    key: "id",
    target: (c) => c.customer,
    foreignInserts: (f) => [{ operator_id: f.operatorId, name: "Intruso Prueba" }],
    update: { name: "Intruso Prueba" },
    updateGrant: "granted",
    deleteGrant: "not granted",
  },
  {
    schema: "public",
    table: "customer_display",
    key: "customer_id",
    target: (c) => c.customer,
    foreignInserts: (f) => [{ operator_id: f.operatorId, customer_id: f.customer, display_name: "Intruso P." }],
    parents: [
      {
        label: "customer",
        row: (o, f) => ({ operator_id: o.operatorId, customer_id: f.customer, display_name: "Intruso P." }),
        roles: [],
      },
    ],
    update: { display_name: "Intruso P." },
    updateGrant: "not granted",
    deleteGrant: "not granted",
  },
  {
    schema: "public",
    table: "reservations",
    key: "id",
    target: (c) => c.reservation,
    foreignInserts: (f) => [{ operator_id: f.operatorId, departure_id: f.departure, customer_id: f.customer, people: 1 }],
    parents: [
      {
        label: "departure",
        row: (o, f) => ({ operator_id: o.operatorId, departure_id: f.departure, customer_id: o.customer, people: 1 }),
        roles: ["administrador", "reservas"],
      },
      {
        label: "customer",
        row: (o, f) => ({ operator_id: o.operatorId, departure_id: o.departure, customer_id: f.customer, people: 1 }),
        roles: ["administrador", "reservas"],
      },
    ],
    update: { people: 2 },
    updateGrant: "granted",
    deleteGrant: "not granted",
  },
  {
    schema: "public",
    table: "reservation_notes",
    key: "reservation_id",
    target: (c) => c.reservation,
    foreignInserts: (f) => [{ operator_id: f.operatorId, reservation_id: f.reservation, notes: "Intruso" }],
    parents: [
      {
        label: "reservation",
        row: (o, f) => ({ operator_id: o.operatorId, reservation_id: f.reservation, notes: "Intruso" }),
        roles: ["administrador", "reservas"],
      },
    ],
    update: { notes: "Intruso" },
    updateGrant: "granted",
    deleteGrant: "not granted",
  },
  {
    schema: "public",
    table: "reservation_amounts",
    key: "reservation_id",
    target: (c) => c.reservation,
    foreignInserts: (f) => [{ operator_id: f.operatorId, reservation_id: f.reservation, unit_price_minor: 1, currency: "USD", total_minor: 1 }],
    parents: [
      {
        label: "reservation",
        row: (o, f) => ({ operator_id: o.operatorId, reservation_id: f.reservation, unit_price_minor: 1, currency: "USD", total_minor: 1 }),
        roles: [],
      },
    ],
    update: { total_minor: 1 },
    updateGrant: "granted",
    deleteGrant: "not granted",
  },
  {
    schema: "audit",
    table: "events",
    key: "id",
    target: (c) => c.event,
    foreignInserts: (f) => [{ operator_id: f.operatorId, table_name: "reservations", op: "insert", actor_source: "jwt" }],
    update: { op: "delete" },
    updateGrant: "not granted",
    deleteGrant: "not granted",
  },
];

/** Tables without operator_id, covered by their own cells below. */
const SPECIAL_TABLES = ["public.operators", "public.profiles"];

/** The matrix list: every table the guard expects in `public` and `audit`. */
const MATRIX_TABLES = [...TABLES.map((spec) => `${spec.schema}.${spec.table}`), ...SPECIAL_TABLES].sort();

// supabase-js types a table name statically; the matrix walks them dynamically.
function from(client: Client, schema: "public" | "audit", table: string) {
  return (client as unknown as SupabaseClient).schema(schema).from(table);
}

/** Pairs of (actor, operator the actor does not belong to). */
const PAIRS = ACTORS.flatMap((actor) => ALL.filter((id) => !actor.own.includes(id)).map((foreign) => ({ actor, foreign })));

const chains = new Map<string, Chain>();
const users: Partial<Users> = {};
const extraGuides: string[] = [];

function chain(operatorId: string): Chain {
  const value = chains.get(operatorId);
  if (!value) throw new Error(`no fixture chain for ${operatorId}`);
  return value;
}

/** The data of a request that must succeed (the caller names its shape). */
async function must<T = Row>(request: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await request;
  if (error) throw error;
  return data as T;
}

/** The id of the one row a request returns. */
async function idOf<T extends string | number = string>(request: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  return (await must<{ id: T }>(request)).id;
}

async function buildChain(operatorId: string): Promise<Chain> {
  const currency = operatorId === B ? "MXN" : operatorId === C ? "EUR" : "USD";
  const tour = await fx.tour(operatorId, { name: "Matriz", currency });
  const archivedTour = await fx.tour(operatorId, { name: "Matriz archivado", currency, price: null });
  await must(admin.from("tours").update({ archived_at: new Date().toISOString() }).eq("id", archivedTour).select("id"));
  const price = await idOf(admin.from("tour_prices").select("id").eq("tour_id", tour).single());
  const schedule = await idOf(
    admin
      .from("tour_schedules")
      .insert({ operator_id: operatorId, tour_id: tour, weekday: 3, start_time: "05:30", valid_from: FUTURE })
      .select("id")
      .single(),
  );
  const guide = await idOf(admin.from("guides").insert({ operator_id: operatorId, name: `Guía matriz ${fx.tag}` }).select("id").single());
  const inactiveGuide = await idOf(
    admin.from("guides").insert({ operator_id: operatorId, name: `Guía inactivo ${fx.tag}`, active: false }).select("id").single(),
  );
  extraGuides.push(guide, inactiveGuide);
  const departure = await fx.departure(operatorId, tour, { guideId: guide });
  const customer = await fx.customer(operatorId, { name: `Cliente ${fx.tag} Matriz` });
  const reservation = await idOf(
    admin
      .from("reservations")
      .insert({ operator_id: operatorId, departure_id: departure, customer_id: customer, people: 1 } as never)
      .select("id")
      .single(),
  );
  await must(admin.from("reservation_notes").insert({ operator_id: operatorId, reservation_id: reservation, notes: "Nota de la matriz" }).select("reservation_id"));
  const event = await idOf<number>(
    admin.schema("audit").from("events").select("id").eq("table_name", "reservations").eq("record_id", reservation).eq("op", "insert").single(),
  );
  const member = await createTestUser(admin, {
    email: uniqueEmail(`matrix-${NAMES[operatorId].toLowerCase()}`),
    memberships: [{ operatorId, role: "contabilidad" }],
  });
  const membership = await idOf(admin.from("memberships").select("id").eq("user_id", member.id).eq("operator_id", operatorId).single());
  return { operatorId, tour, archivedTour, price, schedule, guide, inactiveGuide, departure, customer, reservation, member, membership, event };
}

/** The target row of every table in a chain, read with the secret key. */
async function snapshot(target: Chain): Promise<Record<string, Row>> {
  const rows: Record<string, Row> = {};
  for (const spec of TABLES) {
    rows[`${spec.schema}.${spec.table}`] = await must(from(admin, spec.schema, spec.table).select("*").eq(spec.key, spec.target(target)).single());
  }
  rows["public.operators"] = await must(admin.from("operators").select("*").eq("id", target.operatorId).single());
  rows["public.profiles"] = await must(admin.from("profiles").select("*").eq("id", target.member.id).single());
  return rows;
}

/** Row counts per table for one operator, read with the secret key (a refused insert leaves no row). */
async function counts(operatorId: string): Promise<Record<string, number | null>> {
  const result: Record<string, number | null> = {};
  for (const spec of TABLES) {
    const { count, error } = await from(admin, spec.schema, spec.table).select("*", { count: "exact", head: true }).eq("operator_id", operatorId);
    if (error) throw error;
    result[`${spec.schema}.${spec.table}`] = count;
  }
  return result;
}

const before = new Map<string, { rows: Record<string, Row>; counts: Record<string, number | null> }>();

beforeAll(async () => {
  for (const id of ALL) chains.set(id, await buildChain(id));
  users.free = await createTestUser(admin, { email: uniqueEmail("matrix-free") });
  for (const id of ALL) before.set(id, { rows: await snapshot(chain(id)), counts: await counts(id) });
}, 120_000);

afterAll(async () => {
  for (const target of chains.values()) await deleteTestUser(admin, target.member.id, target.member.email);
  if (users.free) await deleteTestUser(admin, users.free.id, users.free.email);
  await fx.cleanup();
  if (extraGuides.length) await must(admin.from("guides").delete().in("id", extraGuides).select("id"));
  await closeSql();
}, 120_000);

type ApiResult = { data: unknown; error: { code?: string; message: string } | null };

function expectCode(result: ApiResult, codes: string[], context: string): void {
  expect(result.error, `${context}: expected ${codes.join(" or ")}, got a success with ${JSON.stringify(result.data)}`).not.toBeNull();
  expect(codes, `${context}: got ${result.error?.code} ${result.error?.message}`).toContain(result.error?.code);
}

function expectNoRows(result: ApiResult, context: string): void {
  expect(result.error, `${context}: unexpected error ${result.error?.code} ${result.error?.message}`).toBeNull();
  expect(result.data, context).toEqual([]);
}

describe("guard: the matrix covers every table in public and audit", () => {
  it("lists exactly the tables of information_schema.tables", async () => {
    const rows = await sql()`
      select table_schema || '.' || table_name as name
      from information_schema.tables
      where table_schema in ('public', 'audit')
      order by 1`;
    expect(rows.map((row) => row.name as string)).toEqual(MATRIX_TABLES);
  });
});

for (const { actor, foreign: foreignId } of PAIRS) {
  describe(`${actor.label} against operator ${NAMES[foreignId]}`, () => {
    let client: Client;
    const own = () => chain(A);
    const foreign = () => chain(foreignId);
    const ownList = `(${actor.own.join(",")})`;

    beforeAll(async () => {
      client = await clientFor(actor.key);
    });

    for (const spec of TABLES) {
      const name = `${spec.schema}.${spec.table}`;
      describe(name, () => {
        const unchanged = async () => {
          const row = await must(from(admin, spec.schema, spec.table).select("*").eq(spec.key, spec.target(foreign())).single());
          expect(row, `${name} foreign row changed`).toEqual(before.get(foreignId)?.rows[name]);
        };

        it("select returns only rows of the actor's operators", async () => {
          expectNoRows(await from(client, spec.schema, spec.table).select("operator_id").not("operator_id", "in", ownList), `${name} scan`);
          expectNoRows(await from(client, spec.schema, spec.table).select(spec.key).eq(spec.key, spec.target(foreign())), `${name} by id`);
          if (actor.role === "administrador") {
            // An administrador reads every table of their operator: the scan above is not vacuous.
            const mine = await from(client, spec.schema, spec.table).select(spec.key).eq(spec.key, spec.target(own()));
            expect(mine.data, `${name} own row`).toHaveLength(1);
          }
        });

        it("insert with a foreign operator_id fails with 42501", async () => {
          for (const row of spec.foreignInserts(foreign(), users as Users)) {
            expectCode(await from(client, spec.schema, spec.table).insert(row).select(), ["42501"], `${name} insert ${JSON.stringify(row)}`);
          }
        });

        for (const parent of spec.parents ?? []) {
          it(`insert with the own operator_id and a foreign ${parent.label} fails with a foreign-key violation`, async () => {
            const codes = parent.roles.includes(actor.role) ? ["23503"] : ["23503", "42501"];
            expectCode(await from(client, spec.schema, spec.table).insert(parent.row(own(), foreign())).select(), codes, `${name} foreign ${parent.label}`);
            await unchanged();
          });
        }

        it(`update of a foreign row ${spec.updateGrant === "granted" ? "affects zero rows" : "fails with 42501 (no update grant)"}`, async () => {
          const result = await from(client, spec.schema, spec.table).update(spec.update).eq(spec.key, spec.target(foreign())).select(spec.key);
          if (spec.updateGrant === "granted") expectNoRows(result, `${name} update`);
          else expectCode(result, ["42501"], `${name} update`);
          await unchanged();
        });

        it(`delete of a foreign row ${spec.deleteGrant === "granted" ? "affects zero rows" : "fails with 42501 (no delete grant)"}`, async () => {
          const result = await from(client, spec.schema, spec.table).delete().eq(spec.key, spec.target(foreign())).select(spec.key);
          if (spec.deleteGrant === "granted") expectNoRows(result, `${name} delete`);
          else expectCode(result, ["42501"], `${name} delete`);
          await unchanged();
        });
      });
    }

    describe("public.operators (no operator_id: visible only through memberships)", () => {
      it("select returns exactly the actor's operators", async () => {
        const { data, error } = await client.from("operators").select("id");
        expect(error).toBeNull();
        expect(data?.map((row) => row.id).sort()).toEqual([...actor.own].sort());
      });

      it("insert fails with 42501 (no insert grant)", async () => {
        expectCode(
          await client.from("operators").insert({ name: "Intruso", slug: `intruso-${fx.tag}`, timezone: "America/Costa_Rica", currency: "USD" }).select(),
          ["42501"],
          "operators insert",
        );
      });

      it("update of the foreign operator affects zero rows; delete fails with 42501", async () => {
        expectNoRows(await client.from("operators").update({ name: "Intruso" }).eq("id", foreignId).select("id"), "operators update");
        expectCode(await client.from("operators").delete().eq("id", foreignId).select("id"), ["42501"], "operators delete");
        expect(await must(admin.from("operators").select("*").eq("id", foreignId).single())).toEqual(before.get(foreignId)?.rows["public.operators"]);
      });

      it("columns outside name, timezone and locale are not updatable, even on the actor's own operator", async () => {
        for (const update of [{ slug: "intruso" }, { currency: "EUR" }, { status: "inactive" }, { id: foreignId }]) {
          expectCode(await client.from("operators").update(update as never).eq("id", A).select("id"), ["42501"], `operators update ${JSON.stringify(update)}`);
        }
        expect(await must(admin.from("operators").select("*").eq("id", A).single())).toEqual(before.get(A)?.rows["public.operators"]);
      });
    });

    describe("public.profiles (no operator_id: KTD6 policy)", () => {
      it("the profile of a member of only the foreign operator is invisible; the actor's own profile is visible", async () => {
        expectNoRows(await client.from("profiles").select("id").eq("id", foreign().member.id), "foreign profile");
        const self = await client.from("profiles").select("id");
        expect(self.error).toBeNull();
        expect(self.data?.map((row) => row.id)).toContain((await client.auth.getUser()).data.user?.id);
      });

      it("insert, update and delete fail with 42501 (select is the only grant)", async () => {
        const memberId = foreign().member.id;
        expectCode(await client.from("profiles").insert({ id: memberId, email: "intruso@cupo.test" } as never).select(), ["42501"], "profiles insert");
        expectCode(await client.from("profiles").update({ full_name: "Intruso" } as never).eq("id", memberId).select("id"), ["42501"], "profiles update");
        expectCode(await client.from("profiles").delete().eq("id", memberId).select("id"), ["42501"], "profiles delete");
        expect(await must(admin.from("profiles").select("*").eq("id", memberId).single())).toEqual(before.get(foreignId)?.rows["public.profiles"]);
      });
    });

    it(`leaves every row and row count of operator ${NAMES[foreignId]} unchanged`, async () => {
      expect(await snapshot(foreign())).toEqual(before.get(foreignId)?.rows);
      expect(await counts(foreignId)).toEqual(before.get(foreignId)?.counts);
    });
  });
}

describe("anon", () => {
  it("can neither read nor write any table", async () => {
    const anon = anonClient();
    for (const spec of TABLES) {
      const name = `${spec.schema}.${spec.table}`;
      expectCode(await from(anon, spec.schema, spec.table).select(spec.key).limit(1), ["42501"], `${name} anon select`);
      expectCode(await from(anon, spec.schema, spec.table).insert(spec.foreignInserts(chain(A), users as Users)[0]).select(), ["42501"], `${name} anon insert`);
    }
    for (const table of ["operators", "profiles"]) {
      expectCode(await from(anon, "public", table).select("id").limit(1), ["42501"], `${table} anon select`);
    }
  });
});
