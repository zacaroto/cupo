// U4 members against the local stack: the real invite, role, removal and
// resend actions with the real DAL and Supabase clients; only `next/headers`
// (cookie jar), `next/cache` (refresh needs a request) and `server-only` are
// replaced. Emails are read back from Mailpit; the suite sends four mails in
// total to stay well under the local limit of 30 per hour.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OPERATORS } from "./fixtures.ts";
import {
  adminClient,
  clientFor,
  closeSql,
  createTestUser,
  deleteTestUser,
  expectSqlState,
  seedUser,
  sql,
  uniqueEmail,
} from "./helpers.ts";
import { countMessagesTo, waitForAuthLink } from "./mailpit.ts";
import { CookieJar, expectRedirect, form, mailerFailure, requestHeaders, withFetch } from "./next-harness.ts";

let jar = new CookieJar();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => requestHeaders() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

const { loginAction } = await import("../../apps/web/src/app/[locale]/(auth)/login/actions.ts");
const { changeRoleAction, inviteMemberAction, removeMemberAction, resendAccessAction } = await import(
  "../../apps/web/src/app/[locale]/(app)/members/actions.ts"
);
const { ACTIVE_OPERATOR_COOKIE, getOperatorContext } = await import("../../apps/web/src/lib/dal/context.ts");

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const admin = adminClient();
const cleanupUsers: Array<{ id: string; email?: string }> = [];
const IDLE = { status: "idle" } as const;

afterAll(async () => {
  for (const user of cleanupUsers) await deleteTestUser(admin, user.id, user.email);
  await closeSql();
});

/** Signs a user in through the login action into a fresh jar, optionally pinning the active operator. */
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

async function authUserCount(): Promise<number> {
  const [row] = await sql()`select count(*)::int as n from auth.users`;
  return row.n as number;
}

async function userIdByEmail(email: string): Promise<string | null> {
  const [row] = await sql()`select id from auth.users where lower(email) = lower(${email})`;
  return (row?.id as string | undefined) ?? null;
}

async function membershipsOf(userId: string): Promise<Array<{ id: string; operator_id: string; role: string }>> {
  const { data, error } = await admin.from("memberships").select("id, operator_id, role").eq("user_id", userId);
  if (error) throw error;
  return data;
}

async function auditRows(recordId: string) {
  return sql()`
    select op, actor_id, actor_source from audit.events
    where table_name = 'memberships' and record_id = ${recordId}
    order by id`;
}

const SECRET_MARKERS = ["action_link", "hashed_token", "token_hash"];

