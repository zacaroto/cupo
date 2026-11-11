// U4 guides against the local stack: guide RLS and grants, the guía-to-guide
// link rule, email uniqueness, the guide actions (create, edit, send access,
// deactivate) and the guía context's guide id. Same harness as
// members.test.ts: real actions, DAL and Supabase clients; `next/headers`,
// `next/cache` and `server-only` replaced. Sends one email (the guide's
// magic link).
import { afterAll, describe, expect, it, vi } from "vitest";
import { GUIDES, OPERATORS } from "./fixtures.ts";
import {
  adminClient,
  asRole,
  clientFor,
  closeSql,
  createTestUser,
  deleteTestUser,
  expectSqlState,
  expectTypedError,
  expectZeroRows,
  seedUser,
  sql,
  uniqueEmail,
} from "./helpers.ts";
import { countMessagesTo, waitForAuthLink } from "./mailpit.ts";
import { CookieJar, expectRedirect, form, requestHeaders } from "./next-harness.ts";
import { NextRequest } from "next/server";

let jar = new CookieJar();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => requestHeaders() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

const { loginAction } = await import("../../apps/web/src/app/[locale]/(auth)/login/actions.ts");
const { createGuideAction, sendGuideAccessAction, setGuideActiveAction, updateGuideAction } = await import(
  "../../apps/web/src/app/[locale]/(app)/guides/actions.ts"
);
const { GET: confirmGET } = await import("../../apps/web/src/app/auth/confirm/route.ts");
const { ACTIVE_OPERATOR_COOKIE, getOperatorContext, shellGate } = await import("../../apps/web/src/lib/dal/context.ts");

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const admin = adminClient();
const IDLE = { status: "idle" } as const;
const cleanupUsers: Array<{ id: string; email?: string }> = [];
const cleanupGuides: string[] = [];

afterAll(async () => {
  for (const user of cleanupUsers) await deleteTestUser(admin, user.id, user.email);
  if (cleanupGuides.length) await admin.from("guides").delete().in("id", cleanupGuides);
  await closeSql();
});

async function signIn(user: { id: string; email: string; password: string }, operatorId?: string): Promise<void> {
  jar = new CookieJar();
  expect(await expectRedirect(() => loginAction(IDLE, form({ locale: "es", intent: "password", email: user.email, password: user.password })))).toBe(
    "/es",
  );
  if (operatorId) {
    jar.set(ACTIVE_OPERATOR_COOKIE, `${user.id}:${operatorId}`);
    expect((await getOperatorContext())?.operator.id).toBe(operatorId);
  }
}

/** A guide of `operatorId` created with the service role (fixtures for RLS tests). */
async function insertGuide(operatorId: string, fields: { name: string; email?: string | null }): Promise<string> {
  const { data, error } = await admin
    .from("guides")
    .insert({ operator_id: operatorId, name: fields.name, email: fields.email ?? null })
    .select("id")
    .single();
  if (error) throw error;
  cleanupGuides.push(data.id);
  return data.id;
}

