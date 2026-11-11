// Creates an operator and its first administrador (plan U2 step 5, R7).
//
//   node scripts/bootstrap-operator.ts --name "Tours X" --slug tours-x \
//     --timezone America/Costa_Rica --currency USD --admin-email owner@example.com \
//     [--admin-name "Owner"] [--locale es] [--actor <uuid>] [--print-link]
//
// Idempotent on slug and admin email: a second run finds the existing user and
// operator and changes nothing. Prints only the operator id on stdout.
//
// Targets:
// - the local stack, with values from `supabase status` when SUPABASE_URL is unset
//   (a stray SUPABASE_SECRET_KEY in the environment is ignored in that case);
// - a hosted project only inside the `bootstrap-operator` job of
//   .github/workflows/db-deploy.yml (SUPABASE_URL + SUPABASE_SECRET_KEY exported
//   there). From a developer machine any hosted URL is refused.
// - `--print-link` mints the invite link locally (Mailpit has it too) and refuses
//   any non-local URL.
//
// Runs on plain Node >= 22.18 (type stripping) and Node 24/25.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@cupo/shared";
import { isLocalUrl, loadStackEnv } from "./lib/local-stack.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function fail(message: string): never {
  console.error(`bootstrap-operator: ${message}`);
  process.exit(1);
}

function resolveTarget(): { url: string; secretKey: string; local: boolean } {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (url) {
    if (!secretKey) fail("SUPABASE_URL is set but SUPABASE_SECRET_KEY is not");
    const local = isLocalUrl(url);
    if (!local && process.env.GITHUB_ACTIONS !== "true") {
      fail(`refusing the hosted URL ${url}: hosted runs happen only through the bootstrap-operator workflow job`);
    }
    return { url, secretKey, local };
  }
  const stack = loadStackEnv(process.env, repoRoot);
  return { url: stack.url, secretKey: stack.secretKey, local: true };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      timezone: { type: "string" },
      currency: { type: "string" },
      locale: { type: "string", default: "es" },
      "admin-email": { type: "string" },
      "admin-name": { type: "string" },
      actor: { type: "string" },
      "print-link": { type: "boolean", default: false },
    },
    strict: true,
  });

  for (const key of ["name", "slug", "timezone", "currency", "admin-email"] as const) {
    if (!values[key]) fail(`--${key} is required`);
  }
  const adminEmail = values["admin-email"]!.trim().toLowerCase();
  const currency = values.currency!.toUpperCase();

  // Every check that can refuse runs before any network call, so a refusal
  // never writes anything.
  const target = resolveTarget();
  if (values["print-link"] && !target.local) {
    fail(`--print-link works on the local stack only, not against ${target.url}`);
  }

  const admin = createClient<Database>(target.url, target.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Find or invite the administrador. The profile mirror is the lookup table
  // for existing emails (KTD8); inviting an existing email would fail.
  const { data: existing, error: lookupError } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", adminEmail)
    .maybeSingle();
  if (lookupError) fail(`profile lookup failed: ${lookupError.message}`);

  let adminUserId = existing?.id;
  if (!adminUserId) {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(adminEmail, {
      data: { full_name: values["admin-name"] ?? adminEmail },
    });
    if (error || !data.user) fail(`inviteUserByEmail failed: ${error?.message}`);
    adminUserId = data.user.id;
  }

  // The first administrador is recorded as the actor of their own bootstrap
  // unless --actor names someone else (for example the platform owner).
  const actorId = values.actor ?? adminUserId;

  const { data: operatorId, error: rpcError } = await admin.rpc("admin_bootstrap_operator", {
    actor_id: actorId,
    name: values.name!,
    slug: values.slug!,
    timezone: values.timezone!,
    currency,
    locale: values.locale!,
    admin_user_id: adminUserId,
  });
  if (rpcError || !operatorId) fail(`admin_bootstrap_operator failed: ${rpcError?.message}`);

  console.log(operatorId);

  if (values["print-link"]) {
    const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email: adminEmail });
    if (error) fail(`generateLink failed: ${error.message}`);
    const site = process.env.CUPO_SITE_URL ?? "http://localhost:3000";
    console.error(`invite link: ${site}/auth/confirm?token_hash=${data.properties.hashed_token}&type=invite`);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
