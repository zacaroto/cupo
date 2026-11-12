// U9 customers: role-gated personal data, the masked display table, per-
// operator email uniqueness, and the DAL and server actions against the local
// stack (plan U9 test scenarios and verification; R11, R26, R27; KTD2, KTD4,
// KTD6).
//
// Every customer created here carries a random tag in its name and email, so
// assertions never depend on rows other suites leave behind, and afterAll
// removes them with the secret key (authenticated has no delete grant).
//
// The DAL and action half uses the U3 harness shape: the real server actions,
// DAL and @supabase/ssr server client run here; `next/headers` is an
// in-memory cookie jar, `server-only` an empty module and `next/cache` a stub
// (refresh() needs a live action scope).
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATORS, type SeedUserKey } from "./fixtures.ts";
import {
  adminClient,
  clientFor,
  closeSql,
  expectSqlState,
  expectZeroRows,
  seedUser,
  sql,
  type Client,
} from "./helpers.ts";

type StoredCookie = { name: string; value: string; options: Record<string, unknown> };

/** A browser's cookie jar with the surface of Next's `cookies()` store. */
class CookieJar {
  readonly cookies = new Map<string, StoredCookie>();

  get(name: string) {
    const cookie = this.cookies.get(name);
    return cookie ? { name, value: cookie.value } : undefined;
  }

  getAll() {
    return [...this.cookies.values()].map(({ name, value }) => ({ name, value }));
  }

  has(name: string) {
    return this.cookies.has(name);
  }

  set(nameOrCookie: string | ({ name: string; value: string } & Record<string, unknown>), value?: string, options: Record<string, unknown> = {}) {
    const cookie =
      typeof nameOrCookie === "string"
        ? { name: nameOrCookie, value: value ?? "", options }
        : { name: nameOrCookie.name, value: nameOrCookie.value, options: nameOrCookie };
    if (cookie.value === "" || cookie.options.maxAge === 0) {
      this.cookies.delete(cookie.name);
    } else {
      this.cookies.set(cookie.name, cookie);
    }
    return this;
  }

  delete(name: string) {
    this.cookies.delete(name);
    return this;
  }
}

let jar = new CookieJar();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => jar,
  headers: async () => new Headers({ origin: "http://localhost:3000", host: "localhost:3000" }),
}));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

const { createCustomerAction, updateCustomerAction } = await import(
  "../../apps/web/src/app/[locale]/(app)/customers/actions.ts"
);
const { getCustomer, getCustomerDisplays, listCustomers } = await import("../../apps/web/src/lib/dal/customers.ts");
const { requireOperatorContext } = await import("../../apps/web/src/lib/dal/context.ts");
const { NotFoundError } = await import("../../apps/web/src/lib/dal/errors.ts");
const { createClient: createServerClient } = await import("../../apps/web/src/lib/supabase/server.ts");

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const admin: Client = adminClient();

/** Random lowercase tag shared by every row this file creates. */
const tag = `u9${randomBytes(4).toString("hex")}`;

type Fixture = { id: string; name: string; email: string | null; phone: string | null };

let anaA: Fixture;
let pedroA: Fixture;
let onlyNameA: Fixture;
let customerB: Fixture;

async function adminInsert(row: { operator_id: string; name: string; email?: string | null; phone?: string | null }): Promise<Fixture> {
  const { data, error } = await admin.from("customers").insert(row).select("id, name, email, phone").single();
  if (error) throw new Error(`customer insert failed: ${error.message}`);
  return data;
}

async function adminRead(id: string) {
  const { data, error } = await admin.from("customers").select("id, operator_id, name, email, phone").eq("id", id).maybeSingle();
  if (error) throw new Error(`customer read failed: ${error.message}`);
  return data;
}

beforeAll(async () => {
  anaA = await adminInsert({ operator_id: A, name: `Ana ${tag} López`, email: `ana-${tag}@x.com`, phone: "+506 8888-1234" });
  pedroA = await adminInsert({ operator_id: A, name: `Pedro ${tag} Núñez`, email: null, phone: "2222 3333" });
  onlyNameA = await adminInsert({ operator_id: A, name: `Solo${tag}` });
  customerB = await adminInsert({ operator_id: B, name: `Bruno ${tag} Díaz`, email: `bruno-${tag}@x.com` });
});

afterAll(async () => {
  await sql()`delete from public.customers where name like ${`%${tag}%`} or email like ${`%${tag}%`}`;
  await closeSql();
});

// ============================================================================
// rls, grants and triggers through the data api
// ============================================================================

