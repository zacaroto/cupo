// U3 authentication, session context and shell gate against the local stack.
//
// Harness choice: the real server actions, the real /auth/confirm route
// handler, the real @supabase/ssr server client and the real DAL run here;
// only `next/headers` is replaced by an in-memory cookie jar (one per
// simulated browser) and `server-only` by an empty module. A `redirect()`
// surfaces as the NEXT_REDIRECT error Next.js would turn into a response.
// The (app) layout is a thin `shellGate(getOperatorContext())` call, so the
// set-password redirect is asserted on that pair; the full HTTP round trip is
// covered by the manual verification on `next start`.
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATORS } from "./fixtures.ts";
import {
  adminClient,
  anonClient,
  closeSql,
  createTestUser,
  deleteTestUser,
  seedUser,
  sql,
  uniqueEmail,
} from "./helpers.ts";
import { countMessagesTo, waitForAuthLink } from "./mailpit.ts";

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

  authCookieNames(): string[] {
    return [...this.cookies.keys()].filter((name) => /^sb-.+-auth-token(\.\d+)?$/.test(name));
  }
}

let jar = new CookieJar();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => jar,
  headers: async () => new Headers({ origin: "http://localhost:3000", host: "localhost:3000" }),
}));

const { loginAction } = await import("../../apps/web/src/app/[locale]/(auth)/login/actions.ts");
const { resetPasswordAction } = await import("../../apps/web/src/app/[locale]/(auth)/reset-password/actions.ts");
const { setPasswordAction } = await import("../../apps/web/src/app/[locale]/(auth)/set-password/actions.ts");
const { signOutAction, switchOperatorAction } = await import("../../apps/web/src/app/[locale]/(app)/actions.ts");
const { GET: confirmGET } = await import("../../apps/web/src/app/auth/confirm/route.ts");
const { ACTIVE_OPERATOR_COOKIE, getOperatorContext, requireOperatorContext, shellGate } = await import(
  "../../apps/web/src/lib/dal/context.ts"
);
const { ForbiddenError } = await import("../../apps/web/src/lib/dal/errors.ts");
const { createClient: createServerClient } = await import("../../apps/web/src/lib/supabase/server.ts");

const A = OPERATORS.a.id;
const B = OPERATORS.b.id;
const C = OPERATORS.c.id;
const admin = adminClient();
const cleanup: Array<{ id: string; email: string }> = [];

beforeEach(() => {
  jar = new CookieJar();
});

afterAll(async () => {
  for (const user of cleanup) await deleteTestUser(admin, user.id, user.email);
  await closeSql();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** Runs a server action that must redirect and returns the target path. */
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

async function signInWithPassword(email: string, password: string): Promise<string> {
  return expectRedirect(() => loginAction({ status: "idle" }, form({ locale: "es", intent: "password", email, password })));
}

function confirm(query: string): Promise<Response> {
  return confirmGET(new NextRequest(new URL(`/auth/confirm${query}`, "http://localhost:3000")));
}

async function authUserCount(): Promise<number> {
  const [row] = await sql()`select count(*)::int as n from auth.users`;
  return row.n as number;
}

/** An invited staff user (no password, no password_set_at) with a reservas membership in A. */
async function inviteStaff(prefix: string): Promise<{ id: string; email: string }> {
  const email = uniqueEmail(prefix);
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: "http://localhost:3000" });
  if (error || !data.user) throw new Error(`inviteUserByEmail failed: ${error?.message}`);
  cleanup.push({ id: data.user.id, email });
  const { error: rpcError } = await admin.rpc("admin_seed_membership", {
    actor_id: null as unknown as string,
    user_id: data.user.id,
    operator_id: A,
    role: "reservas",
  });
  if (rpcError) throw new Error(`admin_seed_membership failed: ${rpcError.message}`);
  return { id: data.user.id, email };
}

describe("password sign-in (R8)", () => {
  it("signs a seeded staff user in, stores the session cookies and reads their operator under RLS", async () => {
    const reservas = seedUser("reservasA");
    expect(await signInWithPassword(reservas.email, reservas.password)).toBe("/es");
    expect(jar.authCookieNames().length).toBeGreaterThan(0);
    // Written by the login action itself: pages cannot write cookies later.
    expect(jar.get(ACTIVE_OPERATOR_COOKIE)?.value).toBe(`${reservas.id}:${A}`);

    const supabase = await createServerClient();
    const { data, error } = await supabase.from("operators").select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: A }]);

    const ctx = await getOperatorContext();
    expect(ctx).toMatchObject({ role: "reservas", operator: { id: A, name: OPERATORS.a.name } });
    expect(shellGate(ctx)).toBeNull();
  });

  it("answers a wrong password with invalid_credentials and sets no session", async () => {
    const state = await loginAction(
      { status: "idle" },
      form({ locale: "es", intent: "password", email: seedUser("adminA").email, password: "wrong-password-1" }),
    );
    expect(state).toEqual({ status: "error", error: "invalid_credentials" });
    expect(jar.authCookieNames()).toEqual([]);
  });

  it("validates the form before calling Supabase", async () => {
    const state = await loginAction({ status: "idle" }, form({ locale: "es", intent: "password", email: "nope", password: "" }));
    expect(state).toMatchObject({ status: "error", error: "invalid", fieldErrors: { email: "validation.emailInvalid" } });
  });
});

