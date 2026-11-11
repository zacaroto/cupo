-- ============================================================================
-- cupo tours: tours, per-channel prices, weekly schedules and departures with
-- capacity, status and an optional guide; derived starts_at, slot
-- materialization and the status-only cancel_departure rpc (plan u5)
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
-- 5. migrations are forward-only and created with `supabase migration new`;
--    functions change through `create or replace` with the same signature.
-- ============================================================================
--
-- notes for this unit (r15 to r18, r20, r21; ktd5, ktd7, ktd13, ktd14)
-- - schedule and departure times are a local `date` and `time` in the
--   operator's iana zone (ktd7). `tour_departures.starts_at` is derived by a
--   before trigger and recomputed for future departures when the operator's
--   timezone changes. times are whole minutes.
-- - weekdays follow postgres `extract(dow)` and javascript `getUTCDay()`:
--   0 = sunday ... 6 = saturday.
-- - money is `bigint` minor units plus an iso 4217 code (ktd7, ktd14).
--   `tour_prices` is role-gated (ktd4): administrador and contabilidad read
--   it, administrador writes it; reservas and guía get zero rows.
-- - departure states (ktd5): `scheduled -> closed`, `scheduled -> cancelled`,
--   `closed -> cancelled`; `closed` and `cancelled` are terminal otherwise.
--   a transition to `cancelled` is accepted only from public.cancel_departure(),
--   which names the row in the transaction-local setting
--   `cupo.cancel_departure`, so every cancellation runs the cascade that u6
--   adds (same signature, `create or replace`).
-- - a cancelled departure frees its slot: (tour_id, date, start_time) is
--   unique over non-cancelled departures only.
-- - `seats_booked` is owned by the u6 reservation triggers; here it only has
--   its default and the `tour_departures_seats_within_capacity` backstop.
-- ============================================================================


-- ============================================================================
-- types
-- ============================================================================

-- sales channels of the origin data model. phase 1 sells `direct` only; the
-- others carry prices now and bookings from phase 2 ingestion.
create type public.channel as enum ('direct', 'getyourguide', 'viator', 'whatsapp');

create type public.departure_status as enum ('scheduled', 'closed', 'cancelled');

-- how a departure came to exist: from a weekly schedule (materialized on the
-- first reservation) or created ad hoc. set at creation, never updated.
create type public.departure_origin as enum ('schedule', 'ad_hoc');


-- ============================================================================
-- tours (r15, r21)
-- ============================================================================

create table public.tours (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete restrict,
  name text not null,
  description text,
  duration_minutes integer not null,
  default_capacity integer not null,
  meeting_point text,
  -- r21: an archived tour is hidden from pickers and takes no new departures
  -- or reservations; its existing data is unchanged.
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tours_operator_id_id_key unique (operator_id, id),
  constraint tours_name_length check (length(btrim(name)) between 1 and 120),
  constraint tours_description_length check (description is null or length(description) <= 2000),
  constraint tours_duration_range check (duration_minutes between 1 and 43200),
  constraint tours_default_capacity_range check (default_capacity between 1 and 10000),
  constraint tours_meeting_point_length check (meeting_point is null or length(meeting_point) <= 300)
);

comment on table public.tours is
  'tours an operator sells (r15). readable by staff (not guía), written by administradores; archived instead of deleted (r21).';

create index tours_operator_id_name_idx on public.tours (operator_id, name);


-- ============================================================================
-- tour_prices (r15, ktd14)
-- ============================================================================

create table public.tour_prices (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete restrict,
  tour_id uuid not null,
  channel public.channel not null,
  price_minor bigint not null,
  currency char(3) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tour_prices_operator_id_id_key unique (operator_id, id),
  -- one price per tour and channel; leads with operator_id (ktd2 index).
  constraint tour_prices_operator_id_tour_id_channel_key unique (operator_id, tour_id, channel),
  constraint tour_prices_tour_fkey
    foreign key (operator_id, tour_id) references public.tours (operator_id, id) on delete cascade,
  -- the upper bound keeps every amount a safe integer in javascript.
  constraint tour_prices_price_minor_range check (price_minor between 0 and 999999999999),
  constraint tour_prices_currency_format check (currency ~ '^[A-Z]{3}$')
);

