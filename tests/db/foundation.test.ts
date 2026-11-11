// U2 database foundation: operators, profiles, memberships, helpers, audit,
// admin rpcs, seed guard and the pgTAP coverage check (plan U2 test scenarios).
//
// Seeded users and operators are read-mostly; every test that mutates creates
// its own throwaway users or operators and removes them, so the suite can run
// repeatedly against one `db reset` + `db:seed-users`.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  anonClient,
  asRole,
  clientFor,
  closeSql,
  createTestUser,
  deleteTestUser,
  expectSqlState,
  expectTypedError,
  expectZeroRows,
  forgetSession,
  seedUser,
  sql,
  uniqueEmail,
  type Client,
} from "./helpers.ts";
import { OPERATORS, SEED_USERS, type SeedUserKey } from "./fixtures.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const C = OPERATORS.c.id;

const admin: Client = adminClient();

afterAll(async () => {
  await closeSql();
});

async function createOperator(input: { slug: string; status?: "active" | "inactive" }): Promise<string> {
  const { data, error } = await admin
    .from("operators")
    .insert({
      name: `Test ${input.slug}`,
      slug: input.slug,
      timezone: "America/Costa_Rica",
      currency: "USD",
      locale: "es",
      status: input.status ?? "active",
    })
    .select("id")
    .single();
  if (error) throw new Error(`createOperator failed: ${error.message}`);
  return data.id;
}

/** Deactivates (releasing the last-administrador rule), deletes users, then the operator. */
async function dropOperator(id: string, userIds: string[]): Promise<void> {
  await admin.from("operators").update({ status: "inactive" }).eq("id", id);
  for (const userId of userIds) await deleteTestUser(admin, userId);
  await admin.from("memberships").delete().eq("operator_id", id);
  await admin.from("operators").delete().eq("id", id);
}

describe("seed", () => {
  it("has operators A, B and C with the fixture ids", async () => {
    const { data, error } = await admin.from("operators").select("id, slug, status").in("id", [A, B, C]).order("slug");
    expect(error).toBeNull();
    expect(data).toEqual([
      { id: A, slug: "operator-a", status: "active" },
      { id: B, slug: "operator-b", status: "active" },
      { id: C, slug: "operator-c", status: "active" },
    ]);
  });
});

describe("AE2 cross-operator reads", () => {
  it("an administrador of A sees only A in operators and only A's memberships", async () => {
    const client = await clientFor("adminA");
    const operators = await client.from("operators").select("id");
    expect(operators.error).toBeNull();
    expect(operators.data?.map((row) => row.id)).toEqual([A]);

    const memberships = await client.from("memberships").select("operator_id, user_id");
    expect(memberships.error).toBeNull();
    expect(memberships.data?.length).toBeGreaterThanOrEqual(5);
    expect(new Set(memberships.data?.map((row) => row.operator_id))).toEqual(new Set([A]));
  });

  it("a reservas user of A sees A in operators and only their own membership row", async () => {
    const client = await clientFor("reservasA");
    const operators = await client.from("operators").select("id");
    expect(operators.data?.map((row) => row.id)).toEqual([A]);

    const memberships = await client.from("memberships").select("operator_id, user_id, role");
    expect(memberships.error).toBeNull();
    expect(memberships.data).toEqual([{ operator_id: A, user_id: seedUser("reservasA").id, role: "reservas" }]);
  });

  it("a user who is administrador of A and B sees A and B but not C", async () => {
    const client = await clientFor("adminAB");
    const operators = await client.from("operators").select("id").order("slug");
    expect(operators.data?.map((row) => row.id)).toEqual([A, B]);

    const memberships = await client.from("memberships").select("operator_id");
    const seen = new Set(memberships.data?.map((row) => row.operator_id));
    expect(seen).toEqual(new Set([A, B]));
    expect(seen.has(C)).toBe(false);
  });
});

describe("cross-operator writes", () => {
  it("a user of A inserting a membership for operator B fails with a policy violation", async () => {
    const client = await clientFor("adminA");
    const result = await client
      .from("memberships")
      .insert({ user_id: seedUser("reservasB").id, operator_id: B, role: "contabilidad" })
      .select();
    expectSqlState(result, "42501", "row-level security");
    const { count } = await admin
      .from("memberships")
      .select("*", { count: "exact", head: true })
      .eq("user_id", seedUser("reservasB").id)
      .eq("operator_id", B)
      .eq("role", "contabilidad");
    expect(count).toBe(0);
  });

  it("a user of A and B updating operator_id of an A membership fails with a column privilege error", async () => {
    const client = await clientFor("adminAB");
    const result = await client
      .from("memberships")
      .update({ operator_id: B })
      .eq("user_id", seedUser("adminAB").id)
      .eq("operator_id", A)
      .select();
    expectSqlState(result, "42501", "permission denied");
  });
});

