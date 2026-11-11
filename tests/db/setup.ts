// Setup file of the "db" Vitest project (KTD11).
//
// Maps `supabase status -o env` to the app variable names once per process and
// loads the seed users written by `npm run db:seed-users`. Tests and helpers
// read process.env only, so the same files run in CI with exported variables.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyStackEnv, assertLocalUrl, loadStackEnv } from "../../scripts/lib/local-stack.ts";
import { SEED_USERS_FILE, type SeedUsersFile } from "./fixtures.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

if (!process.env.CUPO_DB_ENV_LOADED) {
  const stack = loadStackEnv(process.env, repoRoot);
  // The suite mutates data (throwaway users and operators); never let it run
  // against a hosted project by accident.
  assertLocalUrl(stack.url, "the db test project");
  applyStackEnv(stack);
  process.env.CUPO_DB_ENV_LOADED = "1";
}

const seedPath = resolve(repoRoot, SEED_USERS_FILE);
if (!existsSync(seedPath)) {
  throw new Error(
    `${SEED_USERS_FILE} is missing; run \`npx supabase db reset\` then \`npm run db:seed-users\` first.`,
  );
}

export const seedUsers: SeedUsersFile = JSON.parse(readFileSync(seedPath, "utf8")) as SeedUsersFile;

if (seedUsers.url !== process.env.NEXT_PUBLIC_SUPABASE_URL) {
  throw new Error(
    `${SEED_USERS_FILE} was written for ${seedUsers.url} but the stack is ${process.env.NEXT_PUBLIC_SUPABASE_URL}; re-run \`npm run db:seed-users\`.`,
  );
}

process.env.CUPO_SEED_USERS_JSON = JSON.stringify(seedUsers);
