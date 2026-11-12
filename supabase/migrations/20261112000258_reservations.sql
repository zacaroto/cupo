-- ============================================================================
-- cupo reservations: reservations with role-gated notes and amounts, the seat
-- counter, codes, the incomplete-data flag and audit in definer triggers; the
-- booking rpcs, the departure cancel cascade and the seat reconciliation
-- (plan u6)
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
-- notes for this unit (r11, r22 to r25, r27, r28; ktd4, ktd5, ktd6, ktd13, ktd14)
-- - every invariant lives in a definer trigger, so the rpcs, a direct data api
--   write and the secret key obey the same rules (ktd5):
--   `t20_reservation_rules` (state machine, departure and tour checks,
--   created_by), `t25_reservation_seats` (the seat counter),
--   `t27_reservation_flag` (has_incomplete_data), `t30_reservation_code`
--   (last, so a refused create consumes no code), `t80_reservation_amount`
--   (snapshot and recompute), `t90_audit`; `t85_customer_flag` on customers.
-- - seat rule: a reservation holds `people` seats unless it is `cancelled`.
--   a write applies `new_held - old_held` with one conditional update per
--   departure (`seats_booked + delta <= capacity`), which locks the row; a move
--   releases the old departure and takes the new one in ascending id order, so
--   two opposite moves cannot deadlock. `departure_not_open` is raised only
--   when seats are taken on a cancelled departure, or by an insert or move
--   into a closed one; releases never check the status.
-- - rls checks an insert's `with check` after the before triggers, so
--   t20_reservation_rules refuses a session user without a booking role in
--   the row's operator before any counter moves (same 42501 as the policy).
-- - `reservation_notes` and `reservation_amounts` are role-gated tables (ktd4):
--   notes for administrador, reservas and contabilidad; amounts for
--   administrador and contabilidad, written only by the definer trigger and
--   overridden only by administradores (`amount_overridden`).
-- - a guía reads the non-cancelled reservations of the future departures
--   assigned to them (ktd13, r20), and neither notes nor amounts.
-- - codes are `D-000001` per operator from `private.reservation_counters`; the
--   counter row is locked until commit, so codes are consecutive per operator.
-- - `admin_seat_drift()` and `admin_reconcile_seats(actor_id)` are the
--   service-role runbook rpcs; the reconcile is audited through
--   `t90_audit_seat_reconcile` on tour_departures.
-- ============================================================================


-- ============================================================================
-- types
-- ============================================================================

-- r23: every status except `cancelled` holds seats; `cancelled` is terminal.
create type public.reservation_status as enum ('pending_review', 'confirmed', 'cancelled');


-- ============================================================================
-- reservation codes (private)
-- ============================================================================

-- one counter per operator. private, not exposed and not granted to any api
-- role: only private.next_reservation_code() touches it. derived data, so it
-- goes with its operator.
create table private.reservation_counters (
  operator_id uuid primary key references public.operators (id) on delete cascade,
  last_value bigint not null default 0
);
revoke all on private.reservation_counters from public, anon, authenticated, service_role;

