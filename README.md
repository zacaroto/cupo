# cupo

cupo is a multi-operator booking admin for tour operators. Each operator gets an
isolated workspace with memberships in four roles, tours with capacity, guides,
customers and manual reservations. Every business row is isolated per operator
by Row-Level Security plus composite foreign keys, and an automated
cross-operator isolation suite runs locally and in CI.

Stack: Next.js 16 (App Router, Turbopack), React 19, next-intl 4 (URL locale
prefixes, `es` default and `en`), Tailwind CSS 4, Supabase (Postgres, Auth,
RLS), Vitest 3, npm workspaces.

## Prerequisites

- Node.js 22 (`.nvmrc`; `nvm use` picks it up). `engines.node` in `package.json`,
  `.nvmrc`, the CI `setup-node` step and the Vercel project setting must agree.
- npm 10+ (ships with Node 22).
- Docker Desktop (the local Supabase stack runs in containers).
- Supabase CLI via `npx supabase` (no global install; CI pins the same version,
  3.1.0, in `.github/workflows/ci.yml`).
- The database scripts in `scripts/` run with plain `node` through Node's
  built-in TypeScript type stripping: Node 22.18 or newer, 24 and 25 all work
  (no `ts-node`, no build step).

## Setup

```bash
git clone <repo> cupo && cd cupo
nvm use
npm ci
npx supabase start                                   # pulls images the first time; applies migrations + seed
npm run db:seed-users                                # creates the local auth users (tests/db/.seed-users.json)
cp apps/web/.env.local.example apps/web/.env.local   # fill from `npx supabase status` (see below)
npm run dev                                          # http://localhost:3000 -> /es
```

`npx supabase status -o env` prints the local values. Map them into
`apps/web/.env.local`:

| `supabase status` key | `.env.local` variable |
|---|---|
| `API_URL` | `NEXT_PUBLIC_SUPABASE_URL` |
| `PUBLISHABLE_KEY` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| `SECRET_KEY` | `SUPABASE_SECRET_KEY` |

The local stack also exposes Studio (`STUDIO_URL`) and Mailpit (`MAILPIT_URL`),
where every invite, magic link and recovery email lands. `npx supabase stop`
stops the containers and keeps the data; `npx supabase stop --no-backup`
deletes it.

A fresh clone needs only `npm ci` before `npm run typecheck` passes: the
`typecheck` script runs `next typegen` first, which generates `next-env.d.ts`
and `.next/types`. Both are git-ignored.

## Scripts (repo root)

| Script | What it does |
|---|---|
| `npm run dev` | `next dev` in `apps/web` (Turbopack) |
| `npm run build` | `next build` in `apps/web` |
| `npm run lint` | ESLint in `apps/web` and `packages/shared` (including the shared import rule) |
| `npm run typecheck` | `next typegen && tsc --noEmit` in `apps/web`, `tsc --noEmit` in `packages/shared` |
| `npm run test:unit` | Vitest `unit` project: `apps/web/src/**/*.test.ts`, `packages/shared/src/**/*.test.ts` |
| `npm run test:db` | Vitest `db` project: `tests/db/**/*.test.ts` against the local Supabase stack (needs `db:seed-users`) |
| `npm run db:types` | Regenerates `packages/shared/src/database.types.ts` from the local stack (schemas `public` and `audit`) |
| `npm run db:types -- --check` | Fails when the committed types differ from the running database (CI) |
| `npm run db:seed-users` | Creates the local seed users through the auth admin API and writes `tests/db/.seed-users.json` |
| `npx supabase db reset` | Rebuilds the local database from `supabase/migrations` and `supabase/seed.sql` |
| `npx supabase test db` | Runs the pgTAP files in `supabase/tests` |
| `node scripts/bootstrap-operator.ts ...` | Creates an operator plus its first administrador (runbook below) |

## Workspace layout

