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
- Docker Desktop (for the local Supabase stack, from U2).
- Supabase CLI via `npx supabase` (no global install; the version is pinned in
  CI). The Supabase workflow docs (`supabase start`, `db reset`, seed users,
  generated types, migration preflight, runbooks) arrive with U2.

## Setup

```bash
git clone <repo> cupo && cd cupo
nvm use
npm ci
cp apps/web/.env.local.example apps/web/.env.local   # fill from `supabase status` (U2)
npm run dev                                          # http://localhost:3000 -> /es
```

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
| `npm run test:db` | Vitest `db` project: `tests/db/**/*.test.ts` against the local Supabase stack (U2) |
| `npm run db:types` | Regenerates `packages/shared/src/database.types.ts` (placeholder until U2) |
| `npm run db:seed-users` | Creates the local seed users (placeholder until U2) |

## Workspace layout

```text
cupo/
  package.json              # workspaces apps/*, packages/*; scripts; engines; linux optionalDependencies
  tsconfig.base.json
  vitest.config.ts          # projects: unit, db
  .nvmrc  AGENTS.md  CLAUDE.md  REVIEW.md
  .github/workflows/ci.yml  # check job (lint, typecheck, unit, build, secret grep); db job arrives in U2
  tests/db/                 # Vitest db project (setup.ts placeholder until U2)
  packages/shared/          # @cupo/shared: framework-free TypeScript, consumed as source (no build)
    package.json  tsconfig.json  eslint.config.mjs  src/index.ts
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
  hit. The `db` job (local Supabase stack, pgTAP, Vitest `db` project) is added
  in U2.
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
  deployed by the protected `db-deploy` job after the prod migration push (U2).
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
- [ ] No `set-cookie` header on an anonymous page.
- [ ] The preview URL matches the redirect pattern registered in Supabase.

## Review

See `REVIEW.md` for the review priorities and the multi-tenant rules.
