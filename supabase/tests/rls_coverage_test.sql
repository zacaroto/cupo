-- ============================================================================
-- rls coverage and function hygiene (r31, plan u2 step 7)
-- ============================================================================
-- runs with `supabase test db`. every assertion lists offenders, so a failure
-- names the table or function that broke the template. the whole file runs in
-- one transaction that is rolled back.

begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

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