describe("AE2 cross-operator reads (customers, customer_display)", () => {
  it("a user of B sees none of A's customers or masked names", async () => {
    const client = await clientFor("reservasB");
    const ids = [anaA.id, pedroA.id, onlyNameA.id];
    expectZeroRows(await client.from("customers").select("id").in("id", ids));
    expectZeroRows(await client.from("customer_display").select("customer_id").in("customer_id", ids));

    const all = await client.from("customers").select("operator_id");
    expect(all.error).toBeNull();
    expect(new Set(all.data?.map((row) => row.operator_id))).toEqual(new Set([B]));
    const displays = await client.from("customer_display").select("operator_id");
    expect(new Set(displays.data?.map((row) => row.operator_id))).toEqual(new Set([B]));
  });

  it("an administrador of A sees A's customers and not B's", async () => {
    const client = await clientFor("adminA");
    const { data, error } = await client.from("customers").select("id").in("id", [anaA.id, customerB.id]);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: anaA.id }]);
    expectZeroRows(await client.from("customer_display").select("customer_id").eq("customer_id", customerB.id));
  });

  it("a user of A and B sees both operators' customers", async () => {
    const client = await clientFor("adminAB");
    const { data } = await client.from("customers").select("id").in("id", [anaA.id, customerB.id]).order("name");
    expect(data?.map((row) => row.id)).toEqual([anaA.id, customerB.id]);
  });
});

describe("AE5 masked customers (R11)", () => {
  it.each<SeedUserKey>(["contabilidadA", "guiaA"])("%s gets zero rows from customers", async (user) => {
    const client = await clientFor(user);
    expectZeroRows(await client.from("customers").select("id, name, email, phone"));
  });

  it.each<SeedUserKey>(["contabilidadA"])(
    "%s reads first name plus last initial from customer_display",
    async (user) => {
      const client = await clientFor(user);
      const { data, error } = await client
        .from("customer_display")
        .select("customer_id, operator_id, display_name")
        .in("customer_id", [anaA.id, pedroA.id, onlyNameA.id, customerB.id])
        .order("display_name");
      expect(error).toBeNull();
      expect(data).toEqual([
        { customer_id: anaA.id, operator_id: A, display_name: "Ana L." },
        { customer_id: pedroA.id, operator_id: A, display_name: "Pedro N." },
        { customer_id: onlyNameA.id, operator_id: A, display_name: `Solo${tag}` },
      ]);
    },
  );

  // U7 narrowed the guía's view: only customers on reservations they can see
  // (tests/db/guide-visibility.test.ts covers the positive case).
  it("guiaA reads no masked name of a customer without a reservation on their departures", async () => {
    const client = await clientFor("guiaA");
    expectZeroRows(
      await client.from("customer_display").select("customer_id").in("customer_id", [anaA.id, pedroA.id, onlyNameA.id, customerB.id]),
    );
  });

  it("administrador and reservas read full customer data", async () => {
    for (const user of ["adminA", "reservasA"] as const) {
      const client = await clientFor(user);
      const { data, error } = await client.from("customers").select("name, email, phone").eq("id", anaA.id).single();
      expect(error, user).toBeNull();
      expect(data, user).toEqual({ name: anaA.name, email: anaA.email, phone: anaA.phone });
    }
  });
});

describe("customer writes by role and operator (R10, KTD2, KTD4)", () => {
  it("reservas of A inserting a customer for operator B fails with a policy violation", async () => {
    const client = await clientFor("reservasA");
    const result = await client.from("customers").insert({ operator_id: B, name: `Foreign ${tag}` }).select("id");
    expectSqlState(result, "42501", "row-level security");
    const { data } = await admin.from("customers").select("id").eq("name", `Foreign ${tag}`);
    expect(data).toEqual([]);
  });

  it.each<SeedUserKey>(["contabilidadA", "guiaA"])("%s cannot insert a customer into their own operator", async (user) => {
    const client = await clientFor(user);
    const result = await client.from("customers").insert({ operator_id: A, name: `Denied ${user} ${tag}` }).select("id");
    expectSqlState(result, "42501");
  });

  it("contabilidad updating a customer of A affects zero rows", async () => {
    const client = await clientFor("contabilidadA");
    expectZeroRows(await client.from("customers").update({ name: "Changed" }).eq("id", anaA.id).select("id"));
    expect((await adminRead(anaA.id))?.name).toBe(anaA.name);
  });

  it("reservas of A updating B's customer affects zero rows (re-read as admin)", async () => {
    const client = await clientFor("reservasA");
    expectZeroRows(await client.from("customers").update({ name: "Hijacked" }).eq("id", customerB.id).select("id"));
    expect((await adminRead(customerB.id))?.name).toBe(customerB.name);
  });

  it("operator_id cannot be changed after insert", async () => {
    const client = await clientFor("adminAB");
    const result = await client.from("customers").update({ operator_id: B }).eq("id", anaA.id).select("id");
    expectSqlState(result, "42501", "permission denied");
    expect((await adminRead(anaA.id))?.operator_id).toBe(A);
  });

  it("server-owned columns (id, created_at) are not insertable", async () => {
    const client = await clientFor("reservasA");
    expectSqlState(
      await client.from("customers").insert({ id: crypto.randomUUID(), operator_id: A, name: `Chosen id ${tag}` }),
      "42501",
    );
    expectSqlState(
      await client.from("customers").insert({ operator_id: A, name: `Backdated ${tag}`, created_at: "2020-01-01T00:00:00Z" }),
      "42501",
    );
  });

  it("the database rejects a malformed email or phone written directly", async () => {
    const client = await clientFor("reservasA");
    expectSqlState(await client.from("customers").insert({ operator_id: A, name: `Bad ${tag}`, email: "not-an-email" }), "23514");
    expectSqlState(await client.from("customers").insert({ operator_id: A, name: `Bad ${tag}`, phone: "call me" }), "23514");
    expectSqlState(await client.from("customers").insert({ operator_id: A, name: "   " }), "23514");
  });
});