```text
cupo/
  package.json              # workspaces apps/*, packages/*; scripts; engines; linux optionalDependencies
  tsconfig.base.json
  vitest.config.ts          # projects: unit, db
  .nvmrc  AGENTS.md  CLAUDE.md  REVIEW.md
  .github/workflows/ci.yml        # check job (lint, typecheck, unit, build, secret grep) and db job
  .github/workflows/db-deploy.yml # dev push on merge to main, prod + bootstrap-operator via workflow_dispatch
  supabase/
    config.toml               # local stack + cupo-dev; [remotes.production] overrides for cupo-prod
    migrations/               # forward-only, created with `supabase migration new`
    seed.sql                  # operators A, B, C with a local-only guard
    templates/                # invite, magic_link, recovery emails (token-hash links)
    tests/                    # pgTAP (rls_coverage_test.sql)
  scripts/
    seed-users.ts  bootstrap-operator.ts  db-types.ts  lib/local-stack.ts
  tests/db/                   # Vitest db project: setup.ts, helpers.ts, fixtures.ts, *.test.ts
  packages/shared/          # @cupo/shared: framework-free TypeScript, consumed as source (no build)
    package.json  tsconfig.json  eslint.config.mjs  src/index.ts  src/database.types.ts (generated)
  apps/web/                 # @cupo/web: the Next.js app
    package.json  next.config.mjs  vercel.json  eslint.config.mjs  postcss.config.mjs  tsconfig.json
    .env.local.example
    messages/es.json  messages/en.json
    src/i18n/{routing,request,navigation}.ts
    src/lib/logger.ts
    src/app/globals.css
    src/app/[locale]/layout.tsx          # root layout (<html lang>); there is no src/app/layout.tsx
    src/app/[locale]/page.tsx            # landing
    src/app/[locale]/[...rest]/page.tsx  # localized 404
```

Rules that the tooling enforces:

- `packages/shared` must not import `next`, `next/*`, `next-intl`, `react`,
  `server-only` or the Supabase clients, and must not read `process.env` or
  `FormData` (ESLint) nor use browser APIs (`tsconfig` `lib` has no `dom`).
- In `apps/web`, navigation imports come from `@/i18n/navigation`, not
  `next/link` or `next/navigation` (`notFound` is allowed).
- `messages/es.json` and `messages/en.json` must have identical key sets
  (`apps/web/src/i18n/messages.test.ts`).
- The logger (`apps/web/src/lib/logger.ts`) redacts `password`, `token_hash`,
  `email`, `access_token` and `refresh_token` at any depth.

## Environment variables

`apps/web/.env.local.example` lists the three Supabase variables. Nothing with
`SECRET`, `PASSWORD` or `TOKEN` is ever `NEXT_PUBLIC_`; `SUPABASE_SECRET_KEY` is
read only in `src/lib/supabase/admin.ts` behind `server-only`, and no production
secret ever lives on a developer machine.

## Branches, PRs and CI

- Branches: `feature/CP-{issue}-{slug}` (one PR per implementation unit into
  `main`); commit scopes `web`, `db`, `shared`, `ci`.
- CI (`.github/workflows/ci.yml`): the `check` job runs `npm ci`, lint,
  typecheck, unit tests, `next build`, then greps `apps/web/.next` for a
  Supabase secret key (`sb_secret_` followed by a long key body) and fails on any
  hit. The `db` job always runs; see "Database" below.
- Branch protection on `main`: pull request required; required checks `check`,
  `db` and the Vercel preview; branches up to date; linear history.

## Vercel project settings (dashboard)

- Root Directory: `apps/web`; "Include source files outside of the Root
  Directory": on.
- Framework: Next.js; default install and build commands (npm installs from the
  repo root with workspaces).
- Node.js version: 22.x.
- Production Branch: `main`, with automatic production deploys disabled through
  `apps/web/vercel.json` (`git.deploymentEnabled.main: false`). Production is
  deployed by the protected `deploy-prod` job of `db-deploy.yml` after the prod
  migration push.