async function guideRow(id: string) {
  const { data, error } = await admin.from("guides").select("operator_id, name, email, active, user_id").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function membershipsOf(userId: string) {
  const { data, error } = await admin.from("memberships").select("id, operator_id, role").eq("user_id", userId);
  if (error) throw error;
  return data;
}

function guideForm(fields: Partial<Record<string, string>>): FormData {
  return form({ locale: "es", name: "", email: "", phone: "", languages: "", specialties: "", maxDailyHours: "", ...fields });
}

describe("seeded guides and the guía context (R19, KTD13)", () => {
  it("matches the fixture uuids, with a1 linked to the seeded guía", async () => {
    const { data } = await admin.from("guides").select("id, operator_id, name, email, user_id").in("id", Object.values(GUIDES).map((g) => g.id));
    expect(data?.length).toBe(3);
    for (const guide of Object.values(GUIDES)) {
      const row = data?.find((r) => r.id === guide.id);
      expect(row).toMatchObject({ operator_id: OPERATORS[guide.operator].id, name: guide.name, email: guide.email });
    }
    expect(data?.find((r) => r.id === GUIDES.a1.id)?.user_id).toBe(seedUser("guiaA").id);
  });

  it("gives the seeded guía a context carrying their guide id", async () => {
    await signIn(seedUser("guiaA"));
    const ctx = await getOperatorContext();
    expect(ctx).toMatchObject({ role: "guia", guideId: GUIDES.a1.id, operator: { id: A } });
  });

  it("my_guide_ids() returns a1 for the seeded guía and nothing for staff", async () => {
    const mine = await asRole("authenticated", seedUser("guiaA").id, (tx) => tx`select private.my_guide_ids() as id`);
    expect(mine).toEqual([{ id: GUIDES.a1.id }]);
    const staff = await asRole("authenticated", seedUser("adminA").id, (tx) => tx`select private.my_guide_ids() as id`);
    expect(staff).toEqual([]);
  });
});

describe("guides RLS and grants (R2, R19)", () => {
  it("a guía reads only their own guide row", async () => {
    const guia = await clientFor("guiaA");
    const { data, error } = await guia.from("guides").select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: GUIDES.a1.id }]);
  });

  it("an administrador of A reads A's guides only; staff of B read none of A's", async () => {
    const adminA = await clientFor("adminA");
    const { data } = await adminA.from("guides").select("id, operator_id");
    expect(data?.length).toBeGreaterThanOrEqual(2);
    expect(new Set(data?.map((g) => g.operator_id))).toEqual(new Set([A]));
    expect(data?.map((g) => g.id)).toEqual(expect.arrayContaining([GUIDES.a1.id, GUIDES.a2.id]));

    const reservasB = await clientFor("reservasB");
    expectZeroRows(await reservasB.from("guides").select("id").eq("operator_id", A));
    const { data: inB } = await reservasB.from("guides").select("id");
    expect(inB?.map((g) => g.id)).toContain(GUIDES.b1.id);
  });

  it("reservas and contabilidad read their operator's guides but cannot write them", async () => {
    const contabilidad = await clientFor("contabilidadA");
    const { data } = await contabilidad.from("guides").select("id").eq("id", GUIDES.a2.id);
    expect(data).toEqual([{ id: GUIDES.a2.id }]);
    expectSqlState(await contabilidad.from("guides").insert({ operator_id: A, name: "Nope" }), "42501");

    const reservas = await clientFor("reservasA");
    expectZeroRows(await reservas.from("guides").update({ name: "Renamed" }).eq("id", GUIDES.a2.id).select("id"));
    expect((await guideRow(GUIDES.a2.id)).name).toBe(GUIDES.a2.name);
  });

  it("an administrador cannot insert into another operator, move a guide, set user_id on insert or delete", async () => {
    const adminA = await clientFor("adminA");
    expectSqlState(await adminA.from("guides").insert({ operator_id: B, name: "Foreign" }), "42501");
    expectSqlState(await adminA.from("guides").insert({ operator_id: A, name: "Linked", user_id: seedUser("adminA").id }), "42501");
    const adminAB = await clientFor("adminAB");
    expectSqlState(await adminAB.from("guides").update({ operator_id: B }).eq("id", GUIDES.a2.id), "42501");
    expectSqlState(await adminA.from("guides").delete().eq("id", GUIDES.a2.id), "42501");
    expect((await guideRow(GUIDES.a2.id)).operator_id).toBe(A);
  });

  it("the contact email is unique per operator, case-insensitively, and free across operators", async () => {
    const email = uniqueEmail("dup-guide");
    const adminA = await clientFor("adminA");
    const first = await adminA.from("guides").insert({ operator_id: A, name: "Dup 1", email: email.toUpperCase() }).select("id").single();
    expect(first.error).toBeNull();
    cleanupGuides.push(first.data?.id as string);
    expectSqlState(await adminA.from("guides").insert({ operator_id: A, name: "Dup 2", email }), "23505");

    const adminAB = await clientFor("adminAB");
    const inB = await adminAB.from("guides").insert({ operator_id: B, name: "Dup B", email }).select("id").single();
    expect(inB.error).toBeNull();
    cleanupGuides.push(inB.data?.id as string);
  });
});

