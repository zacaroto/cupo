# Code Review Guidelines — cupo

## Project Context

cupo is a multi-operator booking admin for tour operators: a Next.js 16 App Router
application (TypeScript, Turbopack) with Supabase (Postgres, Auth, Row-Level
Security) as the backend, in an npm-workspaces monorepo (`apps/web`,
`packages/shared`). Spanish is the primary locale, English the secondary.

Every business row belongs to exactly one operator. The tenant boundary is three
layers (RLS on `operator_id`, composite foreign keys between business tables,
`operator_id` excluded from update grants), and a review must protect all three.

## Review Priorities (highest to lowest)

1. **Tenant isolation** — No change may let a user of one operator read or write
   rows of another. See the multi-tenant rules below.
2. **Security** — No exposed secrets, SQL injection, XSS or unsafe user input
   handling. RLS is relied upon but never trusted as the only check: server
   actions are public POST endpoints, every id is validated as a uuid and a
   found-check follows every targeted write.
3. **Data integrity** — Mutations handle errors explicitly. Invariants (capacity,
   state transitions, seat counters) live in database triggers, never only in the
   app.
4. **Type safety** — No `any`. Supabase query results use the generated types from
   `packages/shared/src/database.types.ts`.
5. **Server/client boundary** — Server-only code must never reach a client
   component. Watch `"use client"` directives and the import rules below.
6. **i18n completeness** — New user-facing strings exist in both
   `apps/web/messages/es.json` and `apps/web/messages/en.json` (the parity unit
   test enforces the key sets).
7. **Performance** — N+1 queries, policies that do not filter through an indexed
   `operator_id`, unnecessary client bundles.

## Multi-tenant rules (block the merge when violated)

- **Operator id never comes from the client.** `operator_id` is stamped by the
  server from the request context (`requireOperatorContext`) and checked by RLS
  on insert; it is never read from form data, route params, query strings or a
  JSON body, and it cannot be updated. The same applies to `code`, `created_by`,
  `seats_booked` and `has_incomplete_data`: never accepted from any client
  payload.
- **Money, notes and PII are gated by role in separate tables.** Amounts, internal
  notes and customer personal data live in their own tables with their own
  policies and grants; a change that moves them into a widely readable table, or
  reads them for a role that must not see them (for example guías), is a leak.
- **Never import the server Supabase client in client code.** Server Components,
  server actions and route handlers use `@/lib/supabase/server`; client
  components use `@/lib/supabase/client`. The admin client
  (`@/lib/supabase/admin.ts`, the only reader of `SUPABASE_SECRET_KEY`) is
  `server-only` and is used solely for the enumerated `admin_*` RPCs that carry
  the acting user's id.
- **Shared package import rule.** `packages/shared` is consumed as TypeScript
  source by `apps/web` (and by `apps/worker` in Phase 2). It must not import
  `next`, `next/*`, `next-intl`, `react`, `server-only` or any Supabase client,
  and must not read `process.env`, cookies, headers or `FormData`. ESLint
  (`no-restricted-imports`, `no-restricted-globals`) and a `tsconfig` without the
  `dom` lib enforce this; do not add exceptions.
- **Every new table** has RLS enabled, policies, explicit grants, an `operator_id`
  index and composite foreign keys to its parents; every new function in `public`
  has an explicit execute revoke and grant; a new `security definer` function
  needs a reason in the PR and an entry in the enumerated list.

## Patterns to Enforce

- **Navigation**: `Link`, `redirect`, `usePathname` and `useRouter` come from
  `@/i18n/navigation`, never from `next/link` or `next/navigation` (ESLint
  enforces this; `notFound` from `next/navigation` is fine).
- **Mutations**: server actions with `useActionState`; the action converts
  `FormData` to a plain object first and validates it with a Zod schema from
  `@cupo/shared`. Reads happen in Server Components through the DAL.
- **Logging**: use `@/lib/logger` (structured JSON with `requestId` and
  `operatorId`); never log passwords, token hashes, emails or session tokens
  (the logger redacts those keys, do not work around it).
- **Styling**: Tailwind CSS only, through the tokens in `apps/web/src/app/globals.css`
  (`bg-ground`, `bg-surface`, `text-text`, `text-muted`, `text-accent`, ...) and
  the shared `.field` / `.btn-*` classes. No inline `style`.
- **File naming**: kebab-case filenames; one component per file.
- **Migrations**: forward-only; never edit an applied migration; every migration
  starts with the template banner and is covered by pgTAP.

## What NOT to Flag

- Missing JSDoc on internal functions.
- Cosmetic Tailwind class ordering.
- The Next.js-managed block in `AGENTS.md` (written by `next dev`; committing it
  keeps the tree clean).
