---
title: The cross-operator isolation harness
date: 2026-11-12
category: testing
tags: [vitest, pgtap, rls, multi-tenant, supabase]
applies_to: tests/db, supabase/tests
plan_refs: [KTD11, R30, R31, AE2, AE3, AE11]
---

# The cross-operator isolation harness

## Problem

The Phase 1 exit condition (R30) is a proof, not a promise: for every business
table, a user of operator A cannot read, insert into, update or reference rows
of operator B, including a user who belongs to both A and B. Three things are
needed:

- tests that run through the same path an attacker would use: the Data API
  with the user's own session;
- coverage that cannot silently lag behind the schema;
- evidence that the tests can fail.

## The pieces

- **Native role switching, no extra dependency.**
  - `tests/db/helpers.ts` signs real seeded users in with the publishable key
    (`clientFor`), so every query runs as `authenticated` under RLS, exactly
    like the app.
  - Raw SQL as a role uses `set local role` plus `request.jwt.claims`
    (`asRole`), which is what KTD11 chose over the basejump helpers.
  - The secret-key client and `sql()` (role `postgres`) are used only to
    arrange fixtures and to re-read rows.
- **Seeded actors.** `tests/db/fixtures.ts` holds:
  - operators A, B and C with fixed uuids;
  - every role of A;
  - an administrador of A and B (the multi-operator actor);
  - a reservas of B.

  Tests that mutate create throwaway users, operators and rows, tagged, and
  remove them. The suite runs repeatedly against one reset.
- **`tests/db/isolation-matrix.test.ts` (table-driven).**
  - One `TableSpec` per table: the foreign-operator inserts, the
    foreign-parent cases, an update payload inside the table's update grant,
    and whether update and delete are granted.
  - Every actor is run against every operator they do not belong to:
    - select returns only rows of their operators;
    - an insert with a foreign `operator_id` gets 42501;
    - an insert with their own `operator_id` and a foreign parent gets 23503;
    - update and delete of a foreign row affect zero rows (or get 42501 when
      ungranted).
  - Every foreign row and row count is re-read with the secret key.
  - A guard compares the list with `information_schema.tables` for `public`
    and `audit`.
- **`tests/db/role-matrix.test.ts`.**
  - R11 visibility for each role of A.
  - Every RPC × caller cell (four roles, `anon`, the secret key). Refused
    callers must get `forbidden` (42501, through `lib/result.ts`) with the
    state unchanged; an empty update does not count as a refusal.
  - Another operator's ids answer `not_found`.
  - A guard compares the RPC list with `pg_proc`.
- **`supabase/tests/rls_coverage_test.sql` (pgTAP)** checks the schema side:
  - RLS, policies and grants on every exposed table;
  - `operator_id` columns and their indexes;
  - composite foreign keys;
  - policies only `to authenticated`;
  - `private` tables closed to the API roles;
  - function ACLs;
  - the enumerated `security definer` list.
- **The seat gate** (`npm run db:seat-drift`) runs after the whole suite and
  must report zero drifting departures.

## Lessons

- **Make the fixtures adversarial.** A foreign chain of plain rows proved
  little. The U8 foreign chain holds:
  - an archived tour;
  - an inactive guide;
  - a reservation that already has notes.

  Those states turned three triggers into visible oracles (`tour_archived`,
  `guide_not_linked`, a 23505 on `reservation_notes`) that a happy-path
  fixture would have hidden. See `docs/solutions/database/trigger-ownership.md`.
- **Assert the exact SQLSTATE, not just "failed".** A 23505 where a 23503 was
  expected was the leak.
- **Scan, don't sample.** "Select returns only own rows" is a filter on
  `operator_id not in (own)` that must return `[]`. It covers every row, not
  the first page, and PostgREST caps pages at 1000 rows. Administrador actors
  also read their own fixture row, so the scan is not vacuous.
- **Guards keep coverage honest.** A new table, RPC or definer function fails
  the suite until someone adds its cells. That is the moment to decide its
  policy.
- **Prove the suite can fail.** The README's fail-ability runbook adds a
  temporary `using (true)` policy on `tours`. Exactly the five `tours` select
  cells fail (one per actor-operator pair), and the file is green again after
  the policy is dropped. Run it whenever the matrix or its helpers change.
- **Compare database rows by id, not time.** The database container's clock
  can lag the host, so audit assertions use an id watermark (`auditMark()`).
- **Load.** On a loaded machine, a 20-second test timeout that took much
  longer in wall time is load, not a failure. Rerun that file and say so.