describe("operators updates", () => {
  it("an administrador updates timezone", async () => {
    const client = await clientFor("adminA");
    const updated = await client.from("operators").update({ timezone: "America/Panama" }).eq("id", A).select("timezone");
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ timezone: "America/Panama" }]);
    const restored = await client.from("operators").update({ timezone: OPERATORS.a.timezone }).eq("id", A).select("timezone");
    expect(restored.data).toEqual([{ timezone: OPERATORS.a.timezone }]);
  });

  it("updating status or currency fails with a column privilege error", async () => {
    const client = await clientFor("adminA");
    expectSqlState(await client.from("operators").update({ status: "inactive" }).eq("id", A).select(), "42501", "permission denied");
    expectSqlState(await client.from("operators").update({ currency: "EUR" }).eq("id", A).select(), "42501", "permission denied");
    const { data } = await admin.from("operators").select("status, currency").eq("id", A).single();
    expect(data).toEqual({ status: "active", currency: OPERATORS.a.currency });
  });

  it("a reservas user updating name affects zero rows", async () => {
    const client = await clientFor("reservasA");
    expectZeroRows(await client.from("operators").update({ name: "Hacked" }).eq("id", A).select("id"));
    const { data } = await admin.from("operators").select("name").eq("id", A).single();
    expect(data?.name).toBe(OPERATORS.a.name);
  });
});

describe("admin rpcs", () => {
  const args = {
    actor_id: seedUser("adminA").id,
    name: "Rogue",
    slug: "rogue",
    timezone: "America/Costa_Rica",
    currency: "USD",
    locale: "es",
    admin_user_id: seedUser("adminA").id,
  };

  it("authenticated cannot execute admin_bootstrap_operator or admin_seed_membership", async () => {
    const client = await clientFor("adminA");
    expectSqlState(await client.rpc("admin_bootstrap_operator", args), "42501", "permission denied");
    expectSqlState(
      await client.rpc("admin_seed_membership", { actor_id: args.actor_id, user_id: args.actor_id, operator_id: B, role: "administrador" }),
      "42501",
      "permission denied",
    );
    const { count } = await admin.from("operators").select("*", { count: "exact", head: true }).eq("slug", "rogue");
    expect(count).toBe(0);
  });

  it("anon cannot execute the admin rpcs", async () => {
    expectSqlState(await anonClient().rpc("admin_bootstrap_operator", args), "42501", "permission denied");
  });
});

describe("AE6 last administrador", () => {
  let operatorId: string;
  let first: { id: string; email: string };
  let second: { id: string; email: string };

  beforeAll(async () => {
    operatorId = await createOperator({ slug: "last-admin-test" });
    first = await createTestUser(admin, { email: uniqueEmail("last-admin-1"), memberships: [{ operatorId, role: "administrador" }] });
    second = await createTestUser(admin, { email: uniqueEmail("last-admin-2") });
  });

  afterAll(async () => {
    await dropOperator(operatorId, [first.id, second.id]);
  });

  it("deleting the last administrador fails with last_administrador", async () => {
    expectTypedError(await admin.from("memberships").delete().eq("user_id", first.id).eq("operator_id", operatorId).select(), "last_administrador");
  });

  it("demoting the last administrador fails with last_administrador", async () => {
    expectTypedError(
      await admin.from("memberships").update({ role: "reservas" }).eq("user_id", first.id).eq("operator_id", operatorId).select(),
      "last_administrador",
    );
  });

  it("deleting the auth user of the last administrador is rejected by the cascade", async () => {
    // GoTrue reports the trigger error as a generic database error; the user,
    // profile and membership all survive.
    const { error } = await admin.auth.admin.deleteUser(first.id);
    expect(error?.message).toMatch(/database error deleting user/i);
    const { count } = await admin.from("profiles").select("*", { count: "exact", head: true }).eq("id", first.id);
    expect(count).toBe(1);
    const membership = await admin.from("memberships").select("role").eq("user_id", first.id).eq("operator_id", operatorId);
    expect(membership.data).toEqual([{ role: "administrador" }]);
  });

  it("demoting one of two administradores succeeds", async () => {
    const promoted = await admin.rpc("admin_seed_membership", {
      actor_id: null as unknown as string,
      user_id: second.id,
      operator_id: operatorId,
      role: "administrador",
    });
    expect(promoted.error).toBeNull();
    const demoted = await admin
      .from("memberships")
      .update({ role: "reservas" })
      .eq("user_id", first.id)
      .eq("operator_id", operatorId)
      .select("role");
    expect(demoted.error).toBeNull();
    expect(demoted.data).toEqual([{ role: "reservas" }]);
  });
});

