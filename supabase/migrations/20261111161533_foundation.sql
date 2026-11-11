-- ============================================================================
-- cupo foundation: schemas, roles enum, operators, profiles, memberships,
-- rls helpers, audit, admin rpcs
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


-- ============================================================================
-- schemas
-- ============================================================================

-- `private` holds the helpers that policies and triggers call. it is not
-- listed in `[api] schemas`, so nothing in it is reachable over the data api.
create schema private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- `audit` is exposed over the data api (config.toml) so administradores can
-- read history; rows are written only by the definer trigger below.
create schema audit;
revoke all on schema audit from public;
grant usage on schema audit to authenticated, service_role;


-- ============================================================================
-- types
-- ============================================================================

-- the four roles of r3. identifiers stay ascii (`guia`); the ui shows "Guía".
create type public.membership_role as enum (
  'administrador',
  'reservas',
  'contabilidad',
  'guia'
);


-- ============================================================================
-- generic trigger functions
-- ============================================================================

create function private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function private.set_updated_at() from public, anon, authenticated;


-- ============================================================================
-- operators
-- ============================================================================

create table public.operators (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  -- iana zone name; validated against pg_timezone_names by t20_operator_timezone
  -- (a subquery is not allowed inside a check constraint).
  timezone text not null,
  currency char(3) not null,
  locale text not null default 'es',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operators_slug_key unique (slug),
  constraint operators_name_length check (length(btrim(name)) between 1 and 120),
  constraint operators_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 60),
  constraint operators_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint operators_locale_allowed check (locale in ('es', 'en')),
  constraint operators_status_allowed check (status in ('active', 'inactive'))
);

comment on table public.operators is
  'tour operators (tenants). status, slug and currency change only through admin_* rpcs.';

create index operators_status_idx on public.operators (status);

-- timezone validation runs in a trigger because `pg_timezone_names` is a view
-- and check constraints cannot contain subqueries. the error is reported as a
-- check violation named `operators_timezone_valid` so the dal maps it like
-- any other constraint.
create function private.operator_timezone_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.timezone is distinct from old.timezone then
    if not exists (
      select 1 from pg_catalog.pg_timezone_names where name = new.timezone
    ) then
      raise exception using
        errcode = 'check_violation',
        message = format('invalid timezone "%s"', new.timezone),
        constraint = 'operators_timezone_valid',
        schema = 'public',
        table = 'operators';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function private.operator_timezone_rules() from public, anon, authenticated;

create trigger t10_set_updated_at
  before update on public.operators
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t20_operator_timezone
  before insert or update of timezone on public.operators
  for each row
  execute function private.operator_timezone_rules();


-- ============================================================================
-- profiles (mirror of auth.users)
-- ============================================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'mirror of auth.users (email, full_name) maintained by a definer trigger; never written by the app.';

-- ktd8 looks users up by lower(email) through the admin client.
create index profiles_lower_email_idx on public.profiles (lower(email));

create function private.sync_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null then
    return new;
  end if;
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name
    where profiles.email is distinct from excluded.email
       or profiles.full_name is distinct from excluded.full_name;
  return new;
end;
$$;
revoke execute on function private.sync_profile() from public, anon, authenticated;

create trigger t10_set_updated_at
  before update on public.profiles
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t80_sync_profile
  after insert or update of email, raw_user_meta_data on auth.users
  for each row
  execute function private.sync_profile();


-- ============================================================================
-- memberships
-- ============================================================================

create table public.memberships (
  -- `id` exists so audit rows and later references have a single-column
  -- record id; the business key stays (user_id, operator_id).
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  operator_id uuid not null references public.operators (id) on delete restrict,
  role public.membership_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_pkey primary key (user_id, operator_id),
  constraint memberships_id_key unique (id),
  constraint memberships_operator_id_id_key unique (operator_id, id)
);

comment on table public.memberships is
  'who belongs to which operator with which role (r3). an operator always keeps one administrador (r12).';

create index memberships_operator_id_idx on public.memberships (operator_id, role);


-- ============================================================================
-- rls helpers (private, security definer, called from policies)
-- ============================================================================