describe("invite (R9, AE9, KTD8)", () => {
  let newEmailState: unknown;
  let invited: { id: string; email: string; membershipId: string };

  it("invites a new email: one invite mail, the membership in A, audited with the administrador as actor", async () => {
    const adminA = seedUser("adminA");
    await signIn(adminA, A);
    const email = uniqueEmail("invite-new");

    newEmailState = await inviteMemberAction(IDLE, form({ email: email.toUpperCase(), role: "reservas" }));
    expect(newEmailState).toEqual({ status: "ok" });

    const link = await waitForAuthLink(email, 0);
    expect(link.type).toBe("invite");
    expect(link.href.startsWith("http://localhost:3000/auth/confirm?")).toBe(true);

    const userId = await userIdByEmail(email);
    expect(userId).not.toBeNull();
    cleanupUsers.push({ id: userId as string, email });
    const memberships = await membershipsOf(userId as string);
    expect(memberships).toEqual([{ id: expect.any(String), operator_id: A, role: "reservas" }]);
    invited = { id: userId as string, email, membershipId: memberships[0].id };

    expect(await auditRows(invited.membershipId)).toEqual([{ op: "insert", actor_id: adminA.id, actor_source: "jwt" }]);
  });

  it("AE9: an email already registered to A, invited from B, gets B's membership and a sign-in link, no second user, same state", async () => {
    const existing = await createTestUser(admin, { email: uniqueEmail("ae9"), memberships: [{ operatorId: A, role: "reservas" }] });
    cleanupUsers.push(existing);
    await signIn(seedUser("adminAB"), B);
    const usersBefore = await authUserCount();
    const seen = await countMessagesTo(existing.email);
    const logged = vi.spyOn(console, "log");
    const warned = vi.spyOn(console, "warn");
    const errored = vi.spyOn(console, "error");

    const { result: state, exchanges } = await withFetch(() =>
      inviteMemberAction(IDLE, form({ email: existing.email, role: "contabilidad" })),
    );

    expect(state).toEqual(newEmailState);
    expect(await authUserCount()).toBe(usersBefore);
    expect((await membershipsOf(existing.id)).map(({ operator_id, role }) => ({ operator_id, role })).sort((x, y) => x.operator_id.localeCompare(y.operator_id))).toEqual([
      { operator_id: A, role: "reservas" },
      { operator_id: B, role: "contabilidad" },
    ]);

    const link = await waitForAuthLink(existing.email, seen);
    expect(link.type).toBe("magiclink");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await countMessagesTo(existing.email)).toBe(seen + 1);

    // The action talked to the invite endpoint, the profiles lookup and the
    // OTP endpoint, and never received a minted link or token.
    expect(exchanges.some((e) => e.url.includes("/auth/v1/invite") && e.status === 422)).toBe(true);
    expect(exchanges.some((e) => e.url.includes("/auth/v1/otp") && e.status === 200)).toBe(true);
    expect(exchanges.some((e) => e.url.includes("/auth/v1/admin/generate_link"))).toBe(false);
    for (const exchange of exchanges) {
      for (const marker of SECRET_MARKERS) expect(exchange.body, exchange.url).not.toContain(marker);
    }
    const logs = [...logged.mock.calls, ...warned.mock.calls, ...errored.mock.calls].flat().map(String).join("\n");
    for (const marker of [...SECRET_MARKERS, existing.email]) expect(logs).not.toContain(marker);
    logged.mockRestore();
    warned.mockRestore();
    errored.mockRestore();
  });

  it("inviting an email that is already a member of the operator answers duplicate and leaves one membership", async () => {
    const member = await createTestUser(admin, { email: uniqueEmail("dup"), memberships: [{ operatorId: A, role: "contabilidad" }] });
    cleanupUsers.push(member);
    await signIn(seedUser("adminA"), A);
    const state = await inviteMemberAction(IDLE, form({ email: member.email, role: "reservas" }));
    expect(state).toMatchObject({ status: "error", error: "duplicate" });
    expect(await membershipsOf(member.id)).toEqual([{ id: expect.any(String), operator_id: A, role: "contabilidad" }]);
  });

  it("answers every email failure with one state, for new and existing emails, and leaves no membership behind", async () => {
    await signIn(seedUser("adminA"), A);
    const existing = await createTestUser(admin, { email: uniqueEmail("mailfail"), memberships: [{ operatorId: B, role: "reservas" }] });
    cleanupUsers.push(existing);
    const fresh = uniqueEmail("mailfail-new");

    const { result: existingState } = await withFetch(
      () => inviteMemberAction(IDLE, form({ email: existing.email, role: "reservas" })),
      (url) => (url.includes("/auth/v1/otp") ? mailerFailure() : undefined),
    );
    const { result: newState } = await withFetch(
      () => inviteMemberAction(IDLE, form({ email: fresh, role: "reservas" })),
      (url) => (url.includes("/auth/v1/invite") ? mailerFailure() : undefined),
    );

    const strip = (state: unknown) => ({ ...(state as Record<string, unknown>), values: undefined });
    expect(strip(existingState)).toEqual({ status: "error", error: "email_failed", values: undefined });
    expect(strip(newState)).toEqual(strip(existingState));
    // The form gets its input back.
    expect(newState).toMatchObject({ values: { email: fresh, role: "reservas" } });

    expect(await membershipsOf(existing.id)).toEqual([{ id: expect.any(String), operator_id: B, role: "reservas" }]);
    expect(await userIdByEmail(fresh)).toBeNull();
    const rows = await sql()`
      select op, actor_id from audit.events
      where table_name = 'memberships' and operator_id = ${A} and new_record ->> 'user_id' = ${existing.id}
         or table_name = 'memberships' and operator_id = ${A} and old_record ->> 'user_id' = ${existing.id}
      order by id`;
    expect(rows).toEqual([
      { op: "insert", actor_id: seedUser("adminA").id },
      { op: "delete", actor_id: seedUser("adminA").id },
    ]);
  });

  it("refuses a reservas user (forbidden, nothing created) and a direct insert into memberships", async () => {
    await signIn(seedUser("reservasA"), A);
    const email = uniqueEmail("forbidden");
    const state = await inviteMemberAction(IDLE, form({ email, role: "reservas" }));
    expect(state).toMatchObject({ status: "error", error: "forbidden" });
    expect(await userIdByEmail(email)).toBeNull();

    const reservas = await clientFor("reservasA");
    const target = await createTestUser(admin, { email: uniqueEmail("direct") });
    cleanupUsers.push(target);
    expectSqlState(await reservas.from("memberships").insert({ user_id: target.id, operator_id: A, role: "reservas" }), "42501");
    expect(await membershipsOf(target.id)).toEqual([]);
  });

  it("resends the invite to a member who never accepted it", async () => {
    await signIn(seedUser("adminA"), A);
    const seen = await countMessagesTo(invited.email);
    const state = await resendAccessAction(IDLE, form({ membershipId: invited.membershipId }));
    expect(state).toEqual({ status: "ok" });
    const link = await waitForAuthLink(invited.email, seen);
    expect(link.type).toBe("invite");
    expect(await userIdByEmail(invited.email)).toBe(invited.id);
  });
});

