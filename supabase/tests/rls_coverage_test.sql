-- ============================================================================
-- rls coverage and function hygiene (r31, plan u2 step 7, extended in u8)
-- ============================================================================
-- runs with `supabase test db`. every assertion lists offenders, so a failure
-- names the table or function that broke the template. the whole file runs in
-- one transaction that is rolled back.
--
-- u8 adds the enumerated list of `security definer` functions: a new definer
-- function in `private` fails until it is added to `definer_functions` below
-- with a reviewer's yes (README, "Adding a table or a function").

begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

-- ============================================================================
-- tables exposed to the data api
-- ============================================================================

select is_empty(
  $q$
    select n.nspname || '.' || c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'audit')
      and not c.relrowsecurity
  $q$,
  'every table in public and audit has row level security enabled'
);

select is_empty(
  $q$
    select n.nspname || '.' || c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'audit')
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
  $q$,
  'every table in public and audit has at least one policy'
);

select is_empty(
  $q$
    select n.nspname || '.' || c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'audit')
      and not has_table_privilege('authenticated', c.oid, 'select')
  $q$,
  'every table in public and audit has an explicit select grant to authenticated'
);

select is_empty(
  $q$
    select n.nspname || '.' || c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'audit')
      and not has_table_privilege('service_role', c.oid, 'select')
  $q$,
  'every table in public and audit has an explicit grant to service_role'
);

-- business tables (every table carrying operator_id) have a btree index whose
-- first column is operator_id (ktd2).
select is_empty(
  $q$
    select n.nspname || '.' || c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'operator_id' and not a.attisdropped
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'audit')
      and not exists (
        select 1
        from pg_index i
        join pg_class ic on ic.oid = i.indexrelid
        join pg_am am on am.oid = ic.relam
        where i.indrelid = c.oid
          and am.amname = 'btree'
          and i.indkey[0] = a.attnum
      )
  $q$,
  'every table with operator_id has a btree index leading with operator_id'
);

-- ktd2, r2: every table except the tenant root and the auth mirror carries
-- operator_id (so the index check above applies to it).
select is_empty(
  $q$
    select n.nspname || '.' || c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'audit')
      and (n.nspname, c.relname) not in (('public', 'operators'), ('public', 'profiles'))
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'operator_id' and not a.attisdropped
      )
  $q$,
  'every table in public and audit except operators and profiles carries operator_id'
);

-- ktd2: a foreign key between two tables that both carry operator_id includes
-- operator_id on both sides (composite), so a row cannot reference a parent
-- of another operator.
select is_empty(
  $q$
    select c.conrelid::regclass::text || '.' || c.conname
    from pg_constraint c
    join pg_class src on src.oid = c.conrelid
    join pg_namespace n on n.oid = src.relnamespace
    join pg_attribute sa on sa.attrelid = c.conrelid and sa.attname = 'operator_id' and not sa.attisdropped
    join pg_attribute da on da.attrelid = c.confrelid and da.attname = 'operator_id' and not da.attisdropped
    where c.contype = 'f'
      and n.nspname in ('public', 'audit')
      and not (sa.attnum = any (c.conkey) and da.attnum = any (c.confkey))
  $q$,
  'every foreign key between business tables is composite with operator_id'
);

-- ktd2: every policy applies to authenticated only (anon and service_role
-- never reach a policy that was written for a signed-in member).
select is_empty(
  $q$
    select p.schemaname || '.' || p.tablename || ': ' || p.policyname
    from pg_policies p
    where p.schemaname in ('public', 'audit')
      and p.roles <> array['authenticated']::name[]
  $q$,
  'every policy in public and audit is to authenticated'
);

-- `private` is not exposed to the data api (config.toml), and its tables
-- (private.reservation_counters) grant nothing to the api roles either.
select is_empty(
  $q$
    select n.nspname || '.' || c.relname || ' (' || r.rolname || ')'
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) as r (rolname)
    where c.relkind in ('r', 'p', 'v', 'm')
      and n.nspname = 'private'
      and has_table_privilege(r.rolname, c.oid, 'select, insert, update, delete')
  $q$,
  'no table in private is readable or writable by anon or authenticated'
);

-- ============================================================================
-- functions
-- ============================================================================

select is_empty(
  $q$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'audit')
      and p.prosecdef
  $q$,
  'no security definer function lives in an exposed schema (public, audit)'
);

-- the enumerated definer list (plan u8 step 4). every entry runs with the
-- owner's privileges and bypasses rls, so each one was reviewed when it was
-- added; the comment names the unit and what it is for.
create temporary table definer_functions (name text primary key) on commit drop;
insert into definer_functions (name) values
  -- u2 foundation: policy helpers
  ('user_operator_ids'),
  ('has_role'),
  ('can_view_profile'),
  -- u2 foundation: triggers (updated_at, operator timezone, profile mirror,
  -- last administrador) and the audit writer
  ('set_updated_at'),
  ('operator_timezone_rules'),
  ('sync_profile'),
  ('membership_last_administrador'),
  ('record_change'),
  -- u4 guides: policy helper and triggers
  ('my_guide_ids'),
  ('guide_link_rules'),
  ('guide_deactivation_revokes_access'),
  ('membership_guide_linked'),
  -- u9 customers: masked display
  ('sync_customer_display'),
  -- u5 tours and departures: departure rules, starts_at and its recompute,
  -- guide deactivation, slot materialization
  ('departure_rules'),
  ('set_departure_starts_at'),
  ('recompute_starts_at_on_timezone'),
  ('clear_guide_on_deactivate'),
  ('materialize_departure'),
  -- u6 reservations: code, rules, seats, flags, amount snapshot and override
  ('next_reservation_code'),
  ('reservation_rules'),
  ('reservation_seats'),
  ('reservation_flag'),
  ('reservation_code'),
  ('reservation_amount'),
  ('amount_override'),
  ('customer_flag'),
  -- u8: notes of a cancelled reservation are frozen
  ('reservation_notes_rules');

select is_empty(
  $q$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.prosecdef
      and p.proname not in (select name from definer_functions)
  $q$,
  'every security definer function in private is in the enumerated list'
);

select is_empty(
  $q$
    select d.name
    from definer_functions d
    where not exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = d.name and p.prosecdef
    )
  $q$,
  'every function in the enumerated list exists in private as security definer'
);

select is_empty(
  $q$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
        where cfg like 'search_path=%'
      )
  $q$,
  'every function in private pins search_path'
);

select is_empty(
  $q$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'audit')
      and has_function_privilege('anon', p.oid, 'execute')
  $q$,
  'no function in public or audit is executable by anon'
);

-- every function in public carries an explicit execute revoke and grant: no
-- default acl (null means execute for public) and no grant to public.
select is_empty(
  $q$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'audit')
      and (
        p.proacl is null
        or exists (select 1 from aclexplode(p.proacl) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
      )
  $q$,
  'every function in public and audit has an explicit acl without a grant to public'
);

select is_empty(
  $q$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'admin\_%'
      and has_function_privilege('authenticated', p.oid, 'execute')
  $q$,
  'no admin_* function in public is executable by authenticated'
);

select * from finish();

rollback;
