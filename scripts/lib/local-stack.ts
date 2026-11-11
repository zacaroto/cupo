// Shared helpers for the database scripts and the Vitest db project: reading
// the local Supabase stack's connection values and refusing hosted targets.
//
// Runs on plain Node (type stripping, Node >= 22.18) and under Vitest, so it
// must stay free of TypeScript-only runtime syntax (enums, parameter
// properties, namespaces).
import { execFileSync } from "node:child_process";

export type StackEnv = {
  /** http://127.0.0.1:54321 on the local stack; the app variable NEXT_PUBLIC_SUPABASE_URL. */
  url: string;
  /** sb_publishable_...; the app variable NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. */
  publishableKey: string;
  /** sb_secret_...; the app variable SUPABASE_SECRET_KEY. Never leaves the process. */
  secretKey: string;
  /** postgresql://postgres:postgres@127.0.0.1:54322/postgres; raw SQL for the test harness only. */
  dbUrl: string;
};

/** Hostnames that count as the local stack. Anything else is a hosted project. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "host.docker.internal"]);

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Maps the `KEY="value"` lines of `supabase status -o env` to the app variable
 * names. The CLI prints a "Stopped services" line and warnings on stderr; only
 * stdout is parsed.
 */
export function parseStatusEnv(stdout: string): StackEnv {
  const vars = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) vars.set(match[1], match[2]);
  }
  const need = (key: string): string => {
    const value = vars.get(key);
    if (!value) {
      throw new Error(
        `supabase status did not print ${key}; is the local stack running? (npx supabase start)`,
      );
    }
    return value;
  };
  return {
    url: need("API_URL"),
    publishableKey: need("PUBLISHABLE_KEY"),
    secretKey: need("SECRET_KEY"),
    dbUrl: need("DB_URL"),
  };
}

/**
 * Reads the stack values from the environment when all four app variables are
 * present (CI can export them), otherwise from `supabase status -o env`.
 */
export function loadStackEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): StackEnv {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = env.SUPABASE_SECRET_KEY;
  const dbUrl = env.CUPO_TEST_DB_URL;
  if (url && publishableKey && secretKey && dbUrl) {
    return { url, publishableKey, secretKey, dbUrl };
  }
  const stdout = execFileSync("npx", ["supabase", "status", "-o", "env"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
  });
  return parseStatusEnv(stdout);
}

/** Exports a StackEnv under the app variable names so tests read process.env only. */
export function applyStackEnv(stack: StackEnv, env: NodeJS.ProcessEnv = process.env): void {
  env.NEXT_PUBLIC_SUPABASE_URL = stack.url;
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = stack.publishableKey;
  env.SUPABASE_SECRET_KEY = stack.secretKey;
  env.CUPO_TEST_DB_URL = stack.dbUrl;
}

/** Throws unless `url` points at the local stack. Used by every write path of the scripts. */
export function assertLocalUrl(url: string, what: string): void {
  if (!isLocalUrl(url)) {
    throw new Error(`${what} refuses the non-local Supabase URL ${url}; it works on the local stack only`);
  }
}