-- operators the current user belongs to, excluding inactive operators (r6).
create function private.user_operator_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select m.operator_id
  from public.memberships m
  join public.operators o on o.id = m.operator_id
  where m.user_id = auth.uid()
    and o.status = 'active';
$$;
revoke execute on function private.user_operator_ids() from public, anon;
grant execute on function private.user_operator_ids() to authenticated;

-- true when the current user holds one of `roles` in an active operator.
create function private.has_role(operator_id uuid, roles public.membership_role[])
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.operators o on o.id = m.operator_id
    where m.user_id = auth.uid()
      and m.operator_id = has_role.operator_id
      and m.role = any (has_role.roles)
      and o.status = 'active'
  );
$$;
revoke execute on function private.has_role(uuid, public.membership_role[]) from public, anon;
grant execute on function private.has_role(uuid, public.membership_role[]) to authenticated;

-- true when the current user holds a staff role (administrador, reservas,
-- contabilidad) in an active operator the profile's user belongs to (ktd6).
create function private.can_view_profile(profile_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.operators o on o.id = mine.operator_id
    join public.memberships theirs on theirs.operator_id = mine.operator_id
    where mine.user_id = auth.uid()
      and mine.role in ('administrador', 'reservas', 'contabilidad')
      and o.status = 'active'
      and theirs.user_id = can_view_profile.profile_id
  );
$$;
revoke execute on function private.can_view_profile(uuid) from public, anon;
grant execute on function private.can_view_profile(uuid) to authenticated;


-- ============================================================================
-- audit (ktd6)
-- ============================================================================

create table audit.events (
  id bigint generated always as identity primary key,
  operator_id uuid not null,
  table_name text not null,
  record_id uuid,
  op text not null,
  old_record jsonb,
  new_record jsonb,
  -- no foreign key: history survives user deletion.
  actor_id uuid,
  actor_source text not null,
  at timestamptz not null default now(),
  constraint events_op_allowed check (op in ('insert', 'update', 'delete')),
  constraint events_actor_source_allowed check (actor_source in ('jwt', 'app', 'system'))
);

comment on table audit.events is
  'change history written by private.record_change(); readable by administradores of the operator, never written by any role.';

create index events_operator_record_idx on audit.events (operator_id, table_name, record_id, at desc);

-- actor resolution: a user session (jwt) wins; otherwise the transaction-local
-- `app.actor_id` set by an admin_* rpc (app); otherwise the write came from the
-- system (cascades, seeds, auth hooks).
create function private.record_change()
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
    coalesce(v_new ->> 'id', v_old ->> 'id')::uuid,
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
-- memberships: domain rules and triggers
-- ============================================================================

-- r12: an active operator always keeps at least one administrador. the
-- operator row is locked first so two concurrent demotions cannot both pass
-- the count. an inactive operator grants nothing (r6), so it is released from
-- the rule: deactivating through an admin_* rpc is the only way to remove the
-- last administrador (including a cascade from deleting their auth user).
create function private.membership_last_administrador()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if old.role = 'administrador'
     and (tg_op = 'DELETE' or new.role <> 'administrador' or new.operator_id <> old.operator_id) then
    select o.status into v_status
    from public.operators o
    where o.id = old.operator_id
    for update;
    if v_status = 'active' and not exists (
      select 1
      from public.memberships m
      where m.operator_id = old.operator_id
        and m.role = 'administrador'
        and m.user_id <> old.user_id
    ) then
      raise exception using errcode = 'P0001', message = 'last_administrador';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke execute on function private.membership_last_administrador() from public, anon, authenticated;

create trigger t10_set_updated_at
  before update on public.memberships
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t20_last_administrador
  before update or delete on public.memberships
  for each row
  execute function private.membership_last_administrador();

create trigger t90_audit
  after insert or delete on public.memberships
  for each row
  execute function private.record_change();

create trigger t90_audit_update
  after update on public.memberships
  for each row
  when (old.* is distinct from new.*)
  execute function private.record_change();


-- ============================================================================
-- row level security
-- ============================================================================

alter table public.operators enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table audit.events enable row level security;

-- operators
create policy "Members read their active operators"
  on public.operators for select
  to authenticated
  using (id in (select private.user_operator_ids()));