describe("inactive operator", () => {
  let operatorId: string;
  let user: { id: string; email: string; password: string };

  beforeAll(async () => {
    operatorId = await createOperator({ slug: "inactive-test", status: "inactive" });
    user = await createTestUser(admin, { email: uniqueEmail("inactive"), memberships: [{ operatorId, role: "administrador" }] });
  });

  afterAll(async () => {
    await dropOperator(operatorId, [user.id]);
  });

  it("yields zero rows from private.user_operator_ids() and from operators", async () => {
    const helperRows = await asRole("authenticated", user.id, (tx) => tx`select * from private.user_operator_ids()`);
    expect(helperRows).toHaveLength(0);
    const client = await clientFor(user);
    expectZeroRows(await client.from("operators").select("id"));
  });
});

describe("timezone validation", () => {
  it("rejects America/Nowhere and accepts America/Costa_Rica", async () => {
    const invalid = await admin
      .from("operators")
      .insert({ name: "Nowhere", slug: "nowhere", timezone: "America/Nowhere", currency: "USD" })
      .select();
    expectSqlState(invalid, "23514", "invalid timezone");

    const valid = await admin
      .from("operators")
      .insert({ name: "Somewhere", slug: "somewhere", timezone: "America/Costa_Rica", currency: "USD" })
      .select("id, timezone")
      .single();
    expect(valid.error).toBeNull();
    expect(valid.data?.timezone).toBe("America/Costa_Rica");
    await admin.from("operators").delete().eq("id", valid.data!.id);
  });
});

describe("profiles", () => {
  const membersOfA = (["adminA", "reservasA", "contabilidadA", "guiaA", "adminAB"] as SeedUserKey[]).map((key) => seedUser(key).id);

  it("a staff user of A sees members of A and themself, zero rows of B", async () => {
    const client = await clientFor("reservasA");
    const { data, error } = await client.from("profiles").select("id, email");
    expect(error).toBeNull();
    const ids = new Set(data?.map((row) => row.id));
    for (const id of membersOfA) expect(ids.has(id)).toBe(true);
    expect(ids.has(seedUser("reservasB").id)).toBe(false);
  });

  it("a guía of A sees only their own row", async () => {
    const client = await clientFor("guiaA");
    const { data } = await client.from("profiles").select("id, email, full_name");
    expect(data).toEqual([{ id: seedUser("guiaA").id, email: SEED_USERS.guiaA.email, full_name: SEED_USERS.guiaA.fullName }]);
  });

  it("insert into profiles as authenticated fails", async () => {
    const client = await clientFor("adminA");
    expectSqlState(await client.from("profiles").insert({ id: seedUser("adminA").id, email: "x@cupo.test" }).select(), "42501", "permission denied");
  });
});

describe("auth", () => {
  it("a seeded staff user signs in with a password and carries password_set_at", async () => {
    const client = anonClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: seedUser("adminA").email,
      password: seedUser("adminA").password,
    });
    expect(error).toBeNull();
    expect(data.user?.app_metadata.password_set_at).toEqual(expect.any(String));
  });

  it("the seeded guía signs in but has no password_set_at", async () => {
    const client = anonClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: seedUser("guiaA").email,
      password: seedUser("guiaA").password,
    });
    expect(error).toBeNull();
    expect(data.user?.app_metadata.password_set_at).toBeUndefined();
  });

  it("public signup is disabled", async () => {
    const { error } = await anonClient().auth.signUp({ email: uniqueEmail("signup"), password: "Tt1notallowed99" });
    expect(error?.message).toMatch(/signups not allowed/i);
  });
});

