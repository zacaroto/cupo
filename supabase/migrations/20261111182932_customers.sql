-- ============================================================================
-- cupo customers: customers (full pii, administrador and reservas only) and
-- customer_display (masked name, every role of the operator)
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
-- unit notes (plan u9; r11, r26; ktd2, ktd4, ktd5, ktd6)
-- - `customers` holds the personal data (name, email, phone). only
--   administrador and reservas read or write it; no role may delete it (r27).
-- - `customer_display` holds one masked name per customer (first name plus
--   last initial) for every role of the operator. it is derived data: only the
--   definer trigger on `customers` writes it. roles without full access read
--   reservations first and then `customer_display` for those customer ids in a
--   second query (postgrest cannot embed it from `reservations`).
-- - `customers` is not audited on purpose (ktd6): personal data must be
--   erasable, and audit rows are never deleted.
-- ============================================================================


-- ============================================================================
-- customers
-- ============================================================================

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete restrict,
  name text not null,
  -- stored as entered (the app lowercases); uniqueness is on lower(email).
  email text,
  phone text,
  -- null means "use the operator's locale".
  preferred_locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_operator_id_id_key unique (operator_id, id),
  constraint customers_name_length check (length(btrim(name)) between 1 and 200),
  constraint customers_email_format check (
    email is null or (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
  ),
  constraint customers_phone_format check (
    phone is null or (length(btrim(phone)) between 4 and 40 and phone ~ '^[0-9+(). -]+$')
  ),
  constraint customers_preferred_locale_allowed check (preferred_locale is null or preferred_locale in ('es', 'en'))
);

comment on table public.customers is
  'customers of an operator with personal data (r11, r26). readable and writable by administrador and reservas only; never deleted by authenticated; not audited (pii erasure).';

-- r26: unique per operator by email when present, case-insensitive.
create unique index customers_operator_email_key
  on public.customers (operator_id, lower(email))
  where email is not null;

-- list order and name search within an operator.
create index customers_operator_name_idx on public.customers (operator_id, name);


-- ============================================================================
-- customer_display (masked name, derived)
-- ============================================================================

create table public.customer_display (
  customer_id uuid primary key,
  operator_id uuid not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_display_operator_id_customer_id_key unique (operator_id, customer_id),
  -- cascade: erasing a customer erases its display row too.
  constraint customer_display_customer_fkey
    foreign key (operator_id, customer_id) references public.customers (operator_id, id) on delete cascade
);

comment on table public.customer_display is
  'masked customer name (first name plus last initial) readable by every role of the operator (ktd4). written only by private.sync_customer_display().';


-- ============================================================================
-- functions and triggers
-- ============================================================================

-- first name plus last initial: 'Ana María López' -> 'Ana L.'; a single word
-- stays as is. pure helper called by the display trigger.
create function private.customer_display_name(full_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(array_length(s.parts, 1), 0) = 0 or s.parts[1] = '' then ''
    when array_length(s.parts, 1) = 1 then s.parts[1]
    else s.parts[1] || ' ' || upper(left(s.parts[array_length(s.parts, 1)], 1)) || '.'
  end
  from (
    select regexp_split_to_array(
      regexp_replace(coalesce(full_name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
      '[[:space:]]+'
    ) as parts
  ) s;
$$;
revoke execute on function private.customer_display_name(text) from public, anon, authenticated;

-- keeps customer_display in step with customers.name (ktd5: derived data is
-- owned by definer triggers, so no role needs a write grant on the table).
create function private.sync_customer_display()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_display (customer_id, operator_id, display_name)
  values (new.id, new.operator_id, private.customer_display_name(new.name))
  on conflict (customer_id) do update
    set display_name = excluded.display_name
    where customer_display.display_name is distinct from excluded.display_name;
  return null;
end;
$$;
revoke execute on function private.sync_customer_display() from public, anon, authenticated;

create trigger t10_set_updated_at
  before update on public.customers
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t80_customer_display
  after insert on public.customers
  for each row
  execute function private.sync_customer_display();

create trigger t80_customer_display_update
  after update of name on public.customers
  for each row
  when (old.name is distinct from new.name)
  execute function private.sync_customer_display();

create trigger t10_set_updated_at
  before update on public.customer_display
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();


-- ============================================================================
-- row level security
-- ============================================================================

alter table public.customers enable row level security;
alter table public.customer_display enable row level security;

-- customers: full personal data for administrador and reservas only (r11).
create policy "Administradores and reservas read their operator's customers"
  on public.customers for select
  to authenticated
  using ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])));

create policy "Administradores and reservas add customers to their operator"
  on public.customers for insert
  to authenticated
  with check ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])));

create policy "Administradores and reservas update their operator's customers"
  on public.customers for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador', 'reservas']::public.membership_role[])));

-- customer_display: every role of the operator (ktd4).
create policy "Members read their operator's masked customer names"
  on public.customer_display for select
  to authenticated
  using (operator_id in (select private.user_operator_ids()));


-- ============================================================================
-- grants
-- ============================================================================

-- customers: operator_id insertable, never updatable; no delete (r27).
grant select on public.customers to authenticated;
grant insert (operator_id, name, email, phone, preferred_locale) on public.customers to authenticated;
grant update (name, email, phone, preferred_locale) on public.customers to authenticated;
grant select, insert, update, delete on public.customers to service_role;

-- customer_display: read only; the definer trigger writes it.
grant select on public.customer_display to authenticated;
grant select, insert, update, delete on public.customer_display to service_role;
