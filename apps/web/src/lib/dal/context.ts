// Active operator context (KTD3, R4, R5, R14). The authoritative answer to
// "who is this request and for which operator": derived from the verified
// session and the user's memberships, never from client input. The cookie is
// only a preference among the user's own memberships.
//
// Structure: pure resolution (`resolveOperatorContext`, `shellGate`,
// `requireFromState`) is unit-tested with plain data; `loadOperatorContext`
// does the I/O with injected dependencies; `getOperatorContext` and
// `requireOperatorContext` bind it to the request (React `cache`, one load per
// render pass) and are what pages, layouts and server actions call.
import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { can, isRole, isStaffRole, type Action, type Role } from "@cupo/shared/permissions";
import { createClient, type ServerClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { ForbiddenError, UnauthenticatedError } from "./errors";

export const ACTIVE_OPERATOR_COOKIE = "active_operator_id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionUser = {
  id: string;
  email: string | null;
  /** `app_metadata.password_set_at` from the JWT; null until a staff user sets a password (KTD8). */
  passwordSetAt: string | null;
};

export type OperatorSummary = {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  locale: string;
};

/** One membership of the signed-in user in an active operator. */
export type MembershipRecord = {
  operator: OperatorSummary;
  role: Role;
  createdAt: string;
};

export type OperatorContext = {
  user: SessionUser;
  operator: OperatorSummary;
  role: Role;
  /** The guide record of the user in this operator; only for role guía (R19). */
  guideId?: string;
  /** Every membership of the user, oldest first, for the operator switcher. */
  memberships: ReadonlyArray<{ operatorId: string; operatorName: string; role: Role }>;
};

export type CookieAction = { kind: "keep" } | { kind: "set"; value: string } | { kind: "clear" };

export type RequestState = { user: SessionUser | null; context: OperatorContext | null };

export function formatActiveOperatorCookie(userId: string, operatorId: string): string {
  return `${userId}:${operatorId}`;
}

export function parseActiveOperatorCookie(value: string | undefined): { userId: string; operatorId: string } | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const [userId, operatorId] = parts;
  if (!UUID.test(userId) || !UUID.test(operatorId)) return null;
  return { userId, operatorId };
}

export function activeOperatorCookieOptions(nodeEnv: string | undefined = process.env.NODE_ENV) {
  return { httpOnly: true, secure: nodeEnv !== "development", sameSite: "lax", path: "/" } as const;
}

function byAge(a: MembershipRecord, b: MembershipRecord): number {
  return a.createdAt.localeCompare(b.createdAt) || a.operator.id.localeCompare(b.operator.id);
}

/**
 * Picks the active operator: the cookie's operator when it belongs to this
 * user and is one of their memberships, otherwise the oldest membership. The
 * returned cookie action rewrites a stale, foreign or missing cookie and
 * clears it when no membership is left.
 */
export function resolveOperatorContext(input: {
  user: SessionUser;
  memberships: readonly MembershipRecord[];
  cookieValue: string | undefined;
  /** operator id to guide id for the user's linked guide records. */
  guideIds?: Readonly<Record<string, string>>;
}): { context: OperatorContext | null; cookie: CookieAction } {
  const { user, cookieValue } = input;
  const memberships = [...input.memberships].sort(byAge);

  if (memberships.length === 0) {
    return { context: null, cookie: cookieValue === undefined ? { kind: "keep" } : { kind: "clear" } };
  }

  const preferred = parseActiveOperatorCookie(cookieValue);
  const fromCookie =
    preferred && preferred.userId === user.id
      ? memberships.find((m) => m.operator.id === preferred.operatorId)
      : undefined;
  const active = fromCookie ?? memberships[0];

  const guideId = active.role === "guia" ? input.guideIds?.[active.operator.id] : undefined;
  const context: OperatorContext = {
    user,
    operator: active.operator,
    role: active.role,
    ...(guideId !== undefined && { guideId }),
    memberships: memberships.map((m) => ({ operatorId: m.operator.id, operatorName: m.operator.name, role: m.role })),
  };

  return {
    context,
    cookie: fromCookie ? { kind: "keep" } : { kind: "set", value: formatActiveOperatorCookie(user.id, active.operator.id) },
  };
}

/**
 * Where the (app) shell must send this request instead of rendering (UX only;
 * the DAL is the authority): no context goes to no-access (R5); a staff
 * context without a password goes to set-password (R13, KTD8). A guía context
 * is never sent to set-password.
 */
export function shellGate(context: OperatorContext | null): "no-access" | "set-password" | null {
  if (!context) return "no-access";
  if (isStaffRole(context.role) && !context.user.passwordSetAt) return "set-password";
  return null;
}

/** The context, or the DAL error that the result mapper turns into a state. */
export function requireFromState(state: RequestState, action?: Action): OperatorContext {
  if (!state.user) throw new UnauthenticatedError();
  if (!state.context) throw new ForbiddenError();
  if (action && !can(state.context.role, action)) throw new ForbiddenError(action);
  return state.context;
}

type OperatorRow = { id: string; name: string; timezone: string; currency: string; locale: string; status: string };