comment on table public.tour_prices is
  'price per tour and channel in minor units (r15, ktd14). readable by administrador and contabilidad only (r11); written by administradores.';


-- ============================================================================
-- tour_schedules (r16)
-- ============================================================================

create table public.tour_schedules (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete restrict,
  tour_id uuid not null,
  -- 0 = sunday ... 6 = saturday (`extract(dow)`).
  weekday smallint not null,
  -- local start time in the operator's timezone (ktd7).
  start_time time not null,
  -- null means the tour's default capacity.
  capacity_override integer,
  valid_from date not null,
  -- null means open-ended.
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tour_schedules_operator_id_id_key unique (operator_id, id),
  -- one schedule per tour, weekday and start time; leads with operator_id.
  constraint tour_schedules_operator_id_slot_key unique (operator_id, tour_id, weekday, start_time),
  constraint tour_schedules_tour_fkey
    foreign key (operator_id, tour_id) references public.tours (operator_id, id) on delete cascade,
  constraint tour_schedules_weekday_range check (weekday between 0 and 6),
  constraint tour_schedules_start_time_minute check (extract(second from start_time) = 0),
  constraint tour_schedules_capacity_override_range check (capacity_override is null or capacity_override between 1 and 10000),
  constraint tour_schedules_validity check (valid_to is null or valid_to >= valid_from)
);

comment on table public.tour_schedules is
  'weekly schedules of a tour (r16): weekday, local start time, optional capacity override and a validity window.';


-- ============================================================================
-- tour_departures (r16 to r18, r20; ktd5, ktd13)
-- ============================================================================

create table public.tour_departures (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete restrict,
  tour_id uuid not null,
  -- local date and start time in the operator's timezone (ktd7).
  date date not null,
  start_time time not null,
  -- copied at creation (from the schedule override or the tour default) and
  -- independent of later tour edits (r17). a direct insert may omit it.
  capacity integer not null,
  -- owned by the reservation triggers (u6); never in a client grant.
  seats_booked integer not null default 0,
  status public.departure_status not null default 'scheduled',
  -- ktd13: one optional guide, set by administradores.
  guide_id uuid,
  origin public.departure_origin not null default 'ad_hoc',
  -- derived from date, start_time and the operator's timezone (ktd7).
  starts_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tour_departures_operator_id_id_key unique (operator_id, id),
  constraint tour_departures_tour_fkey
    foreign key (operator_id, tour_id) references public.tours (operator_id, id) on delete restrict,
  -- only guide_id is nulled when the guide row is deleted (operator_id stays).
  constraint tour_departures_guide_fkey
    foreign key (operator_id, guide_id) references public.guides (operator_id, id) on delete set null (guide_id),
  constraint tour_departures_start_time_minute check (extract(second from start_time) = 0),
  constraint tour_departures_capacity_range check (capacity between 1 and 10000),
  -- ktd5 backstop: the counter never leaves [0, capacity]. lowering capacity
  -- below the booked seats fails here (the dal maps the name).
  constraint tour_departures_seats_within_capacity check (seats_booked between 0 and capacity)
);

comment on table public.tour_departures is
  'a tour on a local date and start time with its own capacity and booked-seat counter (r16, r17). never deleted by authenticated (r27); cancelled through public.cancel_departure() only.';

-- r17: a slot holds at most one live departure; a cancelled one frees it.
-- materialize_departure() relies on this exact predicate for `on conflict`.
create unique index tour_departures_slot_key
  on public.tour_departures (tour_id, date, start_time)
  where status <> 'cancelled';

