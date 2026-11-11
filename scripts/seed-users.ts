// Creates the local seed users after `supabase db reset` (plan U2 step 4).
//
//   npm run db:seed-users
//
// Users are created through the auth admin API (direct inserts into auth.users
// leave no auth.identities row and break password login) with random
// passwords written to tests/db/.seed-users.json (git-ignored). Memberships go
// through the service-role-only `admin_seed_membership` rpc with a null actor,
// so their audit rows carry `actor_source = 'system'`. Idempotent: an existing
// user gets its password and metadata reset and its memberships upserted.
//
// Runs on plain Node >= 22.18 (type stripping) and Node 24/25; refuses any
// non-local Supabase URL.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@cupo/shared";
import { assertLocalUrl, loadStackEnv } from "./lib/local-stack.ts";
import {
  OPERATORS,
  SEED_USERS,
  SEED_USERS_FILE,
  type SeedUserKey,
  type SeedUsersFile,
} from "../tests/db/fixtures.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function randomPassword(): string {
  // Satisfies config.toml: minimum_password_length = 10, letters and digits.
  return `Tt1${randomBytes(12).toString("base64url")}`;
}

async function main(): Promise<void> {
  const stack = loadStackEnv(process.env, repoRoot);
  assertLocalUrl(stack.url, "db:seed-users");

  const admin = createClient<Database>(stack.url, stack.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const out: SeedUsersFile = {
    createdAt: new Date().toISOString(),
    url: stack.url,
    users: {} as SeedUsersFile["users"],
  };

  for (const key of Object.keys(SEED_USERS) as SeedUserKey[]) {
    const spec = SEED_USERS[key];
    const password = randomPassword();
    const appMetadata = spec.staff ? { password_set_at: new Date().toISOString() } : {};
    const userMetadata = { full_name: spec.fullName };

    let userId: string | undefined;
    const created = await admin.auth.admin.createUser({
      email: spec.email,
      password,
      email_confirm: true,
      user_metadata: userMetadata,
      app_metadata: appMetadata,
    });
    if (created.data.user) {
      userId = created.data.user.id;
    } else if (/already|registered|exists/i.test(created.error?.message ?? "")) {
      // The profile mirror is the lookup table for existing emails (KTD8).
      const { data: profile, error } = await admin
        .from("profiles")
        .select("id")
        .ilike("email", spec.email)
        .maybeSingle();
      if (error || !profile) throw new Error(`cannot find existing user ${spec.email}: ${error?.message}`);
      userId = profile.id;
      const updated = await admin.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
        user_metadata: userMetadata,
        app_metadata: appMetadata,
      });
      if (updated.error) throw new Error(`updateUserById failed for ${spec.email}: ${updated.error.message}`);
    } else {
      throw new Error(`createUser failed for ${spec.email}: ${created.error?.message}`);
    }

    for (const membership of spec.memberships) {
      const { error } = await admin.rpc("admin_seed_membership", {
        actor_id: null as unknown as string,
        user_id: userId,
        operator_id: OPERATORS[membership.operator].id,
        role: membership.role,
      });
      if (error) throw new Error(`admin_seed_membership failed for ${spec.email}: ${error.message}`);
    }

    out.users[key] = { id: userId, email: spec.email, password };
  }

  const target = resolve(repoRoot, SEED_USERS_FILE);
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });

  // Local stack only: these passwords never leave the developer machine or the CI job.
  console.log(`seeded ${Object.keys(out.users).length} users into ${stack.url}; credentials in ${SEED_USERS_FILE}`);
  for (const key of Object.keys(out.users) as SeedUserKey[]) {
    const user = out.users[key];
    console.log(`  ${user.email.padEnd(28)} ${user.password}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
