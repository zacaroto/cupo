---
title: Migrations through the Supabase CLI, forward-only, with generated types
date: 2026-11-12
category: workflow
tags: [supabase, migrations, ci, types]
applies_to: supabase/migrations, packages/shared/src/database.types.ts, .github/workflows
plan_refs: [KTD1, KTD10, KTD11, R2, R7, R31]
---

# Migrations through the Supabase CLI, forward-only, with generated types

## Problem

In Go Pesca, migrations were numbered by hand and applied through the SQL
editor, so the repository and the live database drifted. Several units of
cupo also ran in parallel against one local stack and one hosted dev project.

## The workflow

1. **Create the file with the CLI:** `npx supabase migration new <name>`. The
   timestamp orders it.
   - Copy the template banner from `20261111161533_foundation.sql` and follow
     it. It covers columns, composite foreign keys, RLS, column-listed grants,
     function revoke and grant, and trigger names.
   - Add a "notes for this unit" block under the banner explaining the
     choices.
2. **Never edit an applied migration.**
   - Fixes ship as a new migration.
   - Functions change through `create or replace` with the same signature.
     Example: U8 replaced `private.departure_rules()` and
     `private.membership_guide_linked()` to add the RLS guards.
   - Every migration works with the app version currently deployed
     (expand/contract), so it does not matter whether Vercel or `db push`
     finishes first.
3. **Rebuild from zero locally:** `npx supabase db reset`, then
   `npm run db:seed-users`. The reset drops auth users. Seed users are created
   through the admin API, because a direct insert into `auth.users` leaves no
   `auth.identities` row and breaks password login.
4. **Regenerate types:** `npm run db:types`, and commit
   `packages/shared/src/database.types.ts`. CI runs `npm run db:types -- --check`
   and fails on any diff.
5. **Cover the change in the same PR.** That means pgTAP in `supabase/tests/`
   and Vitest in `tests/db/`. A new table, RPC or definer function also needs
   its entry in the isolation matrix, the RPC matrix or the definer list
   (README, "Adding a table or a function"). The guards fail otherwise.
6. **Rebase rule.** If `main` gained a newer migration while the PR was open,
   regenerate your file's timestamp before merging. The PR preflight runs
   `supabase db push --dry-run` against `cupo-dev`. It requires the pending
   set to equal exactly the files the PR adds.
7. **Deploy.**
   - `db-deploy.yml` pushes to `cupo-dev` on every merge to `main`, after
     dumping the target. It never cancels a push in progress.
   - `cupo-prod` deploys only through the protected `workflow_dispatch` job.
     That job pushes, then deploys the app, then runs the seat drift check.
   - `--include-seed` is never passed.

## Lessons from Phase 1

- **One shared local stack, many workers.** `supabase db reset` from a
  worktree applies that worktree's migrations to the shared database. Parallel
  work serialized every database command behind a lock directory
  (`mkdir` is atomic) released by `trap`. Each locked block started with a
  reset, because the previous holder's schema could still be in place.
- **Migration order across parallel PRs.** Only one of two parallel units may
  add a migration, or both must expect a timestamp rebase at merge.
- **`auto_expose_new_tables = false`** in `config.toml` makes a forgotten
  grant fail locally first. New Supabase projects no longer auto-grant table
  privileges.
- **Generated types are a contract.** A migration that changes a signature
  shows up in `db:types -- --check` and in `tsc`, before review.
- **Hosted config.** `supabase config push` must accept every key of
  `config.toml` on the hosted API. If one is rejected, drop it from the push,
  not from the local config.