-- lists by local date within an operator.
create index tour_departures_operator_id_date_idx on public.tour_departures (operator_id, date, start_time);
-- the timezone recompute and future-only reads.
create index tour_departures_operator_id_starts_at_idx on public.tour_departures (operator_id, starts_at);
-- the guía policy and the deactivation clear (ktd13).
create index tour_departures_operator_id_guide_id_idx on public.tour_departures (operator_id, guide_id, starts_at)
  where guide_id is not null;


-- ============================================================================
-- functions and triggers
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
create function private.departure_rules()
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

-- t30_departure_starts_at (ktd7): the instant of a local date and time in the
-- operator's zone. runs after t20 so the row is final.
create function private.set_departure_starts_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
begin
  select o.timezone into v_timezone
  from public.operators o
  where o.id = new.operator_id;
  new.starts_at := (new.date + new.start_time) at time zone v_timezone;
  return new;
end;
$$;
revoke execute on function private.set_departure_starts_at() from public, anon, authenticated;

-- ktd7: when an operator's timezone changes, future departures keep their
-- local date and time and get a new instant; past departures are history and
-- keep theirs. rows whose instant does not change are not touched.
create function private.recompute_starts_at_on_timezone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tour_departures d
  set starts_at = (d.date + d.start_time) at time zone new.timezone
  where d.operator_id = new.id
    and d.starts_at >= now()
    and d.starts_at is distinct from ((d.date + d.start_time) at time zone new.timezone);
  return null;
end;
$$;
revoke execute on function private.recompute_starts_at_on_timezone() from public, anon, authenticated;

-- ktd13: deactivating a guide unassigns them from their future departures
-- (past ones keep the history). runs after t80_revoke_access_on_deactivation.
create function private.clear_guide_on_deactivate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tour_departures d
  set guide_id = null
  where d.operator_id = new.operator_id
    and d.guide_id = new.id
    and d.starts_at >= now();
  return null;
end;
$$;
revoke execute on function private.clear_guide_on_deactivate() from public, anon, authenticated;

-- r17: the live departure of a slot, created on first need (u6's reservation
-- rpcs call this). returns the id of the inserted row, or of the existing
-- non-cancelled one when a concurrent call (or an earlier one) won the slot.
-- capacity and origin come from the weekly schedule that matches the
-- weekday, start time and validity window, else the tour default with origin
-- `ad_hoc`. security definer and sql-internal: the caller must hold
-- administrador or reservas in the tour's operator (the roles that book), or
-- be the service role; anything else, including another operator's tour, is
-- `not_found`.
create function private.materialize_departure(tour_id uuid, date date, start_time time)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_operator_id uuid;
  v_default_capacity integer;
  v_capacity_override integer;
  v_origin public.departure_origin := 'ad_hoc';
  v_claims_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  v_id uuid;
begin
  select t.operator_id, t.default_capacity
  into v_operator_id, v_default_capacity
  from public.tours t
  where t.id = materialize_departure.tour_id;

  if v_operator_id is null
     or (v_claims_role is distinct from 'service_role'
         and not private.has_role(v_operator_id, array['administrador', 'reservas']::public.membership_role[]))
  then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select s.capacity_override
  into v_capacity_override
  from public.tour_schedules s
  where s.operator_id = v_operator_id
    and s.tour_id = materialize_departure.tour_id
    and s.weekday = extract(dow from materialize_departure.date)
    and s.start_time = materialize_departure.start_time
    and s.valid_from <= materialize_departure.date
    and (s.valid_to is null or s.valid_to >= materialize_departure.date);
  if found then
    v_origin := 'schedule';
  end if;

  -- read committed: `on conflict do nothing` waits for a concurrent insert of
  -- the same slot and then skips; the select (a new statement, a new
  -- snapshot) sees the winner. if the winner was cancelled in between, the
  -- slot is free again and the loop retries.
  for attempt in 1..3 loop
    insert into public.tour_departures (operator_id, tour_id, date, start_time, capacity, origin)
    values (
      v_operator_id,
      materialize_departure.tour_id,
      materialize_departure.date,
      materialize_departure.start_time,
      coalesce(v_capacity_override, v_default_capacity),
      v_origin
    )
    on conflict (tour_id, date, start_time) where status <> 'cancelled' do nothing
    returning id into v_id;
    if v_id is not null then
      return v_id;
    end if;

    select d.id
    into v_id
    from public.tour_departures d
    where d.tour_id = materialize_departure.tour_id
      and d.date = materialize_departure.date
      and d.start_time = materialize_departure.start_time
      and d.status <> 'cancelled';
    if v_id is not null then
      return v_id;
    end if;
  end loop;

  raise exception using errcode = '40001', message = 'retry';
