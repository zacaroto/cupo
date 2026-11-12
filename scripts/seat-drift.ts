// Seat counter invariant check (plan U6 step 5, KTD5; README runbook "Seat
// counter drift"). Read-only: calls public.admin_seat_drift() with the secret
// key and exits 1 when any departure's seats_booked differs from the people
// held by its non-cancelled reservations.
//
//   node scripts/seat-drift.ts
//
// Targets:
// - the local stack, with values from `supabase status` when SUPABASE_URL is
//   unset (the CI `db` job after the suite);
// - a hosted project when SUPABASE_URL and SUPABASE_SECRET_KEY are exported
//   (the db-deploy jobs after a push, or cupo-dev from a developer machine).
//
// Prints departure and operator ids with the two counts only, never
// customer data. Runs on plain Node >= 22.18 (type stripping) and Node 24/25.
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@cupo/shared";
import { loadStackEnv } from "./lib/local-stack.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function fail(message: string): never {
  console.error(`seat-drift: ${message}`);
  process.exit(1);
}

function resolveTarget(): { url: string; secretKey: string } {
  const url = process.env.SUPABASE_URL;
  if (url) {
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!secretKey) fail("SUPABASE_URL is set but SUPABASE_SECRET_KEY is not");
    return { url, secretKey };
  }
  const stack = loadStackEnv(process.env, repoRoot);
  return { url: stack.url, secretKey: stack.secretKey };
}

async function main(): Promise<void> {
  const target = resolveTarget();
  const admin = createClient<Database>(target.url, target.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc("admin_seat_drift");
  if (error) fail(`admin_seat_drift failed: ${error.code ?? ""} ${error.message}`);
  if (data.length === 0) {
    console.log(`seat-drift: no drift on ${target.url}`);
    return;
  }
  console.error(`seat-drift: ${data.length} departure(s) on ${target.url} drift from their reservations:`);
  for (const row of data) {
    console.error(`  departure ${row.departure_id} (operator ${row.operator_id}): seats_booked ${row.seats_booked}, held ${row.held}`);
  }
  console.error("seat-drift: follow the README runbook before running admin_reconcile_seats(actor_id).");
  process.exit(1);
}

await main();