describe("guía membership requires a linked guide (R19, guide_not_linked)", () => {
  it("fails without a matching guides.user_id and succeeds after linking the guide", async () => {
    const user = await createTestUser(admin, { email: uniqueEmail("unlinked"), staff: false });
    cleanupUsers.push(user);
    const guideId = await insertGuide(A, { name: "Link me", email: user.email });
    const adminA = await clientFor("adminA");

    expectTypedError(await adminA.from("memberships").insert({ user_id: user.id, operator_id: A, role: "guia" }), "guide_not_linked");

    const linked = await adminA.from("guides").update({ user_id: user.id }).eq("id", guideId).select("id");
    expect(linked.error).toBeNull();
    const inserted = await adminA.from("memberships").insert({ user_id: user.id, operator_id: A, role: "guia" }).select("role");
    expect(inserted.error).toBeNull();
    expect(inserted.data).toEqual([{ role: "guia" }]);

    // The link cannot be cleared while the account holds the role.
    expectTypedError(await adminA.from("guides").update({ user_id: null }).eq("id", guideId), "guide_has_access");
  });

  it("a guide of another operator does not count", async () => {
    const user = await createTestUser(admin, { email: uniqueEmail("cross-link"), staff: false });
    cleanupUsers.push(user);
    const adminAB = await clientFor("adminAB");
    const guideB = await insertGuide(B, { name: "In B", email: null });
    expect((await adminAB.from("guides").update({ user_id: user.id }).eq("id", guideB).select("id")).error).toBeNull();
    expectTypedError(await adminAB.from("memberships").insert({ user_id: user.id, operator_id: A, role: "guia" }), "guide_not_linked");
  });
});