-- the next code of an operator: `D-` and six digits (more once past 999999).
-- the upsert locks the counter row until the transaction ends, so concurrent
-- creates of one operator get consecutive codes and a rolled-back create
-- returns its number.
create function private.next_reservation_code(operator_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_value bigint;
begin
  insert into private.reservation_counters as c (operator_id, last_value)
  values (next_reservation_code.operator_id, 1)
  on conflict (operator_id) do update set last_value = c.last_value + 1
  returning c.last_value into v_value;
  return 'D-' || case when v_value < 1000000 then lpad(v_value::text, 6, '0') else v_value::text end;
end;
$$;
revoke execute on function private.next_reservation_code(uuid) from public, anon, authenticated;


-- ============================================================================
-- reservations (r22 to r25)
-- ============================================================================

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete restrict,
  -- server-owned (ktd4): t30_reservation_code assigns it.
  code text not null,
  -- phase 1 books `direct` only; phase 2 ingestion writes the other channels.
  channel public.channel not null default 'direct',
  -- the channel's own booking reference (phase 2).
  external_code text,
  departure_id uuid not null,
  customer_id uuid not null,
  people integer not null,
  status public.reservation_status not null default 'confirmed',
  -- server-owned: true when the customer has neither email nor phone (r26).
  has_incomplete_data boolean not null,
  cancel_reason text,
  -- server-owned: the session user that created the row.
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservations_operator_id_id_key unique (operator_id, id),
  constraint reservations_operator_id_code_key unique (operator_id, code),
  constraint reservations_operator_id_external_code_key unique (operator_id, channel, external_code),
  constraint reservations_departure_fkey
    foreign key (operator_id, departure_id) references public.tour_departures (operator_id, id) on delete restrict,
  constraint reservations_customer_fkey
    foreign key (operator_id, customer_id) references public.customers (operator_id, id) on delete restrict,
  constraint reservations_people_range check (people between 1 and 10000),
  constraint reservations_external_code_length check (external_code is null or length(btrim(external_code)) between 1 and 100),
  -- r23: cancelling requires a reason.
  constraint reservations_cancel_reason_required check (status <> 'cancelled' or cancel_reason is not null),
  constraint reservations_cancel_reason_length check (cancel_reason is null or length(btrim(cancel_reason)) between 1 and 500)
);

comment on table public.reservations is
  'manual reservations (r22 to r25). the seat counter, code, created_by, has_incomplete_data, amount snapshot and audit are owned by definer triggers; never deleted by authenticated (r27).';

-- the seat rule, the cancel cascade, the guía policy and the drift check read
-- by departure; the customer flag by customer.
create index reservations_operator_id_departure_id_idx on public.reservations (operator_id, departure_id, status);
create index reservations_operator_id_customer_id_idx on public.reservations (operator_id, customer_id);
create index reservations_created_by_idx on public.reservations (created_by) where created_by is not null;


-- ============================================================================
-- reservation_notes (r11)
-- ============================================================================

create table public.reservation_notes (
  reservation_id uuid primary key,
  operator_id uuid not null,
  notes text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservation_notes_operator_id_reservation_id_key unique (operator_id, reservation_id),
  constraint reservation_notes_reservation_fkey
    foreign key (operator_id, reservation_id) references public.reservations (operator_id, id) on delete cascade,
  constraint reservation_notes_notes_length check (length(notes) <= 2000)
);

comment on table public.reservation_notes is
  'internal notes of a reservation (r11): readable by administrador, reservas and contabilidad; written by administrador and reservas; never by a guía.';


-- ============================================================================
-- reservation_amounts (r25, ktd14)
-- ============================================================================

create table public.reservation_amounts (
  reservation_id uuid primary key,
  operator_id uuid not null,
  unit_price_minor bigint not null,
  currency char(3) not null,
  total_minor bigint not null,
  -- true once an administrador sets the total by hand; people changes then
  -- leave it alone.
  amount_overridden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservation_amounts_operator_id_reservation_id_key unique (operator_id, reservation_id),
  constraint reservation_amounts_reservation_fkey
    foreign key (operator_id, reservation_id) references public.reservations (operator_id, id) on delete cascade,
  constraint reservation_amounts_unit_price_minor_range check (unit_price_minor between 0 and 999999999999),
  constraint reservation_amounts_total_minor_range check (total_minor between 0 and 999999999999),
  constraint reservation_amounts_currency_format check (currency ~ '^[A-Z]{3}$')
);

comment on table public.reservation_amounts is
  'amount snapshot of a reservation in minor units (r25, ktd14): written by private.reservation_amount() from tour_prices, readable by administrador and contabilidad, overridden by administradores only.';


-- ============================================================================
-- audit: record id for tables keyed by reservation_id
-- ============================================================================

-- same function and signature as the foundation's; `record_id` falls back to
-- `reservation_id` for tables without an `id` (reservation_amounts), so a
-- reservation's history is every event whose record_id is the reservation.
create or replace function private.record_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_jwt_actor uuid := auth.uid();
  v_app_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
