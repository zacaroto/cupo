import { beforeEach, describe, expect, it, vi } from "vitest";

// context.ts is server-only and reads cookies through next/headers; the pure
// functions are tested directly and the I/O wrapper with these fakes.
vi.mock("server-only", () => ({}));
const cookieJar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) as string } : undefined),
  set: vi.fn((name: string, value: string) => void cookieJar.set(name, value)),
  delete: vi.fn((name: string) => void cookieJar.delete(name)),
};
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
let fakeClient: unknown;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient }));

import { ForbiddenError, UnauthenticatedError } from "./errors";
import {
  ACTIVE_OPERATOR_COOKIE,
  activeOperatorCookieOptions,
  formatActiveOperatorCookie,
  getOperatorContext,
  loadOperatorContext,
  parseActiveOperatorCookie,
  requireFromState,
  requireOperatorContext,
  resolveOperatorContext,
  shellGate,
  type MembershipRecord,
  type SessionUser,
} from "./context";

const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const A = "0a000000-0000-4000-8000-00000000000a";
const B = "0b000000-0000-4000-8000-00000000000b";
const C = "0c000000-0000-4000-8000-00000000000c";

const user: SessionUser = { id: U, email: "u@cupo.test", passwordSetAt: "2026-11-11T00:00:00.000Z" };

function membership(operatorId: string, role: MembershipRecord["role"], createdAt: string): MembershipRecord {
  return {
    operator: { id: operatorId, name: `Operator ${operatorId.slice(1, 2).toUpperCase()}`, timezone: "America/Costa_Rica", currency: "USD", locale: "es" },
    role,
    createdAt,
  };
}

const mA = membership(A, "administrador", "2026-01-01T00:00:00.000Z");
const mB = membership(B, "reservas", "2026-02-01T00:00:00.000Z");

describe("active operator cookie", () => {
  it("round-trips <user_id>:<operator_id> and rejects malformed values", () => {
    expect(parseActiveOperatorCookie(formatActiveOperatorCookie(U, A))).toEqual({ userId: U, operatorId: A });
    for (const bad of [undefined, "", A, `${U}:`, `:${A}`, `${U}:${A}:x`, `${U}:not-a-uuid`, `x:${A}`]) {
      expect(parseActiveOperatorCookie(bad), String(bad)).toBeNull();
    }
  });

  it("is httpOnly, sameSite lax, path / and secure outside development", () => {
    expect(activeOperatorCookieOptions("production")).toEqual({ httpOnly: true, sameSite: "lax", path: "/", secure: true });
    expect(activeOperatorCookieOptions("development").secure).toBe(false);
  });
});

