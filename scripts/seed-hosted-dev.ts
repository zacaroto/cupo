// Creates fixed test accounts on the hosted `cupo-dev` project so previews can
// be tested with password login while hosted email is unavailable (issues #13
// and #15).
//
// Runs only inside the `seed-dev-accounts` job of .github/workflows/db-deploy.yml:
// - GITHUB_ACTIONS must be "true";
// - SUPABASE_URL must be https://<ref>.supabase.co with <ref> equal to
//   CUPO_DEV_PROJECT_REF (the repository variable SUPABASE_PROJECT_REF_DEV);
// - SUPABASE_SECRET_KEY is the cupo-dev secret key. The prod key lives only in
//   the protected `production` environment, which this job never uses.
// - SEED_PASSWORD is the one password shared by every account. It is never
//   printed: the repository is public, so Actions logs are public.
//
// Creates operators `demo-a` and `demo-b` through admin_bootstrap_operator
// (first administrador as actor) and the six accounts of tests/db/fixtures.ts
// (no seed account belongs to operator C, so it is not created). Idempotent: an existing account
// gets the current password and metadata, and memberships are upserted.
//
// Runs on plain Node >= 22.18 (type stripping) and Node 24/25.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@cupo/shared";
import { SEED_USERS, type OperatorKey, type SeedUserKey } from "../tests/db/fixtures.ts";

type DemoOperatorKey = Exclude<OperatorKey, "c">;

const DEMO_OPERATORS = {
  a: {
    name: "Demo A",
    slug: "demo-a",
    timezone: "America/Costa_Rica",
    currency: "USD",
    locale: "es",
    firstAdmin: "adminA",
  },
  b: {
    name: "Demo B",
    slug: "demo-b",
    timezone: "America/Mexico_City",
    currency: "MXN",
    locale: "es",
    firstAdmin: "adminAB",
  },
} as const satisfies Record<
  DemoOperatorKey,
  { name: string; slug: string; timezone: string; currency: string; locale: string; firstAdmin: SeedUserKey }
>;

function fail(message: string): never {
  console.error(`seed-hosted-dev: ${message}`);
  process.exit(1);
}

function assertDevTarget(env: NodeJS.ProcessEnv): { url: string; secretKey: string; password: string } {
  if (env.GITHUB_ACTIONS !== "true") {
    fail("runs only inside the seed-dev-accounts workflow job");
  }
  const ref = env.CUPO_DEV_PROJECT_REF ?? "";
  if (!/^[a-z]{20}$/.test(ref)) fail("CUPO_DEV_PROJECT_REF is missing or malformed");
  const url = env.SUPABASE_URL ?? "";
  if (url !== `https://${ref}.supabase.co`) {
    fail("SUPABASE_URL does not point at the cupo-dev project");
  }
  const secretKey = env.SUPABASE_SECRET_KEY ?? "";
  if (!secretKey.startsWith("sb_secret_")) fail("SUPABASE_SECRET_KEY is missing or not a secret key");
  const password = env.SEED_PASSWORD ?? "";
  // config.toml: minimum_password_length = 10, letters and digits.
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    fail("SEED_PASSWORD must have at least 10 characters with letters and digits");
  }
  return { url, secretKey, password };
}

async function main(): Promise<void> {
  const target = assertDevTarget(process.env);
  const admin = createClient<Database>(target.url, target.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const userIds = {} as Record<SeedUserKey, string>;
  for (const key of Object.keys(SEED_USERS) as SeedUserKey[]) {
    const spec = SEED_USERS[key];
    // Staff accounts are not sent to set-password (KTD8); the guía never is.
    const attributes = {
      password: target.password,
      email_confirm: true,
      user_metadata: { full_name: spec.fullName },
      app_metadata: spec.staff ? { password_set_at: new Date().toISOString() } : {},
    };
    const created = await admin.auth.admin.createUser({ email: spec.email, ...attributes });
    if (created.data.user) {
      userIds[key] = created.data.user.id;
      continue;
    }
    if (!/already|registered|exists/i.test(created.error?.message ?? "")) {
      fail(`createUser failed for ${spec.email}: ${created.error?.message}`);
    }
    // The profile mirror is the lookup table for existing emails (KTD8).
    const { data: profile, error } = await admin
      .from("profiles")
      .select("id")
      .ilike("email", spec.email)
      .maybeSingle();
    if (error || !profile) fail(`cannot find existing user ${spec.email}: ${error?.message ?? "no profile"}`);
    const updated = await admin.auth.admin.updateUserById(profile.id, attributes);
    if (updated.error) fail(`updateUserById failed for ${spec.email}: ${updated.error.message}`);
    userIds[key] = profile.id;
  }

  const operatorIds = {} as Record<DemoOperatorKey, string>;
  for (const key of Object.keys(DEMO_OPERATORS) as DemoOperatorKey[]) {
    const op = DEMO_OPERATORS[key];
    const adminId = userIds[op.firstAdmin];
    const { data, error } = await admin.rpc("admin_bootstrap_operator", {
      actor_id: adminId,
      name: op.name,
      slug: op.slug,
      timezone: op.timezone,
      currency: op.currency,
      locale: op.locale,
      admin_user_id: adminId,
    });
    if (error || !data) fail(`admin_bootstrap_operator failed for ${op.slug}: ${error?.message ?? "no id"}`);
    operatorIds[key] = data;
  }

  for (const key of Object.keys(SEED_USERS) as SeedUserKey[]) {
    for (const membership of SEED_USERS[key].memberships) {
      const { error } = await admin.rpc("admin_seed_membership", {
        actor_id: null as unknown as string,
        user_id: userIds[key],
        operator_id: operatorIds[membership.operator],
        role: membership.role,
      });
      if (error) fail(`admin_seed_membership failed for ${SEED_USERS[key].email}: ${error.message}`);
    }
  }

  // Emails and operator ids only; the password is never printed.
  for (const key of Object.keys(DEMO_OPERATORS) as DemoOperatorKey[]) {
    console.log(`operator ${DEMO_OPERATORS[key].slug.padEnd(8)} ${operatorIds[key]}`);
  }
  for (const key of Object.keys(SEED_USERS) as SeedUserKey[]) {
    const roles = SEED_USERS[key].memberships
      .map((m) => `${DEMO_OPERATORS[m.operator].slug}:${m.role}`)
      .join(", ");
    console.log(`account  ${SEED_USERS[key].email.padEnd(26)} ${roles}`);
  }
  console.log("password: the SUPABASE_DEV_SEED_PASSWORD secret (not printed)");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