describe("magic link and reset parity (R9, U3 approach 4)", () => {
  it("answers an unknown email exactly like a known one and creates no user", async () => {
    const unknown = uniqueEmail("nobody");
    const usersBefore = await authUserCount();

    // reservasB: a real account that no other test in this file mails (max_frequency is 1 s per user).
    const known = await loginAction({ status: "idle" }, form({ locale: "es", intent: "link", email: seedUser("reservasB").email }));
    const missing = await loginAction({ status: "idle" }, form({ locale: "es", intent: "link", email: unknown }));

    expect(missing).toEqual(known);
    expect(known).toEqual({ status: "sent" });
    expect(await authUserCount()).toBe(usersBefore);
    const { data: profile } = await admin.from("profiles").select("id").ilike("email", unknown).maybeSingle();
    expect(profile).toBeNull();
    expect(await countMessagesTo(unknown)).toBe(0);
  });

  it("answers a password reset for an unknown email like a known one", async () => {
    const usersBefore = await authUserCount();
    const known = await resetPasswordAction({ status: "idle" }, form({ email: seedUser("contabilidadA").email }));
    const missing = await resetPasswordAction({ status: "idle" }, form({ email: uniqueEmail("nobody") }));
    expect(missing).toEqual(known);
    expect(known).toEqual({ status: "sent" });
    expect(await authUserCount()).toBe(usersBefore);
  });
});

describe("guía magic link (R8, F5)", () => {
  it("follows the emailed link through /auth/confirm into a guía context that is never sent to set-password", async () => {
    const guia = seedUser("guiaA");
    const seen = await countMessagesTo(guia.email);
    const state = await loginAction({ status: "idle" }, form({ locale: "es", intent: "link", email: guia.email }));
    expect(state).toEqual({ status: "sent" });

    const link = await waitForAuthLink(guia.email, seen);
    expect(link.type).toBe("magiclink");
    expect(link.href.startsWith("http://localhost:3000/auth/confirm?")).toBe(true);

    const response = await confirm(`?token_hash=${link.tokenHash}&type=${link.type}`);
    expect(response.status).toBe(303);
    // Home; the home page sends a guía on to the agenda.
    expect(response.headers.get("location")).toBe("http://localhost:3000/es");
    expect(jar.get(ACTIVE_OPERATOR_COOKIE)?.value).toBe(`${guia.id}:${A}`);

    const ctx = await getOperatorContext();
    expect(ctx?.role).toBe("guia");
    expect(ctx?.user.passwordSetAt).toBeNull();
    expect(shellGate(ctx)).toBeNull();
  });
});

describe("invite and set-password (R13, KTD8)", () => {
  it("lands an invite on set-password, gates the shell until a password is set, then lets it through", async () => {
    const invited = await inviteStaff("invited");
    const link = await waitForAuthLink(invited.email, 0);
    expect(link.type).toBe("invite");

    // A different type for the same token fails verification and leaves it unused.
    const wrongType = await confirm(`?token_hash=${link.tokenHash}&type=magiclink`);
    expect(wrongType.headers.get("location")).toBe("http://localhost:3000/es/login?error=link_invalid");
    expect(jar.authCookieNames()).toEqual([]);

    const response = await confirm(`?token_hash=${link.tokenHash}&type=invite&next=${encodeURIComponent("/es/reservations")}`);
    expect(response.headers.get("location")).toBe("http://localhost:3000/es/set-password");

    // What the (app) layout does on /es/reservations: a staff context without a password.
    const before = await getOperatorContext();
    expect(before).toMatchObject({ role: "reservas", user: { passwordSetAt: null } });
    expect(shellGate(before)).toBe("set-password");

    const password = "Chosen1234pass";
    const mismatch = await setPasswordAction(
      { status: "idle" },
      form({ locale: "es", password, confirmPassword: `${password}x` }),
    );
    expect(mismatch).toMatchObject({ status: "error", fieldErrors: { confirmPassword: "validation.passwordMismatch" } });

    expect(
      await expectRedirect(() => setPasswordAction({ status: "idle" }, form({ locale: "es", password, confirmPassword: password }))),
    ).toBe("/es");

    // The refreshed cookies already carry password_set_at: the next request is not redirected.
    const after = await getOperatorContext();
    expect(after?.user.passwordSetAt).toEqual(expect.any(String));
    expect(shellGate(after)).toBeNull();

    const { data } = await admin.auth.admin.getUserById(invited.id);
    expect(data.user?.app_metadata.password_set_at).toEqual(expect.any(String));
    expect(data.user?.app_metadata.provider).toBe("email");

    jar = new CookieJar();
    expect(await signInWithPassword(invited.email, password)).toBe("/es");
  });

  it("an invite token verified as type=email still cannot reach the app without a password", async () => {
    const invited = await inviteStaff("invited-email");
    const link = await waitForAuthLink(invited.email, 0);

    const response = await confirm(`?token_hash=${link.tokenHash}&type=email`);
    // GoTrue accepts the invite token for type=email; the route sends it home...
    expect(response.headers.get("location")).toBe("http://localhost:3000/es");
    // ...and the shell gate sends the passwordless staff context to set-password.
    expect(shellGate(await getOperatorContext())).toBe("set-password");
  });

  it("rejects a missing token without touching Supabase", async () => {
    const response = await confirm("?type=invite");
    expect(response.headers.get("location")).toBe("http://localhost:3000/es/login?error=link_invalid");
  });
});