begin
  insert into audit.events (
    operator_id, table_name, record_id, op, old_record, new_record, actor_id, actor_source
  )
  values (
    coalesce(v_new ->> 'operator_id', v_old ->> 'operator_id')::uuid,
    tg_table_name,
    coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'reservation_id', v_old ->> 'reservation_id')::uuid,
    lower(tg_op),
    v_old,
    v_new,
    coalesce(v_jwt_actor, v_app_actor),
    case
      when v_jwt_actor is not null then 'jwt'
      when v_app_actor is not null then 'app'
      else 'system'
    end
  );
  return null;
end;
$$;
revoke execute on function private.record_change() from public, anon, authenticated;


-- ============================================================================
-- reservation triggers (ktd5)
-- ============================================================================

-- t20_reservation_rules: who may insert, the state machine and the departure.
-- - insert: a session user needs administrador or reservas in the row's
--   operator (rls would refuse it too, but only after the counter moved); a
--   reservation is never born `cancelled`; created_by is the session user.
-- - update: `cancelled` is terminal (status, people, departure, customer and
--   reason are frozen); `confirmed` never goes back to `pending_review`.
-- - the departure (on insert or a move) must belong to the row's operator
--   (else the composite foreign key's violation, before any counter moves); an
--   insert refuses an archived tour (r21, the tour row locked `for share`
--   against a concurrent archive); a move stays within the same tour.
create function private.reservation_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tour_id uuid;
  v_archived_at timestamptz;
  v_old_tour_id uuid;
begin
  if tg_op = 'INSERT' then
    if v_uid is not null
       and not private.has_role(new.operator_id, array['administrador', 'reservas']::public.membership_role[])
    then
      raise exception using
        errcode = 'insufficient_privilege',
        message = 'new row violates row-level security policy for table "reservations"';
    end if;
    if new.status = 'cancelled' then
      raise exception using errcode = 'P0001', message = 'forbidden_transition';
    end if;
    new.created_by := v_uid;
  else
    if (old.status = 'cancelled'
        and (new.status is distinct from old.status
             or new.people is distinct from old.people
             or new.departure_id is distinct from old.departure_id
             or new.customer_id is distinct from old.customer_id
             or new.cancel_reason is distinct from old.cancel_reason))
       or (old.status = 'confirmed' and new.status = 'pending_review')
    then
      raise exception using errcode = 'P0001', message = 'forbidden_transition';
    end if;
  end if;

  if tg_op = 'INSERT' or new.departure_id is distinct from old.departure_id then
    select d.tour_id, t.archived_at
    into v_tour_id, v_archived_at
    from public.tour_departures d
    join public.tours t on t.operator_id = d.operator_id and t.id = d.tour_id
    where d.operator_id = new.operator_id
      and d.id = new.departure_id
    for share of t;
    if not found then
      raise exception using
        errcode = 'foreign_key_violation',
        message = 'insert or update on table "reservations" violates foreign key constraint "reservations_departure_fkey"',
        constraint = 'reservations_departure_fkey',
        schema = 'public',
        table = 'reservations';
    end if;
    if tg_op = 'INSERT' then
      if v_archived_at is not null then
        raise exception using errcode = 'P0001', message = 'tour_archived';
      end if;
    else
      select d.tour_id
      into v_old_tour_id
      from public.tour_departures d
      where d.operator_id = old.operator_id
        and d.id = old.departure_id;
      if v_old_tour_id is distinct from v_tour_id then
        raise exception using errcode = 'P0001', message = 'forbidden_transition';
      end if;
    end if;
  end if;

  return new;
end;
$$;
revoke execute on function private.reservation_rules() from public, anon, authenticated;

-- t25_reservation_seats (ktd5, r24): `new_held - old_held` on the departure,
-- or a release on the old one and a take on the new one, in ascending id
-- order. a take is one conditional update (`seats_booked + delta <=
-- capacity`) that locks the row and returns its current status; zero rows is
-- `capacity_exceeded` (or `departure_not_open` when the departure is not open
-- for this write, which reads better than "full"). the
-- tour_departures_seats_within_capacity check is the backstop.
create function private.reservation_seats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator_id uuid := case when tg_op = 'DELETE' then old.operator_id else new.operator_id end;
  v_old_departure uuid := case when tg_op = 'INSERT' then null else old.departure_id end;
  v_new_departure uuid := case when tg_op = 'DELETE' then null else new.departure_id end;
  v_old_held integer := case when tg_op <> 'INSERT' and old.status <> 'cancelled' then old.people else 0 end;
  v_new_held integer := case when tg_op <> 'DELETE' and new.status <> 'cancelled' then new.people else 0 end;
  v_step record;
  v_status public.departure_status;
  v_taken boolean;
begin
  for v_step in
    select s.departure_id, s.delta, s.entering
    from (
      -- same departure: one net change; a people increase is not an entry.
      select v_new_departure as departure_id, v_new_held - v_old_held as delta, false as entering
      where tg_op = 'UPDATE' and v_new_departure = v_old_departure
      union all
      select v_old_departure, -v_old_held, false
      where v_old_departure is not null and v_old_departure is distinct from v_new_departure
      union all
      select v_new_departure, v_new_held, true
      where v_new_departure is not null and v_new_departure is distinct from v_old_departure
    ) s
    where s.delta <> 0
    order by s.departure_id
  loop
    if v_step.delta < 0 then
      update public.tour_departures d
      set seats_booked = d.seats_booked + v_step.delta
      where d.operator_id = v_operator_id
        and d.id = v_step.departure_id;
    else
      update public.tour_departures d
      set seats_booked = d.seats_booked + v_step.delta
      where d.operator_id = v_operator_id
        and d.id = v_step.departure_id
        and d.seats_booked + v_step.delta <= d.capacity
      returning d.status into v_status;
      v_taken := found;
      if not v_taken then
        select d.status into v_status
        from public.tour_departures d
        where d.operator_id = v_operator_id
          and d.id = v_step.departure_id;
      end if;
      if v_status = 'cancelled' or (v_step.entering and v_status = 'closed') then
        raise exception using errcode = 'P0001', message = 'departure_not_open';
      end if;
      if not v_taken then
        raise exception using errcode = 'P0001', message = 'capacity_exceeded';
      end if;
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke execute on function private.reservation_seats() from public, anon, authenticated;

-- t27_reservation_flag (r22, r26): incomplete when the customer has neither
-- email nor phone. the customer row is locked `for share`, so a concurrent
-- contact change waits and t85_customer_flag then sees this reservation.
create function private.reservation_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_incomplete boolean;
begin
  select c.email is null and c.phone is null
  into v_incomplete
  from public.customers c
  where c.operator_id = new.operator_id
    and c.id = new.customer_id
  for share;
  if not found then
    raise exception using
      errcode = 'foreign_key_violation',
      message = 'insert or update on table "reservations" violates foreign key constraint "reservations_customer_fkey"',
      constraint = 'reservations_customer_fkey',
      schema = 'public',
      table = 'reservations';
  end if;
  new.has_incomplete_data := v_incomplete;
  return new;
end;
$$;
revoke execute on function private.reservation_flag() from public, anon, authenticated;

-- t30_reservation_code: last before trigger, after the counter accepted the
-- seats, so a refused create consumes no code.
create function private.reservation_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.code := private.next_reservation_code(new.operator_id);
  return new;
end;
$$;
revoke execute on function private.reservation_code() from public, anon, authenticated;

-- t80_reservation_amount (r25, ktd14): the snapshot of the tour's price for
-- the reservation's channel at creation (`price_missing` without one), and
-- the total recomputed when people change unless an administrador overrode it.
-- reservas cannot read prices, so only definer code can compute this.
create function private.reservation_amount()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price_minor bigint;
  v_currency char(3);
begin
  if tg_op = 'INSERT' then
    select p.price_minor, p.currency
    into v_price_minor, v_currency
    from public.tour_departures d
    join public.tour_prices p
      on p.operator_id = d.operator_id
     and p.tour_id = d.tour_id
     and p.channel = new.channel
    where d.operator_id = new.operator_id
      and d.id = new.departure_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'price_missing';
    end if;
    insert into public.reservation_amounts (reservation_id, operator_id, unit_price_minor, currency, total_minor)
    values (new.id, new.operator_id, v_price_minor, v_currency, v_price_minor * new.people);
  else
    update public.reservation_amounts a
    set total_minor = a.unit_price_minor * new.people
    where a.operator_id = new.operator_id
      and a.reservation_id = new.id
      and not a.amount_overridden;
  end if;
  return null;
end;
$$;
revoke execute on function private.reservation_amount() from public, anon, authenticated;

-- an update of total_minor issued directly (trigger depth 1: an
-- administrador through the data api, or the secret key) is an override; the
-- recompute above runs nested inside the reservations trigger and is not.
create function private.amount_override()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() = 1 and new.total_minor is distinct from old.total_minor then
    new.amount_overridden := true;
  end if;
  return new;
end;
$$;
revoke execute on function private.amount_override() from public, anon, authenticated;

-- t85_customer_flag: a contact change on a customer rewrites the flag of the
-- reservations whose value changes (and only those, so each change is one
-- audit row per affected reservation).
create function private.customer_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.reservations r
  set has_incomplete_data = (new.email is null and new.phone is null)
  where r.operator_id = new.operator_id
    and r.customer_id = new.id
    and r.has_incomplete_data is distinct from (new.email is null and new.phone is null);
  return null;
end;
$$;
revoke execute on function private.customer_flag() from public, anon, authenticated;

create trigger t10_set_updated_at
  before update on public.reservations
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t20_reservation_rules
  before insert or update on public.reservations
  for each row
  execute function private.reservation_rules();

create trigger t25_reservation_seats
  before insert or update of status, people, departure_id or delete on public.reservations
  for each row
  execute function private.reservation_seats();

create trigger t27_reservation_flag
  before insert or update of customer_id on public.reservations
  for each row
  execute function private.reservation_flag();

create trigger t30_reservation_code
  before insert on public.reservations
  for each row
  execute function private.reservation_code();

create trigger t80_reservation_amount
  after insert on public.reservations
  for each row
  execute function private.reservation_amount();

create trigger t80_reservation_amount_update
  after update of people on public.reservations
  for each row
  when (old.people is distinct from new.people)
  execute function private.reservation_amount();

create trigger t90_audit
  after insert or delete on public.reservations
  for each row
  execute function private.record_change();

create trigger t90_audit_update
  after update on public.reservations
  for each row
  when (old.* is distinct from new.*)
  execute function private.record_change();

create trigger t10_set_updated_at
  before update on public.reservation_notes
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t10_set_updated_at
  before update on public.reservation_amounts
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t20_amount_override
  before update of total_minor on public.reservation_amounts
  for each row
  execute function private.amount_override();

create trigger t90_audit
  after insert or delete on public.reservation_amounts
  for each row
  execute function private.record_change();

create trigger t90_audit_update
  after update on public.reservation_amounts
  for each row
  when (old.* is distinct from new.*)
  execute function private.record_change();

create trigger t85_customer_flag
  after update of email, phone on public.customers
  for each row
  when (old.email is distinct from new.email or old.phone is distinct from new.phone)
  execute function private.customer_flag();

-- the reconcile rpc below is the only writer that sets `cupo.reconcile_seats`;
-- its counter rewrites are audited with the actor it was given.
create trigger t90_audit_seat_reconcile
  after update of seats_booked on public.tour_departures
  for each row
  when (old.seats_booked is distinct from new.seats_booked
        and current_setting('cupo.reconcile_seats', true) = 'on')
  execute function private.record_change();


-- ============================================================================
-- booking rpcs (public, security invoker; ktd5)
-- ============================================================================

-- f3: one transaction that resolves the departure (an existing one, or the
-- slot's live departure, materialized on first need, r17), resolves the
-- customer (an existing one, or a new one; a new one whose email the operator
-- already has is that customer, r26), inserts the reservation and its notes,
-- and returns its id and code. every rule is a trigger's; this function only
-- checks the caller's role, found-checks the ids it is given (`not_found`
-- also for another operator's) and validates that a departure and a customer
-- were named (22023).
create function public.create_reservation(
  operator_id uuid,
  people integer,
  departure_id uuid default null,
  tour_id uuid default null,
  date date default null,
  start_time time default null,
  status public.reservation_status default 'confirmed',
  customer_id uuid default null,
  customer_name text default null,
  customer_email text default null,
  customer_phone text default null,
  notes text default null
)
returns table (id uuid, code text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_departure_id uuid := create_reservation.departure_id;
  v_customer_id uuid := create_reservation.customer_id;
  v_email text := nullif(lower(btrim(create_reservation.customer_email)), '');
  v_id uuid;
  v_code text;
begin
  if not private.has_role(create_reservation.operator_id, array['administrador', 'reservas']::public.membership_role[]) then
    raise exception using errcode = '42501', message = 'permission denied for create_reservation';
  end if;

  if v_departure_id is not null then
    perform 1
    from public.tour_departures d
    where d.operator_id = create_reservation.operator_id
      and d.id = v_departure_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
  elsif create_reservation.tour_id is not null
        and create_reservation.date is not null
        and create_reservation.start_time is not null
  then
    perform 1
    from public.tours t
    where t.operator_id = create_reservation.operator_id
      and t.id = create_reservation.tour_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    v_departure_id := private.materialize_departure(
      create_reservation.tour_id, create_reservation.date, create_reservation.start_time
    );
  else
    raise exception using errcode = '22023', message = 'a departure or a tour, date and start time is required';
  end if;

  if v_customer_id is not null then
    perform 1
    from public.customers c
    where c.operator_id = create_reservation.operator_id
      and c.id = v_customer_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
  elsif nullif(btrim(create_reservation.customer_name), '') is not null then
    insert into public.customers (operator_id, name, email, phone)
    values (
      create_reservation.operator_id,
      btrim(create_reservation.customer_name),
      v_email,
      nullif(btrim(create_reservation.customer_phone), '')
    )
    on conflict (operator_id, lower(email)) where email is not null do nothing
    returning customers.id into v_customer_id;
    if v_customer_id is null then
      select c.id
      into v_customer_id
      from public.customers c
      where c.operator_id = create_reservation.operator_id
        and lower(c.email) = v_email;
    end if;
  else
    raise exception using errcode = '22023', message = 'a customer id or a customer name is required';
  end if;

  insert into public.reservations (operator_id, departure_id, customer_id, people, status)
  values (
    create_reservation.operator_id,
    v_departure_id,
    v_customer_id,
    create_reservation.people,
    coalesce(create_reservation.status, 'confirmed')
  )
  returning reservations.id, reservations.code into v_id, v_code;

  if nullif(btrim(create_reservation.notes), '') is not null then
    insert into public.reservation_notes (operator_id, reservation_id, notes)
    values (create_reservation.operator_id, v_id, btrim(create_reservation.notes));
  end if;

  return query select v_id, v_code;
end;
$$;
revoke execute on function public.create_reservation(
  uuid, integer, uuid, uuid, date, time, public.reservation_status, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_reservation(
  uuid, integer, uuid, uuid, date, time, public.reservation_status, uuid, text, text, text, text
) to authenticated;

-- edits people, moves to another departure of the same tour (an existing one,
-- or a slot materialized on first need), and sets or clears the notes ('' is
-- empty notes). null arguments keep the current value. status changes
-- (confirm, cancel with a reason) are plain updates under the same triggers.
-- `not_found` when the caller cannot see the reservation or the target
-- departure; 42501 for a role that cannot book.
create function public.update_reservation(
  reservation_id uuid,
  people integer default null,
  departure_id uuid default null,
  date date default null,
  start_time time default null,
  notes text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_operator_id uuid;
  v_current_departure uuid;
  v_departure_id uuid;
  v_tour_id uuid;
begin
  select r.operator_id, r.departure_id
  into v_operator_id, v_current_departure
  from public.reservations r
  where r.id = update_reservation.reservation_id;
  if v_operator_id is null then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not private.has_role(v_operator_id, array['administrador', 'reservas']::public.membership_role[]) then
    raise exception using errcode = '42501', message = 'permission denied for update_reservation';
  end if;

  v_departure_id := v_current_departure;
  if update_reservation.departure_id is not null then
    perform 1
    from public.tour_departures d
    where d.operator_id = v_operator_id
      and d.id = update_reservation.departure_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    v_departure_id := update_reservation.departure_id;
  elsif update_reservation.date is not null or update_reservation.start_time is not null then
    if update_reservation.date is null or update_reservation.start_time is null then
      raise exception using errcode = '22023', message = 'a move needs both a date and a start time';
    end if;
    select d.tour_id
    into v_tour_id
    from public.tour_departures d
    where d.operator_id = v_operator_id
      and d.id = v_current_departure;
    v_departure_id := private.materialize_departure(v_tour_id, update_reservation.date, update_reservation.start_time);
  end if;

  if update_reservation.people is not null or v_departure_id is distinct from v_current_departure then
    update public.reservations r
    set people = coalesce(update_reservation.people, r.people),
        departure_id = v_departure_id
    where r.operator_id = v_operator_id
      and r.id = update_reservation.reservation_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
  end if;

  if update_reservation.notes is not null then
    insert into public.reservation_notes (operator_id, reservation_id, notes)
    values (v_operator_id, update_reservation.reservation_id, btrim(update_reservation.notes))
    on conflict (reservation_id) do update
      set notes = excluded.notes
      where reservation_notes.notes is distinct from excluded.notes;
  end if;
end;
$$;
revoke execute on function public.update_reservation(uuid, integer, uuid, date, time, text) from public, anon, authenticated;
grant execute on function public.update_reservation(uuid, integer, uuid, date, time, text) to authenticated;

-- cancel_departure with the cascade (r18, ktd5): same signature as u5. the
-- departure is cancelled first (lock plus transition in one statement, so
-- creates that wait on the row then see `cancelled`), then its active
-- reservations are cancelled with reason `departure_cancelled` in the same
-- transaction; each one releases its seats through t25 and is audited with
-- the administrador as the jwt actor.
create or replace function public.cancel_departure(departure_id uuid)
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

  update public.reservations r
  set status = 'cancelled',
      cancel_reason = 'departure_cancelled'
  where r.operator_id = v_operator_id
    and r.departure_id = cancel_departure.departure_id
    and r.status <> 'cancelled';
end;
$$;
revoke execute on function public.cancel_departure(uuid) from public, anon, authenticated;
grant execute on function public.cancel_departure(uuid) to authenticated;


-- ============================================================================
-- seat reconciliation (public, security invoker, service_role only; ktd6)
-- ============================================================================

-- read-only: departures whose counter differs from the people held by their
-- non-cancelled reservations. zero rows is the r24 invariant.
create function public.admin_seat_drift()
returns table (departure_id uuid, operator_id uuid, seats_booked integer, held integer)
language sql
security invoker
stable
set search_path = ''
as $$
  select d.id, d.operator_id, d.seats_booked, coalesce(h.held, 0)::integer
  from public.tour_departures d
  left join (
    select r.operator_id, r.departure_id, sum(r.people)::integer as held
    from public.reservations r
    where r.status <> 'cancelled'
    group by r.operator_id, r.departure_id
  ) h on h.operator_id = d.operator_id and h.departure_id = d.id
  where d.seats_booked <> coalesce(h.held, 0)
  order by d.operator_id, d.id;
$$;
revoke execute on function public.admin_seat_drift() from public, anon, authenticated;
grant execute on function public.admin_seat_drift() to service_role;

-- rewrites every drifting counter to the held sum on behalf of `actor_id`
-- (runbook: decide with the operator first when a sum exceeds capacity; the
-- backstop check refuses that rewrite). locks the drifting departures in id
-- order, the order the seat trigger uses, then recomputes from a fresh
-- snapshot. returns the number of departures rewritten; each rewrite is
-- audited with source `app` (t90_audit_seat_reconcile).
create function public.admin_reconcile_seats(actor_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_count integer;
begin
  perform set_config('app.actor_id', coalesce(admin_reconcile_seats.actor_id::text, ''), true);
  perform set_config('cupo.reconcile_seats', 'on', true);

  perform 1
  from public.tour_departures d
  where d.id in (select s.departure_id from public.admin_seat_drift() s)
  order by d.id
  for update;

  update public.tour_departures d
  set seats_booked = s.held
  from public.admin_seat_drift() s
  where d.id = s.departure_id;
  get diagnostics v_count = row_count;

  perform set_config('cupo.reconcile_seats', '', true);
  return v_count;
end;
$$;
revoke execute on function public.admin_reconcile_seats(uuid) from public, anon, authenticated;
grant execute on function public.admin_reconcile_seats(uuid) to service_role;


-- ============================================================================
-- row level security
-- ============================================================================

alter table public.reservations enable row level security;
alter table public.reservation_notes enable row level security;
alter table public.reservation_amounts enable row level security;

-- reservations: staff read every reservation of the operator; a guía reads
-- the non-cancelled ones on the future departures assigned to them (ktd13).
create policy "Staff read their operator's reservations and guías the active ones on their future departures"
  on public.reservations for select
  to authenticated
  using (
    (select private.has_role(operator_id, array['administrador', 'reservas', 'contabilidad']::public.membership_role[]))
    or (
      status <> 'cancelled'
      and departure_id in (
        select d.id
        from public.tour_departures d
        where d.guide_id in (select private.my_guide_ids())
          and d.starts_at >= now()
      )
    )
  );

create policy "Administradores and reservas add reservations to their operator"
  on public.reservations for insert
  to authenticated
  with check ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])));

create policy "Administradores and reservas edit their operator's reservations"
  on public.reservations for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])));

