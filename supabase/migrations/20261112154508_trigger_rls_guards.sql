-- ============================================================================
-- cupo trigger rls guards: before-insert definer triggers refuse a caller
-- without the inserting role before they read another operator's rows
-- (plan u8 isolation matrix; r2, r30; ktd2, ktd5)
-- ============================================================================
--
-- migration template (copy this banner into every migration; plan KTD2, KTD4,
-- KTD5, KTD6, KTD10; checked by supabase/tests/rls_coverage_test.sql)
--
-- 1. tables
--    - every business table carries `operator_id uuid not null`, `created_at`
--      and `updated_at timestamptz not null default now()`.
--    - every parent table declares `unique (operator_id, id)`; every child
--      declares `foreign key (operator_id, <parent>_id) references
--      <parent> (operator_id, id)`. single-column foreign keys between business
--      tables are not allowed.
--    - every business table has a btree index leading with `operator_id`.
--    - `on delete`: `profiles.id` and `memberships.user_id` cascade from
--      `auth.users`; `guides.user_id` set null; `tour_prices` and
--      `tour_schedules` cascade from tours; `tour_departures.tour_id`,
--      `reservations.departure_id`, `reservations.customer_id` restrict;
--      `tour_departures.guide_id` set null; `reservation_amounts` and
--      `reservation_notes` cascade from reservations; `operators` restrict
--      everywhere.
-- 2. row level security and grants (new projects do not auto-grant privileges)
--    - `alter table ... enable row level security` on every table.
--    - every policy is `to authenticated`, wraps helper and `auth.uid()` calls
--      in `(select ...)`, and never subqueries `memberships` directly (use the
--      helpers in `private`).
--    - explicit `grant select` to `authenticated`; column-listed
--      `grant insert (...)` and `grant update (...)` to `authenticated` that
--      omit server-owned columns (`created_at`, `created_by`, `code`,
--      `seats_booked`, `has_incomplete_data`, `starts_at`); `operator_id` is in
--      the insert list and never in the update list.
--    - explicit `grant select, insert, update, delete` to `service_role`.
-- 3. functions
--    - helpers called from policies and triggers live in `private`
--      (`security definer`, `stable` where possible, `set search_path = ''`).
--    - anything the app or the tests call over the data api lives in `public`
--      as `security invoker` with `set search_path = ''`.
--    - right after creating a function in `public`: `revoke execute on function
--      ... from public, anon, authenticated;` followed by the explicit grant
--      (to `authenticated` for invoker rpcs, to `service_role` for `admin_*`).
--    - `admin_*` rpcs take `actor_id uuid` and call
--      `set_config('app.actor_id', ..., true)` before writing.
-- 4. triggers
--    - `t10_set_updated_at` (before update), `t20_<domain rule>` (before),
--      `t80_<derived>` (after), `t90_audit` (after insert or delete) and
--      `t90_audit_update` (after update).
--    - update triggers carry `when (old.* is distinct from new.*)`.
--    - trigger functions live in `private` as `security definer` with
--      `set search_path = ''`; typed errors are
--      `raise exception using errcode = 'P0001', message = '<name>'`.
--
-- notes for this unit
-- - rls checks an insert's `with check` after the before triggers. a definer
--   trigger that looks up rows by `new.operator_id` therefore runs for a
--   caller of another operator before the policy refuses the row, and its
--   typed error is an oracle across operators. u6 closed it for reservations
--   (`private.reservation_rules`); u8's matrix found two more:
--   - `private.departure_rules`: an insert with `operator_id` of another
--     operator answered `tour_archived` for an archived tour of that operator
--     (and `guide_inactive` for an inactive guide) instead of 42501, and took
--     a `for share` lock on its tour row.
--   - `private.membership_guide_linked`: a guía membership insert into
--     another operator answered `guide_not_linked` unless the user is that
--     operator's linked guide, revealing guide accounts.
-- - both functions are replaced with the same signature and the same rules,
--   plus a first check on insert: a session user (`auth.uid()` set) without
--   the role the insert policy requires in `new.operator_id` gets the
--   policy's 42501 (administrador or reservas for departures, administrador
--   for memberships). the secret key and postgres have no `auth.uid()` and
--   pass, as before. updates are unaffected: rls filters them with `using`
--   before any row trigger runs, and `operator_id` is not updatable.
-- ============================================================================