describe("resolveOperatorContext (KTD3)", () => {
  it("memberships [A, B] and cookie B yield operator B without a rewrite", () => {
    const { context, cookie } = resolveOperatorContext({ user, memberships: [mA, mB], cookieValue: `${U}:${B}` });
    expect(context?.operator.id).toBe(B);
    expect(context?.role).toBe("reservas");
    expect(cookie).toEqual({ kind: "keep" });
  });

  it("cookie C (not a member) falls back to the oldest membership and marks the cookie for rewrite", () => {
    const { context, cookie } = resolveOperatorContext({ user, memberships: [mB, mA], cookieValue: `${U}:${C}` });
    expect(context?.operator.id).toBe(A);
    expect(cookie).toEqual({ kind: "set", value: `${U}:${A}` });
  });

  it("ignores and rewrites a cookie whose user part is another user", () => {
    const { context, cookie } = resolveOperatorContext({ user, memberships: [mA, mB], cookieValue: `${OTHER}:${B}` });
    expect(context?.operator.id).toBe(A);
    expect(cookie).toEqual({ kind: "set", value: `${U}:${A}` });
  });

  it("memberships [B newer, A older] fall back to A", () => {
    const { context } = resolveOperatorContext({ user, memberships: [mB, mA], cookieValue: undefined });
    expect(context?.operator.id).toBe(A);
  });

  it("writes the cookie when it is missing or malformed", () => {
    expect(resolveOperatorContext({ user, memberships: [mA], cookieValue: undefined }).cookie).toEqual({
      kind: "set",
      value: `${U}:${A}`,
    });
    expect(resolveOperatorContext({ user, memberships: [mA], cookieValue: "garbage" }).cookie).toEqual({
      kind: "set",
      value: `${U}:${A}`,
    });
  });

  it("no memberships yield null and clear a stale cookie", () => {
    expect(resolveOperatorContext({ user, memberships: [], cookieValue: `${U}:${A}` })).toEqual({
      context: null,
      cookie: { kind: "clear" },
    });
    expect(resolveOperatorContext({ user, memberships: [], cookieValue: undefined })).toEqual({
      context: null,
      cookie: { kind: "keep" },
    });
  });

  it("a guía membership yields the guide id of that operator", () => {
    const guia = membership(A, "guia", "2026-01-01T00:00:00.000Z");
    const { context } = resolveOperatorContext({
      user,
      memberships: [guia],
      cookieValue: undefined,
      guideIds: { [A]: "33333333-3333-4333-8333-333333333333", [B]: "44444444-4444-4444-8444-444444444444" },
    });
    expect(context?.role).toBe("guia");
    expect(context?.guideId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("does not attach a guide id to a staff context", () => {
    const { context } = resolveOperatorContext({
      user,
      memberships: [mA],
      cookieValue: undefined,
      guideIds: { [A]: "33333333-3333-4333-8333-333333333333" },
    });
    expect(context?.guideId).toBeUndefined();
  });

  it("lists every membership for the switcher, oldest first", () => {
    const { context } = resolveOperatorContext({ user, memberships: [mB, mA], cookieValue: `${U}:${B}` });
    expect(context?.memberships).toEqual([
      { operatorId: A, operatorName: mA.operator.name, role: "administrador" },
      { operatorId: B, operatorName: mB.operator.name, role: "reservas" },
    ]);
  });
});

describe("shellGate (R5, R13, KTD8)", () => {
  const staff = resolveOperatorContext({ user, memberships: [mA], cookieValue: undefined }).context;
  const noPassword: SessionUser = { ...user, passwordSetAt: null };

  it("sends a user without context to no-access", () => {
    expect(shellGate(null)).toBe("no-access");
  });

  it("sends a staff context without password_set_at to set-password", () => {
    const ctx = resolveOperatorContext({ user: noPassword, memberships: [mB], cookieValue: undefined }).context;
    expect(shellGate(ctx)).toBe("set-password");
  });

  it("never sends a guía context to set-password", () => {
    const ctx = resolveOperatorContext({
      user: noPassword,
      memberships: [membership(A, "guia", "2026-01-01T00:00:00.000Z")],
      cookieValue: undefined,
    }).context;
    expect(shellGate(ctx)).toBeNull();
  });

  it("asks a guía-in-A, staff-in-B user for a password only when B is active", () => {
    const memberships = [membership(A, "guia", "2026-01-01T00:00:00.000Z"), mB];
    const inA = resolveOperatorContext({ user: noPassword, memberships, cookieValue: `${U}:${A}` }).context;
    const inB = resolveOperatorContext({ user: noPassword, memberships, cookieValue: `${U}:${B}` }).context;
    expect(shellGate(inA)).toBeNull();
    expect(shellGate(inB)).toBe("set-password");
  });

  it("lets a staff context with a password through", () => {
    expect(shellGate(staff)).toBeNull();
  });
});

describe("requireFromState", () => {
  const ctx = resolveOperatorContext({ user, memberships: [mB], cookieValue: undefined }).context;

  it("throws UnauthenticatedError without a session", () => {
    expect(() => requireFromState({ user: null, context: null })).toThrow(UnauthenticatedError);
  });

  it("throws ForbiddenError(no_context) without a context (AE7)", () => {
    expect(() => requireFromState({ user, context: null }, "reservations.read")).toThrow(ForbiddenError);
    expect(() => requireFromState({ user, context: null }, "reservations.read")).toThrow(
      expect.objectContaining({ reason: "no_context" }),
    );
  });

  it("throws ForbiddenError(missing_permission) when the role lacks the action", () => {
    expect(() => requireFromState({ user, context: ctx }, "members.invite")).toThrow(
      expect.objectContaining({ reason: "missing_permission", action: "members.invite" }),
    );
  });

  it("returns the context when the role holds the action", () => {
    expect(requireFromState({ user, context: ctx }, "reservations.write")).toBe(ctx);
    expect(requireFromState({ user, context: ctx })).toBe(ctx);
  });
});

/** Minimal stand-in for the supabase-js surface the loader uses. */
function fakeSupabase(options: {
  claims: Record<string, unknown> | null;
  rows?: Array<{ role: string; created_at: string; operator: Record<string, unknown> | null }>;
  error?: { code: string; message: string } | null;
  guides?: Array<{ id: string; operator_id: string }>;
  guidesError?: { code: string; message: string } | null;
}) {
  const eq = vi.fn(async () => ({ data: options.error ? null : (options.rows ?? []), error: options.error ?? null }));
  const select = vi.fn(() => ({ eq }));
  // guides: select("id, operator_id").eq("user_id", ...).eq("active", true)
  const guidesActiveEq = vi.fn(async () => ({
    data: options.guidesError ? null : (options.guides ?? []),
    error: options.guidesError ?? null,
  }));
  const guidesUserEq = vi.fn(() => ({ eq: guidesActiveEq }));
  const guidesSelect = vi.fn(() => ({ eq: guidesUserEq }));
  const from = vi.fn((table: string) => (table === "guides" ? { select: guidesSelect } : { select }));
  return {
    client: {
      auth: { getClaims: vi.fn(async () => ({ data: options.claims ? { claims: options.claims } : null, error: null })) },
      from,
    },
    from,
    select,
    eq,
    guidesSelect,
    guidesUserEq,
    guidesActiveEq,
  };
}

function operatorRow(id: string, status = "active") {
  return { id, name: `Op ${id.slice(1, 2)}`, timezone: "America/Costa_Rica", currency: "USD", locale: "es", status };
}

describe("loadOperatorContext (I/O wrapper)", () => {
  const claims = { sub: U, email: "u@cupo.test", app_metadata: { password_set_at: "2026-11-11T00:00:00.000Z" } };

  it("returns no user and no query when there is no session", async () => {
    const fake = fakeSupabase({ claims: null });
    const writeCookie = vi.fn();
    const state = await loadOperatorContext({ supabase: fake.client as never, readCookie: () => undefined, writeCookie });
    expect(state).toEqual({ user: null, context: null });
    expect(fake.from).not.toHaveBeenCalled();
    expect(writeCookie).not.toHaveBeenCalled();
  });

  it("loads the user's memberships, skips inactive operators and rewrites a foreign cookie", async () => {
    const fake = fakeSupabase({
      claims,
      rows: [
        { role: "administrador", created_at: "2026-01-01T00:00:00Z", operator: operatorRow(A, "inactive") },
        { role: "reservas", created_at: "2026-02-01T00:00:00Z", operator: operatorRow(B) },
        { role: "reservas", created_at: "2026-03-01T00:00:00Z", operator: null },
      ],
    });
    const writeCookie = vi.fn();
    const state = await loadOperatorContext({
      supabase: fake.client as never,
      readCookie: () => `${OTHER}:${A}`,
      writeCookie,
    });
    expect(fake.from).toHaveBeenCalledWith("memberships");
    expect(fake.eq).toHaveBeenCalledWith("user_id", U);
    expect(state.user).toEqual({ id: U, email: "u@cupo.test", passwordSetAt: "2026-11-11T00:00:00.000Z" });
    expect(state.context?.operator.id).toBe(B);
    expect(state.context?.memberships).toHaveLength(1);
    expect(writeCookie).toHaveBeenCalledWith({ kind: "set", value: `${U}:${B}` });
  });

  it("reads password_set_at as null when the claim is absent", async () => {
    const fake = fakeSupabase({ claims: { sub: U, email: "g@cupo.test", app_metadata: {} }, rows: [] });
    const state = await loadOperatorContext({ supabase: fake.client as never, readCookie: () => undefined, writeCookie: vi.fn() });
    expect(state.user?.passwordSetAt).toBeNull();
    expect(state.context).toBeNull();
  });

  it("does not query guides for a user without a guía membership", async () => {
    const fake = fakeSupabase({
      claims,
      rows: [{ role: "administrador", created_at: "2026-01-01T00:00:00Z", operator: operatorRow(A) }],
    });
    const state = await loadOperatorContext({ supabase: fake.client as never, readCookie: () => undefined, writeCookie: vi.fn() });
    expect(state.context?.guideId).toBeUndefined();
    expect(fake.from).not.toHaveBeenCalledWith("guides");
  });

  it("feeds the user's active guide records into guideId for a guía context (R19, KTD13)", async () => {
    const G_A = "33333333-3333-4333-8333-333333333333";
    const G_B = "44444444-4444-4444-8444-444444444444";
    const rows = [
      { role: "guia", created_at: "2026-01-01T00:00:00Z", operator: operatorRow(A) },
      { role: "reservas", created_at: "2026-02-01T00:00:00Z", operator: operatorRow(B) },
    ];
    const guides = [
      { id: G_A, operator_id: A },
      { id: G_B, operator_id: B },
    ];
    const inA = fakeSupabase({ claims, rows, guides });
    const stateA = await loadOperatorContext({ supabase: inA.client as never, readCookie: () => `${U}:${A}`, writeCookie: vi.fn() });
    expect(inA.from).toHaveBeenCalledWith("guides");
    expect(inA.guidesSelect).toHaveBeenCalledWith("id, operator_id");
    expect(inA.guidesUserEq).toHaveBeenCalledWith("user_id", U);
    expect(inA.guidesActiveEq).toHaveBeenCalledWith("active", true);
    expect(stateA.context).toMatchObject({ role: "guia", guideId: G_A });

    // The staff context in B never carries a guide id, even with a guide row in B.
    const inB = fakeSupabase({ claims, rows, guides });
    const stateB = await loadOperatorContext({ supabase: inB.client as never, readCookie: () => `${U}:${B}`, writeCookie: vi.fn() });
    expect(stateB.context?.role).toBe("reservas");
    expect(stateB.context?.guideId).toBeUndefined();
  });

  it("keeps a guía context without a guide id when the guide lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase({
      claims,
      rows: [{ role: "guia", created_at: "2026-01-01T00:00:00Z", operator: operatorRow(A) }],
      guidesError: { code: "XX000", message: "boom" },
    });
    const state = await loadOperatorContext({ supabase: fake.client as never, readCookie: () => undefined, writeCookie: vi.fn() });
    expect(state.context?.role).toBe("guia");
    expect(state.context?.guideId).toBeUndefined();
  });

  it("fails closed when the memberships query errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase({ claims, error: { code: "XX000", message: "boom" } });
    const state = await loadOperatorContext({ supabase: fake.client as never, readCookie: () => `${U}:${A}`, writeCookie: vi.fn() });
    expect(state.context).toBeNull();
    expect(state.user?.id).toBe(U);
  });
});