- Preview deployments from forks: off.
- Environment variables: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` per environment
  (Preview: `cupo-dev` keys; Production: `cupo-prod` keys, Sensitive).
- Record the Vercel project name and team here once created.

## First-preview smoke checklist (U1)

Run on the first Vercel preview of the scaffold PR and attach the build log to
the PR:

- [ ] Build log shows one install at the repo root and no missing
      `@swc/core-linux` or `lightningcss` binary.
- [ ] Turbopack detects the repo root (no multiple-lockfile warning).
- [ ] `/es` and `/en` return 200.
- [ ] `/` redirects to `/es`.
- [ ] An unknown locale (for example `/xx`) returns 404.
- [ ] An unknown path under a valid locale (for example `/es/nope`) returns
      status 404 and, in the browser, the localized 404: `<html lang="es">`
      and the title "Página no encontrada". (`curl` shows Next's hydration
      shell with the locale in the RSC payload; check the DOM, not the raw HTML.)
- [ ] No `set-cookie` header on an anonymous page.
- [ ] The preview URL matches the redirect pattern registered in Supabase.

## Database

### Local stack

`supabase/config.toml` describes the local stack and the hosted `cupo-dev`
project at the same time (KTD1): `[api] schemas = ["public", "audit"]`
(`private` is never exposed), `auto_expose_new_tables = false` so a missing
grant fails locally first, `[auth] enable_signup = false` (invite-only, KTD8),
`otp_expiry = 900`, a password policy of 10+ characters with letters and
digits, email templates under `supabase/templates/` whose links are
`{{ .RedirectTo }}/auth/confirm?token_hash=...&type=...`, and secrets through
`env(...)` only. `[remotes.production]` overrides the project ref, site URL and
redirect list for `cupo-prod`. Two placeholders must be replaced once the
external projects exist: the Vercel preview pattern in
`additional_redirect_urls` and the `cupo-prod` `project_id`/`site_url` in
`[remotes.production]`.

### Migrations

- Create one with `npx supabase migration new <name>`; it lands in
  `supabase/migrations/<timestamp>_<name>.sql`. Copy the template banner from
  `20261111161533_foundation.sql` (columns, composite foreign keys, RLS,
  column-listed grants, function revoke/grant, trigger naming) and follow it;
  `supabase/tests/rls_coverage_test.sql` fails the PR otherwise.
- Migrations are forward-only. Never edit an applied migration; ship a fix as a
  new one. Functions change through `create or replace` with the same
  signature. Every migration must be compatible with the app version currently
  deployed (expand/contract).
- Timestamp rebase rule: if `main` gained a migration with a newer timestamp
  than yours while your PR was open, rename your file with a fresh timestamp
  (`npx supabase migration new` again and move the SQL) before merging. The
  PR preflight compares the migrations pending on `cupo-dev` with the files
  your PR adds and fails on any difference.
- `npx supabase db reset` rebuilds the local database from zero and then runs
  `supabase/seed.sql`. Run `npm run db:seed-users` afterwards (the reset drops
  the auth users).

### Seed and seed users

`supabase/seed.sql` inserts operators A, B and C with fixed uuids (mirrored in
`tests/db/fixtures.ts`). Its first statement is a guard that aborts unless the
server address is loopback or the Docker bridge range (`172.16.0.0/12`; from
the host the local Postgres reports its container address, for example
`172.18.0.2`) and the legacy JWT secret setting equals the constant the
Supabase CLI bakes into every local stack. The deploy workflow never passes
`--include-seed`.

`npm run db:seed-users` creates the auth users through the admin API (direct
inserts into `auth.users` leave no `auth.identities` row and break password
login): every role of operator A, one administrador of A and B, one reservas of
B. Staff users carry `app_metadata.password_set_at`; the guía does not. Each run
generates new random passwords, prints them and writes
`tests/db/.seed-users.json` (git-ignored). Memberships go through the
service-role-only `admin_seed_membership` rpc with a null actor, so their audit
rows carry `actor_source = 'system'`. The script refuses any non-local URL.

### Database tests

- `npx supabase test db` runs the pgTAP files in `supabase/tests/`.
  `rls_coverage_test.sql` asserts that every table in `public` and `audit` has
  RLS, at least one policy, a select grant to `authenticated` and a grant to
  `service_role`, that tables with `operator_id` have a btree index leading with
  it, that no `security definer` function lives in `public` or `audit`, that
  every function in `private` pins `search_path`, that `anon` can execute
  nothing in `public` or `audit`, and that no `admin_*` function is executable
  by `authenticated`.
- `npm run test:db` runs the Vitest `db` project (`tests/db/**/*.test.ts`,
  files in series). `tests/db/setup.ts` maps `supabase status -o env` to the app
  variable names once per process and loads the seed users; `tests/db/helpers.ts`
  offers `clientFor(user)` (signed-in client, publishable key),
  `adminClient()` (secret key), `anonClient()`, `expectZeroRows`,
  `expectSqlState`, `expectTypedError`, `asRole()` (raw SQL as a role with JWT
  claims, for `private` helpers and catalogs) and a `reconcileSeats()` stub that
  becomes real in U6. Tests that mutate create throwaway users and operators and
  remove them, so the suite runs repeatedly against one reset.
- Both suites need the stack running and the seed users created:

```bash
npx supabase db reset && npm run db:seed-users
npx supabase test db
npm run test:db
```

### Generated types

`npm run db:types` writes `packages/shared/src/database.types.ts` from the
running local stack (schemas `public` and `audit`); `@cupo/shared` re-exports
the `Database` type. Run it after every migration and commit the result:
`npm run db:types -- --check` fails in CI when the file differs.

### CI `db` job

The job always runs (it is a required check). On pull requests it first
detects whether anything database-related changed (`supabase/`, `tests/db/`,
`scripts/`, the generated types, the root tooling files); when nothing did, it
prints a notice and succeeds without starting the stack. Otherwise it installs
the pinned CLI with `supabase/setup-cli@v3`, starts the stack excluding
`studio,storage-api,realtime,edge-runtime,logflare,vector,imgproxy` (one retry
after `supabase stop --no-backup`), then runs `supabase db reset`,
`npm run db:seed-users`, `supabase test db`, `npm run test:db` and
`npm run db:types -- --check`. On pull requests it also runs the migration
preflight against `cupo-dev` (`supabase migration list --remote` and
`supabase db push --dry-run --remote`; the pending set must equal exactly the
PR's new migration files) when `SUPABASE_ACCESS_TOKEN_DEV` and
`SUPABASE_PROJECT_REF_DEV` exist, and prints a notice otherwise.

### Deploy workflow (`.github/workflows/db-deploy.yml`)

- `deploy-dev`: on every push to `main`, under a concurrency group that never
  cancels a push in progress. Links `cupo-dev`, dumps schema and data to a
  workflow artifact (7-day retention), runs `supabase db push --remote`, then
  `supabase config push --remote`, and verifies with `migration list` and
  `config push --dry-run`.
- `deploy-prod`: `workflow_dispatch` with `action = deploy-prod`, on the
  protected `production` environment (required reviewer). Same steps against
  `cupo-prod`, with the dump encrypted with `age` to `AGE_PUBLIC_KEY_PROD` (the
  private key stays with the plan owner outside GitHub), followed by
  `vercel deploy --prod` so the app never runs against an old schema.
- `bootstrap-operator`: `workflow_dispatch` with `action = bootstrap-operator`
  and `target = dev | prod`; runs `scripts/bootstrap-operator.ts` with the
  secret key of that environment.
- Every job checks its secrets and variables first and skips with a visible
  notice when any is missing, so the workflow stays green until the hosted
  projects exist.

### GitHub secrets and variables (Kevin)

| Name | Kind | Where | Used by |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN_DEV` | secret | repository | PR preflight, `deploy-dev` (CI account in the dev organization) |
| `SUPABASE_DB_PASSWORD_DEV` | secret | repository | `deploy-dev` (dump and push) and the preflight |
| `SUPABASE_PROJECT_REF_DEV` | variable | repository | preflight, `deploy-dev`, `bootstrap-operator` (dev) |
| `SUPABASE_SECRET_KEY_DEV` | secret | repository (or `development` environment) | `bootstrap-operator` with `target = dev` |
| `SUPABASE_ACCESS_TOKEN_PROD` | secret | `production` environment | `deploy-prod` |
| `SUPABASE_DB_PASSWORD_PROD` | secret | `production` environment | `deploy-prod` |
| `SUPABASE_PROJECT_REF_PROD` | variable | `production` environment | `deploy-prod`, `bootstrap-operator` (prod) |
| `SUPABASE_SECRET_KEY_PROD` | secret | `production` environment | `bootstrap-operator` with `target = prod` |
| `AGE_PUBLIC_KEY_PROD` | secret | `production` environment | encrypts the prod dump |
| `VERCEL_TOKEN` | secret | `production` environment | `vercel deploy --prod` |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | variables | `production` environment | `vercel deploy --prod` |