describe("removed membership (AE7, R5)", () => {
  it("makes the next resolution return null, requireOperatorContext throw ForbiddenError and clears the cookie", async () => {
    const user = await createTestUser(admin, {
      email: uniqueEmail("ae7"),
      memberships: [{ operatorId: A, role: "reservas" }],
    });
    cleanup.push(user);
    await signInWithPassword(user.email, user.password);

    const ctx = await getOperatorContext();
    expect(ctx?.operator.id).toBe(A);
    expect(jar.get(ACTIVE_OPERATOR_COOKIE)?.value).toBe(`${user.id}:${A}`);

    const { error } = await admin.from("memberships").delete().eq("user_id", user.id).eq("operator_id", A);
    expect(error).toBeNull();

    expect(await getOperatorContext()).toBeNull();
    await expect(requireOperatorContext("reservations.read")).rejects.toBeInstanceOf(ForbiddenError);
    expect(shellGate(null)).toBe("no-access");
    expect(jar.has(ACTIVE_OPERATOR_COOKIE)).toBe(false);
  });
});

describe("operator switch (R14, F6)", () => {
  it("refuses a non-member operator with forbidden and leaves the cookie unchanged", async () => {
    const adminAB = seedUser("adminAB");
    await signInWithPassword(adminAB.email, adminAB.password);
    // The cookie the login wrote, before any page resolves the context.
    const cookieBefore = jar.get(ACTIVE_OPERATOR_COOKIE)?.value;
    const ctx = await getOperatorContext();
    expect(ctx?.memberships.map((m) => m.operatorId).sort()).toEqual([A, B].sort());
    expect(cookieBefore).toBe(`${adminAB.id}:${ctx?.operator.id}`);

    const state = await switchOperatorAction({ status: "idle" }, form({ locale: "es", operatorId: C }));
    expect(state).toEqual({ status: "error", error: "forbidden" });
    expect(jar.get(ACTIVE_OPERATOR_COOKIE)?.value).toBe(cookieBefore);

    const malformed = await switchOperatorAction({ status: "idle" }, form({ locale: "es", operatorId: `${C}'--` }));
    expect(malformed).toMatchObject({ status: "error", error: "invalid" });
    expect(jar.get(ACTIVE_OPERATOR_COOKIE)?.value).toBe(cookieBefore);
  });

  it("switches to another membership and the next context follows it", async () => {
    const adminAB = seedUser("adminAB");
    await signInWithPassword(adminAB.email, adminAB.password);
    const current = (await getOperatorContext())?.operator.id;
    const target = current === A ? B : A;

    expect(await expectRedirect(() => switchOperatorAction({ status: "idle" }, form({ locale: "en", operatorId: target })))).toBe(
      "/en",
    );
    expect(jar.get(ACTIVE_OPERATOR_COOKIE)?.value).toBe(`${adminAB.id}:${target}`);
    expect((await getOperatorContext())?.operator.id).toBe(target);
  });

  it("refuses an unauthenticated switch", async () => {
    const state = await switchOperatorAction({ status: "idle" }, form({ locale: "es", operatorId: A }));
    expect(state).toEqual({ status: "error", error: "unauthenticated" });
  });
});

describe("sign-out (R14)", () => {
  it("clears the Supabase cookies and active_operator_id and revokes the session", async () => {
    const user = await createTestUser(admin, {
      email: uniqueEmail("signout"),
      memberships: [{ operatorId: A, role: "contabilidad" }],
    });
    cleanup.push(user);
    await signInWithPassword(user.email, user.password);
    await getOperatorContext();
    expect(jar.has(ACTIVE_OPERATOR_COOKIE)).toBe(true);
    expect(jar.authCookieNames().length).toBeGreaterThan(0);

    const supabase = await createServerClient();
    const { data: before } = await supabase.auth.getSession();
    const refreshToken = before.session?.refresh_token;
    expect(refreshToken).toEqual(expect.any(String));

    expect(await expectRedirect(() => signOutAction(form({ locale: "es" })))).toBe("/es/login");
    expect(jar.has(ACTIVE_OPERATOR_COOKIE)).toBe(false);
    expect(jar.authCookieNames()).toEqual([]);

    const { error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken as string });
    expect(error).not.toBeNull();
  });
});