end;
$$;
revoke execute on function private.materialize_departure(uuid, date, time) from public, anon;
grant execute on function private.materialize_departure(uuid, date, time) to authenticated, service_role;

create trigger t10_set_updated_at
  before update on public.tours
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t10_set_updated_at
  before update on public.tour_prices
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t10_set_updated_at
  before update on public.tour_schedules
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t10_set_updated_at
  before update on public.tour_departures
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t20_departure_rules
  before insert or update on public.tour_departures
  for each row
  execute function private.departure_rules();

create trigger t30_departure_starts_at
  before insert or update of date, start_time on public.tour_departures
  for each row
  execute function private.set_departure_starts_at();

create trigger t80_recompute_departure_starts_at
  after update of timezone on public.operators
  for each row
  when (old.timezone is distinct from new.timezone)
  execute function private.recompute_starts_at_on_timezone();

-- second trigger on guides.active (t80_revoke_access_on_deactivation is the
-- first; triggers fire in name order).
create trigger t81_clear_guide_on_departures
  after update of active on public.guides
  for each row
  when (old.active and not new.active)
  execute function private.clear_guide_on_deactivate();


-- ============================================================================
-- cancel_departure (public rpc, security invoker; ktd5)
-- ============================================================================

-- cancels a departure (scheduled or closed) for an administrador of its
-- operator. status-only in u5; u6 replaces the body with the same signature
-- to cancel the departure's active reservations in the same transaction.
-- `not_found` when the caller cannot see the departure (another operator's
-- included), 42501 for a role other than administrador, `forbidden_transition`
-- when it is already cancelled.
create function public.cancel_departure(departure_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_operator_id uuid;
  v_id uuid;
begin
  select d.operator_id
  into v_operator_id
  from public.tour_departures d
  where d.id = cancel_departure.departure_id;
  if v_operator_id is null then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not private.has_role(v_operator_id, array['administrador']::public.membership_role[]) then
    raise exception using errcode = '42501', message = 'permission denied for cancel_departure';
  end if;

  -- lock plus transition in one statement; t20_departure_rules accepts the
  -- move to `cancelled` only for the row named here.
  perform set_config('cupo.cancel_departure', cancel_departure.departure_id::text, true);
  update public.tour_departures d
  set status = 'cancelled'
  where d.id = cancel_departure.departure_id
    and d.status <> 'cancelled'
  returning d.id into v_id;
  perform set_config('cupo.cancel_departure', '', true);

  if v_id is null then
    raise exception using errcode = 'P0001', message = 'forbidden_transition';
  end if;
end;
$$;
revoke execute on function public.cancel_departure(uuid) from public, anon, authenticated;
grant execute on function public.cancel_departure(uuid) to authenticated;


-- ============================================================================
-- row level security
-- ============================================================================

alter table public.tours enable row level security;
alter table public.tour_prices enable row level security;
alter table public.tour_schedules enable row level security;
alter table public.tour_departures enable row level security;

-- tours: staff read, administradores write (a guía reads departures only).
create policy "Staff read their operator's tours"
  on public.tours for select
  to authenticated
  using ((select private.has_role(operator_id, array['administrador', 'reservas', 'contabilidad']::public.membership_role[])));

create policy "Administradores add tours to their operator"
  on public.tours for insert
  to authenticated
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

create policy "Administradores edit their operator's tours"
  on public.tours for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

-- tour_prices: amounts for administrador and contabilidad only (r11, ktd4).
create policy "Administradores and contabilidad read their operator's prices"
  on public.tour_prices for select
  to authenticated
  using ((select private.has_role(operator_id, array['administrador', 'contabilidad']::public.membership_role[])));

create policy "Administradores add prices to their operator's tours"
  on public.tour_prices for insert
  to authenticated
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

create policy "Administradores edit their operator's prices"
  on public.tour_prices for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

-- tour_schedules: staff read, administradores write and remove.
create policy "Staff read their operator's schedules"
  on public.tour_schedules for select
  to authenticated
  using ((select private.has_role(operator_id, array['administrador', 'reservas', 'contabilidad']::public.membership_role[])));

create policy "Administradores add schedules to their operator's tours"
  on public.tour_schedules for insert
  to authenticated
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

create policy "Administradores edit their operator's schedules"
  on public.tour_schedules for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

create policy "Administradores remove their operator's schedules"
  on public.tour_schedules for delete
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

-- tour_departures: staff read every departure of the operator; a guía reads
-- the future departures assigned to them (ktd13, r20).
create policy "Staff read their operator's departures and guías their future assigned ones"
  on public.tour_departures for select
  to authenticated
  using (
    (select private.has_role(operator_id, array['administrador', 'reservas', 'contabilidad']::public.membership_role[]))
    or (guide_id in (select private.my_guide_ids()) and starts_at >= now())
  );

-- ad hoc departures (r17): administradores, and reservas without a guide
-- (the guide link is set by administradores, ktd13).
create policy "Administradores and reservas add ad hoc departures"
  on public.tour_departures for insert
  to authenticated
  with check (
    (select private.has_role(operator_id, array['administrador']::public.membership_role[]))
    or (guide_id is null and (select private.has_role(operator_id, array['reservas']::public.membership_role[])))
  );

create policy "Administradores edit their operator's departures"
  on public.tour_departures for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));