The `production` environment needs a required reviewer. Supabase access tokens
are account-wide, so the dev token belongs to a CI account that is a member of
the dev organization only (KTD1).

### Bootstrap-operator runbook

```bash
# local stack (values from `supabase status`; --print-link mints the invite link, Mailpit has it too)
node scripts/bootstrap-operator.ts --name "Tours X" --slug tours-x \
  --timezone America/Costa_Rica --currency USD --admin-email owner@example.com \
  --admin-name "Owner" --print-link
```

- The script is idempotent on slug and admin email: a second run finds the
  existing user and operator and prints the same operator id. It prints only
  the operator id on stdout.
- The first administrador is recorded in `audit.events` as the actor of their
  own membership (`actor_source = 'app'`) unless `--actor <uuid>` is given.
- Hosted projects: never from a developer machine (the script refuses any
  non-local URL unless it runs inside GitHub Actions). Use the
  `bootstrap-operator` job of `db-deploy.yml` (Actions, "Run workflow",
  `action = bootstrap-operator`, pick the target and fill the operator fields).
  The invited administrador receives the invite email from the hosted project
  and sets a password through `/auth/confirm` (U3).
- An active operator always keeps one administrador: deleting or demoting the
  last one, including deleting their auth user, is rejected with
  `last_administrador`. Deactivating the operator (`status = 'inactive'`,
  service role only) releases the rule.

### Hosted project status

`cupo-dev` exists (project ref `lnyjvnqhpwktxptxopvy`, region `us-west-2`).
The repository holds `SUPABASE_ACCESS_TOKEN_DEV`, `SUPABASE_DB_PASSWORD_DEV`
and the variable `SUPABASE_PROJECT_REF_DEV`, so the PR migration preflight
and `deploy-dev` run for real. Still missing:

- `SUPABASE_SECRET_KEY_DEV`, needed only by the `bootstrap-operator` job with
  `target = dev`;
- the first `deploy-dev` run must confirm that `supabase config push` accepts
  every key in `config.toml` on the hosted API (drop a rejected key from the
  push, not from the local config);
- the Vercel preview redirect pattern in `additional_redirect_urls` (needs the
  Vercel project name and team; currently a placeholder);
- `cupo-prod`, the `production` environment, the `age` key and
  `vercel deploy --prod` (Phase 2 prerequisites);
- an SMTP provider for hosted email (`[auth.email.smtp]` stays disabled).

## Review

See `REVIEW.md` for the review priorities and the multi-tenant rules.