-- reservation_notes: staff read (r11), administrador and reservas write.
create policy "Staff read their operator's reservation notes"
  on public.reservation_notes for select
  to authenticated
  using ((select private.has_role(operator_id, array['administrador', 'reservas', 'contabilidad']::public.membership_role[])));

create policy "Administradores and reservas add reservation notes"
  on public.reservation_notes for insert
  to authenticated
  with check ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])));

create policy "Administradores and reservas edit reservation notes"
  on public.reservation_notes for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])));

-- reservation_amounts: administrador and contabilidad read (r11); only
-- administradores override; nobody inserts (the definer trigger does).
create policy "Administradores and contabilidad read their operator's amounts"
  on public.reservation_amounts for select
  to authenticated
  using ((select private.has_role(operator_id, array['administrador', 'contabilidad']::public.membership_role[])));

create policy "Administradores override their operator's amounts"
  on public.reservation_amounts for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));


-- ============================================================================
-- grants
-- ============================================================================

-- reservations (ktd4): code, created_by, has_incomplete_data, channel and
-- external_code are server-owned; operator_id insertable, never updatable;
-- no delete (r27).
grant select on public.reservations to authenticated;
grant insert (operator_id, departure_id, customer_id, people, status) on public.reservations to authenticated;
grant update (departure_id, customer_id, people, status, cancel_reason) on public.reservations to authenticated;
grant select, insert, update, delete on public.reservations to service_role;

-- reservation_notes: the reservation of a note never changes; no delete.
grant select on public.reservation_notes to authenticated;
grant insert (operator_id, reservation_id, notes) on public.reservation_notes to authenticated;
grant update (notes) on public.reservation_notes to authenticated;
grant select, insert, update, delete on public.reservation_notes to service_role;

-- reservation_amounts: no insert for authenticated; the override is the total only.
grant select on public.reservation_amounts to authenticated;
grant update (total_minor) on public.reservation_amounts to authenticated;
grant select, insert, update, delete on public.reservation_amounts to service_role;
