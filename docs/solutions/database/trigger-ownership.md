---
title: Invariants live in definer triggers; RPCs orchestrate; the DAL maps errors
date: 2026-11-12
category: database
tags: [postgres, triggers, security-definer, rls, invariants]
applies_to: supabase/migrations, apps/web/src/lib/result.ts
plan_refs: [KTD5, KTD6, R10, R23, R24, R28]
---

# Invariants live in definer triggers; RPCs orchestrate; the DAL maps errors

## Problem

The same row can be written in four ways:

- a server action;
- a direct Data API call with the user's own session;
- an RPC;
- the secret key.

A rule enforced in only one of them is enforced nowhere. A rule enforced in
several places drifts.

## The ownership rule (KTD5)

| Layer | Owns | Never does |
|---|---|---|
| Policies | who may read or write which rows (operator, role) | business state checks |
| Triggers in `private` (`security definer`, `set search_path = ''`) | every invariant on every write path: seat counter and capacity, state machines (`forbidden_transition`), `departure_not_open`, `tour_archived`, cancel reason, `created_by`, codes, `has_incomplete_data`, amount snapshot, `starts_at`, `customer_display`, audit | orchestration |
| RPCs in `public` (`security invoker`) | one transaction, input validation, a found-check on every id they are given | re-raising rules the triggers own |
| `apps/web/src/lib/result.ts` | SQLSTATE and typed error name to action state (the only place that knows `42501`, `23505`, `23503`, `P0001`, ...) | business checks |

Typed errors are `raise exception using errcode = 'P0001', message = '<name>'`,
with the names listed once in `packages/shared/src/errors.ts`. Trigger names
encode the order: `t10_set_updated_at`, then `t20_<rule>`, then `t80_<derived>`,
then `t90_audit` / `t90_audit_update`. Update triggers carry
`when (old.* is distinct from new.*)`.

Example (U8): U10 refused notes edits on a cancelled reservation in its server
action only, so a direct Data API write still succeeded. The fix was a trigger,
`t20_reservation_notes_rules`. The action keeps its own check only to build the
form state.

## Pitfall: a before trigger runs before RLS `with check`

On `insert`, Postgres runs the `before` row triggers first. It checks the
policy's `with check` afterwards, and the foreign keys run as `after` triggers
at the end of the statement. A definer trigger therefore runs for a caller who
is about to be refused, and it can read any operator's rows. Whatever it
raises first is what that caller sees. That turns it into an oracle on another
operator's data, given a known uuid:

- `tour_departures` (fixed in U8): inserting `operator_id = B` with an
  archived tour of B answered `tour_archived` instead of 42501. It also took a
  share lock on B's tour row.
- `memberships` (fixed in U8): a guía membership insert into B answered
  `guide_not_linked` unless the user was B's linked guide.
- `reservations` (fixed in U6) leaked departure state the same way.

The pattern every definer `before insert` trigger follows:

1. When `auth.uid()` is set and the caller lacks the role the insert policy
   requires in `new.operator_id`, raise the policy's own error first:
   `errcode = 'insufficient_privilege'`, message
   `new row violates row-level security policy for table "<t>"`. The secret
   key and `postgres` have no `auth.uid()` and pass.
2. Look parents up by `(new.operator_id, <parent id>)`. When nothing is found,
   raise the composite foreign key's violation yourself (`foreign_key_violation`
   with the constraint name).

   Without this, a unique check on a single-column key can answer first. U8's
   matrix caught exactly that on `reservation_notes`: its primary key is
   `reservation_id` alone, so an insert with A's operator and B's reservation
   id answered 23505 whenever that reservation had notes.

`update` and `delete` mostly avoid this problem. RLS filters them with
`using` before any row trigger fires, and `operator_id` is not updatable, so a
trigger only ever sees the caller's own rows. The gap left is an update that
points an updatable parent column at another operator's row:

- a reservation's `departure_id` or `customer_id`;
- a departure's `guide_id`.

The triggers that read those parents look them up by
`(new.operator_id, <parent id>)` and answer 23503 when nothing is found, so a
foreign parent and a missing one look the same. The U8 matrix has a cell for
each case.

U8 swept every `before` trigger, and the list is in the U8 report. Only the
three inserts above needed a change:

- `set_updated_at`, `operator_timezone_rules` and `amount_override` read no
  other operator's rows.
- `membership_last_administrador` and `guide_link_rules` run on update and
  delete only, behind `using`, on the caller's own operator.
- The seat, flag and code triggers on reservations and `set_departure_starts_at`
  run after the guarded `t20` trigger of their table.
- Tours, prices and schedules have no business `before` trigger. Their unique
  keys all include `operator_id`. The departure slot key does not, but it is
  only reachable after `departure_rules` has refused a foreign tour.

Tests that set JWT claims and then `reset role` keep the claims for the rest of
the transaction. Clear them (`set_config('request.jwt.claims', '{}', true)`)
before acting as `postgres` again, or the guard sees that user.

## Other lessons

- **Lock what you check.** A rule that reads another row locks it, so a
  concurrent writer serializes behind it. Examples:
  - the tour `for share` against an archive;
  - the guide `for share` against a deactivation;
  - the reservation `for share` in the notes rule, against a cancel.
  Read-then-check without a lock is not atomic.
- **The seat counter is a conditional update.**
  `seats_booked + delta <= capacity ... returning` locks the row and decides in
  one statement. A move locks two departures in ascending id order, so two
  opposite moves cannot deadlock. The check constraint is only the backstop.
- **A transition only one RPC may make uses a transaction-local setting.**
  `cancel_departure` sets `cupo.cancel_departure` to the row id, and
  `t20_departure_rules` accepts `-> cancelled` only for that row. The setting
  cannot be set over the Data API, because `set_config` is not exposed.
- **Audit reuses one writer.**
  - `private.record_change()` takes `record_id` from `id` and falls back to
    `reservation_id`. Amounts and, since U8, notes therefore join the
    reservation's history.
  - KTD6 excludes `customers` from the audit on purpose, for PII erasure.
  - Notes are audited because the plan owner extended KTD6 in U8. Their audit
    rows are readable by administradores only, who also read the notes.
- **Every definer function is enumerated** in `rls_coverage_test.sql`. Adding
  one is a reviewed decision, not a side effect.