create policy "Administradores update their operator"
  on public.operators for update
  to authenticated
  using ((select private.has_role(id, array['administrador']::public.membership_role[])))
  with check ((select private.has_role(id, array['administrador']::public.membership_role[])));

-- profiles
create policy "Users read their own profile and staff read their operators' members"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()) or (select private.can_view_profile(id)));

-- memberships
create policy "Users read their own memberships and administradores read their operator's"
  on public.memberships for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.has_role(operator_id, array['administrador']::public.membership_role[]))
  );

create policy "Administradores add members to their operator"
  on public.memberships for insert
  to authenticated
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

create policy "Administradores change roles in their operator"
  on public.memberships for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

create policy "Administradores remove members from their operator"
  on public.memberships for delete
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

-- audit
create policy "Administradores read their operator's history"
  on audit.events for select
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));


-- ============================================================================
-- grants
-- ============================================================================

-- operators: no insert or delete for authenticated; `status`, `slug` and
-- `currency` change only through admin_* rpcs.
grant select on public.operators to authenticated;
grant update (name, timezone, locale) on public.operators to authenticated;
grant select, insert, update, delete on public.operators to service_role;

-- profiles: read only; rows come from the auth.users mirror.
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;

-- memberships: operator_id insertable, never updatable.
grant select on public.memberships to authenticated;
grant insert (user_id, operator_id, role) on public.memberships to authenticated;
grant update (role) on public.memberships to authenticated;
grant delete on public.memberships to authenticated;
grant select, insert, update, delete on public.memberships to service_role;

-- audit: read only for everyone; the trigger writes as definer.
grant select on audit.events to authenticated;
grant select on audit.events to service_role;


-- ============================================================================
-- admin rpcs (public, security invoker, service_role only; ktd6)
-- ============================================================================

-- creates an operator and its first administrador; idempotent on slug and on
-- (user, operator). `actor_id` is recorded in audit.events with source `app`.
create function public.admin_bootstrap_operator(
  actor_id uuid,
  name text,
  slug text,
  timezone text,
  currency text,
  locale text,
  admin_user_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_operator_id uuid;
begin
  perform set_config('app.actor_id', coalesce(admin_bootstrap_operator.actor_id::text, ''), true);

  insert into public.operators (name, slug, timezone, currency, locale)
  values (
    admin_bootstrap_operator.name,
    admin_bootstrap_operator.slug,
    admin_bootstrap_operator.timezone,
    admin_bootstrap_operator.currency,
    admin_bootstrap_operator.locale
  )
  on conflict (slug) do nothing
  returning id into v_operator_id;

  if v_operator_id is null then
    select o.id into v_operator_id
    from public.operators o
    where o.slug = admin_bootstrap_operator.slug;
  end if;

  insert into public.memberships (user_id, operator_id, role)
  values (admin_user_id, v_operator_id, 'administrador')
  on conflict (user_id, operator_id) do update
    set role = excluded.role
    where memberships.role is distinct from excluded.role;

  return v_operator_id;
end;
$$;
revoke execute on function public.admin_bootstrap_operator(uuid, text, text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_bootstrap_operator(uuid, text, text, text, text, text, uuid)
  to service_role;

-- upserts one membership on behalf of `actor_id` (null = system); used by
-- scripts/seed-users.ts after `db reset`.
create function public.admin_seed_membership(
  actor_id uuid,
  user_id uuid,
  operator_id uuid,
  role public.membership_role
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform set_config('app.actor_id', coalesce(admin_seed_membership.actor_id::text, ''), true);

  insert into public.memberships (user_id, operator_id, role)
  values (
    admin_seed_membership.user_id,
    admin_seed_membership.operator_id,
    admin_seed_membership.role
  )
  on conflict (user_id, operator_id) do update
    set role = excluded.role
    where memberships.role is distinct from excluded.role;
end;
$$;
revoke execute on function public.admin_seed_membership(uuid, uuid, uuid, public.membership_role)
  from public, anon, authenticated;
grant execute on function public.admin_seed_membership(uuid, uuid, uuid, public.membership_role)
  to service_role;