describe("getOperatorContext / requireOperatorContext (request wrappers)", () => {
  beforeEach(() => {
    cookieJar.clear();
    cookieStore.set.mockClear();
    cookieStore.delete.mockClear();
  });

  it("resolves through next/headers cookies and the server client, writing the cookie with the KTD3 options", async () => {
    fakeClient = fakeSupabase({
      claims: { sub: U, email: "u@cupo.test", app_metadata: { password_set_at: "x" } },
      rows: [{ role: "administrador", created_at: "2026-01-01T00:00:00Z", operator: operatorRow(A) }],
    }).client;
    cookieJar.set(ACTIVE_OPERATOR_COOKIE, `${U}:${C}`);
    const ctx = await getOperatorContext();
    expect(ctx?.operator.id).toBe(A);
    expect(cookieStore.set).toHaveBeenCalledWith(ACTIVE_OPERATOR_COOKIE, `${U}:${A}`, expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }));
    await expect(requireOperatorContext("audit.read")).resolves.toMatchObject({ role: "administrador" });
  });

  it("tolerates a read-only cookie store (Server Component render)", async () => {
    fakeClient = fakeSupabase({
      claims: { sub: U, email: "u@cupo.test", app_metadata: {} },
      rows: [{ role: "reservas", created_at: "2026-01-01T00:00:00Z", operator: operatorRow(A) }],
    }).client;
    cookieStore.set.mockImplementationOnce(() => {
      throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
    });
    await expect(getOperatorContext()).resolves.toMatchObject({ role: "reservas" });
  });

  it("throws UnauthenticatedError without a session and ForbiddenError for a missing permission", async () => {
    fakeClient = fakeSupabase({ claims: null }).client;
    await expect(requireOperatorContext()).rejects.toBeInstanceOf(UnauthenticatedError);
    fakeClient = fakeSupabase({
      claims: { sub: U, email: "u@cupo.test", app_metadata: {} },
      rows: [{ role: "guia", created_at: "2026-01-01T00:00:00Z", operator: operatorRow(A) }],
    }).client;
    await expect(requireOperatorContext("reservations.read")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("clears the cookie when the user has no membership left", async () => {
    fakeClient = fakeSupabase({ claims: { sub: U, email: "u@cupo.test", app_metadata: {} }, rows: [] }).client;
    cookieJar.set(ACTIVE_OPERATOR_COOKIE, `${U}:${A}`);
    await expect(getOperatorContext()).resolves.toBeNull();
    expect(cookieStore.delete).toHaveBeenCalledWith(ACTIVE_OPERATOR_COOKIE);
  });
});