describe("R26 per-operator email uniqueness", () => {
  it("inserting Ana@x.com when ana@x.com exists in the same operator fails", async () => {
    const client = await clientFor("reservasA");
    const upper = `Ana-${tag}@X.com`;
    expect(upper.toLowerCase()).toBe(anaA.email);
    const result = await client.from("customers").insert({ operator_id: A, name: `Ana dup ${tag}`, email: upper });
    expectSqlState(result, "23505");
  });

  it("the same email in another operator succeeds", async () => {
    const client = await clientFor("reservasB");
    const { data, error } = await client
      .from("customers")
      .insert({ operator_id: B, name: `Ana ${tag} en B`, email: anaA.email })
      .select("operator_id, email")
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({ operator_id: B, email: anaA.email });
  });

  it("customers with only a name may repeat", async () => {
    const client = await clientFor("reservasA");
    for (let i = 0; i < 2; i++) {
      const { error } = await client.from("customers").insert({ operator_id: A, name: `Twin ${tag}` });
      expect(error).toBeNull();
    }
    const { data } = await admin.from("customers").select("id").eq("name", `Twin ${tag}`);
    expect(data).toHaveLength(2);
  });
});

describe("customer_display is derived data (KTD4, KTD5)", () => {
  it("renaming a customer updates display_name; an email change leaves it", async () => {
    const client = await clientFor("reservasA");
    const renamed = await admin.from("customers").insert({ operator_id: A, name: `Marta ${tag} Gómez` }).select("id").single();
    const id = renamed.data!.id;

    const display = async () =>
      (await client.from("customer_display").select("display_name").eq("customer_id", id).single()).data?.display_name;
    expect(await display()).toBe("Marta G.");

    const update = await client.from("customers").update({ name: `Marta ${tag} Ruiz` }).eq("id", id).select("id");
    expect(update.error).toBeNull();
    expect(update.data).toEqual([{ id }]);
    expect(await display()).toBe("Marta R.");

    const before = await sql()`select updated_at from public.customer_display where customer_id = ${id}`;
    await client.from("customers").update({ email: `marta-${tag}@x.com` }).eq("id", id);
    const after = await sql()`select display_name, updated_at from public.customer_display where customer_id = ${id}`;
    expect(after[0].display_name).toBe("Marta R.");
    expect(after[0].updated_at).toEqual(before[0].updated_at);
  });

  it("rejects a direct insert, update or delete from authenticated", async () => {
    for (const user of ["adminA", "reservasA"] as const) {
      const client = await clientFor(user);
      expectSqlState(
        await client.from("customer_display").insert({ customer_id: onlyNameA.id, operator_id: A, display_name: "X" }),
        "42501",
      );
      expectSqlState(
        await client.from("customer_display").update({ display_name: "Spoofed" }).eq("customer_id", anaA.id),
        "42501",
      );
      expectSqlState(await client.from("customer_display").delete().eq("customer_id", anaA.id), "42501");
    }
    const { data } = await admin.from("customer_display").select("display_name").eq("customer_id", anaA.id).single();
    expect(data?.display_name).toBe("Ana L.");
  });
});