describe("role changes and removal (R12, AE6 at the action layer)", () => {
  let operatorId: string;
  let owner: { id: string; email: string; password: string };
  let member: { id: string; email: string; password: string };

  async function membershipId(userId: string, operator: string): Promise<string> {
    const { data, error } = await admin.from("memberships").select("id").eq("user_id", userId).eq("operator_id", operator).single();
    if (error) throw error;
    return data.id;
  }

  beforeAll(async () => {
    const slug = `members-test-${randomBytes(3).toString("hex")}`;
    owner = await createTestUser(admin, { email: uniqueEmail("sole-admin") });
    const { data, error } = await admin.rpc("admin_bootstrap_operator", {
      actor_id: null as unknown as string,
      name: `Test ${slug}`,
      slug,
      timezone: "America/Costa_Rica",
      currency: "USD",
      locale: "es",
      admin_user_id: owner.id,
    });
    if (error) throw error;
    operatorId = data;
    member = await createTestUser(admin, { email: uniqueEmail("member"), memberships: [{ operatorId, role: "reservas" }] });
    await signIn(owner, operatorId);
  });

  afterAll(async () => {
    // Deactivating releases the last-administrador rule (U2), then users and operator go.
    await admin.from("operators").update({ status: "inactive" }).eq("id", operatorId);
    for (const user of [owner, member]) await deleteTestUser(admin, user.id, user.email);
    await admin.from("memberships").delete().eq("operator_id", operatorId);
    await admin.from("operators").delete().eq("id", operatorId);
  });

  it("demoting or removing the last administrador through the actions answers last_administrador", async () => {
    const own = await membershipId(owner.id, operatorId);
    expect(await changeRoleAction(IDLE, form({ membershipId: own, role: "reservas" }))).toEqual({
      status: "error",
      error: "last_administrador",
    });
    expect(await removeMemberAction(IDLE, form({ membershipId: own }))).toEqual({ status: "error", error: "last_administrador" });
    expect(await membershipsOf(owner.id)).toEqual([{ id: own, operator_id: operatorId, role: "administrador" }]);
  });

  it("changes a member's role, and refuses guía without a linked guide", async () => {
    const id = await membershipId(member.id, operatorId);
    expect(await changeRoleAction(IDLE, form({ membershipId: id, role: "contabilidad" }))).toEqual({ status: "ok" });
    expect(await membershipsOf(member.id)).toEqual([{ id, operator_id: operatorId, role: "contabilidad" }]);
    expect(await changeRoleAction(IDLE, form({ membershipId: id, role: "guia" }))).toEqual({
      status: "error",
      error: "guide_not_linked",
    });
  });

  it("validates ids and found-checks: unknown, malformed and another operator's membership", async () => {
    expect(await removeMemberAction(IDLE, form({ membershipId: "00000000-0000-4000-8000-000000000000" }))).toEqual({
      status: "error",
      error: "not_found",
    });
    expect(await removeMemberAction(IDLE, form({ membershipId: "x' or 1=1" }))).toMatchObject({ status: "error", error: "invalid" });
    const foreign = await membershipId(seedUser("reservasA").id, A);
    expect(await changeRoleAction(IDLE, form({ membershipId: foreign, role: "administrador" }))).toEqual({
      status: "error",
      error: "not_found",
    });
    expect(await membershipsOf(seedUser("reservasA").id)).toEqual([{ id: foreign, operator_id: A, role: "reservas" }]);
  });

  it("removes a member with one audit row naming the administrador", async () => {
    const id = await membershipId(member.id, operatorId);
    expect(await removeMemberAction(IDLE, form({ membershipId: id }))).toEqual({ status: "ok" });
    expect(await membershipsOf(member.id)).toEqual([]);
    const deletes = (await auditRows(id)).filter((row) => row.op === "delete");
    expect(deletes).toEqual([{ op: "delete", actor_id: owner.id, actor_source: "jwt" }]);
  });

  it("refuses a staff user of another operator calling the actions", async () => {
    await signIn(seedUser("contabilidadA"), A);
    const own = await membershipId(owner.id, operatorId);
    expect(await changeRoleAction(IDLE, form({ membershipId: own, role: "reservas" }))).toEqual({ status: "error", error: "forbidden" });
    expect(await removeMemberAction(IDLE, form({ membershipId: own }))).toEqual({ status: "error", error: "forbidden" });
    await signIn(owner, operatorId);
  });
});
