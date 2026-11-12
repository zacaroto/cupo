-- ============================================================================
-- cupo reservation notes rules: notes of a cancelled reservation are frozen on
-- every write path, and notes changes are audited into the reservation's
-- history (plan u8 scope additions; r23, r28, r29; ktd5, ktd6)
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
-- - `t20_reservation_notes_rules` (before insert or update on
--   reservation_notes) raises `forbidden_transition` when the note's
--   reservation is cancelled, so a direct data api write, the
--   `update_reservation` rpc and the secret key obey the same rule as the u10
--   action (which keeps its own check for the form state). deletes are not
--   covered: only the secret key can delete, and the reservation cascade must
--   keep working.
-- - the reservation row is read `for share`, so a notes write and a concurrent
--   cancel serialize: whichever commits second sees the other's result.
-- - rls checks an insert's `with check` after the before triggers, so the
--   trigger first refuses a session user without administrador or reservas
--   in the row's operator with the same 42501 as the policy; otherwise a user
--   of a would learn from the error whether a reservation of b is cancelled.
-- - the reservation is looked up by (operator_id, reservation_id). when it is
--   not found (another operator's reservation id under the caller's own
--   operator, or no reservation at all) the trigger raises the composite
--   foreign key's violation itself: the primary key is `reservation_id`
--   alone, so otherwise its unique check would run first and answer 23505
--   whenever that foreign reservation already has notes (an oracle the u8
--   matrix found).
-- - `t90_audit` / `t90_audit_update` attach `private.record_change()` to
--   reservation_notes (ktd6 extended by the plan owner): its `record_id`
--   falls back to `reservation_id`, so notes changes join the reservation's
--   history. audit rows are readable by administradores only, who also read
--   the notes.
-- ============================================================================


-- ============================================================================
-- functions
-- ============================================================================

create function private.reservation_notes_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.reservation_status;
begin
  if auth.uid() is not null
     and not private.has_role(new.operator_id, array['administrador', 'reservas']::public.membership_role[])
  then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'new row violates row-level security policy for table "reservation_notes"';
  end if;

  select r.status
  into v_status
  from public.reservations r
  where r.operator_id = new.operator_id
    and r.id = new.reservation_id
  for share;

  if not found then
    raise exception using
      errcode = 'foreign_key_violation',
      message = 'insert or update on table "reservation_notes" violates foreign key constraint "reservation_notes_reservation_fkey"',
      constraint = 'reservation_notes_reservation_fkey',
      schema = 'public',
      table = 'reservation_notes';
  end if;
  if v_status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'forbidden_transition';
  end if;

  return new;
end;
$$;
revoke execute on function private.reservation_notes_rules() from public, anon, authenticated;


-- ============================================================================
-- triggers
-- ============================================================================

create trigger t20_reservation_notes_rules
  before insert or update on public.reservation_notes
  for each row
  execute function private.reservation_notes_rules();

create trigger t90_audit
  after insert or delete on public.reservation_notes
  for each row
  execute function private.record_change();

create trigger t90_audit_update
  after update on public.reservation_notes
  for each row
  when (old.* is distinct from new.*)
  execute function private.record_change();

comment on table public.reservation_notes is
  'internal notes of a reservation (r11): readable by administrador, reservas and contabilidad; written by administrador and reservas; never by a guía. frozen once the reservation is cancelled; changes are audited under the reservation id.';
