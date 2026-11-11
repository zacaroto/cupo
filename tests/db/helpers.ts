// Helpers of the "db" Vitest project. Every client talks to the local stack
// through the Data API exactly like the app does; raw SQL is reserved for
// assertions that the API cannot express (private helpers, pgTAP, catalogs).
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres, { type Sql } from "postgres";
import { expect } from "vitest";
import type { Database } from "@cupo/shared";
import { SEED_USERS, type MembershipRole, type SeedUserKey, type SeedUsersFile } from "./fixtures.ts";

export type Client = SupabaseClient<Database>;

type ApiError = { code?: string | null; message: string; details?: string | null; hint?: string | null };
type ApiResult<T> = { data: T | null; error: ApiError | null };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; tests/db/setup.ts maps it from supabase status`);
  return value;
}

export function seedUsers(): SeedUsersFile {
  return JSON.parse(env("CUPO_SEED_USERS_JSON")) as SeedUsersFile;
}

export function seedUser(key: SeedUserKey): { id: string; email: string; password: string } {
  return seedUsers().users[key];
}

/** Role spec of a seeded user, from the fixtures (not from the database). */
export function seedUserSpec(key: SeedUserKey) {
  return SEED_USERS[key];
}

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

/** A client holding no session: the `anon` role. */
export function anonClient(): Client {
  return createClient<Database>(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), clientOptions);
}

/** A client with the secret key: the `service_role`, bypasses RLS. */
export function adminClient(): Client {
  return createClient<Database>(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), clientOptions);
}

const sessions = new Map<string, Promise<Client>>();

/**
 * A client signed in as the given user with the publishable key, so every
 * query runs as `authenticated` under RLS. Sessions are cached per email for
 * the life of the test file.
 */
export function clientFor(user: SeedUserKey | { email: string; password: string }): Promise<Client> {
  const credentials = typeof user === "string" ? seedUser(user) : user;
  const cached = sessions.get(credentials.email);
  if (cached) return cached;
  const pending = (async () => {
    const client = anonClient();
    const { error } = await client.auth.signInWithPassword({
      email: credentials.email,
      password: credentials.password,
    });
    if (error) throw new Error(`signInWithPassword failed for ${credentials.email}: ${error.message}`);
    return client;
  })();
  sessions.set(credentials.email, pending);
  return pending;
}

/** Forgets cached sessions (call after deleting a user the cache may hold). */
export function forgetSession(email: string): void {
  sessions.delete(email);
}

/** The query succeeded and returned no rows (RLS filtered everything). */
export function expectZeroRows<T>(result: ApiResult<T[]>): void {
  expect(result.error, result.error ? `unexpected error: ${result.error.code} ${result.error.message}` : undefined).toBeNull();
  expect(result.data).toEqual([]);
}

/** The query failed with the given SQLSTATE (for example 42501). */
export function expectSqlState<T>(result: ApiResult<T>, code: string, messageIncludes?: string): ApiError {
  expect(result.error, `expected SQLSTATE ${code}, got a success`).not.toBeNull();
  const error = result.error as ApiError;
  expect(error.code, `expected SQLSTATE ${code}, got ${error.code}: ${error.message}`).toBe(code);
  if (messageIncludes) expect(error.message).toContain(messageIncludes);
  return error;
}

/** The query failed with a typed error: SQLSTATE P0001 and message `<name>` (KTD5). */
export function expectTypedError<T>(result: ApiResult<T>, name: string): void {
  const error = expectSqlState(result, "P0001");
  expect(error.message).toBe(name);
}

/**
 * Zero seat-drift rows over every departure (plan verification gate).
 * `admin_seat_drift()` ships with the departures and reservations units.
 */
export function reconcileSeats(): Promise<never> {
  return Promise.reject(new Error("reconcileSeats() is available from U6 (admin_seat_drift)"));
}

/** A password that satisfies the policy in config.toml (10+ chars, letters and digits). */
export function randomPassword(): string {
  return `Tt1${randomBytes(12).toString("base64url")}`;
}

let sqlClient: Sql | undefined;

/** Raw SQL connection (role `postgres`, bypasses RLS). For catalog and private helper checks only. */
export function sql(): Sql {
  sqlClient ??= postgres(env("CUPO_TEST_DB_URL"), { max: 2, onnotice: () => {} });
  return sqlClient;
}

export async function closeSql(): Promise<void> {
  await sqlClient?.end({ timeout: 5 });
  sqlClient = undefined;
}

/**
 * Runs `fn` inside one transaction as the Data API would: `set local role` plus
 * the JWT claims `auth.uid()` reads. The native pattern KTD11 chose over the
 * basejump helpers.
 */
export function asRole<T>(
  role: "authenticated" | "anon" | "service_role",
  userId: string | null,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  const claims = userId ? { sub: userId, role, email: "" } : { role };
  return sql().begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

/** Creates a throwaway auth user plus memberships the way the seed script does (system actor). */
export async function createTestUser(
  admin: Client,
  input: {
    email: string;
    fullName?: string;
    staff?: boolean;
    memberships?: Array<{ operatorId: string; role: MembershipRole }>;
    /** Guide to link to the new user before the memberships (required for a guía membership, R19). */
    guideId?: string;
  },
): Promise<{ id: string; email: string; password: string }> {
  const password = randomPassword();
  const { data, error } = await admin.auth.admin.createUser({
    email: input.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName ?? input.email },
    app_metadata: input.staff === false ? {} : { password_set_at: new Date().toISOString() },
  });
  if (error || !data.user) throw new Error(`createUser failed for ${input.email}: ${error?.message}`);
  if (input.guideId) {
    const { error: linkError } = await admin.rpc("admin_seed_guide_user", {
      actor_id: null as unknown as string,
      guide_id: input.guideId,
      user_id: data.user.id,
    });
    if (linkError) throw new Error(`admin_seed_guide_user failed: ${linkError.message}`);
  }
  for (const membership of input.memberships ?? []) {
    const { error: rpcError } = await admin.rpc("admin_seed_membership", {
      actor_id: null as unknown as string,
      user_id: data.user.id,
      operator_id: membership.operatorId,
      role: membership.role,
    });
    if (rpcError) throw new Error(`admin_seed_membership failed: ${rpcError.message}`);
  }
  return { id: data.user.id, email: input.email, password };
}

export async function deleteTestUser(admin: Client, id: string, email?: string): Promise<void> {
  if (email) forgetSession(email);
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error && !/not found/i.test(error.message)) throw new Error(`deleteUser failed: ${error.message}`);
}

/** Unique email for throwaway users so reruns never collide. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}@cupo.test`;
}