describe("audit", () => {
  let invited: { id: string; email: string };
  let bootstrapOperatorId: string | undefined;
  const bootstrapActor = "11111111-1111-4111-8111-111111111111";

  beforeAll(async () => {
    invited = await createTestUser(admin, { email: uniqueEmail("audit-invitee") });
  });

  afterAll(async () => {
    await admin.from("memberships").delete().eq("user_id", invited.id).eq("operator_id", A);
    if (bootstrapOperatorId) await dropOperator(bootstrapOperatorId, []);
    await deleteTestUser(admin, invited.id);
  });

  it("a membership inserted under an administrador session records that actor with source jwt", async () => {
    const client = await clientFor("adminA");
    const inserted = await client
      .from("memberships")
      .insert({ user_id: invited.id, operator_id: A, role: "reservas" })
      .select("id")
      .single();
    expect(inserted.error).toBeNull();
    const events = await sql()`
      select operator_id, op, actor_id, actor_source, new_record ->> 'role' as role
      from audit.events where table_name = 'memberships' and record_id = ${inserted.data!.id}`;
    expect(events).toEqual([{ operator_id: A, op: "insert", actor_id: seedUser("adminA").id, actor_source: "jwt", role: "reservas" }]);
  });

  it("the bootstrap rpc records the given actor with source app", async () => {
    const { data, error } = await admin.rpc("admin_bootstrap_operator", {
      actor_id: bootstrapActor,
      name: "Bootstrap Audit",
      slug: "bootstrap-audit",
      timezone: "America/Costa_Rica",
      currency: "USD",
      locale: "es",
      admin_user_id: invited.id,
    });
    expect(error).toBeNull();
    bootstrapOperatorId = data as string;
    const events = await sql()`
      select actor_id, actor_source, op from audit.events
      where table_name = 'memberships' and operator_id = ${bootstrapOperatorId} and new_record ->> 'user_id' = ${invited.id}`;
    expect(events).toEqual([{ actor_id: bootstrapActor, actor_source: "app", op: "insert" }]);
  });

  it("seeded memberships show source system and null actor", async () => {
    const events = await sql()`
      select actor_id, actor_source from audit.events
      where table_name = 'memberships' and op = 'insert' and new_record ->> 'user_id' = ${seedUser("reservasA").id}`;
    expect(events).toEqual([{ actor_id: null, actor_source: "system" }]);
  });

  it("a reservas user reads zero audit rows; an administrador of A reads only A's rows", async () => {
    const reservas = await clientFor("reservasA");
    expectZeroRows(await reservas.schema("audit").from("events").select("id"));

    const adminA = await clientFor("adminA");
    const { data, error } = await adminA.schema("audit").from("events").select("operator_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(new Set(data?.map((row) => row.operator_id))).toEqual(new Set([A]));
  });

  it("insert into audit.events as authenticated fails", async () => {
    const adminA = await clientFor("adminA");
    const result = await adminA
      .schema("audit")
      .from("events")
      .insert({ operator_id: A, table_name: "memberships", op: "insert", actor_source: "jwt" })
      .select();
    expectSqlState(result, "42501", "permission denied");
  });
});

describe("auth user deletion cascade", () => {
  it("removes membership and profile and writes an audit row with source system", async () => {
    const user = await createTestUser(admin, { email: uniqueEmail("cascade"), memberships: [{ operatorId: B, role: "reservas" }] });
    const before = await admin.from("memberships").select("id").eq("user_id", user.id).single();
    expect(before.data?.id).toEqual(expect.any(String));

    await deleteTestUser(admin, user.id, user.email);

    const memberships = await admin.from("memberships").select("id").eq("user_id", user.id);
    expectZeroRows(memberships);
    const profiles = await admin.from("profiles").select("id").eq("id", user.id);
    expectZeroRows(profiles);
    const events = await sql()`
      select actor_id, actor_source, op from audit.events
      where table_name = 'memberships' and record_id = ${before.data!.id} and op = 'delete'`;
    expect(events).toEqual([{ actor_id: null, actor_source: "system", op: "delete" }]);
  });
});

describe("bootstrap script", () => {
  const script = resolve(repoRoot, "scripts/bootstrap-operator.ts");
  const slug = "script-bootstrap";
  const adminEmail = uniqueEmail("script-admin");
  const args = ["--name", "Script Op", "--slug", slug, "--timezone", "America/Costa_Rica", "--currency", "usd", "--admin-email", adminEmail];
  // No SUPABASE_URL: the script resolves the local stack itself, like a developer would.
  const env = { ...process.env, GITHUB_ACTIONS: undefined, SUPABASE_URL: undefined, SUPABASE_SECRET_KEY: undefined };

  afterAll(async () => {
    const { data: op } = await admin.from("operators").select("id").eq("slug", slug).maybeSingle();
    const { data: profile } = await admin.from("profiles").select("id").ilike("email", adminEmail).maybeSingle();
    if (op) await dropOperator(op.id, profile ? [profile.id] : []);
    else if (profile) await deleteTestUser(admin, profile.id);
  });

  it("run twice leaves one operator and one membership and prints the operator id", async () => {
    const first = execFileSync(process.execPath, [script, ...args], { cwd: repoRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const second = execFileSync(process.execPath, [script, ...args], { cwd: repoRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);

    const operators = await admin.from("operators").select("id, currency").eq("slug", slug);
    expect(operators.data).toEqual([{ id: first, currency: "USD" }]);
    const memberships = await admin.from("memberships").select("role").eq("operator_id", first);
    expect(memberships.data).toEqual([{ role: "administrador" }]);
  });

  it("refuses a non-local URL with --print-link without writing", async () => {
    const { count: before } = await admin.from("operators").select("*", { count: "exact", head: true });
    const run = spawnSync(
      process.execPath,
      [script, ...args.slice(0, -2), "--admin-email", uniqueEmail("hosted"), "--slug", "hosted-refused", "--print-link"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...env, SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_notreal" },
      },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/refus|local stack only/i);
    const { count: after } = await admin.from("operators").select("*", { count: "exact", head: true });
    expect(after).toBe(before);
    const { count } = await admin.from("operators").select("*", { count: "exact", head: true }).eq("slug", "hosted-refused");
    expect(count).toBe(0);
  });

  it("refuses a hosted URL from a developer machine", () => {
    const run = spawnSync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...env, SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_notreal" },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/refusing the hosted URL/);
  });
});

describe("seed guard", () => {
  const seed = readFileSync(resolve(repoRoot, "supabase/seed.sql"), "utf8");
  const guardStart = seed.indexOf("do $$");
  const guard = seed.slice(guardStart, seed.indexOf("$$;", guardStart) + 3);

  it("is the first statement of seed.sql", () => {
    expect(guardStart).toBeGreaterThan(-1);
    expect(seed.indexOf("insert into")).toBeGreaterThan(guardStart);
  });

  it("passes on the local stack", async () => {
    await expect(sql().unsafe(guard)).resolves.toBeDefined();
  });

  it("aborts against a non-local address", async () => {
    const hosted = guard.replace("inet_server_addr()", "'52.1.2.3'::inet");
    expect(hosted).not.toBe(guard);
    await expect(sql().unsafe(hosted)).rejects.toMatchObject({ code: "P0001", message: expect.stringContaining("seed.sql refused") });
  });

  it("aborts when the server is not a cli local stack", async () => {
    const hosted = guard.replace("current_setting('app.settings.jwt_secret', true)", "'something-else'");
    expect(hosted).not.toBe(guard);
    await expect(sql().unsafe(hosted)).rejects.toMatchObject({ code: "P0001", message: expect.stringContaining("not a supabase cli local stack") });
  });
});

describe("pgTAP coverage", () => {
  const file = readFileSync(resolve(repoRoot, "supabase/tests/rls_coverage_test.sql"), "utf8");

  // The file carries its own begin/rollback, so it runs on a reserved
  // connection; the prelude's throwaway objects are rolled back with it.
  async function runCoverage(prelude: string): Promise<string[]> {
    const reserved = await sql().reserve();
    try {
      const results = (await reserved.unsafe(`${prelude}\n${file}`)) as unknown as Array<Array<Record<string, string>>>;
      return results.flat().flatMap((row) => Object.values(row ?? {})).filter((value) => typeof value === "string");
    } finally {
      reserved.release();
    }
  }

  it("passes against the migrations", async () => {
    const lines = await runCoverage("");
    expect(lines.filter((line) => line.startsWith("not ok"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("ok ")).length).toBeGreaterThanOrEqual(9);
  });

  it("fails when a table is created without rls, policies or grants (rolled back)", async () => {
    const lines = await runCoverage("begin; create table public.throwaway_no_rls (id int primary key);");
    const failures = lines.filter((line) => line.startsWith("not ok"));
    expect(failures.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((line) => line.includes("public.throwaway_no_rls"))).toBe(true);
    const exists = await sql()`select to_regclass('public.throwaway_no_rls') as oid`;
    expect(exists[0].oid).toBeNull();
  });
});

describe("harness", () => {
  it("forgets cached sessions on request", async () => {
    forgetSession(seedUser("adminA").email);
    const client = await clientFor("adminA");
    const { data } = await client.auth.getUser();
    expect(data.user?.id).toBe(seedUser("adminA").id);
  });
});