function sessionUserFromClaims(claims: Record<string, unknown> | null | undefined): SessionUser | null {
  const sub = claims?.sub;
  if (typeof sub !== "string" || !UUID.test(sub)) return null;
  const appMetadata = (claims?.app_metadata ?? {}) as Record<string, unknown>;
  const passwordSetAt = appMetadata.password_set_at;
  return {
    id: sub,
    email: typeof claims?.email === "string" ? claims.email : null,
    passwordSetAt: typeof passwordSetAt === "string" && passwordSetAt.length > 0 ? passwordSetAt : null,
  };
}

/**
 * operator id to guide id for the user's own active guide records (R19, KTD13).
 * A direct read under RLS: a guía sees only their own guide row
 * (`private.my_guide_ids()`); a staff member sees their operator's guides, so
 * the `user_id` filter keeps the result to the user's own records. Only run
 * when the user holds a guía membership; a failure leaves the guía context
 * without a guide id, which the guía policies turn into an empty agenda.
 */
async function loadGuideIds(supabase: ContextDeps["supabase"], userId: string): Promise<Record<string, string> | undefined> {
  const { data, error } = await supabase.from("guides").select("id, operator_id").eq("user_id", userId).eq("active", true);
  if (error) {
    logger.error("guide lookup failed", { userId, extra: { code: error.code } });
    return undefined;
  }
  return Object.fromEntries((data ?? []).map((guide) => [guide.operator_id, guide.id]));
}

export type ContextDeps = {
  supabase: Pick<ServerClient, "auth" | "from">;
  readCookie: () => string | undefined;
  writeCookie: (action: CookieAction) => void;
};

/** Verifies the session, loads the memberships under RLS and resolves the context. */
export async function loadOperatorContext(deps: ContextDeps): Promise<RequestState> {
  const { data: claimsData } = await deps.supabase.auth.getClaims();
  const user = sessionUserFromClaims(claimsData?.claims as Record<string, unknown> | undefined);
  if (!user) return { user: null, context: null };

  // RLS returns only the user's own memberships; operators hides inactive
  // operators (R6), so their embed comes back null and is skipped.
  const { data, error } = await deps.supabase
    .from("memberships")
    .select("role, created_at, operator:operators(id, name, timezone, currency, locale, status)")
    .eq("user_id", user.id);

  if (error) {
    logger.error("membership lookup failed", { userId: user.id, extra: { code: error.code } });
    return { user, context: null };
  }

  const memberships: MembershipRecord[] = [];
  for (const row of data ?? []) {
    const operator = row.operator as OperatorRow | null;
    if (!operator || operator.status !== "active" || !isRole(row.role)) continue;
    memberships.push({
      operator: {
        id: operator.id,
        name: operator.name,
        timezone: operator.timezone,
        currency: operator.currency,
        locale: operator.locale,
      },
      role: row.role,
      createdAt: row.created_at,
    });
  }

  const guideIds = memberships.some((m) => m.role === "guia") ? await loadGuideIds(deps.supabase, user.id) : undefined;
  const { context, cookie } = resolveOperatorContext({ user, memberships, cookieValue: deps.readCookie(), guideIds });
  if (cookie.kind !== "keep") deps.writeCookie(cookie);
  return { user, context };
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function cookieDeps(cookieStore: CookieStore): Omit<ContextDeps, "supabase"> {
  return {
    readCookie: () => cookieStore.get(ACTIVE_OPERATOR_COOKIE)?.value,
    writeCookie: (action) => {
      try {
        if (action.kind === "set") {
          cookieStore.set(ACTIVE_OPERATOR_COOKIE, action.value, activeOperatorCookieOptions());
        } else if (action.kind === "clear") {
          cookieStore.delete(ACTIVE_OPERATOR_COOKIE);
        }
      } catch {
        // Server Components cannot write cookies; the next server action or
        // a fresh resolution repeats the rewrite. The context is still correct.
      }
    },
  };
}

const loadRequestState = cache(async (): Promise<RequestState> => {
  const [supabase, cookieStore] = await Promise.all([createClient(), cookies()]);
  return loadOperatorContext({ supabase, ...cookieDeps(cookieStore) });
});

/**
 * Right after a sign-in (login action, confirm route), resolves the context
 * with the client that holds the new session and writes the active-operator
 * cookie, so it exists from the first page (Server Components cannot write
 * it). Best effort: a failure is logged and every request resolves anyway.
 */
export async function primeActiveOperatorCookie(supabase: ContextDeps["supabase"]): Promise<void> {
  try {
    await loadOperatorContext({ supabase, ...cookieDeps(await cookies()) });
  } catch (error) {
    logger.warn("priming the active operator cookie failed", {
      extra: { kind: error instanceof Error ? error.name : typeof error },
    });
  }
}

/** The verified session user, or null. Cached per request. */
export async function getSessionUser(): Promise<SessionUser | null> {
  return (await loadRequestState()).user;
}

/** The active operator context, or null (no session or no membership). Cached per request. */
export async function getOperatorContext(): Promise<OperatorContext | null> {
  return (await loadRequestState()).context;
}

/**
 * The context for a page or server action; throws `UnauthenticatedError` or
 * `ForbiddenError` (also when the role lacks `action`). Call it in every page
 * and every server action; domain DAL modules take the returned ctx.
 */
export async function requireOperatorContext(action?: Action): Promise<OperatorContext> {
  return requireFromState(await loadRequestState(), action);
}
