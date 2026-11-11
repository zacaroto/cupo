-- ============================================================================
-- cupo guides: guide registry, private.my_guide_ids(), the guía-to-guide link
-- rules on memberships and guides, policies, grants, admin seed rpc (plan u4)
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
-- guides (r19)
-- ============================================================================

create table public.guides (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete restrict,
  name text not null,
  email text,
  phone text,
  languages text[] not null default '{}',
  specialties text[] not null default '{}',
  max_daily_hours smallint,
  active boolean not null default true,
  -- the account a guía signs in with; set by the "send access" action under
  -- the administrador's session. history of the guide survives the account.
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guides_operator_id_id_key unique (operator_id, id),
  -- one guide per account per operator, so a guía membership maps to exactly
  -- one guide (r19). nulls are distinct: many guides may have no account.
  constraint guides_operator_id_user_id_key unique (operator_id, user_id),
  constraint guides_name_length check (length(btrim(name)) between 1 and 120),
  constraint guides_email_format check (email is null or (email ~ '^[^@[:space:]]+@[^@[:space:]]+$' and length(email) <= 254)),
  constraint guides_phone_length check (phone is null or length(phone) between 1 and 40),
  constraint guides_languages_size check (cardinality(languages) <= 20),
  constraint guides_specialties_size check (cardinality(specialties) <= 20),
  constraint guides_max_daily_hours_range check (max_daily_hours is null or max_daily_hours between 1 and 24)
);

comment on table public.guides is
  'guide registry per operator (r19). a guía membership must match an active guide of the same operator whose user_id is the member.';

-- contact email is unique per operator, case-insensitively.
create unique index guides_operator_id_lower_email_key on public.guides (operator_id, lower(email))
  where email is not null;
create index guides_operator_id_name_idx on public.guides (operator_id, name);
-- my_guide_ids() and the auth.users `on delete set null` cascade look up by user.
create index guides_user_id_idx on public.guides (user_id) where user_id is not null;


-- ============================================================================
-- rls helper (private, security definer, called from policies)
-- ============================================================================

-- guides the current user is the linked guía of: one per active operator where
-- the user holds a guía membership and the guide is active (ktd2, ktd13).
-- requiring the membership keeps a guide row linked by an administrador to an
-- account that is not a guía of that operator from granting anything.
create function private.my_guide_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select g.id
  from public.guides g
  join public.memberships m
    on m.operator_id = g.operator_id
   and m.user_id = g.user_id
   and m.role = 'guia'
  join public.operators o on o.id = g.operator_id
  where g.user_id = auth.uid()
    and g.active
    and o.status = 'active';
$$;
revoke execute on function private.my_guide_ids() from public, anon;
grant execute on function private.my_guide_ids() to authenticated;


-- ============================================================================
-- guides: domain rules and triggers
-- ============================================================================

-- r19, memberships side: a guía membership needs an active guide of the same
-- operator linked to the member. the guide row is locked `for share` so a
-- concurrent unlink or deactivation waits for this transaction and then sees
-- the membership (and the guide-side rule below rejects or revokes it).
create function private.membership_guide_linked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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

-- r19, guides side: the linked account cannot change or be cleared (and the
-- guide cannot be deleted) while that account still holds the guía
-- membership; remove the access first. deleting the auth user itself is
-- exempt: its memberships cascade away in the same statement.
create function private.guide_link_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.user_id is not null
     and (tg_op = 'DELETE' or new.user_id is distinct from old.user_id)
     and exists (
       select 1
       from public.memberships m
       where m.operator_id = old.operator_id
         and m.user_id = old.user_id
         and m.role = 'guia'
     )
     and exists (select 1 from auth.users u where u.id = old.user_id)
  then
    raise exception using errcode = 'P0001', message = 'guide_has_access';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke execute on function private.guide_link_rules() from public, anon, authenticated;

-- deactivating a guide revokes their access in the same transaction (plan u4
-- step 5): the guía membership is deleted, so the next request of that user
-- resolves no context for this operator. the delete is audited with the
-- caller as actor.
create function private.guide_deactivation_revokes_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is not null then
    delete from public.memberships m
    where m.operator_id = new.operator_id
      and m.user_id = new.user_id
      and m.role = 'guia';
  end if;
  return null;
end;
$$;
revoke execute on function private.guide_deactivation_revokes_access() from public, anon, authenticated;

create trigger t10_set_updated_at
  before update on public.guides
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

create trigger t20_guide_link
  before update of user_id or delete on public.guides
  for each row
  execute function private.guide_link_rules();

create trigger t80_revoke_access_on_deactivation
  after update of active on public.guides
  for each row
  when (old.active and not new.active)
  execute function private.guide_deactivation_revokes_access();

create trigger t20_guide_linked
  before insert or update on public.memberships
  for each row
  when (new.role = 'guia')
  execute function private.membership_guide_linked();


-- ============================================================================
-- row level security
-- ============================================================================

alter table public.guides enable row level security;

create policy "Staff read their operator's guides and guías read their own"
  on public.guides for select
  to authenticated
  using (
    (select private.has_role(operator_id, array['administrador', 'reservas', 'contabilidad']::public.membership_role[]))
    or id in (select private.my_guide_ids())
  );

create policy "Administradores add guides to their operator"
  on public.guides for insert
  to authenticated
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));

create policy "Administradores edit their operator's guides"
  on public.guides for update
  to authenticated
  using ((select private.has_role(operator_id, array['administrador']::public.membership_role[])))
  with check ((select private.has_role(operator_id, array['administrador']::public.membership_role[])));


-- ============================================================================
-- grants
-- ============================================================================

-- guides: operator_id insertable, never updatable; user_id is set only by the
-- access action (update), never on insert; no delete for authenticated
-- (deactivate instead).
grant select on public.guides to authenticated;
grant insert (operator_id, name, email, phone, languages, specialties, max_daily_hours, active)
  on public.guides to authenticated;
grant update (name, email, phone, languages, specialties, max_daily_hours, active, user_id)
  on public.guides to authenticated;
grant select, insert, update, delete on public.guides to service_role;


-- ============================================================================
-- admin rpcs (public, security invoker, service_role only; ktd6)
-- ============================================================================

-- links a guide to an auth user on behalf of `actor_id` (null = system); used
-- by scripts/seed-users.ts before the seeded guía membership, which the
-- t20_guide_linked rule requires.
create function public.admin_seed_guide_user(
  actor_id uuid,
  guide_id uuid,
  user_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform set_config('app.actor_id', coalesce(admin_seed_guide_user.actor_id::text, ''), true);

  update public.guides
  set user_id = admin_seed_guide_user.user_id
  where id = admin_seed_guide_user.guide_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
end;
$$;
revoke execute on function public.admin_seed_guide_user(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_seed_guide_user(uuid, uuid, uuid)
  to service_role;