-- ============================================================================
-- functions
-- ============================================================================

-- t20_departure_rules (ktd5, r17, r18, r21): the departure state machine for
-- every write path, the archived-tour rule, the capacity default and the
-- active-guide rule.
-- - insert: a departure is born `scheduled`; the tour must not be archived
--   (the tour row is locked `for share`, so a concurrent archive and this
--   insert serialize); an omitted capacity is copied from the tour.
-- - update: `cancelled` is terminal; `closed` never goes back to `scheduled`;
--   `-> cancelled` only when public.cancel_departure() named this row in
--   `cupo.cancel_departure` for the current transaction.
-- - a newly assigned guide must be active (locked `for share`, so it cannot be
--   deactivated half-way; private.clear_guide_on_deactivate covers the rest).
-- - u8: an insert by a session user without administrador or reservas in the
--   row's operator gets the insert policy's 42501 before any lookup.
create or replace function private.departure_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_archived_at timestamptz;
  v_default_capacity integer;
  v_guide_active boolean;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null
       and not private.has_role(new.operator_id, array['administrador', 'reservas']::public.membership_role[])
    then
      raise exception using
        errcode = 'insufficient_privilege',
        message = 'new row violates row-level security policy for table "tour_departures"';
    end if;
    if new.status <> 'scheduled' then
      raise exception using errcode = 'P0001', message = 'forbidden_transition';
    end if;
    select t.archived_at, t.default_capacity
    into v_archived_at, v_default_capacity
    from public.tours t
    where t.operator_id = new.operator_id
      and t.id = new.tour_id
    for share;
    -- a missing tour, or one of another operator, is the composite foreign
    -- key's violation; raised here so an omitted capacity cannot surface as a
    -- not-null error first.
    if not found then
      raise exception using
        errcode = 'foreign_key_violation',
        message = 'insert or update on table "tour_departures" violates foreign key constraint "tour_departures_tour_fkey"',
        constraint = 'tour_departures_tour_fkey',
        schema = 'public',
        table = 'tour_departures';
    end if;
    if v_archived_at is not null then
      raise exception using errcode = 'P0001', message = 'tour_archived';
    end if;
    new.capacity := coalesce(new.capacity, v_default_capacity);
  elsif new.status is distinct from old.status then
    if old.status = 'cancelled'
       or (old.status = 'closed' and new.status = 'scheduled')
       or (new.status = 'cancelled'
           and coalesce(current_setting('cupo.cancel_departure', true), '') <> new.id::text)
    then
      raise exception using errcode = 'P0001', message = 'forbidden_transition';
    end if;
  end if;

  if new.guide_id is not null
     and (tg_op = 'INSERT' or new.guide_id is distinct from old.guide_id)
  then
    select g.active
    into v_guide_active
    from public.guides g
    where g.operator_id = new.operator_id
      and g.id = new.guide_id
    for share;
    if v_guide_active is false then
      raise exception using errcode = 'P0001', message = 'guide_inactive';
    end if;
  end if;

  return new;
end;
$$;
revoke execute on function private.departure_rules() from public, anon, authenticated;

-- r19, memberships side: a guía membership needs an active guide of the same
-- operator linked to the member. the guide row is locked `for share` so a
-- concurrent unlink or deactivation waits for this transaction and then sees
-- the membership (and the guide-side rule below rejects or revokes it).
-- u8: an insert by a session user who is not administrador of the row's
-- operator gets the insert policy's 42501 before the guide lookup.
create or replace function private.membership_guide_linked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     and auth.uid() is not null
     and not private.has_role(new.operator_id, array['administrador']::public.membership_role[])
  then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'new row violates row-level security policy for table "memberships"';
  end if;
  perform 1
  from public.guides g
  where g.operator_id = new.operator_id
    and g.user_id = new.user_id
    and g.active
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'guide_not_linked';
  end if;
  return new;
end;
$$;
revoke execute on function private.membership_guide_linked() from public, anon, authenticated;