-- ============================================================================
-- grants
-- ============================================================================

-- tours: operator_id insertable, never updatable; no delete (archive, r21).
grant select on public.tours to authenticated;
grant insert (operator_id, name, description, duration_minutes, default_capacity, meeting_point)
  on public.tours to authenticated;
grant update (name, description, duration_minutes, default_capacity, meeting_point, archived_at)
  on public.tours to authenticated;
grant select, insert, update, delete on public.tours to service_role;

-- tour_prices: the tour and channel of a price never change; no delete.
grant select on public.tour_prices to authenticated;
grant insert (operator_id, tour_id, channel, price_minor, currency) on public.tour_prices to authenticated;
grant update (price_minor, currency) on public.tour_prices to authenticated;
grant select, insert, update, delete on public.tour_prices to service_role;

-- tour_schedules: removing a schedule leaves existing departures unchanged.
grant select on public.tour_schedules to authenticated;
grant insert (operator_id, tour_id, weekday, start_time, capacity_override, valid_from, valid_to)
  on public.tour_schedules to authenticated;
grant update (weekday, start_time, capacity_override, valid_from, valid_to) on public.tour_schedules to authenticated;
grant delete on public.tour_schedules to authenticated;
grant select, insert, update, delete on public.tour_schedules to service_role;

-- tour_departures (ktd4): seats_booked, starts_at, origin and status are
-- server-owned on insert (defaults and triggers); the update list is the one
-- the plan fixes. no delete (r27).
grant select on public.tour_departures to authenticated;
grant insert (operator_id, tour_id, date, start_time, capacity, guide_id) on public.tour_departures to authenticated;
grant update (capacity, status, guide_id, date, start_time) on public.tour_departures to authenticated;
grant select, insert, update, delete on public.tour_departures to service_role;