describe("R27 no hard delete", () => {
  it("a reservas user attempting delete on customers affects zero rows (re-read as admin)", async () => {
    const client = await clientFor("reservasA");
    const result = await client.from("customers").delete().eq("id", anaA.id).select("id");
    // No delete grant: PostgREST answers with a privilege error and nothing is removed.
    expectSqlState(result, "42501", "permission denied");
    expect(await adminRead(anaA.id)).toMatchObject({ id: anaA.id, name: anaA.name });
  });

  it("an administrador cannot delete customers either", async () => {
    const client = await clientFor("adminA");
    expectSqlState(await client.from("customers").delete().eq("id", pedroA.id), "42501");
    expect(await adminRead(pedroA.id)).not.toBeNull();
  });
});

describe("KTD6 customers are not audited", () => {
  it("writes no audit.events rows for customers or customer_display", async () => {
    const client = await clientFor("reservasA");
    await client.from("customers").update({ phone: "+506 7777-0000" }).eq("id", anaA.id);
    const [row] = await sql()`
      select count(*)::int as n from audit.events where table_name in ('customers', 'customer_display')
    `;
    expect(row.n).toBe(0);
  });
});

// ============================================================================
// dal and server actions (U9 verification: reservas creates and searches,
// contabilidad sees masked names only)
// ============================================================================

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** Starts a fresh browser signed in as the seeded user. */
async function signIn(user: SeedUserKey): Promise<void> {
  jar = new CookieJar();
  const { email, password } = seedUser(user);
  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInWithPassword failed for ${user}: ${error.message}`);
}

async function expectRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw error;
  }
  throw new Error("expected a redirect");
}

describe("customers DAL and actions", () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    // Customer data never reaches the log: no line carries this file's tag.
    for (const spy of consoleSpies.splice(0)) {
      const output = spy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
      expect(output).not.toContain(tag);
      spy.mockRestore();
    }
  });

  it("reservas creates a customer; operator_id comes from the context, never the form", async () => {
    await signIn("reservasA");
    const state = await createCustomerAction(
      { status: "idle" },
      form({
        locale: "es",
        name: `  Lucía ${tag} Mora `,
        email: ` Lucia-${tag}@Example.com `,
        phone: "+506 6000-1111",
        preferredLocale: "en",
        operator_id: B,
        operatorId: B,
      }),
    );
    expect(state).toMatchObject({ status: "ok", data: { name: `Lucía ${tag} Mora` } });
    const id = state.status === "ok" ? state.data.id : "";
    expect(await adminRead(id)).toMatchObject({
      operator_id: A,
      name: `Lucía ${tag} Mora`,
      email: `lucia-${tag}@example.com`,
      phone: "+506 6000-1111",
    });
  });

  it("reservas searches by name, email or phone, case-insensitively", async () => {
    await signIn("reservasA");
    const ctx = await requireOperatorContext("customers.read");

    const byName = await listCustomers(ctx, { query: `ANA ${tag.toUpperCase()}` });
    expect(byName.access).toBe("full");
    expect(byName.customers.map((c) => c.id)).toEqual([anaA.id]);
    expect(byName.customers[0]).toMatchObject({ name: anaA.name, email: anaA.email });

    const byEmail = await listCustomers(ctx, { query: `ana-${tag}@` });
    expect(byEmail.customers.map((c) => c.id)).toEqual([anaA.id]);

    const byPhone = await listCustomers(ctx, { query: "2222 3333" });
    expect(byPhone.customers.map((c) => c.id)).toContain(pedroA.id);

    const byTag = await listCustomers(ctx, { query: tag });
    const ids = byTag.customers.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([anaA.id, pedroA.id, onlyNameA.id]));
    expect(ids).not.toContain(customerB.id);
  });

  it("search input cannot change the filter: wildcards match literally and syntax is inert", async () => {
    await signIn("reservasA");
    const ctx = await requireOperatorContext("customers.read");
    const promo = await adminInsert({ operator_id: A, name: `Promo 100% ${tag}` });
    await adminInsert({ operator_id: A, name: `Promo 1000 ${tag}` });
    const under = await adminInsert({ operator_id: A, name: `Under_score ${tag}` });
    await adminInsert({ operator_id: A, name: `UnderXscore ${tag}` });

    // `%` and `_` are LIKE wildcards; escaped, they only match themselves.
    const percent = await listCustomers(ctx, { query: `100% ${tag}` });
    expect(percent.customers.map((c) => c.id)).toEqual([promo.id]);
    const underscore = await listCustomers(ctx, { query: `Under_score ${tag}` });
    expect(underscore.customers.map((c) => c.id)).toEqual([under.id]);

    // Filter syntax inside the term neither errors nor widens the result.
    for (const query of [`${tag},id.not.is.null`, `${tag}) or (id.not.is.null`, `"${tag}`, `${tag}\\`, `${tag}:*`]) {
      const result = await listCustomers(ctx, { query });
      expect(result.customers, query).toEqual([]);
    }

    // `*` (the PostgREST wildcard) is dropped: on its own it is an empty search.
    expect(await listCustomers(ctx, { query: "*" })).toEqual(await listCustomers(ctx, { query: "" }));
  });

  it("contabilidad lists masked names only and searches them", async () => {
    await signIn("contabilidadA");
    const ctx = await requireOperatorContext("customers.read");
    const list = await listCustomers(ctx, { query: "Ana L." });
    expect(list.access).toBe("masked");
    expect(list.customers).toContainEqual({ id: anaA.id, displayName: "Ana L." });
    for (const customer of list.customers) expect(Object.keys(customer).sort()).toEqual(["displayName", "id"]);
    expect(JSON.stringify(list)).not.toContain(anaA.email);
    await expect(getCustomer(ctx, anaA.id)).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("getCustomerDisplays returns masked names for the active operator's ids only", async () => {
    await signIn("contabilidadA");
    const ctx = await requireOperatorContext("customers.read");
    const names = await getCustomerDisplays(ctx, [anaA.id, pedroA.id, customerB.id, anaA.id]);
    expect(Object.fromEntries(names)).toEqual({ [anaA.id]: "Ana L.", [pedroA.id]: "Pedro N." });
    expect((await getCustomerDisplays(ctx, [])).size).toBe(0);
  });

  it("contabilidad calling the create action gets forbidden and nothing is written", async () => {
    await signIn("contabilidadA");
    const state = await createCustomerAction({ status: "idle" }, form({ locale: "es", name: `Nope ${tag}` }));
    expect(state).toMatchObject({ status: "error", error: "forbidden" });
    expect((await admin.from("customers").select("id").eq("name", `Nope ${tag}`)).data).toEqual([]);
  });

  it("a duplicate email is reported on the email field and the input is kept", async () => {
    await signIn("reservasA");
    const state = await createCustomerAction(
      { status: "idle" },
      form({ locale: "es", name: `Otra ${tag}`, email: anaA.email!.toUpperCase(), phone: "", preferredLocale: "" }),
    );
    expect(state).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: { email: "validation.emailTaken" },
      values: { name: `Otra ${tag}`, email: anaA.email!.toUpperCase() },
    });
  });

  it("validation errors carry message keys and the submitted values", async () => {
    await signIn("reservasA");
    const state = await createCustomerAction(
      { status: "idle" },
      form({ locale: "es", name: " ", email: "nope", phone: "abc", preferredLocale: "fr" }),
    );
    expect(state).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: {
        name: "validation.nameRequired",
        email: "validation.emailInvalid",
        phone: "validation.phoneInvalid",
        preferredLocale: "validation.localeInvalid",
      },
    });
  });

  it("updating a customer of another operator is not_found and changes nothing", async () => {
    await signIn("reservasA");
    const state = await updateCustomerAction(
      { status: "idle" },
      form({ locale: "es", id: customerB.id, name: "Hijacked", email: "", phone: "", preferredLocale: "" }),
    );
    expect(state).toMatchObject({ status: "error", error: "not_found" });
    expect((await adminRead(customerB.id))?.name).toBe(customerB.name);

    const ctx = await requireOperatorContext("customers.read");
    await expect(getCustomer(ctx, customerB.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an id that is not a uuid is rejected before any query", async () => {
    await signIn("reservasA");
    const state = await updateCustomerAction(
      { status: "idle" },
      form({ locale: "es", id: "1 or 1=1", name: "X", email: "", phone: "", preferredLocale: "" }),
    );
    expect(state).toMatchObject({ status: "error", error: "invalid", fieldErrors: { id: "validation.customerInvalid" } });
  });

  it("reservas edits a customer, the masked name follows, and the action returns to the list", async () => {
    await signIn("reservasA");
    const target = await adminInsert({ operator_id: A, name: `Elena ${tag} Vega`, email: `elena-${tag}@x.com` });
    const path = await expectRedirect(() =>
      updateCustomerAction(
        { status: "idle" },
        form({ locale: "en", id: target.id, name: `Elena ${tag} Soto`, email: "", phone: "8888 0000", preferredLocale: "es" }),
      ),
    );
    expect(path).toBe("/en/customers");
    expect(await adminRead(target.id)).toMatchObject({ name: `Elena ${tag} Soto`, email: null, phone: "8888 0000" });
    const { data } = await admin.from("customer_display").select("display_name").eq("customer_id", target.id).single();
    expect(data?.display_name).toBe("Elena S.");
  });
});