describe("guide actions", () => {
  let guideId: string;
  let guideEmail: string;
  let guiaJar: CookieJar;

  it("creates a guide and opens its record; validation answers carry the input back", async () => {
    await signIn(seedUser("adminA"), A);
    const invalid = await createGuideAction(IDLE, guideForm({ name: " ", maxDailyHours: "30" }));
    expect(invalid).toMatchObject({
      status: "error",
      error: "invalid",
      fieldErrors: { name: "validation.nameRequired", maxDailyHours: "validation.hoursInvalid" },
      values: { maxDailyHours: "30" },
    });

    guideEmail = uniqueEmail("guide-access");
    const target = await expectRedirect(() =>
      createGuideAction(IDLE, guideForm({ name: "Ana Access", email: guideEmail, languages: "es, en", maxDailyHours: "8" })),
    );
    const match = /^\/es\/guides\/([0-9a-f-]{36})$/.exec(target);
    expect(match).not.toBeNull();
    guideId = match?.[1] as string;
    cleanupGuides.push(guideId);
    expect(await guideRow(guideId)).toMatchObject({ operator_id: A, name: "Ana Access", email: guideEmail, active: true, user_id: null });
  });

  it("edits a guide and found-checks the target, including another operator's guide", async () => {
    expect(await updateGuideAction(IDLE, guideForm({ guideId, name: "Ana María Access", email: guideEmail }))).toEqual({ status: "ok" });
    expect((await guideRow(guideId)).name).toBe("Ana María Access");

    expect(
      await updateGuideAction(IDLE, guideForm({ guideId: "00000000-0000-4000-8000-000000000000", name: "Ghost" })),
    ).toMatchObject({ status: "error", error: "not_found" });
    expect(await updateGuideAction(IDLE, guideForm({ guideId: GUIDES.b1.id, name: "Hijacked" }))).toMatchObject({
      status: "error",
      error: "not_found",
    });
    expect((await guideRow(GUIDES.b1.id)).name).toBe(GUIDES.b1.name);
    expect(await updateGuideAction(IDLE, guideForm({ guideId: "not-a-uuid", name: "X" }))).toMatchObject({
      status: "error",
      error: "invalid",
    });
  });

  it("refuses reservas on every guide action", async () => {
    await signIn(seedUser("reservasA"), A);
    expect(await createGuideAction(IDLE, guideForm({ name: "Nope" }))).toMatchObject({ status: "error", error: "forbidden" });
    expect(await sendGuideAccessAction(IDLE, form({ guideId }))).toEqual({ status: "error", error: "forbidden" });
    expect(await setGuideActiveAction(IDLE, form({ guideId, active: "false" }))).toEqual({ status: "error", error: "forbidden" });
    await signIn(seedUser("adminA"), A);
  });

  it("sending access creates the account without an invite mail, links it, and only a magic link arrives", async () => {
    const usersBefore = await sql()`select count(*)::int as n from auth.users`;
    expect(await countMessagesTo(guideEmail)).toBe(0);

    expect(await sendGuideAccessAction(IDLE, form({ guideId }))).toEqual({ status: "ok" });

    const [user] = await sql()`
      select id, email_confirmed_at, invited_at, raw_app_meta_data from auth.users where email = ${guideEmail}`;
    expect(user).toBeDefined();
    cleanupUsers.push({ id: user.id as string, email: guideEmail });
    expect((await sql()`select count(*)::int as n from auth.users`)[0].n).toBe(usersBefore[0].n + 1);
    expect(user.email_confirmed_at).not.toBeNull();
    // Created confirmed, never invited (GoTrue stores a random password hash nobody knows).
    expect(user.invited_at).toBeNull();
    expect((user.raw_app_meta_data as Record<string, unknown>).password_set_at).toBeUndefined();
    expect((await guideRow(guideId)).user_id).toBe(user.id);
    expect(await membershipsOf(user.id as string)).toEqual([{ id: expect.any(String), operator_id: A, role: "guia" }]);

    const link = await waitForAuthLink(guideEmail, 0);
    expect(link.type).toBe("magiclink");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await countMessagesTo(guideEmail)).toBe(1);

    // The guide follows the link: a guía context with the guide id, never sent to set-password.
    guiaJar = new CookieJar();
    jar = guiaJar;
    const response = await confirmGET(
      new NextRequest(new URL(`/auth/confirm?token_hash=${link.tokenHash}&type=${link.type}`, "http://localhost:3000")),
    );
    expect(response.headers.get("location")).toBe("http://localhost:3000/es");
    const ctx = await getOperatorContext();
    expect(ctx).toMatchObject({ role: "guia", guideId, operator: { id: A }, user: { passwordSetAt: null } });
    expect(shellGate(ctx)).toBeNull();
  });

  it("refuses access for an inactive guide, a guide without email and a staff member of the operator", async () => {
    await signIn(seedUser("adminA"), A);
    const noEmail = await insertGuide(A, { name: "No email" });
    expect(await sendGuideAccessAction(IDLE, form({ guideId: noEmail }))).toEqual({ status: "error", error: "guide_email_required" });

    const staffGuide = await insertGuide(A, { name: "Reservas as guide", email: seedUser("reservasA").email });
    expect(await sendGuideAccessAction(IDLE, form({ guideId: staffGuide }))).toEqual({ status: "error", error: "duplicate" });
    expect((await guideRow(staffGuide)).user_id).toBeNull();
    expect(await membershipsOf(seedUser("reservasA").id)).toEqual([{ id: expect.any(String), operator_id: A, role: "reservas" }]);

    const inactive = await insertGuide(A, { name: "Inactive", email: uniqueEmail("inactive-guide") });
    await admin.from("guides").update({ active: false }).eq("id", inactive);
    expect(await sendGuideAccessAction(IDLE, form({ guideId: inactive }))).toEqual({ status: "error", error: "guide_inactive" });

    expect(await sendGuideAccessAction(IDLE, form({ guideId: GUIDES.b1.id }))).toEqual({ status: "error", error: "not_found" });
  });

  it("deactivating a guide removes their membership (audited) and their next request yields no context", async () => {
    const { user_id: userId } = await guideRow(guideId);
    const [membership] = await membershipsOf(userId as string);

    expect(await setGuideActiveAction(IDLE, form({ guideId, active: "false" }))).toEqual({ status: "ok" });
    expect(await guideRow(guideId)).toMatchObject({ active: false, user_id: userId });
    expect(await membershipsOf(userId as string)).toEqual([]);
    const audit = await sql()`
      select op, actor_id, actor_source from audit.events
      where table_name = 'memberships' and record_id = ${membership.id} order by id`;
    expect(audit.map((row) => row.op)).toEqual(["insert", "delete"]);
    expect(audit[0]).toMatchObject({ actor_id: seedUser("adminA").id, actor_source: "jwt" });
    expect(audit[1]).toMatchObject({ actor_id: seedUser("adminA").id, actor_source: "jwt" });

    jar = guiaJar;
    expect(await getOperatorContext()).toBeNull();

    await signIn(seedUser("adminA"), A);
    expect(await setGuideActiveAction(IDLE, form({ guideId, active: "true" }))).toEqual({ status: "ok" });
    expect(await membershipsOf(userId as string)).toEqual([]);
  });

  it("deleting the auth user of a guide keeps the guide with user_id null", async () => {
    const { user_id: userId } = await guideRow(guideId);
    await deleteTestUser(admin, userId as string, guideEmail);
    expect((await guideRow(guideId)).user_id).toBeNull();
  });
});
