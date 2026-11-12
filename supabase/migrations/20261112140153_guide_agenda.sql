-- ============================================================================
-- cupo guide agenda: the guía reads the tours of their future assigned
-- departures and only the masked names of the customers on the reservations
-- they can see (plan u7)
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
-- notes for this unit (r11, r20; ktd4, ktd13)
-- - no tables, functions, triggers or grants change. `tours` and
--   `customer_display` already grant select to authenticated; this migration
--   only adds and replaces select policies.
-- - tours: a second, permissive select policy lets a guía read the tours of
--   the departures their own departures policy returns (assigned to them and
--   `starts_at >= now()`), so the agenda shows tour names. prices and
--   schedules stay staff-only; a guía still reads zero `tour_prices` rows.
-- - customer_display: u9 let every member of the operator read every masked
--   name. the policy is replaced: staff (administrador, reservas,
--   contabilidad) keep reading every row of their operator, which is the same
--   set as before for them (`has_role` and `user_operator_ids` both require
--   the membership in an active operator); a guía reads only the rows of the
--   customers on the reservations the guía reservations policy returns
--   (non-cancelled, on their future assigned departures), ae10.
-- - no rls cycle: customer_display -> reservations -> tour_departures, and
--   tours -> tour_departures; none of those policies reads tours or
--   customer_display, and `private.my_guide_ids()` / `private.has_role()` are
--   definer helpers that bypass rls. no new definer function is needed.
-- ============================================================================


-- ============================================================================
-- row level security
-- ============================================================================

-- tours: a guía reads the tours of their future assigned departures (r20).
create policy "Guías read the tours of their future assigned departures"
  on public.tours for select
  to authenticated
  using (
    id in (
      select d.tour_id
      from public.tour_departures d
      where d.guide_id in (select private.my_guide_ids())
        and d.starts_at >= now()
    )
  );

-- customer_display: staff read every masked name of their operator (ktd4); a
-- guía reads the names of the customers on the reservations visible to them
-- (r11, r20, ae10).
drop policy "Members read their operator's masked customer names" on public.customer_display;

create policy "Staff read their operator's masked customer names and guías those of their reservations"
  on public.customer_display for select
  to authenticated
  using (
    (select private.has_role(operator_id, array['administrador', 'reservas', 'contabilidad']::public.membership_role[]))
    or customer_id in (
      select r.customer_id
      from public.reservations r
      where r.status <> 'cancelled'
        and r.departure_id in (
          select d.id
          from public.tour_departures d
          where d.guide_id in (select private.my_guide_ids())
            and d.starts_at >= now()
        )
    )
  );

comment on table public.customer_display is
  'masked customer name (first name plus last initial) readable by the staff of the operator and, for the customers on their visible reservations, by a guía (ktd4, u7). written only by private.sync_customer_display().';
