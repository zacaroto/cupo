---
title: Tenant isolation with RLS helpers and composite foreign keys
date: 2026-11-12
category: security
tags: [supabase, postgres, rls, multi-tenant, foreign-keys]
applies_to: every table in public and audit
plan_refs: [KTD2, KTD4, KTD6, KTD13, R2, R11, R30, R31]
---

# Tenant isolation with RLS helpers and composite foreign keys

## Problem

Every business row belongs to one operator, and one user can belong to several
operators with different roles. The browser holds the same Supabase session as
the server, so anything the Data API returns for that session is readable,
whatever the UI hides. Go Pesca, the predecessor, hit two failures here. A
`memberships` policy that subqueried `memberships` recursed. Single-column
foreign keys let a row of one tenant point at a parent of another.

## What cupo does

Isolation has three layers, and a review must protect all three:

1. **RLS on `operator_id`, through `private` helpers.**
   - `private.user_operator_ids()` and `private.has_role(operator_id, roles[])`
     join `memberships` with `operators` and ignore inactive operators.
   - `private.my_guide_ids()` returns the guide ids of a guía user.
   - `private.can_view_profile(id)` implements the profile rule.
   - All of them are `security definer`, `stable`, `set search_path = ''`, and
     executable by `authenticated`.
   - Policies call them wrapped in `(select ...)`, so the planner evaluates
     them once per statement. They never subquery `memberships` directly; that
     was the recursion bug.
   - Every policy is `to authenticated`.
2. **Composite foreign keys.**
   - Every parent declares `unique (operator_id, id)`.
   - Every child declares `foreign key (operator_id, <parent>_id) references
     <parent> (operator_id, id)`.
   - With RLS alone, a user of A could insert a reservation with
     `operator_id = A` and a departure of B whose id they know. The composite
     key makes that row impossible (AE11). Single-column foreign keys between
     business tables are not allowed.
3. **`operator_id` cannot change.**
   - It is in each table's column-listed insert grant and in no update grant.
   - The server stamps it from the active context. It never reads it from
     form data.

Role-gated data lives in its own tables with their own select policies:

| Data | Table | Readers |
|---|---|---|
| Prices | `tour_prices` | administrador, contabilidad |
| Amounts | `reservation_amounts` | administrador, contabilidad |
| Notes | `reservation_notes` | administrador, reservas, contabilidad |
| Customer PII | `customers` | administrador, reservas |
| Masked names | `customer_display` | staff, plus a guía for the customers on their visible reservations |
| History | `audit.events` | administrador |

Column grants and `security_invoker` views were rejected for read privacy. They
cannot hide a column from a role that can already read the row through
PostgREST.

## Narrowing applied in U7 (KTD4 wording is stale)

KTD4 says `customer_display` is "readable by every role of the operator". U9
shipped exactly that. U7 then narrowed it for the guía, and the plan text was
not edited:

- Staff (administrador, reservas, contabilidad) read every masked name of
  their operator. This is the same set as before, because `has_role` and
  `user_operator_ids` both require a membership in an active operator.
- A guía reads only the masked names of the customers on the reservations
  their own reservations policy returns: non-cancelled reservations on their
  future assigned departures.
- In the same change, the guía can read `tours`, but only the tours of their
  future assigned departures (`20261112140153_guide_agenda.sql`). Prices and
  schedules stay staff-only.

Read the KTD4 line as "readable by the staff of the operator, and by a guía
for their visible reservations". `tests/db/role-matrix.test.ts` pins both rows
of that rule.

## RLS cycles

Policies that read other tables can recurse. Before adding a policy that reads
another table, check that the chain has no cycle. Two ways to avoid one:

- Route the membership check through a `private` definer helper, which
  bypasses RLS.
- Keep the policy chain acyclic.

Today's chains are `customer_display -> reservations -> tour_departures` and
`tours -> tour_departures`. None of those policies reads `tours` or
`customer_display`.

## How it is checked

- `supabase/tests/rls_coverage_test.sql`:
  - RLS on, a policy and grants on every table in `public` and `audit`;
  - `operator_id` with a leading btree index on every table except
    `operators` and `profiles`;
  - composite foreign keys between business tables;
  - policies only `to authenticated`;
  - `private` tables closed to the API roles.
- `tests/db/isolation-matrix.test.ts` proves the three layers for every table
  and actor. See the isolation harness entry.
